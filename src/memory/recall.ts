import { type DateRef, expandDays, formatCivil, type Civil } from "./dates.js";
import type { ConversationRow, MemoryStore, MessageRow } from "./store.js";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …[truncated]" : s);
const hhmm = (ts: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));

export interface DayRecall {
  date: Civil;
  conversations: { conv: ConversationRow; messages: MessageRow[] }[];
}

export interface Recall {
  /** Rendered memory block to inject into the prompt ("" if nothing relevant). */
  text: string;
  /** Short brief for the router (titles + topics only). */
  brief: string;
  days: DayRecall[];
  topicHits: ConversationRow[];
  /** Days the user asked about that have no stored conversations. */
  emptyDays: Civil[];
}

/** Recall by explicit dates: pure DB reads, no LLM involved. */
export function recallByDates(store: MemoryStore, refs: DateRef[], excludeMessageIds: number[] = []): Pick<Recall, "days" | "emptyDays"> {
  const wanted = expandDays(refs);
  const groups = store.messagesOnDays(wanted, excludeMessageIds);
  const days: DayRecall[] = wanted
    .map((date) => ({
      date,
      conversations: groups.filter((g) => g.date === date).map((g) => ({ conv: g.conv, messages: g.messages })),
    }))
    .filter((d) => d.conversations.length);
  const hard = new Set(expandDays(refs.filter((r) => !r.soft)));
  const emptyDays = [...hard].filter((d) => !days.some((x) => x.date === d));
  return { days, emptyDays };
}

export function renderMemory(
  parts: { days: DayRecall[]; emptyDays: Civil[]; topicHits: ConversationRow[]; store: MemoryStore },
  tz: string,
  budgetChars = 9000,
): Pick<Recall, "text" | "brief"> {
  const lines: string[] = [];
  const brief: string[] = [];
  let used = 0;
  const push = (s: string) => { lines.push(s); used += s.length; };

  for (const d of parts.days) {
    for (const { conv, messages } of d.conversations) {
      push(`### ${formatCivil(d.date)} — "${conv.title || "untitled"}" (conversation ${conv.id})`);
      brief.push(`- ${d.date} "${conv.title || "untitled"}" topics: ${conv.topics.join(", ") || "n/a"}`);
      for (const m of messages) {
        const per = m.role === "user" ? 1200 : Math.max(500, Math.floor((budgetChars - used) / Math.max(2, messages.length)));
        push(`[${hhmm(m.ts, tz)}] ${m.role === "user" ? "USER" : "ASSISTANT"}: ${clip(m.content, per)}`);
        if (m.role === "assistant" && m.sources.length)
          push(`  (sources cited then: ${m.sources.slice(0, 6).map((s) => `${s.title} <${s.url}>`).join("; ")})`);
      }
      if (used > budgetChars) break;
    }
  }
  for (const c of parts.topicHits) {
    if (used > budgetChars) break;
    const when = new Date(c.updated_at);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(when);
    push(`### Related earlier conversation — ${formatCivil(date)} — "${c.title || "untitled"}"`);
    push(`Summary: ${clip(c.summary || "(no summary)", 900)}`);
    brief.push(`- ${date} "${c.title || "untitled"}" topics: ${c.topics.join(", ") || "n/a"}`);
  }
  for (const d of parts.emptyDays) push(`### ${formatCivil(d)}: NO stored conversations on this day.`);

  const text = lines.length
    ? "MEMORY (retrieved from this user's past conversations by the app, not from the web). What was said then is reliable as a record of the past, but any facts/prices in it may be OUT OF DATE.\n" + lines.join("\n")
    : "";
  return { text, brief: brief.join("\n") };
}
