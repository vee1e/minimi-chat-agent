# minimi chat agent

A web-search chat agent (one tool: `web_search`) that **remembers past conversations by date** and re-verifies old answers ("What did I ask on 3 November — is it still correct?").

```bash
cp .env.example .env     # set LLM_API_KEY and TAVILY_API_KEY (any OpenAI-compatible LLM works)
npm install
npm run dev              # http://localhost:3000
```

- First start seeds demo conversations on earlier days so the example prompts work immediately (`SEED_DEMO=0` to disable).
- `npm test` — offline unit/integration tests (date resolution, memory recall, agent pipeline, SSE server, OpenAI client).
- `MOCK_PROVIDERS=1 npm run dev` — run with fake LLM + search (no keys).
- `npm run chat` — CLI instead of the web UI.

Read [`DESIGN.md`](DESIGN.md) for the architecture and [`NOTES.md`](NOTES.md) for study notes and interview Q&A.

| Env var | Purpose |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Strong model (answers). Any OpenAI-compatible endpoint. |
| `LLM_FAST_MODEL`, `LLM_FAST_BASE_URL`, `LLM_FAST_API_KEY` | Small model (routing, summaries). Defaults to the strong model's endpoint/key. |
| `SEARCH_PROVIDER`, `TAVILY_API_KEY` | Primary search (`tavily` \| `brave` \| `exa`). |
| `SEARCH_FALLBACK_PROVIDER`, `BRAVE_API_KEY`, `EXA_API_KEY` | Optional fallback provider. |
| `USER_TZ`, `DB_PATH`, `PORT`, `SEARCH_CACHE_TTL`, `SEED_DEMO`, `MOCK_PROVIDERS`, `NOW_OVERRIDE` | App settings (see `.env.example`). |
