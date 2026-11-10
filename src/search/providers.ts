import { RECENCY_DAYS, type SearchProvider, type SearchQuery, type SearchResult } from "./types.js";

const clip = (s: string | undefined, n = 900) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function json(res: Response, who: string): Promise<any> {
  if (!res.ok) throw new Error(`${who} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(private key: string) {}
  async search(q: SearchQuery): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: q.query, search_depth: "basic", max_results: q.maxResults ?? 6,
      topic: q.news ? "news" : "general", include_answer: false,
    };
    const days = RECENCY_DAYS[q.recency ?? "any"];
    if (days) body.time_range = days <= 1 ? "day" : days <= 7 ? "week" : days <= 30 ? "month" : "year";
    const j = await json(await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    }), "tavily");
    return (j.results ?? []).map((r: any) => ({
      title: clip(r.title, 160), url: r.url, snippet: clip(r.content), published: r.published_date || undefined,
    }));
  }
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  constructor(private key: string) {}
  async search(q: SearchQuery): Promise<SearchResult[]> {
    const days = RECENCY_DAYS[q.recency ?? "any"];
    const p = new URLSearchParams({ q: q.query, count: String(q.maxResults ?? 6) });
    if (days) p.set("freshness", days <= 1 ? "pd" : days <= 7 ? "pw" : days <= 30 ? "pm" : "py");
    const path = q.news ? "news/search" : "web/search";
    const j = await json(await fetch(`https://api.search.brave.com/res/v1/${path}?${p}`, {
      headers: { accept: "application/json", "x-subscription-token": this.key }, signal: AbortSignal.timeout(15000),
    }), "brave");
    const rows = q.news ? j.results : j.web?.results;
    return (rows ?? []).map((r: any) => ({
      title: clip(r.title, 160), url: r.url, snippet: clip(r.description),
      published: r.page_age || r.age || undefined,
    }));
  }
}

export class ExaProvider implements SearchProvider {
  readonly name = "exa";
  constructor(private key: string) {}
  async search(q: SearchQuery): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: q.query, numResults: q.maxResults ?? 6, type: "auto",
      contents: { text: { maxCharacters: 900 } },
    };
    if (q.news) body.category = "news";
    const days = RECENCY_DAYS[q.recency ?? "any"];
    if (days) body.startPublishedDate = new Date(Date.now() - days * 86_400_000).toISOString();
    const j = await json(await fetch("https://api.exa.ai/search", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": this.key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    }), "exa");
    return (j.results ?? []).map((r: any) => ({
      title: clip(r.title, 160), url: r.url, snippet: clip(r.text), published: r.publishedDate || undefined,
    }));
  }
}
