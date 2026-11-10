import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { ChatMessage, LLMPair, ToolCall } from "../llm/types.js";
import { parseJsonLoose } from "../llm/types.js";
import { formatNow, resolveDates } from "../memory/dates.js";
import { recallByDates, renderMemory } from "../memory/recall.js";
import type { ConversationRow, MemoryStore, Source } from "../memory/store.js";
import type { SearchOutcome, WebSearch } from "../search/web-search.js";
import type { Recency, SearchQuery } from "../search/types.js";
import { META_SYSTEM, WEB_SEARCH_TOOL, answerSystem } from "./prompts.js";
import { route } from "./router.js";

export type AgentEvent =
  | { type: "meta"; conversationId: string }
  | { type: "status"; stage: string; message: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; result: TurnResult }
  | { type: "error"; message: string };

export interface TurnResult {
  conversationId: string;
  text: string;
  sources: Source[];
  route: string;
  reverify: boolean;
  memory: { dates: string[]; emptyDates: string[]; conversations: string[] };
  queries: string[];
  timings: { routerMs: number; searchMs: number; firstTokenMs: number; totalMs: number; toolRounds: number; cacheHits: number; searches: number };
}

export interface AgentDeps {
  cfg: Config;
  store: MemoryStore;
  llm: LLMPair;
  search: WebSearch;
  clock: () => Date;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

export class Agent {
  constructor(private d: AgentDeps) {}

  /** Render search outcomes for the model, numbering sources globally for the turn and de-duplicating URLs. */
  private formatResults(outcomes: SearchOutcome[], sources: Source[]): string {
    const out: string[] = [];
    for (const o of outcomes) {
      out.push(`## Query: "${o.query}" (${o.cached ? "cached" : "live"} via ${o.provider})`);
      if (!o.results.length) out.push(`(no results${o.error ? `: ${o.error}` : ""})`);
      for (const r of o.results) {
        let s = sources.find((x) => x.url === r.url);
        if (!s) { s = { n: sources.length + 1, title: r.title, url: r.url, published: r.published }; sources.push(s); }
        out.push(`[${s.n}] ${r.title} — ${r.url} — published: ${r.published ?? "date not shown"}\n    ${r.snippet}`);
      }
    }
    return out.join("\n");
  }

