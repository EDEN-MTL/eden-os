/**
 * npm run quarry:send
 *
 * Sends to every APPROVED lead eligible for a pitch or a due nudge, under
 * each channel's own daily cap. Unlike calibration, this does NOT bypass
 * quarry.enabled — this is the command that puts a real message in front of
 * a real stranger, so the kill switch has to actually mean something here.
 */
import "dotenv/config";
import { BatchResult, SendOutcome } from "./outreach";
import { sendPending } from "./send";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function printResult(label: string, r: BatchResult): void {
  const tail = r.capReached ? "  — daily cap reached, rest held for next run" : "";
  console.log(`\n  ${label}`);
  console.log(`    sent ${r.sent}/${r.attempted} attempted (${r.skipped.length} skipped, ${r.failed.length} failed)${tail}`);
  for (const f of r.failed as SendOutcome[]) console.log(`      ✗ lead ${f.leadId}: ${f.error}`);
}

async function main() {
  const clientId = arg("client") ?? "eden";
  console.log(`\nSending approved Quarry leads for "${clientId}"...`);

  const report = await sendPending(clientId, { log: (line) => console.log(`  ${line}`) });

  console.log("\n──────────────────────────────────────────");
  console.log("  QUARRY SEND");
  console.log("──────────────────────────────────────────");
  printResult("SMS — nudges", report.smsNudge);
  printResult("SMS — new pitches", report.smsPitch);
  printResult("Email — nudges", report.emailNudge);
  printResult("Email — new pitches", report.emailPitch);
  console.log("");
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
