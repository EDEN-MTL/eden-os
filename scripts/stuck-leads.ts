/**
 * Dry run of the stuck-lead check (agents/iris/stuck-leads.ts) against the live pipeline: reads every early-stage card,
 * prints what Iris would do about each and the Slack post. Writes nothing and sends nothing; the follow-up text is a
 * placeholder (no model is called).
 *   npx tsx --env-file=.env scripts/stuck-leads.ts [clientId]
 */
import { formatStuckPost, runStuckLeadCheck } from "../agents/iris/stuck-leads";

async function main() {
  const clientId = process.argv[2] ?? "3-percent-east-coast";
  const r = await runStuckLeadCheck(clientId, { dryRun: true, composer: async (ctx) => ({ text: `[a follow-up text for ${ctx.firstName}, written from the thread]` }) });
  console.log(`scanned ${r.scanned}`);
  for (const e of r.entries) {
    const d = e.diagnosed.diagnosis;
    console.log(`${e.stageName.trim().slice(0, 14).padEnd(14)} ${e.name.slice(0, 24).padEnd(24)} ${d.action.padEnd(18)} ${d.why}${e.did ? `  => ${e.did}` : ""}${e.deferred ? " (over today's limit)" : ""}`);
  }
  console.log(`\n${formatStuckPost(r) ?? "(nothing to post)"}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
