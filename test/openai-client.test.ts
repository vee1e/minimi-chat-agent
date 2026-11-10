import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { OpenAICompatClient } from "../src/llm/openai.js";
import { parseJsonLoose } from "../src/llm/types.js";

/** Fake OpenAI-compatible server: lets us test SSE parsing + tool-call assembly without a real key. */
function fake(handler: (body: any) => string[] | { status: number; body: string }) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const body = JSON.parse(raw); seen.push({ body, auth: req.headers.authorization });
      const out = handler(body);
      if (!Array.isArray(out)) { res.writeHead(out.status); return res.end(out.body); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // deliberately split the payload at awkward byte boundaries
      const all = out.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
      for (let i = 0; i < all.length; i += 17) res.write(all.slice(i, i + 17));
      res.end();
    });
  }).listen(0);
  return { srv, seen, url: `http://127.0.0.1:${(srv.address() as any).port}` };
}
const chunk = (delta: any) => JSON.stringify({ choices: [{ delta }] });

describe("OpenAICompatClient", () => {
  it("streams text deltas and sends bearer auth + tools", async () => {
    const f = fake(() => [chunk({ content: "Hel" }), chunk({ content: "lo" })]);
    const c = new OpenAICompatClient(f.url, "k123", "m");
    let text = "";
    for await (const e of c.stream({ task: "answer", messages: [{ role: "user", content: "hi" }], tools: [{ name: "web_search", description: "d", parameters: { type: "object" } }] }))
      if (e.type === "text") text += e.delta;
    f.srv.close();
    expect(text).toBe("Hello");
    expect(f.seen[0].auth).toBe("Bearer k123");
    expect(f.seen[0].body.tools[0].function.name).toBe("web_search");
    expect(f.seen[0].body.stream).toBe(true);
  });
  it("assembles tool calls whose arguments arrive in fragments, across parallel indexes", async () => {
    const f = fake(() => [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"que' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "c2", function: { name: "web_search", arguments: '{"query":"b"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"a"}' } }] }),
    ]);
    const c = new OpenAICompatClient(f.url, "k", "m");
    const calls: any[] = [];
    for await (const e of c.stream({ task: "answer", messages: [] })) if (e.type === "tool_calls") calls.push(...e.calls);
    f.srv.close();
    expect(calls.map((x) => [x.id, JSON.parse(x.arguments).query])).toEqual([["c1", "a"], ["c2", "b"]]);
  });
  it("complete(): retries without response_format when the provider rejects it", async () => {
    let n = 0;
    const f = fake((b) => (n++ === 0 && b.response_format ? { status: 400, body: "unsupported" } : { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) }));
    const c = new OpenAICompatClient(f.url, "k", "m");
    const out = await c.complete({ task: "route", json: true, messages: [{ role: "user", content: "x" }] });
    f.srv.close();
    expect(parseJsonLoose(out)).toEqual({ ok: true });
    expect(f.seen).toHaveLength(2);
    expect(f.seen[1].body.response_format).toBeUndefined();
  });
  it("surfaces HTTP errors", async () => {
    const f = fake(() => ({ status: 401, body: "bad key" }));
    const c = new OpenAICompatClient(f.url, "k", "m");
    await expect(c.complete({ task: "meta", messages: [] })).rejects.toThrow(/401/);
    f.srv.close();
  });
  it("parseJsonLoose tolerates fences and chatter", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(parseJsonLoose("nope")).toBeNull();
  });
});