  async run(input: { conversationId?: string; message: string }, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
    const { cfg, store, llm, search, clock } = this.d;
    const t0 = Date.now();
    const now = clock();
    const nowStr = formatNow(now, cfg.tz);
    const convId = input.conversationId || randomUUID();
    const message = input.message.trim();
    emit({ type: "meta", conversationId: convId });

    // ---- 1. Memory pre-step (pure code): resolve dates deterministically, read that day's turns -------------------
    const history = store.recentMessages(convId, cfg.limits.historyMessages);
    const conv = store.getConversation(convId);
    const refs = resolveDates(message, now, cfg.tz);
    const { days, emptyDays } = recallByDates(store, refs);
    const dateBrief = renderMemory({ days, emptyDays: [], topicHits: [], store }, cfg.tz).brief;
    const candidates = store
      .searchConversations(message, { excludeConv: convId, limit: 3 })
      .filter((c) => !days.some((d) => d.conversations.some((x) => x.conv.id === c.conv.id)));
    if (refs.length) emit({ type: "status", stage: "memory", message: `Looking up ${refs.map((r) => r.phrase).join(", ")} in memory…` });

    // ---- 2. Router (small fast model): search or not? which queries? which extra memory? -------------------------
    const tr = Date.now();
    const histText = history.slice(-4).map((m) => `${m.role.toUpperCase()}: ${clip(m.content, 300)}`).join("\n");
    const decision = await route(llm.fast, {
      now: nowStr, message, history: histText, dateMemoryBrief: dateBrief,
      candidates: candidates.map((c) => `- id=${c.conv.id} "${c.conv.title}" topics: ${c.conv.topics.join(", ")}`).join("\n"),
    });
    const routerMs = Date.now() - tr;

    const topicHits: ConversationRow[] = candidates.map((c) => c.conv).filter((c) => decision.memoryConvIds.includes(c.id));
    const memory = renderMemory({ days, emptyDays, topicHits, store }, cfg.tz);
    emit({ type: "status", stage: "route", message: decision.route === "search" ? `Searching (${decision.queries.length} ${decision.queries.length === 1 ? "query" : "queries"})…` : "Answering directly…" });

    // ---- 3. Parallel prefetch of the planned searches ------------------------------------------------------------
    const sources: Source[] = [];
    let prefetched = "";
    let searchMs = 0, cacheHits = 0, searches = 0;
    const allQueries: string[] = [];
    if (decision.route === "search" && decision.queries.length) {
      const ts = Date.now();
      const outcomes = await search.many(decision.queries, cfg.limits.maxParallelSearches);
      searchMs = Date.now() - ts;
      cacheHits += outcomes.filter((o) => o.cached).length;
      searches += outcomes.length;
      allQueries.push(...outcomes.map((o) => o.query));
      prefetched = this.formatResults(outcomes, sources);
    }

    // ---- 4. Strong model answers (streamed). The one LLM-callable tool is web_search. ------------------------------
    const msgs: ChatMessage[] = [{ role: "system", content: answerSystem(nowStr) }];
    if (memory.text) msgs.push({ role: "system", content: memory.text });
    if (prefetched) msgs.push({ role: "system", content: `WEB SEARCH RESULTS (fetched just now, ${nowStr}). Cite with markdown links.\n${prefetched}` });
    if (conv?.summary && conv.summarized_upto > 0 && history.length >= cfg.limits.historyMessages)
      msgs.push({ role: "system", content: `Summary of the earlier part of this conversation: ${conv.summary}` });
    for (const m of history) msgs.push({ role: m.role, content: clip(m.content, 2500) });
    msgs.push({ role: "user", content: message });

    // Store the user message only now so same-day recall above could never return the question being asked.
    store.addMessage(convId, "user", message, now.getTime());

    let answer = "";
    let firstTokenMs = 0;
    let rounds = 0;
    try {
      for (;;) {
        const allowTools = rounds < cfg.limits.maxToolRounds;
        let pending: ToolCall[] = [];
        let roundText = "";
        for await (const ev of llm.strong.stream({ task: "answer", messages: msgs, tools: allowTools ? [WEB_SEARCH_TOOL] : undefined, signal })) {
          if (ev.type === "text") {
            if (!firstTokenMs) firstTokenMs = Date.now() - t0;
            roundText += ev.delta;
            answer += ev.delta;
            emit({ type: "token", text: ev.delta });
          } else pending = ev.calls;
        }
        if (!pending.length) break;
        rounds++;
        emit({ type: "status", stage: "tool", message: `Searching more (${pending.length})…` });
        msgs.push({ role: "assistant", content: roundText || null, tool_calls: pending });
        const parsed = pending.map((c) => {
          let a: any = {};
          try { a = JSON.parse(c.arguments || "{}"); } catch { /* bad args => empty query below */ }
          const q: SearchQuery = { query: String(a.query ?? "").slice(0, 200), recency: (a.recency ?? "any") as Recency, news: a.news === true };
          return { call: c, q };
        });
        const ts = Date.now();
        const outs = await search.many(parsed.filter((p) => p.q.query).map((p) => p.q), cfg.limits.maxParallelSearches);
        searchMs += Date.now() - ts;
        searches += outs.length;
        cacheHits += outs.filter((o) => o.cached).length;
        allQueries.push(...outs.map((o) => o.query));
        for (const p of parsed) {
          const o = outs.find((x) => x.query === p.q.query);
          msgs.push({ role: "tool", tool_call_id: p.call.id, content: o ? this.formatResults([o], sources) : "Error: empty query." });
        }
      }
    } catch (e) {
      emit({ type: "error", message: (e as Error).message });
      throw e;
    }

    if (sources.length) emit({ type: "sources", sources });
    store.addMessage(convId, "assistant", answer, Date.now(), sources);

    const result: TurnResult = {
      conversationId: convId, text: answer, sources, route: decision.route, reverify: decision.reverify,
      memory: {
        dates: days.map((d) => d.date), emptyDates: emptyDays,
        conversations: [...days.flatMap((d) => d.conversations.map((c) => c.conv.id)), ...topicHits.map((c) => c.id)],
      },
      queries: allQueries,
      timings: { routerMs, searchMs, firstTokenMs, totalMs: Date.now() - t0, toolRounds: rounds, cacheHits, searches },
    };
    emit({ type: "done", result });
    return result;
  }

  /** Post-turn: refresh title/summary/topics with the fast model. Off the critical path; failures are ignored. */
  async updateMemoryMeta(convId: string): Promise<void> {
    const { store, llm } = this.d;
    try {
      const conv = store.getConversation(convId);
      const msgs = store.messages(convId);
      if (!conv || !msgs.length) return;
      const fresh = msgs.slice(-6).map((m) => `${m.role.toUpperCase()}: ${clip(m.content, 1800)}`).join("\n");
      const raw = await llm.fast.complete({
        task: "meta", json: true,
        messages: [
          { role: "system", content: META_SYSTEM },
          { role: "user", content: `Previous summary: ${conv.summary || "(none)"}\nPrevious topics: ${conv.topics.join(", ") || "(none)"}\n\nLatest messages:\n${fresh}` },
        ],
      });
      const j = parseJsonLoose<{ title?: string; summary?: string; topics?: string[] }>(raw);
      if (!j) return;
      store.setMeta(convId, {
        title: typeof j.title === "string" ? j.title.slice(0, 80) : undefined,
        summary: typeof j.summary === "string" ? j.summary.slice(0, 1200) : undefined,
        topics: Array.isArray(j.topics) ? j.topics.map(String).slice(0, 10) : undefined,
        summarizedUpto: msgs.length,
      });
    } catch {
      /* memory index is best-effort */
    }
  }
}
