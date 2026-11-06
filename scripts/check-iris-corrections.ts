/**
 * Runs the REAL text classifier over every case in agents/iris/corrections.ts — the messages Iris has misread before —
 * and scores each N/N. Run it before shipping any change to agents/iris/text-signals.ts:
 *
 *   npx tsx --env-file=.env scripts/check-iris-corrections.ts        (N=3 per case)
 *
 * Needs ANTHROPIC_API_KEY (a few cents of model tokens), so run it where that key exists — Render's shell, or a
 * machine with the key. Every case should score N/N; anything less means the change reintroduced a known mistake.
 */
import { TEXT_SIGNAL_CASES } from "../agents/iris/corrections";
import { classifyInboundText } from "../agents/iris/text-signals";

// Thursday 2026-11-06 10:00 in St. John's, so a bare "6 pm" is hours away.
const NOW = new Date("2026-11-06T13:30:00.000Z");

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — the classifier can only run where that key exists (Render).");
    process.exit(2);
  }
  const N = Number(process.env.N || 3);
  let failed = 0;
  for (const c of TEXT_SIGNAL_CASES) {
    const got: string[] = [];
    for (let i = 0; i < N; i++) got.push((await classifyInboundText(c.message, NOW, "America/St_Johns", c.precedingOutbound ?? null)).type);
    const ok = got.filter((t) => (c.expect as string[]).includes(t)).length;
    if (ok < N) failed++;
    console.log(`${ok}/${N}  ${c.id.padEnd(28)} "${c.message}"  expected ${c.expect.join("|")}  got ${got.join(",")}`);
  }
  console.log(failed === 0 ? "\nAll cases pass." : `\n${failed} case(s) below ${N}/${N}.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
