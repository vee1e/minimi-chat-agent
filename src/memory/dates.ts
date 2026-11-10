/**
 * Deterministic natural-date resolution.
 *
 * The LLM never does date arithmetic. Given the user's message, the current instant and the
 * user's timezone, we find phrases like "on Monday", "last Tuesday", "3 November", "2 days ago"
 * and turn them into concrete calendar days (civil dates, YYYY-MM-DD, in the user's timezone).
 *
 * Convention for weekdays: "on Monday" / "last Monday" / "Monday" = the most recent such
 * weekday strictly BEFORE today. So on Tue 10 Nov 2026: "Monday" = 9 Nov, "last Tuesday" = 3 Nov
 * (today is itself a Tuesday, so it must mean the previous one).
 */

export type Civil = string; // "YYYY-MM-DD"

export interface DateRef {
  phrase: string; // text as matched in the message
  start: Civil;
  end: Civil; // inclusive; equals start for a single day
  kind: "day" | "range";
  /** "today" style refs: inject if conversations exist, but don't claim "nothing found". */
  soft?: boolean;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const pad = (n: number) => String(n).padStart(2, "0");
export const civil = (y: number, m: number, d: number): Civil => `${y}-${pad(m)}-${pad(d)}`;
const toUTC = (c: Civil) => {
  const [y, m, d] = c.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const addDays = (c: Civil, n: number): Civil => {
  const dt = new Date(toUTC(c) + n * 86_400_000);
  return civil(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};
export const weekdayOf = (c: Civil) => new Date(toUTC(c)).getUTCDay(); // 0 = Sunday
export const isValidCivil = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Calendar day of an instant in a timezone. */
export function civilInTz(instant: Date, tz: string): Civil {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  return parts; // en-CA => YYYY-MM-DD
}

export function formatCivil(c: Civil): string {
  const dt = new Date(toUTC(c));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(dt);
}

export function formatNow(instant: Date, tz: string): string {
  const d = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(instant);
  const t = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(instant);
  return `${d}, ${t} (${tz})`;
}

function lastWeekday(today: Civil, wd: number): Civil {
  // most recent weekday strictly before today
  let diff = (weekdayOf(today) - wd + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, -diff);
}

function monthDay(today: Civil, month: number, day: number, year?: number): Civil | null {
  const ty = Number(today.slice(0, 4));
  if (year) return isValidCivil(year, month, day) ? civil(year, month, day) : null;
  if (!isValidCivil(ty, month, day)) return null;
  const c = civil(ty, month, day);
  if (c <= today) return c;
  return isValidCivil(ty - 1, month, day) ? civil(ty - 1, month, day) : null; // future => last year
}

export function resolveDates(text: string, now: Date, tz: string): DateRef[] {
  const today = civilInTz(now, tz);
  const refs: DateRef[] = [];
  let s = text.toLowerCase();

  /** run a regex over the (progressively masked) text; masks matches so patterns don't overlap */
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => Omit<DateRef, "phrase"> | null) => {
    s = s.replace(re, (...args) => {
      const groups = args.slice(0, -2) as string[]; // drop offset + full string
      const m = groups as unknown as RegExpExecArray;
      const r = fn(m);
      if (!r) return args[0];
      refs.push({ phrase: args[0].trim(), ...r });
      return " ".repeat(args[0].length);
    });
  };
  const day = (c: Civil, soft = false): Omit<DateRef, "phrase"> => ({ start: c, end: c, kind: "day", soft });
  const range = (a: Civil, b: Civil): Omit<DateRef, "phrase"> => ({ start: a, end: b, kind: "range" });

  // 1. ISO date
  scan(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) =>
    isValidCivil(+m[1], +m[2], +m[3]) ? day(civil(+m[1], +m[2], +m[3])) : null);

  // 2. "3 November", "3rd of Nov 2026"
  scan(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, "g"), (m) => {
    const c = monthDay(today, MONTHS[m[2]], +m[1], m[3] ? +m[3] : undefined);
    return c ? day(c) : null;
  });
  // 3. "November 3", "Nov 3rd, 2026"
  scan(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"), (m) => {
    const c = monthDay(today, MONTHS[m[1]], +m[2], m[3] ? +m[3] : undefined);
    return c ? day(c) : null;
  });

  // 4. relative days
  scan(/\bday before yesterday\b/g, () => day(addDays(today, -2)));
  scan(/\byesterday\b/g, () => day(addDays(today, -1)));
  // Bare "today" is NOT a memory reference ("is it still correct today?"); only "earlier today" is.
  scan(/\bearlier today\b/g, () => day(today, true));
  scan(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week)s?\s+ago\b/g, (m) => {
    const n = /^\d+$/.test(m[1]) ? +m[1] : NUM_WORDS[m[1]];
    return day(addDays(today, -n * (m[2] === "week" ? 7 : 1)));
  });

  // 5. ranges
  scan(/\b(?:last|past|previous)\s+(\d+)\s+days\b/g, (m) => range(addDays(today, -+m[1]), addDays(today, -1)));
  scan(/\blast week\b/g, () => {
    const wd = weekdayOf(today); // 0=Sun
    const thisMonday = addDays(today, -((wd + 6) % 7));
    return range(addDays(thisMonday, -7), addDays(thisMonday, -1));
  });
  scan(/\bthis week\b/g, () => {
    const thisMonday = addDays(today, -((weekdayOf(today) + 6) % 7));
    return range(thisMonday, today);
  });
  scan(/\blast month\b/g, () => {
    const [y, mo] = today.split("-").map(Number);
    const pm = mo === 1 ? 12 : mo - 1;
    const py = mo === 1 ? y - 1 : y;
    const first = civil(py, pm, 1);
    return range(first, addDays(civil(y, mo, 1), -1));
  });

  // 6. weekdays: "last Tuesday", "on Monday", "this past Friday", bare "Monday"
  scan(new RegExp(`\\b(?:(?:last|previous|this past|past)\\s+|on\\s+)?(${WEEKDAYS.join("|")})\\b`, "g"), (m) =>
    day(lastWeekday(today, WEEKDAYS.indexOf(m[1]))));

  refs.sort((a, b) => a.start.localeCompare(b.start));
  return refs;
}

/** All calendar days covered by the refs (ranges expanded, capped), deduped, ascending. */
export function expandDays(refs: DateRef[], cap = 31): Civil[] {
  const out = new Set<Civil>();
  for (const r of refs) {
    let c = r.start;
    for (let i = 0; i < cap && c <= r.end; i++) { out.add(c); c = addDays(c, 1); }
  }
  return [...out].sort();
}
