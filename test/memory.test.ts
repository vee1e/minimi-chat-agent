import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { recallByDates, renderMemory } from "../src/memory/recall.js";
import { resolveDates } from "../src/memory/dates.js";
import { ftsQuery } from "../src/memory/store.js";
import { seed } from "../src/seed.js";

const NOW = new Date("2026-11-10T14:00:00+05:30");
const TZ = "Asia/Kolkata";
const mk = () => createApp({ cfg: { mock: true, dbPath: ":memory:", tz: TZ }, clock: () => NOW });

describe("memory store + recall", () => {
  it("seed puts conversations on the right local days", () => {
    const app = mk(); seed(app);
    const mon = recallByDates(app.store, resolveDates("on Monday", NOW, TZ));
    expect(mon.days).toHaveLength(1);
    expect(mon.days[0].date).toBe("2026-11-09");
    expect(mon.days[0].conversations[0].conv.title).toMatch(/CRM/);
    expect(mon.days[0].conversations[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
  it("3 November returns BOTH conversations that day (Postgres + Node)", () => {
    const app = mk(); seed(app);
    const r = recallByDates(app.store, resolveDates("What did I ask you on 3 November?", NOW, TZ));
    expect(r.days[0].conversations.map((c) => c.conv.title).sort()).toEqual(["Node.js version for production", "Postgres hosting options and pricing"]);
    // "last Tuesday" is the same calendar day
    const r2 = recallByDates(app.store, resolveDates("Last Tuesday I asked about Postgres hosting", NOW, TZ));
    expect(r2.days[0].date).toBe("2026-11-03");
  });
  it("a day with no conversations is reported as empty (so the model can't invent one)", () => {
    const app = mk(); seed(app);
    const r = recallByDates(app.store, resolveDates("what did I ask on 1 November?", NOW, TZ));
    expect(r.days).toEqual([]);
    expect(r.emptyDays).toEqual(["2026-11-01"]);
    const txt = renderMemory({ ...r, topicHits: [], store: app.store }, TZ).text;
    expect(txt).toMatch(/NO stored conversations/);
  });
  it("rendered memory carries dated headers, the user's words and the assistant's old numbers", () => {
    const app = mk(); seed(app);
    const r = recallByDates(app.store, resolveDates("on Monday", NOW, TZ));
    const { text, brief } = renderMemory({ ...r, topicHits: [], store: app.store }, TZ);
    expect(text).toMatch(/Monday, 9 November 2026/);
    expect(text).toMatch(/20-person sales team/);
    expect(text).toMatch(/Pipedrive/);
    expect(brief).toMatch(/topics: .*HubSpot Sales Hub/);
  });
  it("timestamps are bucketed by the user's local day, not UTC", () => {
    const app = mk();
    // 00:30 IST on 10 Nov == 19:00Z on 9 Nov
    app.store.addMessage("c1", "user", "late night question", new Date("2026-11-10T00:30:00+05:30").getTime());
    expect(app.store.messagesOnDays(["2026-11-10"])).toHaveLength(1);
    expect(app.store.messagesOnDays(["2026-11-09"])).toHaveLength(0);
  });
  it("keyword recall finds the right past conversation and can exclude the current one", () => {
    const app = mk(); seed(app);
    const hits = app.store.searchConversations("what did we decide about postgres hosting pricing?");
    expect(hits[0].conv.title).toMatch(/Postgres/);
    const excl = app.store.searchConversations("postgres hosting", { excludeConv: hits[0].conv.id });
    expect(excl.find((h) => h.conv.id === hits[0].conv.id)).toBeUndefined();
  });
  it("ftsQuery strips stopwords and neutralises FTS syntax", () => {
    expect(ftsQuery('the "NEAR(" crm AND pricing')).toBe('"near" OR "crm" OR "pricing"');
    expect(ftsQuery("what is it?")).toBeNull();
  });
  it("seed is idempotent", () => {
    const app = mk(); const a = seed(app); const b = seed(app);
    expect(a).toBeGreaterThan(0); expect(b).toBe(0);
  });
});
