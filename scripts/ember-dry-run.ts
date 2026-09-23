/**
 * Read-only preview of Ember's dormancy scan against a client's live GHL
 * pipeline: who would be enrolled right now, which tracked leads look
 * reactivated, and why everything else was skipped. Enrolls nothing, sends
 * nothing, posts nothing to Slack.
 *
 *   npx tsx scripts/ember-dry-run.ts [clientId] [thresholdDaysOverride] [--messages]
 *
 * clientId defaults to "eden-sub-account-one" (the test account). The
 * override lets a young test pipeline be checked without waiting 45 days.
 * --messages also reads each would-be lead's conversation history and
 * prints the exact first text Ember would send them (or why it would skip
 * them) — one small Claude call per lead with real history, nothing sent.
 */
import "dotenv/config";
import { runEmberScanForClient } from "../agents/ember/scan";
import { loadEmberConfig } from "../agents/ember/config";
import { previewFirstTouches } from "../agents/ember/preview";

async function main() {
  const args = process.argv.slice(2);
  const withMessages = args.includes("--messages");
  const positional = args.filter((a) => !a.startsWith("--"));
  const clientId = positional[0] || "eden-sub-account-one";
  const override = positional[1] ? Number(positional[1]) : undefined;
  const report = await runEmberScanForClient(clientId, { dryRun: true, thresholdDaysOverride: override });
  console.log(JSON.stringify(report, null, 2));
  if (withMessages) {
    const previews = await previewFirstTouches(clientId, loadEmberConfig(clientId)!, report.eligible);
    console.log("\n--- first texts Ember would send (nothing was sent) ---");
    console.log(JSON.stringify(previews, null, 2));
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[EMB] dry run failed:", error);
  process.exit(1);
});
