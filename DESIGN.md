# DESIGN — minimi chat agent

**Goal:** a chat agent with exactly one tool (web search) that answers fast, gets things right, is pleasant to talk to — and remembers past conversations *by date*, so "Last Tuesday I asked about Postgres hosting — has pricing changed?" works.

## How it works (one turn)

```
user msg ─► 1 MEMORY PRE-STEP (code, ~1 ms) ─► 2 ROUTER (small model) ─► 3 PARALLEL SEARCH ─► 4 ANSWER (strong model, streamed)
            resolve dates in code              search or not?            N queries at once,     web_search is its only tool;
            read that day's turns from SQLite  which queries?            SQLite-cached          may call it again (max 2 rounds)
            keyword recall candidates          which memories matter?                           ─► 5 save turn; fast model refreshes
                                                                                                    title/summary/topics (off critical path)
```

1. **Memory pre-step.** `memory/dates.ts` turns "on Monday", "last Tuesday", "3 November", "2 days ago", "last week" into concrete calendar days in the user's timezone, deterministically, against the current date. We fetch every message stored on those days (SQLite, each message carries a UTC timestamp and a local-date column) and render them with dated headers. If the user names a day with no conversations, the prompt says so explicitly, so the model cannot invent one. BM25 (FTS5) over conversation summaries/topics/messages supplies *candidates* for references without dates ("what did we decide about X earlier?").
2. **Router.** A small fast model gets the message, short history, a brief of the date-recalled memory and the keyword candidates, and returns JSON: search vs. direct, "is this a re-verification?", which candidate memories to include, and up to 6 self-contained search queries. Pure small talk skips even this call. If the router fails or returns junk we fall back to searching the raw message — slower, never broken.
3. **Parallel search.** Planned queries run concurrently through one `WebSearch` service (Tavily primary, Brave/Exa fallback, results cached in SQLite; news/"today" queries use a 10-minute TTL so freshness is never traded away).
4. **Answer.** The strong model streams tokens (SSE) with: date-stamped system prompt, MEMORY block, prefetched results (each with URL and published date or "date not shown"), recent history. Its only tool is `web_search` for follow-up searching. Prompt rules: lead with the answer, cite inline with links and source dates, separate "no change found in sources checked" from "nothing changed", and for re-verification present **Then → Now → verdict** per item.
5. **After the answer:** the exchange is saved with sources; the fast model refreshes the conversation's title, summary (concrete claims/prices) and topics (entities). That is what makes tomorrow's "has any of them changed?" searchable.

## Why this shape

- **Memory is not a tool.** The brief says one tool: web search. Making memory a second LLM-callable tool would break that and cost an extra model round-trip. "Last Tuesday" is also a *deterministic* question — models are unreliable at weekday arithmetic, code isn't — so recall is a pre-step the agent performs itself, and the model only ever sees the correct day's transcripts.
- **Speculative parallel search** removes the serial "think → call tool → wait → think" loop for the common case: the router plans queries up-front and they run concurrently with nothing else to wait on. The answering model can still search again if the results are thin.
- **Two models.** Routing, summaries and topic extraction are cheap classification/extraction tasks (small model, JSON); only the user-visible answer needs the strong model. Both are plain env vars, and the fast model can live on a different provider (e.g. Groq).
- **Re-verification is a first-class mode**, not a prompt accident: the router flags it, queries are built per remembered entity, and the answer format forces a then-vs-now comparison with dates.
- **SQLite via `node:sqlite`** (built into Node ≥ 22.5): zero native builds, so `npm install && npm run dev` just works; FTS5 gives BM25 recall without a vector DB.
- **OpenAI-compatible HTTP, no SDKs.** One `fetch` client works with OpenAI, OpenRouter, Groq, DeepSeek, vLLM. There are zero runtime dependencies (`tsx` only runs the TypeScript in dev).

## Considered and rejected

| Option | Why not |
|---|---|
| `recall_memory` as a second tool | Breaks the one-tool rule; adds a model round-trip; lets the model get the date wrong. |
| LLM resolves "last Tuesday" | Weekday arithmetic is exactly where models slip. Code is exact and unit-tested. |
| Vector DB / embeddings for memory | Needs an embedding key + service; the dominant access pattern is by *date*, then keyword. FTS5 is enough and offline. |
| Agent loop only (model decides every search) | Serial round-trips dominate latency; speculative prefetch + optional follow-ups gets both. |
| Full-page scraping/reader step | Slow and flaky; search snippets with dates + a second search round cover most questions. |
| Frameworks (LangChain, AI SDK) | More surface to explain, less control over the pipeline; ~100 lines of client code replace them. |

## What I'd do with another week

1. **Evals:** a replayable set of dated-memory and "changed since?" cases with a judge model, tracked per commit (precision of "no change" claims especially).
2. **Page fetch for pricing pages** (one extra fetch tool *inside* `web_search`, so still one tool) to read exact prices instead of snippets; per-claim source dating.
3. **Smarter memory:** persist the *claims* the assistant made (entity, attribute, value, date) so re-verification diffs structured facts; embeddings as a second retriever for undated references.
4. **Latency:** stream the router's queries into search before its JSON finishes, cache by query intent, and race two search providers.
5. **Production concerns:** auth + per-user memory, rate limiting, prompt-injection filtering of search snippets, trace/log UI.
