import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AgentEvent } from "../src/agent/agent.js";
import { createMockLLM } from "../src/llm/mock.js";
import type { ChatMessage, LLMClient, LLMPair, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { MockSearchProvider } from "../src/search/mock.js";
import { seed } from "../src/seed.js";
import { createHttpServer } from "../src/server.js";

const NOW = new Date("2026-11-10T14:00:00+05:30");
const mk = (llm: LLMPair = createMockLLM(), provider = new MockSearchProvider()) => {
  const app = createApp({ cfg: { mock: true, dbPath: ":memory:", tz: "Asia/Kolkata" }, clock: () => NOW, llm, searchProvider: provider });
  seed(app);
  return { app, provider };
};

/** Wraps the mock strong model to record exactly what the answering model was given. */
function spyLLM() {
  const base = createMockLLM();
  const seen: { messages: ChatMessage[]; tools?: string[] }[] = [];
  const strong: LLMClient = {
    model: "spy",
    complete: (r) => base.strong.complete(r),
    stream: (r: StreamRequest): AsyncGenerator<StreamEvent> => { seen.push({ messages: r.messages, tools: r.tools?.map((t) => t.name) }); return base.strong.stream(r); },
  };
  return { llm: { fast: base.fast, strong } as LLMPair, seen };
}
const sys = (m: { messages: ChatMessage[] }) => m.messages.filter((x) => x.role === "system").map((x) => (x as any).content).join("\n");

describe("agent turn (mock providers)", () => {
  it("'On Monday we shortlisted 5 CRM tools…' → injects Monday's turns, re-verifies each tool in parallel", async () => {
    const { llm, seen } = spyLLM();
    const { app, provider } = mk(llm);
    const r = await app.agent.run({ message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" }, () => {});
    expect(r.memory.dates).toEqual(["2026-11-09"]);
    expect(r.reverify).toBe(true);
    expect(sys(seen[0])).toMatch(/Monday, 9 November 2026/);
    expect(sys(seen[0])).toMatch(/Freshsales/);
    expect(provider.calls.length).toBe(5); // one query per remembered tool (HubSpot, Salesforce, Pipedrive, Zoho, Freshsales)
    expect(provider.calls.join("|")).toMatch(/Pipedrive/);
    expect(r.sources.length).toBeGreaterThan(0);
  });

  it("'What did I ask you on 3 November?' → both conversations from that day reach the model", async () => {
    const { llm, seen } = spyLLM();
    const { app } = mk(llm);
    await app.agent.run({ message: "What did I ask you on 3 November? Is your answer still correct today?" }, () => {});
    const s = sys(seen[0]);
    expect(s).toMatch(/Postgres/); expect(s).toMatch(/Which Node\.js version/);
    expect(s).not.toMatch(/20-person sales team/); // Monday's CRM chat must NOT leak in
  });

  it("'Last Tuesday I asked about Postgres hosting' → Tuesday 3 Nov, with Postgres vendors queried", async () => {
    const { llm, seen } = spyLLM();
    const { app, provider } = mk(llm);
    const r = await app.agent.run({ message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" }, () => {});
    expect(r.memory.dates).toEqual(["2026-11-03"]);
    expect(sys(seen[0])).toMatch(/Supabase Pro is \$25|Pro is \$25\/mo/);
    expect(provider.calls.some((q) => /Supabase/.test(q))).toBe(true);
  });

  it("a day with no conversations is stated explicitly (anti-hallucination)", async () => {
    const { llm, seen } = spyLLM();
    const { app } = mk(llm);
    await app.agent.run({ message: "What did I ask you on 1 November?" }, () => {});
    expect(sys(seen[0])).toMatch(/NO stored conversations/);
  });

  it("web_search is the ONLY tool ever exposed to the LLM", async () => {
    const { llm, seen } = spyLLM();
    const { app } = mk(llm);
    await app.agent.run({ message: "What's the best CRM for startups?" }, () => {});
    for (const s of seen) expect(s.tools).toEqual(["web_search"]);
  });

  it("small talk skips the router LLM and the search entirely", async () => {
    const { app, provider } = mk();
    const r = await app.agent.run({ message: "thanks!" }, () => {});
    expect(r.route).toBe("direct");
    expect(provider.calls).toEqual([]);
    expect(r.timings.searches).toBe(0);
  });

  it("repeat queries hit the SQLite cache", async () => {
    const { app, provider } = mk();
    await app.agent.run({ message: "What's the best CRM for startups?" }, () => {});
    const r2 = await app.agent.run({ message: "What's the best CRM for startups?" }, () => {});
    expect(provider.calls.length).toBe(1);
    expect(r2.timings.cacheHits).toBe(1);
  });

  it("handles a model that calls web_search itself (tool loop, parallel calls)", async () => {
    const base = createMockLLM();
    let round = 0;
    const strong: LLMClient = {
      model: "tooly", complete: (r) => base.strong.complete(r),
      async *stream(r) {
        if (round++ === 0 && r.tools) {
          yield { type: "tool_calls", calls: [
            { id: "a", name: "web_search", arguments: JSON.stringify({ query: "alpha 2026", recency: "month" }) },
            { id: "b", name: "web_search", arguments: JSON.stringify({ query: "beta 2026", news: true }) }] };
          return;
        }
        yield { type: "text", delta: `got ${r.messages.filter((m) => m.role === "tool").length} tool results` };
      },
    };
    const { app, provider } = mk({ fast: base.fast, strong });
    const r = await app.agent.run({ message: "hello there friend" }, () => {});
    expect(r.text).toBe("got 2 tool results");
    expect(r.timings.toolRounds).toBe(1);
    expect(provider.calls.sort()).toEqual(["alpha 2026", "beta 2026"]);
  });

  it("falls back to searching the raw message if the router returns garbage", async () => {
    const base = createMockLLM();
    const fast: LLMClient = { model: "bad", complete: async () => "not json at all", stream: base.fast.stream.bind(base.fast) };
    const { app, provider } = mk({ fast, strong: base.strong });
    const r = await app.agent.run({ message: "What is the latest Node release?" }, () => {});
    expect(provider.calls).toEqual(["What is the latest Node release?"]);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("persists the exchange with timestamps and updates the memory index", async () => {
    const { app } = mk();
    const r = await app.agent.run({ message: "Which database is best for analytics?" }, () => {});
    await app.agent.updateMemoryMeta(r.conversationId);
    const msgs = app.store.messages(r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].local_date).toBe("2026-11-10");
    expect(app.store.getConversation(r.conversationId)!.title).not.toBe("");
  });
});

describe("HTTP server (SSE)", () => {
  it("streams status → token → sources → done over /api/chat and serves the UI", async () => {
    const { app } = mk();
    const server = createHttpServer(app).listen(0);
    const port = (server.address() as any).port;
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/<html/i);
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" }) });
      const raw = await res.text();
      const types = [...raw.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
      expect(types[0]).toBe("meta");
      expect(types).toContain("token");
      expect(types).toContain("sources");
      expect(types.at(-1)).toBe("done");
      const j = await (await fetch(`http://127.0.0.1:${port}/api/chat?stream=0`, { method: "POST", body: JSON.stringify({ message: "yo thanks" }) })).json();
      expect(j.route).toBe("direct");
      const list = (await (await fetch(`http://127.0.0.1:${port}/api/conversations`)).json()) as any[];
      expect(list.length).toBeGreaterThanOrEqual(5);
    } finally { server.close(); }
  });
});
