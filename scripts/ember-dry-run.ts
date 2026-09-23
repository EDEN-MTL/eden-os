/**
 * Read-only preview of Ember's dormancy scan against a client's live GHL
 * pipeline: who would be enrolled right now, which tracked leads look
 * reactivated, and why everything else was skipped. Enrolls nothing, sends
 * nothing, posts nothing to Slack.
 *
 *   npx tsx scripts/ember-dry-run.ts [clientId] [thresholdDaysOverride]
 *
 * clientId defaults to "eden-sub-account-one" (the test account). The
 * override lets a young test pipeline be checked without waiting 45 days.
 */
import "dotenv/config";
import { runEmberScanForClient } from "../agents/ember/scan";

async function main() {
  const clientId = process.argv[2] || "eden-sub-account-one";
  const override = process.argv[3] ? Number(process.argv[3]) : undefined;
  const report = await runEmberScanForClient(clientId, { dryRun: true, thresholdDaysOverride: override });
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error("[EMB] dry run failed:", error);
  process.exit(1);
});
