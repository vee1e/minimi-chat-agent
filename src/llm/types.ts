export interface ToolCall { id: string; name: string; arguments: string; }
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown>; }

/** What the call is for. Real providers ignore it; the mock uses it to behave deterministically. */
export type Task = "route" | "meta" | "answer";

export interface CompleteRequest { task: Task; messages: ChatMessage[]; json?: boolean; }
export interface StreamRequest { task: Task; messages: ChatMessage[]; tools?: ToolSpec[]; signal?: AbortSignal; }

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export interface LLMClient {
  readonly model: string;
  complete(req: CompleteRequest): Promise<string>;
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
}

export interface LLMPair { fast: LLMClient; strong: LLMClient; }

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
export function parseJsonLoose<T = unknown>(raw: string): T | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) as T; } catch { /* ignore */ } }
  return null;
}
