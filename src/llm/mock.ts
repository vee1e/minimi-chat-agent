import type { ChatMessage, CompleteRequest, LLMClient, LLMPair, StreamEvent, StreamRequest } from "./types.js";

const text = (m?: ChatMessage) => (m && "content" in m && typeof m.content === "string" ? m.content : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP_CAPS = new Set(["I", "The", "What", "Is", "Has", "On", "Last", "Can", "Do", "Did", "How", "Which", "Any", "Are", "You", "We", "It", "A", "An", "And", "My"]);

/** Deterministic stand-in for the LLM: no network, no keys. Behaves like a (dumb) router / summarizer / answerer. */
export class MockLLM implements LLMClient {
  constructor(readonly model: string) {}

  async complete(req: CompleteRequest): Promise<string> {
    if (req.task === "route") return JSON.stringify(this.route(text(req.messages.at(-1))));
    return JSON.stringify(this.meta(req.messages));
  }

  private route(u: string) {
    const msg = (u.split("MESSAGE:\n")[1] ?? u).trim();
    const brief = u.split("MEMORY FOR THE DATES YOU ASKED ABOUT (already attached):\n")[1]?.split("\n\n")[0] ?? "";
    const cands = [...(u.split("MEMORY CANDIDATES")[1]?.split("MESSAGE:")[0] ?? "").matchAll(/id=(\S+)/g)].map((m) => m[1]);
    const reverify = /(changed|still correct|still true|since|update|shipped|new )/i.test(msg);
    const search = reverify || /\?|latest|price|pricing|news|current|today|best/i.test(msg);
    const lines = brief.split("\n").filter((l) => l.startsWith("- "));
    const related = lines.filter((l) => (l.match(/"([^"]+)"/)?.[1] ?? "").toLowerCase().split(/\W+/).some((w) => w.length >= 5 && msg.toLowerCase().includes(w)));
    const entities = [...new Set((related.length ? related : lines).flatMap((l) => (l.match(/topics: (.+)$/)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "n/a")))];
    const queries = !search ? [] : reverify && entities.length
      ? entities.slice(0, 6).map((e) => ({ query: `${e} pricing changes 2026`, recency: "month", news: false }))
      : [{ query: msg.slice(0, 120), recency: "any", news: false }];
    const pastCue = /(earlier|before|last time|previously|we discussed|you told|remember)/i.test(msg);
    return { route: search ? "search" : "direct", reverify, memory_conv_ids: pastCue ? cands.slice(0, 2) : [], queries };
  }

  private meta(messages: ChatMessage[]) {
    const body = text(messages.at(-1));
    const users = [...body.matchAll(/^USER: (.+)$/gm)].map((m) => m[1]);
    const caps = [...body.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\b/g)].map((m) => m[1]).filter((w) => !STOP_CAPS.has(w));
    const topics = [...new Set(caps)].slice(0, 10);
    return {
      title: (users[0] ?? "Conversation").slice(0, 50),
      summary: `User asked: ${users.join(" / ").slice(0, 300)}`,
      topics,
    };
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const all = req.messages.map(text).join("\n");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const memHeads = [...all.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    const srcTitles = [...all.matchAll(/^\[(\d+)\] (.+?) — (https?:\S+)/gm)].map((m) => `[${m[2]}](${m[3]})`);
    const parts = [`[mock answer] You said: "${text(lastUser).slice(0, 120)}".`];
    if (memHeads.length) parts.push(`Memory used: ${memHeads.join(" | ")}.`);
    if (srcTitles.length) parts.push(`Sources: ${srcTitles.slice(0, 4).join(", ")}.`);
    for (const w of parts.join(" ").split(/(?<= )/)) {
      if (req.signal?.aborted) return;
      yield { type: "text", delta: w };
      await sleep(2);
    }
  }
}

export function createMockLLM(): LLMPair {
  return { fast: new MockLLM("mock-fast"), strong: new MockLLM("mock-strong") };
}
