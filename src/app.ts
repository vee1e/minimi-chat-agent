import { Agent } from "./agent/agent.js";
import { loadConfig, makeClock, type Config } from "./config.js";
import { createLLM } from "./llm/index.js";
import type { LLMPair } from "./llm/types.js";
import { MemoryStore } from "./memory/store.js";
import { createWebSearch } from "./search/index.js";
import type { SearchProvider } from "./search/types.js";

export interface App { cfg: Config; store: MemoryStore; agent: Agent; clock: () => Date; }

/** Composition root. Tests inject fake LLM / search / clock through `overrides`. */
export function createApp(overrides: { cfg?: Partial<Config>; llm?: LLMPair; searchProvider?: SearchProvider; clock?: () => Date } = {}): App {
  const cfg = { ...loadConfig(), ...overrides.cfg } as Config;
  const clock = overrides.clock ?? makeClock(cfg);
  const store = new MemoryStore(cfg.dbPath, cfg.tz);
  const llm = overrides.llm ?? createLLM(cfg);
  const search = createWebSearch(cfg, store, clock, overrides.searchProvider);
  return { cfg, store, clock, agent: new Agent({ cfg, store, llm, search, clock }) };
}
