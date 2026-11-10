import { createHash } from "node:crypto";
import type { MemoryStore } from "../memory/store.js";
import type { SearchProvider, SearchQuery, SearchResult } from "./types.js";

export interface SearchOutcome { query: string; results: SearchResult[]; provider: string; cached: boolean; ms: number; error?: string; }

/**
 * The single capability the agent has: web_search.
 * Wraps a primary provider (+ optional fallback) with a SQLite result cache and parallel fan-out.
 */
export class WebSearch {
  constructor(
    private store: MemoryStore,
    private primary: SearchProvider,
    private fallback: SearchProvider | null,
    private ttlSec: number,
    private clock: () => Date = () => new Date(),
  ) {}

  private key(q: SearchQuery) {
    const norm = JSON.stringify([q.query.trim().toLowerCase().replace(/\s+/g, " "), q.recency ?? "any", !!q.news, q.maxResults ?? 6]);
    return createHash("sha1").update(norm).digest("hex");
  }

  /** Time-sensitive queries get a short TTL so "latest"/news never goes stale. */
  private ttl(q: SearchQuery) {
    if (q.news || q.recency === "day") return Math.min(this.ttlSec, 600);
    if (q.recency === "week") return Math.min(this.ttlSec, 3600);
    return this.ttlSec;
  }

  async one(q: SearchQuery): Promise<SearchOutcome> {
    const t0 = Date.now();
    const key = this.key(q);
    const hit = this.store.cacheGet(key, this.clock().getTime());
    if (hit) {
      const parsed = JSON.parse(hit) as { provider: string; results: SearchResult[] };
      return { query: q.query, results: parsed.results, provider: parsed.provider, cached: true, ms: Date.now() - t0 };
    }
    const errors: string[] = [];
    for (const p of [this.primary, this.fallback]) {
      if (!p) continue;
      try {
        const results = await p.search(q);
        if (results.length) {
          this.store.cachePut(key, JSON.stringify({ provider: p.name, results }), this.clock().getTime(), this.ttl(q));
          return { query: q.query, results, provider: p.name, cached: false, ms: Date.now() - t0 };
        }
        errors.push(`${p.name}: no results`);
      } catch (e) {
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    return { query: q.query, results: [], provider: "none", cached: false, ms: Date.now() - t0, error: errors.join(" | ") };
  }

  /** Run many queries concurrently (order preserved, duplicates collapsed). */
  async many(qs: SearchQuery[], max = 6): Promise<SearchOutcome[]> {
    const seen = new Set<string>();
    const uniq = qs.filter((q) => {
      const k = this.key(q);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, max);
    return Promise.all(uniq.map((q) => this.one(q)));
  }
}
