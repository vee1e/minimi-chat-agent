import { existsSync } from "node:fs";

// Load .env if present (Node >= 20.12 built-in; no dotenv dependency).
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* ignore malformed .env; env vars may come from the shell */
  }
}

const e = (k: string, d = "") => (process.env[k] ?? "").trim() || d;

function json(k: string): Record<string, unknown> {
  const v = e(k);
  if (!v) return {};
  try { return JSON.parse(v); } catch { console.warn(`${k} is not valid JSON; ignoring`); return {}; }
}

export interface Config {
  port: number;
  tz: string;
  dbPath: string;
  mock: boolean;
  nowOverride?: string;
  llm: { baseUrl: string; apiKey: string; model: string; extraBody: Record<string, unknown> };
  llmFast: { baseUrl: string; apiKey: string; model: string; extraBody: Record<string, unknown> };
  search: {
    primary: string;
    fallback: string;
    tavilyKey: string;
    braveKey: string;
    exaKey: string;
    cacheTtlSec: number;
  };
  limits: { maxParallelSearches: number; maxToolRounds: number; historyMessages: number };
}

export function loadConfig(): Config {
  const model = e("LLM_MODEL", "gpt-4.1");
  const baseUrl = e("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = e("LLM_API_KEY");
  return {
    port: Number(e("PORT", "3000")),
    tz: e("USER_TZ", "Asia/Kolkata"),
    dbPath: e("DB_PATH", "./data/minimi.db"),
    mock: ["1", "true", "yes"].includes(e("MOCK_PROVIDERS").toLowerCase()),
    nowOverride: e("NOW_OVERRIDE") || undefined,
    llm: { baseUrl, apiKey, model, extraBody: json("LLM_EXTRA_BODY") },
    llmFast: {
      baseUrl: e("LLM_FAST_BASE_URL", baseUrl).replace(/\/$/, ""),
      apiKey: e("LLM_FAST_API_KEY", apiKey),
      model: e("LLM_FAST_MODEL", model),
      extraBody: json("LLM_FAST_EXTRA_BODY"),
    },
    search: {
      primary: e("SEARCH_PROVIDER", "tavily").toLowerCase(),
      fallback: e("SEARCH_FALLBACK_PROVIDER", "").toLowerCase(),
      tavilyKey: e("TAVILY_API_KEY"),
      braveKey: e("BRAVE_API_KEY"),
      exaKey: e("EXA_API_KEY"),
      cacheTtlSec: Number(e("SEARCH_CACHE_TTL", "21600")),
    },
    limits: { maxParallelSearches: 6, maxToolRounds: 1, historyMessages: 10 },
  };
}

/** The clock. Everything that needs "now" goes through here so tests/demos can pin it. */
export function makeClock(cfg: Pick<Config, "nowOverride">): () => Date {
  if (cfg.nowOverride) {
    const fixed = new Date(cfg.nowOverride);
    if (!Number.isNaN(fixed.getTime())) return () => fixed;
  }
  return () => new Date();
}

export function missingKeys(cfg: Config): string[] {
  if (cfg.mock) return [];
  const m: string[] = [];
  if (!cfg.llm.apiKey) m.push("LLM_API_KEY");
  const need = (p: string) =>
    p === "tavily" ? (cfg.search.tavilyKey ? null : "TAVILY_API_KEY")
    : p === "brave" ? (cfg.search.braveKey ? null : "BRAVE_API_KEY")
    : p === "exa" ? (cfg.search.exaKey ? null : "EXA_API_KEY")
    : `SEARCH_PROVIDER=${p} (unknown)`;
  const p = need(cfg.search.primary);
  if (p) m.push(p);
  return m;
}
