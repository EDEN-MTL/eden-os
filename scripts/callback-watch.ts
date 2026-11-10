/**
 * Dry run of Iris's callback watch on live data: who rang back and was not picked up, and the text each would get.
 * Sends nothing. NOW=<iso> pretends it is another time; ONLY=<contactId,...> limits it.
 *   npx tsx --env-file=.env scripts/callback-watch.ts
 */
import { runCallbackWatch } from "../agents/iris/callback-watch";

async function main() {
  const clientId = process.env.CLIENT ?? "3-percent-east-coast";
  const result = await runCallbackWatch(clientId, {
    dryRun: true,
    now: process.env.NOW ? new Date(process.env.NOW) : undefined,
    only: process.env.ONLY?.split(","),
  });
  console.log(`${result.checked} recent conversations with leads Iris has worked; ${result.entries.length} unanswered callbacks.`);
  for (const e of result.entries) {
    console.log(`\n${e.name} (${e.contactId}) — called ${new Date(e.call.at).toISOString()} for ${e.call.durationSeconds}s`);
    console.log(e.decision.send ? `  WOULD TEXT: ${e.text}` : `  skip: ${e.decision.reason}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
