import type { SearchProvider, SearchQuery, SearchResult } from "./types.js";

/** Deterministic fake search for tests/offline demos. Never touches the network. */
export class MockSearchProvider implements SearchProvider {
  readonly name = "mock";
  calls: string[] = [];
  async search(q: SearchQuery): Promise<SearchResult[]> {
    this.calls.push(q.query);
    const slug = q.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    return [
      { title: `Official pricing page — ${q.query}`, url: `https://example.com/${slug}/pricing`,
        snippet: `[mock] Pricing details for "${q.query}".`, published: "2026-11-05" },
      { title: `Release notes — ${q.query}`, url: `https://example.com/${slug}/changelog`,
        snippet: `[mock] Latest changes for "${q.query}".`, published: "2026-11-08" },
    ];
  }
}
