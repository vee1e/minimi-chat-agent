# DESIGN — minimi chat agent

**Goal:** a chat agent with exactly one tool (web search) that answers fast, gets things right, is good to talk to — and remembers past conversations *by date*, so "Last Tuesday I asked about Postgres hosting — has pricing changed?" works.

## How it works (one turn)

```
user msg ─► 1 MEMORY PRE-STEP (code) ─► 2 ROUTER (small model) ─► 3 PARALLEL SEARCH ─► 4 ANSWER (strong model, streamed) ─► 5 SAVE
            dates → days, read turns      search? which queries?    ≤6 queries at once,    only tool: web_search           turn + fast-model
            from SQLite, FTS candidates   which memories matter?    SQLite-cached          (≤2 follow-up rounds)           summary/topics
```

1. **Memory pre-step.** `memory/dates.ts` resolves "on Monday", "last Tuesday", "3 November", "2 days ago", "last week" to calendar days in the user's timezone, deterministically. We load every message stored on those days (each row has a UTC timestamp and a local-date column) and render them under dated headers. A named day with no conversations is stated explicitly, so the model can't invent one. BM25 (SQLite FTS5) over summaries/topics/messages proposes candidates for undated references ("what did we decide about X?").
2. **Router.** A small model returns JSON: search vs. direct, "is this a re-verification?", which candidate memories to include, and ≤6 self-contained queries. Small talk skips even this call; a router failure falls back to searching the raw message (slower, never broken).
3. **Parallel search.** Queries run concurrently through one `WebSearch` service: Tavily primary, Brave/Exa fallback, SQLite cache (10-minute TTL for news/"today" queries, so freshness isn't traded away).
4. **Answer.** The strong model streams (SSE) with the dated system prompt, MEMORY block, search results (URL + published date or "date not shown") and recent history. It may call `web_search` again. Rules: answer first, inline links with source dates, "no change found in sources checked" ≠ "nothing changed", and **Then → Now → verdict** per item when re-verifying.
5. **Save.** Turn stored with its sources; the fast model refreshes title, summary (concrete claims/prices) and entity topics *after* the response — that's what makes next week's "has it changed?" answerable.

## Why this shape

- **Memory is not a tool.** The brief says one tool. A second LLM-callable tool would break that and add a round trip. "Last Tuesday" is also deterministic — models slip on weekday arithmetic, code doesn't — so the agent does recall itself and the model only sees the right day's transcripts.
- **Speculative parallel search** removes the serial think → tool → wait → think loop in the common case; the model can still search again if results are thin.
- **Two models:** routing/summaries are cheap extraction (small model, JSON); only the user-visible answer needs the strong one. Both are env vars; the fast one may sit on another provider (e.g. Groq).
- **Re-verification is a first-class mode** (router flag → one query per remembered entity → forced then-vs-now format), not a prompt accident.
- **`node:sqlite` + FTS5, `fetch` + OpenAI-compatible API:** zero native builds and zero runtime dependencies, so `npm install && npm run dev` just works with OpenAI, OpenRouter, Groq, DeepSeek, vLLM…

## Considered and rejected

- **`recall_memory` tool** — breaks one-tool rule, slower, model can mis-date. · **LLM date resolution** — unreliable, untestable.
- **Vector DB** — needs an embedding service; access is by date then keyword, which FTS5 covers offline. · **Pure agent loop** — serial round-trips dominate latency.
- **Page scraping/reader step** — slow and flaky; dated snippets + a follow-up search cover most questions. · **LangChain/AI SDK** — more to explain, less control over the pipeline.

## With another week

1. **Evals:** replayable dated-memory and "changed since?" cases with a judge; track false "no change" rate per commit.
2. **Pricing-page fetch inside `web_search`** (still one tool) to read exact prices, with per-claim dating.
3. **Structured claim memory** (entity, attribute, value, date) so re-verification diffs facts; embeddings as a second retriever for undated references.
4. **Latency:** start searches while the router JSON streams; race two providers.
5. **Production:** auth + per-user memory, rate limits, prompt-injection filtering of snippets, traces.
