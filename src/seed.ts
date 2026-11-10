/**
 * Demo data: realistic past conversations on past days, so the example prompts work out of the box:
 *   "On Monday we shortlisted 5 CRM tools…"   "What did I ask you on 3 November?"   "Last Tuesday … Postgres hosting"
 * Dates are computed relative to "now" in the user's timezone (except 3 November 2026, which is pinned).
 * The assistant answers below are DEMO DATA (prices as "said then"), deliberately a bit stale — the agent's job is to re-verify them.
 */
import { fileURLToPath } from "node:url";
import { createApp, type App } from "./app.js";
import { civilInTz, resolveDates, type Civil } from "./memory/dates.js";
import type { Source } from "./memory/store.js";

/** The instant at hh:mm wall-clock on a civil day in tz. */
export function instantAt(day: Civil, hh: number, mm: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(base)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return base - (wall - base);
}

interface SeedConv {
  day: Civil; time: [number, number]; title: string; summary: string; topics: string[];
  turns: { role: "user" | "assistant"; content: string; sources?: Source[] }[];
}

export function seedData(now: Date, tz: string): SeedConv[] {
  const monday = resolveDates("monday", now, tz)[0].start;
  const lastTuesday = resolveDates("last tuesday", now, tz)[0].start;
  const friday = resolveDates("last friday", now, tz)[0].start;
  const nov3 = "2026-11-03";
  return [
    {
      day: monday, time: [11, 5], title: "CRM shortlist for 20-person sales team",
      topics: ["HubSpot Sales Hub", "Salesforce Sales Cloud", "Pipedrive", "Zoho CRM", "Freshsales"],
      summary: "User's 20-person sales team shortlisted 5 CRMs: HubSpot Sales Hub (Pro ~$90–100/seat/mo, 5 seats min), Salesforce Sales Cloud (Pro Suite ~$100/user/mo), Pipedrive (Advanced ~$29/user/mo annual, Professional ~$59), Zoho CRM (Enterprise ~$40/user/mo annual), Freshsales (Growth ~$11, Pro ~$39/user/mo annual). Recommended trialling HubSpot and Pipedrive first.",
      turns: [
        { role: "user", content: "We're a 20-person sales team and need a CRM. Can you shortlist 5 good options with what each costs per seat?" },
        { role: "assistant", sources: [
            { n: 1, title: "HubSpot Sales Hub pricing", url: "https://www.hubspot.com/pricing/sales" },
            { n: 2, title: "Pipedrive pricing", url: "https://www.pipedrive.com/en/pricing" },
            { n: 3, title: "Salesforce Sales Cloud pricing", url: "https://www.salesforce.com/sales/pricing/" }],
          content: "Here's a shortlist for a 20-person sales team (list prices, billed annually, as of today):\n\n| Tool | Plan that fits | ~Price/seat/mo | 20 seats/mo |\n|---|---|---|---|\n| HubSpot Sales Hub | Professional | $90–100 (plus onboarding fee) | ~$1,900 |\n| Salesforce Sales Cloud | Pro Suite | $100 | $2,000 |\n| Pipedrive | Advanced → Professional | $29 → $59 | $580–$1,180 |\n| Zoho CRM | Enterprise | $40 | $800 |\n| Freshsales | Growth → Pro | $11 → $39 | $220–$780 |\n\nPipedrive and HubSpot are the best fit for a team your size: quick to adopt, good pipeline views. Salesforce is stronger if you expect heavy customisation later. Start free trials of HubSpot and Pipedrive first." },
        { role: "user", content: "Great — we'll shortlist those five. What should we evaluate in the trials?" },
        { role: "assistant", content: "Evaluate five things over a 2-week trial: (1) how fast reps log a deal/call (clicks per task), (2) email + calendar sync reliability, (3) reporting your manager actually needs (pipeline by stage, forecast), (4) integrations you already use (Slack, Gmail/Outlook, billing), (5) true cost at 20 seats incl. onboarding and add-ons. Score each 1–5 and weight (1) and (3) highest." },
      ],
    },
    {
      day: lastTuesday, time: [10, 20], title: "Postgres hosting options and pricing",
      topics: ["Supabase", "Neon", "AWS RDS", "Render", "Crunchy Bridge"],
      summary: "User asked about managed Postgres hosting for a small SaaS. Said then: Supabase Pro $25/mo (8 GB DB included), Neon Launch usage-based (~$19/mo typical) with scale-to-zero, AWS RDS db.t4g.micro ~$13/mo + storage, Render Postgres from $6/mo (Basic 256MB) and Crunchy Bridge Hobby ~$10/mo. Recommended Neon or Supabase for a startup.",
      turns: [
        { role: "user", content: "We need managed Postgres hosting for a small SaaS (a few GB, spiky traffic). What are the options and what do they cost?" },
        { role: "assistant", sources: [
            { n: 1, title: "Supabase pricing", url: "https://supabase.com/pricing" },
            { n: 2, title: "Neon pricing", url: "https://neon.com/pricing" },
            { n: 3, title: "Amazon RDS for PostgreSQL pricing", url: "https://aws.amazon.com/rds/postgresql/pricing/" }],
          content: "For a small, spiky-traffic SaaS, as of today:\n\n- **Supabase** — Pro is $25/mo (8 GB database included, auth/storage bundled).\n- **Neon** — Launch plan is usage-based, roughly $19/mo for a small app; scales to zero, which suits spiky load.\n- **AWS RDS** — db.t4g.micro is about $13/mo plus storage and backups; more ops work.\n- **Render Postgres** — from $6/mo (Basic, 256 MB RAM); simple but small.\n- **Crunchy Bridge** — Hobby tier around $10/mo.\n\nMy pick: Neon (scale-to-zero) or Supabase (if you also want auth/storage)." },
      ],
    },
    {
      day: nov3, time: [16, 40], title: "Node.js version for production",
      topics: ["Node.js", "Node 24", "Node 22", "Node 20", "LTS"],
      summary: "User asked which Node.js version to run in production. Said then: Node 24 is the Active LTS and the best default for new services; Node 22 is in Maintenance LTS; Node 20 reached end-of-life in April 2026 and should be migrated off.",
      turns: [
        { role: "user", content: "Which Node.js version should we run in production for a new service?" },
        { role: "assistant", sources: [{ n: 1, title: "Node.js release schedule", url: "https://nodejs.org/en/about/previous-releases" }],
          content: "Run **Node 24** — it's the Active LTS line and the right default for a new service. Node 22 is in Maintenance LTS (fine for existing services), and Node 20 reached end-of-life in April 2026, so move anything still on it." },
      ],
    },
    {
      day: friday, time: [19, 15], title: "Local LLM hardware",
      topics: ["Mac mini M4", "local LLM", "Ollama", "RAM"],
      summary: "User asked whether a Mac mini M4 with 32 GB RAM is enough to run local LLMs. Said: fine for 7–14B models quantised via Ollama; 70B models need 64 GB+.",
      turns: [
        { role: "user", content: "Is a Mac mini M4 with 32 GB enough to run local LLMs?" },
        { role: "assistant", content: "Yes for 7–14B parameter models (quantised, via Ollama or LM Studio) at comfortable speeds. 32B models run but slowly; 70B models want 64 GB+ unified memory." },
      ],
    },
  ];
}

export function seedIfEmpty(app: App): number {
  const n = (app.store.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  return n === 0 ? seed(app) : 0;
}

export function seed(app: App): number {
  let count = 0;
  const now = app.clock();
  for (const [i, c] of seedData(now, app.cfg.tz).entries()) {
    const id = `seed-${c.day}-${i}`;
    if (app.store.messages(id).length) continue; // idempotent
    let ts = instantAt(c.day, c.time[0], c.time[1], app.cfg.tz);
    app.store.ensureConversation(id, ts);
    for (const t of c.turns) {
      app.store.addMessage(id, t.role, t.content, ts, t.sources ?? []);
      ts += 45_000;
      count++;
    }
    app.store.setMeta(id, { title: c.title, summary: c.summary, topics: c.topics, summarizedUpto: c.turns.length });
  }
  return count;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp({ cfg: { mock: true } }); // seeding never needs LLM/search keys
  const n = seed(app);
  console.log(`Seeded ${n} messages into ${app.cfg.dbPath} (today = ${civilInTz(app.clock(), app.cfg.tz)} ${app.cfg.tz}).`);
}
