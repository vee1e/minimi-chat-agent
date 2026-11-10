import { describe, expect, it } from "vitest";
import { civilInTz, expandDays, resolveDates } from "../src/memory/dates.js";

// Tuesday 10 Nov 2026, 14:00 in Asia/Calcutta
const NOW = new Date("2026-11-10T14:00:00+05:30");
const TZ = "Asia/Kolkata";
const r = (t: string) => resolveDates(t, NOW, TZ);

describe("resolveDates (pinned now = Tue 10 Nov 2026, Asia/Kolkata)", () => {
  it("'on Monday' -> most recent Monday = 9 Nov", () => {
    expect(r("On Monday we shortlisted 5 CRM tools")[0]).toMatchObject({ start: "2026-11-09", end: "2026-11-09" });
  });
  it("'last Tuesday' when today IS Tuesday -> 3 Nov (not today)", () => {
    expect(r("Last Tuesday I asked you about Postgres hosting")[0].start).toBe("2026-11-03");
  });
  it("'3 November' and 'November 3rd' and ISO", () => {
    expect(r("What did I ask you on 3 November?")[0].start).toBe("2026-11-03");
    expect(r("what about November 3rd")[0].start).toBe("2026-11-03");
    expect(r("on 2026-11-03")[0].start).toBe("2026-11-03");
    expect(r("3rd of Nov, 2025")[0].start).toBe("2025-11-03");
  });
  it("month/day later than today means last year", () => {
    expect(r("on 15 December")[0].start).toBe("2025-12-15");
  });
  it("yesterday / day before yesterday / N days ago / a week ago", () => {
    expect(r("yesterday")[0].start).toBe("2026-11-09");
    expect(r("the day before yesterday")[0].start).toBe("2026-11-08");
    expect(r("3 days ago")[0].start).toBe("2026-11-07");
    expect(r("a week ago")[0].start).toBe("2026-11-03");
  });
  it("bare 'today' is not a memory reference, 'earlier today' is (soft)", () => {
    expect(r("is your answer still correct today?")).toEqual([]);
    expect(r("what did we discuss earlier today")[0]).toMatchObject({ start: "2026-11-10", soft: true });
  });
  it("ranges: last week, this week, last month, past 3 days", () => {
    expect(r("last week")[0]).toMatchObject({ start: "2026-11-02", end: "2026-11-08", kind: "range" });
    expect(r("this week")[0]).toMatchObject({ start: "2026-11-09", end: "2026-11-10" });
    expect(r("last month")[0]).toMatchObject({ start: "2026-10-01", end: "2026-10-31" });
    expect(r("in the past 3 days")[0]).toMatchObject({ start: "2026-11-07", end: "2026-11-09" });
  });
  it("weekday resolution from a Wednesday", () => {
    const wed = new Date("2026-11-11T09:00:00+05:30");
    expect(resolveDates("last Tuesday", wed, TZ)[0].start).toBe("2026-11-10");
    expect(resolveDates("on Wednesday", wed, TZ)[0].start).toBe("2026-11-04");
    expect(resolveDates("on Sunday", wed, TZ)[0].start).toBe("2026-11-08");
  });
  it("multiple refs, no double counting", () => {
    const refs = r("compare Monday with 3 November");
    expect(refs.map((x) => x.start)).toEqual(["2026-11-03", "2026-11-09"]);
  });
  it("no date phrase -> nothing; 'may' as a verb is not a month", () => {
    expect(r("what is the best CRM?")).toEqual([]);
    expect(r("may I ask something")).toEqual([]);
    expect(r("rejects 31 February")).toEqual([]);
  });
  it("uses the USER's timezone, not UTC: 00:30 IST on Tue is still Mon in UTC", () => {
    const early = new Date("2026-11-10T00:30:00+05:30"); // 2026-11-09T19:00Z
    expect(civilInTz(early, TZ)).toBe("2026-11-10");
    expect(resolveDates("yesterday", early, TZ)[0].start).toBe("2026-11-09");
    expect(resolveDates("yesterday", early, "UTC")[0].start).toBe("2026-11-08");
  });
  it("expandDays expands ranges", () => {
    expect(expandDays(r("last week")).length).toBe(7);
  });
});
