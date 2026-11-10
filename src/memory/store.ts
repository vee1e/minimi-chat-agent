import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { civilInTz, type Civil } from "./dates.js";

export type Role = "user" | "assistant";

export interface Source { n: number; title: string; url: string; published?: string; }
export interface MessageRow {
  id: number; conv_id: string; role: Role; content: string; ts: number; local_date: Civil; sources: Source[];
}
export interface ConversationRow {
  id: string; title: string; summary: string; topics: string[]; created_at: number; updated_at: number;
  summarized_upto: number;
}

// Loaded via require so bundlers/test runners that strip the "node:" prefix (vite) can't break the built-in module.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const STOP = new Set(("the a an and or of to in on for with is are was were be been it its this that these those i you we they " +
  "me my our your what which who how when where why do does did have has had can could should would will about from into than then " +
  "any all some there here as at by not no yes please tell ask asked told remember earlier before last since changed change them").split(" "));

/** Turn free text into a safe FTS5 OR-query of its content words (or null if nothing useful). */
export function ftsQuery(text: string, max = 8): string | null {
  const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const uniq = [...new Set(words)].slice(0, max);
  return uniq.length ? uniq.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ") : null;
}

export class MemoryStore {
  readonly db: DB;
  constructor(path: string, private tz: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
        topics TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        summarized_upto INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL, local_date TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(local_date);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(title, summary, topics, tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS search_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL, ttl INTEGER NOT NULL);
    `);
  }

  close() { this.db.close(); }

  // ---------- writes ----------
  ensureConversation(id: string, ts: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO conversations(id, created_at, updated_at) VALUES (?, ?, ?)`).run(id, ts, ts);
  }

  addMessage(convId: string, role: Role, content: string, ts: number, sources: Source[] = []): number {
    this.ensureConversation(convId, ts);
    const r = this.db.prepare(
      `INSERT INTO messages(conv_id, role, content, ts, local_date, sources) VALUES (?,?,?,?,?,?)`,
    ).run(convId, role, content, ts, civilInTz(new Date(ts), this.tz), JSON.stringify(sources));
    const id = Number(r.lastInsertRowid);
    this.db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`).run(id, content);
    this.db.prepare(`UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?`).run(ts, convId);
    return id;
  }

  setMeta(convId: string, meta: { title?: string; summary?: string; topics?: string[]; summarizedUpto?: number }): void {
    const cur = this.getConversation(convId);
    if (!cur) return;
    const title = meta.title ?? cur.title;
    const summary = meta.summary ?? cur.summary;
    const topics = meta.topics ?? cur.topics;
    this.db.prepare(`UPDATE conversations SET title=?, summary=?, topics=?, summarized_upto=? WHERE id=?`)
      .run(title, summary, JSON.stringify(topics), meta.summarizedUpto ?? cur.summarized_upto, convId);
    const rowid = (this.db.prepare(`SELECT rowid AS r FROM conversations WHERE id=?`).get(convId) as { r: number }).r;
    this.db.prepare(`DELETE FROM conv_fts WHERE rowid=?`).run(rowid);
    this.db.prepare(`INSERT INTO conv_fts(rowid, title, summary, topics) VALUES (?,?,?,?)`)
      .run(rowid, title, summary, topics.join(" "));
  }

  // ---------- reads ----------
  private toConv(r: any): ConversationRow {
    return { ...r, topics: JSON.parse(r.topics || "[]") };
  }
  private toMsg(r: any): MessageRow {
    return { ...r, sources: JSON.parse(r.sources || "[]") };
  }

  getConversation(id: string): ConversationRow | null {
    const r = this.db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id);
    return r ? this.toConv(r) : null;
  }

  listConversations(limit = 50): (ConversationRow & { local_date: Civil; n_messages: number })[] {
    const rows = this.db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id) AS n_messages FROM conversations c
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conv_id=c.id) ORDER BY c.updated_at DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map((r) => ({ ...this.toConv(r), n_messages: r.n_messages, local_date: civilInTz(new Date(r.updated_at), this.tz) }));
  }

  messages(convId: string): MessageRow[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id=? ORDER BY id`).all(convId) as any[]).map((r) => this.toMsg(r));
  }

  recentMessages(convId: string, n: number): MessageRow[] {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?`).all(convId, n) as any[];
    return rows.map((r) => this.toMsg(r)).reverse();
  }

  /** Every message on the given calendar days (user's timezone), grouped by conversation. */
  messagesOnDays(days: Civil[], excludeMessageIds: number[] = []): { conv: ConversationRow; date: Civil; messages: MessageRow[] }[] {
    if (!days.length) return [];
    const ph = days.map(() => "?").join(",");
    const rows = (this.db.prepare(
      `SELECT * FROM messages WHERE local_date IN (${ph}) ORDER BY ts, id`,
    ).all(...days) as any[]).map((r) => this.toMsg(r)).filter((m) => !excludeMessageIds.includes(m.id));
    const groups = new Map<string, { date: Civil; messages: MessageRow[] }>();
    for (const m of rows) {
      const k = `${m.conv_id}|${m.local_date}`;
      if (!groups.has(k)) groups.set(k, { date: m.local_date, messages: [] });
      groups.get(k)!.messages.push(m);
    }
    return [...groups.entries()].map(([k, g]) => ({ conv: this.getConversation(k.split("|")[0])!, ...g }));
  }

  /** Topic / keyword recall across all past conversations (BM25 over conversation meta + message text). */
  searchConversations(text: string, opts: { excludeConv?: string; limit?: number } = {}): { conv: ConversationRow; score: number }[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const scores = new Map<string, number>();
    const bump = (id: string, s: number) => scores.set(id, (scores.get(id) ?? 0) + s);
    const metaHits = this.db.prepare(
      `SELECT c.id AS id, bm25(conv_fts, 4.0, 2.0, 4.0) AS s FROM conv_fts JOIN conversations c ON c.rowid = conv_fts.rowid
       WHERE conv_fts MATCH ? ORDER BY s LIMIT 10`,
    ).all(q) as { id: string; s: number }[];
    for (const h of metaHits) bump(h.id, -h.s * 1.5);
    const msgHits = this.db.prepare(
      `SELECT m.conv_id AS id, bm25(messages_fts) AS s FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? ORDER BY s LIMIT 20`,
    ).all(q) as { id: string; s: number }[];
    for (const h of msgHits) bump(h.id, -h.s);
    if (opts.excludeConv) scores.delete(opts.excludeConv);
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit ?? 5)
      .map(([id, score]) => ({ conv: this.getConversation(id)!, score }));
  }

  // ---------- search cache ----------
  cacheGet(key: string, nowMs: number): string | null {
    const r = this.db.prepare(`SELECT value, ts, ttl FROM search_cache WHERE key=?`).get(key) as any;
    if (!r || nowMs - r.ts > r.ttl * 1000) return null;
    return r.value;
  }
  cachePut(key: string, value: string, nowMs: number, ttlSec: number): void {
    this.db.prepare(`INSERT OR REPLACE INTO search_cache(key, value, ts, ttl) VALUES (?,?,?,?)`).run(key, value, nowMs, ttlSec);
  }
}
