# Study notes — know this cold

## The 60-second pitch
"It's a pipeline, not just a loop. Before the LLM sees anything, **code** resolves dates ('last Tuesday' → 3 Nov) and pulls that day's conversation from SQLite. A **small model** decides whether to search and plans up to 6 queries, which run **in parallel**. A **strong model** then streams the answer with citations and source dates. The only tool the model can call is `web_search` — memory is deliberately *not* a tool."

## Map of the code
| File | Job |
|---|---|
| `src/memory/dates.ts` | Pure function `resolveDates(text, now, tz)` → calendar days. No LLM. Most-tested file. |
| `src/memory/store.ts` | SQLite (`node:sqlite`): conversations, messages (UTC ts + local date), FTS5 indexes, search cache. |
| `src/memory/recall.ts` | Turns day-hits into a dated MEMORY block; says "NO stored conversations" for empty days. |
| `src/agent/router.ts` | Fast-model JSON router + safe fallbacks. |
| `src/agent/agent.ts` | The turn: memory → router → parallel search → streamed answer (+tool loop) → save → update index. |
| `src/agent/prompts.ts` | All prompts + the single `web_search` tool schema. |
| `src/search/*` | Tavily/Brave/Exa providers, cache + fallback + parallel fan-out (`web-search.ts`), mock. |
| `src/llm/*` | OpenAI-compatible client (streaming + tool-call assembly), mock. |
| `src/server.ts`, `public/index.html` | HTTP + SSE streaming, vanilla-JS chat UI. |
| `src/seed.ts` | Demo conversations on past days (CRM on Monday, Postgres + Node on 3 Nov, …). |

## Decisions in plain language
- **Why a pre-step instead of a memory tool?** One-tool rule, one fewer model round-trip, and date maths done by code is exact.
- **Why store a local-date column?** "Monday" means Monday *for the user*. A message at 00:30 IST is still the previous day in UTC; bucketing by the user's timezone avoids off-by-one days. (There's a test for exactly this.)
- **"Last Tuesday" on a Tuesday?** Convention: most recent such weekday strictly *before* today → 3 Nov. "On Monday" said on Tuesday → 9 Nov.
- **What if two conversations happened that day?** Both are injected; the router/answer only uses the relevant one ("3 November" returns Postgres *and* Node).
- **What if nothing happened that day?** Prompt says "NO stored conversations on this day" → the model must say so rather than invent.
- **Why speculative search?** Saves a serial tool round-trip. The model can still call `web_search` itself (max 2 rounds) if results are thin.
- **How is it fast?** Streaming (first token as soon as the strong model starts), small-talk fast path (no router call), parallel searches, SQLite cache, small model for non-user-visible work, summaries updated after the response.
- **How is it correct?** Time-sensitive facts only from sources fetched this turn; inline links + source dates; "date not shown" is stated; "no change found" ≠ "nothing changed"; Then→Now→verdict format for re-verification; old answers are treated as *what was said*, never as current fact.
- **Failure handling:** router failure → search the raw message; search provider error → fallback provider; both fail → the model is told there were no results and says so; LLM error → SSE `error` event.
- **Why no framework / SDK?** Fewer moving parts to explain; the OpenAI wire format is simple and universal.

## Likely interview questions
1. **Why isn't memory a tool?** See above — also determinism and latency. Trade-off: the model can't decide to "dig deeper" into memory mid-answer; the router's `memory_conv_ids` + keyword candidates cover most cases. With more time I'd allow a second pre-step round.
2. **How do you handle "last Tuesday" ambiguity?** Documented convention, tested; the MEMORY header shows the resolved date in the answer's context so the user sees what was assumed ("Tuesday, 3 November").
3. **What stops hallucinated past conversations?** Empty-day marker + system rule + the model only sees real stored turns.
4. **How do you avoid stale answers being repeated as fact?** MEMORY is framed "may be out of date"; re-verification mode forces fresh queries per entity and a then-vs-now table.
5. **Where does latency go, and what did you do about it?** Router call (small model), search (parallel, cached), answer (streamed). First visible token ≈ router + search + model time-to-first-token. Per-turn timings are returned and shown in the UI.
6. **Prompt injection from web pages?** Snippets are untrusted data; the only tool is read-only search, so the blast radius is wrong text, not actions. Next step: instruct + filter snippets.
7. **Why SQLite FTS5 not embeddings?** Access is mostly by date then keyword; no extra service/key; BM25 is explainable. Embeddings would help undated fuzzy references — week-2 work.
8. **How would it scale to many users?** Add `user_id` to conversations, per-user DB or row filters, move cache to Redis, queue the post-turn summarisation.
9. **How do you test it without API keys?** `MOCK_PROVIDERS=1` swaps in deterministic fake LLM + search; tests pin the clock (Tue 10 Nov 2026 IST) and assert what the answering model *receives*. The OpenAI client is tested against a fake SSE server.
10. **What would you measure?** Time-to-first-token, total latency, % of "changed since" answers whose claims are backed by a cited source dated after the original answer, and false "no change" rate.

## Running it
`cp .env.example .env` → fill `LLM_API_KEY` + `TAVILY_API_KEY` → `npm install && npm run dev` → http://localhost:3000. First start seeds demo history; try the three example prompts (buttons above the input box). `npm test` runs everything offline. `MOCK_PROVIDERS=1 npm run dev` runs without keys.
