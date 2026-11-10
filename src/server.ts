import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createApp, type App } from "./app.js";
import { loadConfig, missingKeys } from "./config.js";
import { seedIfEmpty } from "./seed.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export function createHttpServer(app: App) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/health")
        return send(res, 200, { ok: true, mock: app.cfg.mock, tz: app.cfg.tz, now: app.clock().toISOString(), models: { strong: app.cfg.llm.model, fast: app.cfg.llmFast.model }, search: app.cfg.search.primary });

      if (req.method === "GET" && url.pathname === "/api/conversations")
        return send(res, 200, app.store.listConversations().map((c) => ({ id: c.id, title: c.title || "New chat", date: c.local_date, messages: c.n_messages })));

      const m = url.pathname.match(/^\/api\/conversations\/([\w-]+)$/);
      if (req.method === "GET" && m)
        return send(res, 200, app.store.messages(m[1]).map((x) => ({ role: x.role, content: x.content, ts: x.ts, sources: x.sources })));

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readBody(req);
        if (!body.message || typeof body.message !== "string") return send(res, 400, { error: "message required" });
        const stream = url.searchParams.get("stream") !== "0";
        const abort = new AbortController();
        res.on("close", () => { if (!res.writableEnded) abort.abort(); });

        if (!stream) {
          try {
            const r = await app.agent.run({ conversationId: body.conversationId, message: body.message }, () => {}, abort.signal);
            void app.agent.updateMemoryMeta(r.conversationId);
            return send(res, 200, r);
          } catch (e) { return send(res, 500, { error: (e as Error).message }); }
        }

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        const emit = (e: { type: string }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        try {
          const r = await app.agent.run({ conversationId: body.conversationId, message: body.message }, emit, abort.signal);
          res.end();
          void app.agent.updateMemoryMeta(r.conversationId); // after the response is complete
        } catch { res.end(); }
        return;
      }

      // static UI
      if (req.method === "GET") {
        const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        if (file.includes("..")) return send(res, 400, { error: "bad path" });
        try {
          const data = await readFile(join(PUBLIC, file));
          res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".css") ? "text/css" : "application/javascript" });
          return res.end(data);
        } catch { /* fallthrough */ }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
}

// Entry point (npm run dev)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const missing = missingKeys(loadConfig());
  if (missing.length) {
    console.error(`\n  Missing configuration: ${missing.join(", ")}\n  Copy .env.example to .env and fill them in (or set MOCK_PROVIDERS=1 to try the app with fake providers).\n`);
    process.exit(1);
  }
  const app = createApp();
  const seeded = process.env.SEED_DEMO === "0" ? 0 : seedIfEmpty(app);
  if (seeded) console.log(`Seeded ${seeded} demo messages from earlier days (see src/seed.ts). Set SEED_DEMO=0 to skip.`);
  createHttpServer(app).listen(app.cfg.port, () =>
    console.log(`minimi chat agent on http://localhost:${app.cfg.port}  (${app.cfg.mock ? "MOCK providers" : `${app.cfg.llm.model} + ${app.cfg.search.primary}`}, tz ${app.cfg.tz})`));
}
