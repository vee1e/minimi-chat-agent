import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { MockSearchProvider } from "./mock.js";
import { BraveProvider, ExaProvider, TavilyProvider } from "./providers.js";
import type { SearchProvider } from "./types.js";
import { WebSearch } from "./web-search.js";

function make(name: string, cfg: Config): SearchProvider | null {
  if (name === "tavily" && cfg.search.tavilyKey) return new TavilyProvider(cfg.search.tavilyKey);
  if (name === "brave" && cfg.search.braveKey) return new BraveProvider(cfg.search.braveKey);
  if (name === "exa" && cfg.search.exaKey) return new ExaProvider(cfg.search.exaKey);
  return null;
}

export function createWebSearch(cfg: Config, store: MemoryStore, clock: () => Date, override?: SearchProvider): WebSearch {
  if (override) return new WebSearch(store, override, null, cfg.search.cacheTtlSec, clock);
  if (cfg.mock) return new WebSearch(store, new MockSearchProvider(), null, cfg.search.cacheTtlSec, clock);
  const primary = make(cfg.search.primary, cfg);
  if (!primary) throw new Error(`Search provider "${cfg.search.primary}" is not configured (missing API key).`);
  const fb = cfg.search.fallback && cfg.search.fallback !== cfg.search.primary ? make(cfg.search.fallback, cfg) : null;
  return new WebSearch(store, primary, fb, cfg.search.cacheTtlSec, clock);
}
