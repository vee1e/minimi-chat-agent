import type { LLMClient } from "../llm/types.js";
import { parseJsonLoose } from "../llm/types.js";
import type { Recency, SearchQuery } from "../search/types.js";
import { ROUTER_SYSTEM, routerUser } from "./prompts.js";

export interface RouteDecision {
  route: "search" | "direct";
  reverify: boolean;
  memoryConvIds: string[];
  queries: SearchQuery[];
  source: "fast-path" | "llm" | "fallback";
}

const SMALLTALK = /^\s*(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|great|nice|bye|good (morning|afternoon|evening|night))\b[\s!.,?]*$/i;
const RECENCIES = new Set(["any", "day", "week", "month", "year"]);

export async function route(
  fast: LLMClient,
  input: { now: string; message: string; history: string; dateMemoryBrief: string; candidates: string },
): Promise<RouteDecision> {
  // Fast path: pure small talk skips the router LLM call entirely (zero added latency).
  if (SMALLTALK.test(input.message)) return { route: "direct", reverify: false, memoryConvIds: [], queries: [], source: "fast-path" };
  try {
    const raw = await fast.complete({
      task: "route", json: true,
      messages: [{ role: "system", content: ROUTER_SYSTEM }, { role: "user", content: routerUser(input) }],
    });
    const j = parseJsonLoose<any>(raw);
    if (!j) throw new Error("router returned non-JSON");
    const queries: SearchQuery[] = (Array.isArray(j.queries) ? j.queries : [])
      .filter((q: any) => q && typeof q.query === "string" && q.query.trim())
      .slice(0, 6)
      .map((q: any) => ({
        query: String(q.query).trim().slice(0, 200),
        recency: (RECENCIES.has(q.recency) ? q.recency : "any") as Recency,
        news: q.news === true,
      }));
    const routeName = j.route === "direct" ? "direct" : "search";
    return {
      route: routeName,
      reverify: j.reverify === true,
      memoryConvIds: Array.isArray(j.memory_conv_ids) ? j.memory_conv_ids.map(String).slice(0, 3) : [],
      // If the router wants search but gave no queries, search the raw message.
      queries: routeName === "search" ? (queries.length ? queries : [{ query: input.message.slice(0, 200) }]) : [],
      source: "llm",
    };
  } catch {
    // Router failure must never break the chat: fall back to "search the message" (safe, just slower).
    return { route: "search", reverify: false, memoryConvIds: [], queries: [{ query: input.message.slice(0, 200) }], source: "fallback" };
  }
}
