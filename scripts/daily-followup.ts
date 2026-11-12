/**
 * Dry run of the daily lead follow-up (agents/iris/review-followup.ts): reads the latest nightly review, applies the
 * same vetting as production, and prints who Iris WOULD line up today and who she would leave to a person, plus which
 * pipeline stages the review reads and which it leaves alone. NEVER queues, calls, texts or moves anything.
 *
 *   npx tsx --env-file=.env scripts/daily-followup.ts
 *   NOW=2026-11-13T13:20:00Z to pretend it is later; CLIENT=<id> for another client
 */
import { getGhlConfig, listOpportunitiesInStage, listPipelines } from "../shared/ghl";
import { DEFAULT_SKIP_STAGES, isWithAgentStage } from "../agents/iris/lead-review";
import { formatDailyFollowUpPost, PARKED_STAGES, runDailyLeadFollowUp } from "../agents/iris/review-followup";

const CLIENT = process.env.CLIENT || "3-percent-east-coast";

(async () => {
  const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
  const ghl = (await getGhlConfig(CLIENT))!;
  const skip = new Set(DEFAULT_SKIP_STAGES.map((s) => s.toLowerCase()));
  console.log("STAGES");
  for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
    for (const s of p.stages ?? []) {
      const name = String(s.name);
      const cards = (await listOpportunitiesInStage(ghl.locationId, p.id, s.id, ghl.apiKey)).filter((o: any) => o?.status !== "lost" && o?.status !== "won").length;
      const role = skip.has(name.toLowerCase()) ? "NOT READ (finished or owned by another flow)" : isWithAgentStage(name) ? "read, never followed up by Iris (with an agent)" : PARKED_STAGES.some((x) => x.toLowerCase() === name.toLowerCase()) ? "read, listed for a person only (parked on purpose)" : "read and followed up";
      console.log(`  ${name.padEnd(36)} ${String(cards).padStart(3)} cards  ${role}`);
    }
  }
  const result = await runDailyLeadFollowUp(CLIENT, { now, dryRun: true });
  console.log("\nWOULD LINE UP:", result.skipped ?? result.queued.map((q) => `${q.name} [${q.kind}]`));
  console.log("OVER THE DAILY LIMIT:", result.waiting.map((q) => q.name));
  console.log("LEFT OUT:", result.left);
  console.log("FOR A PERSON:", result.forAPerson.map((f) => `${f.name} (${f.stageName})`));
  console.log("\nSLACK POST WOULD READ:\n" + (formatDailyFollowUpPost(result) ?? "(nothing)"));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
