import type { ChatMessage, CompleteRequest, LLMClient, StreamEvent, StreamRequest, ToolCall, ToolSpec } from "./types.js";

/** Minimal OpenAI-compatible Chat Completions client (works with OpenAI, OpenRouter, Groq, DeepSeek, vLLM...). */
export class OpenAICompatClient implements LLMClient {
  constructor(private baseUrl: string, private apiKey: string, readonly model: string, private extraBody: Record<string, unknown> = {}) {}

  private headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  private wireMessages(ms: ChatMessage[]) {
    return ms.map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length)
        return {
          role: "assistant", content: m.content,
          tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        };
      return m;
    });
  }
  private wireTools(tools: ToolSpec[]) {
    return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  async complete(req: CompleteRequest): Promise<string> {
    const body: Record<string, unknown> = { ...this.extraBody, model: this.model, messages: this.wireMessages(req.messages), stream: false };
    if (req.json) body.response_format = { type: "json_object" };
    let res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok && req.json && res.status === 400) {
      // Some providers reject response_format; retry without it (we parse JSON loosely anyway).
      delete body.response_format;
      res = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    }
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = { ...this.extraBody, model: this.model, messages: this.wireMessages(req.messages), stream: true };
    if (req.tools?.length) { body.tools = this.wireTools(req.tools); body.tool_choice = "auto"; }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal,
    });
    if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const calls: ToolCall[] = [];
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: "text", delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: "", name: "", arguments: "" };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        }
      }
    }
    const done = calls.filter((c) => c && c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    if (done.length) yield { type: "tool_calls", calls: done };
  }
}
