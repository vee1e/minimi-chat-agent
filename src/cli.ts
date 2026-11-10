import { createInterface } from "node:readline/promises";
import { createApp } from "./app.js";
import { missingKeys } from "./config.js";

const app = createApp();
const missing = missingKeys(app.cfg);
if (missing.length) { console.error(`Missing: ${missing.join(", ")} (see .env.example)`); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
let conv: string | undefined;
for (;;) {
  const q = (await rl.question("\nyou> ")).trim();
  if (!q || q === "/quit") break;
  process.stdout.write("bot> ");
  const r = await app.agent.run({ conversationId: conv, message: q }, (e) => {
    if (e.type === "token") process.stdout.write(e.text);
    if (e.type === "status") process.stderr.write(`\n[${e.message}]\n`);
  });
  conv = r.conversationId;
  console.log(`\n(${r.timings.firstTokenMs}ms to first token, ${r.timings.totalMs}ms total)`);
  await app.agent.updateMemoryMeta(conv);
}
rl.close();
