export type Recency = "any" | "day" | "week" | "month" | "year";

export interface SearchQuery { query: string; recency?: Recency; news?: boolean; maxResults?: number; }
export interface SearchResult { title: string; url: string; snippet: string; published?: string; }

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery): Promise<SearchResult[]>;
}

export const RECENCY_DAYS: Record<Recency, number | undefined> = { any: undefined, day: 1, week: 7, month: 30, year: 365 };
