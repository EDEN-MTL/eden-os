/**
 * Dry run of the ASAP watch (agents/iris/asap-watch.ts): which ASAP leads there are, what Iris would do with each
 * and why, and, with COMPOSE=1, the text she would send. NEVER sends anything.
 *
 *   npx tsx --env-file=.env scripts/asap-watch.ts                (decisions only, no model)
 *   COMPOSE=1 npx tsx --env-file=.env scripts/asap-watch.ts      (also writes each text, via Vapi's text chat, since there
 *                                                                 is no ANTHROPIC_API_KEY locally; same prompt as production)
 *   NOW=2026-11-06T15:00:00Z to pretend it is later; ONLY=<contactId>[,<contactId>] to look at specific leads
 */
import { COMPOSER_SYSTEM, composeAsapText, composerInput, runAsapWatch } from "../agents/iris/asap-watch";

const CLIENT = process.env.CLIENT || "3-percent-east-coast";

async function viaVapi(system: string, input: string): Promise<string> {
  const r = await fetch("https://api.vapi.ai/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assistant: { name: "asap-compose-test", model: { provider: process.env.VAPI_MODEL_PROVIDER, model: process.env.VAPI_MODEL_NAME, messages: [{ role: "system", content: system }], temperature: 0.5, maxTokens: 220 }, firstMessageMode: "assistant-waits-for-user" }, input }),
  });
  const j: any = await r.json();
  return (j.output ?? []).filter((m: any) => m.role === "assistant").map((m: any) => m.content ?? "").join(" ");
}

(async () => {
  const result = await runAsapWatch(CLIENT, {
    dryRun: true,
    now: process.env.NOW ? new Date(process.env.NOW) : undefined, // pretend it is later, to see what a later pass would write
    only: process.env.ONLY?.split(","),
    compose: process.env.COMPOSE === "1",
    composer: (ctx, now, tz) => {
      if (process.env.SHOW === "1") console.log(`\n----- ${ctx.name}: what the model is shown -----\n${composerInput(ctx, now, tz)}\n-----`);
      return composeAsapText(ctx, now, tz, viaVapi);
    },
  });
  console.log(`ASAP leads watched: ${result.watched}`);
  for (const e of result.entries) {
    const d = e.decision;
    console.log(`\n${d.send ? "WOULD TEXT" : "skip      "}  ${e.name} (${e.stageName})${d.send ? "" : ` — ${d.reason}${d.needsPerson ? "  [needs a person]" : ""}`}`);
    if (e.text) console.log(`   → ${e.text}`);
  }
  process.exit(0);
})();
