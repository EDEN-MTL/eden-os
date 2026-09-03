/**
 * Quarry CLI.
 *
 *   npm run quarry:calibrate -- --leads 50
 *
 * Runs discovery → triage → enrichment → phone verification and stops. It
 * never generates a site, never touches GHL, and never sends anything, so the
 * only money it spends is Twilio Lookup at $0.008 per number checked.
 *
 * The point is to measure the two rates that decide whether this offer can
 * hit a weekly client target, before committing to the volume that would.
 */
import "dotenv/config";
import { CalibrationReport, run, StopAfter } from "./pipeline";
import { PlaywrightCapturer } from "./screenshot";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printReport(r: CalibrationReport, leadsRequested: number): void {
  const line = "─".repeat(58);
  console.log(`\n${line}`);
  console.log("  QUARRY CALIBRATION");
  console.log(line);

  console.log(`\n  Discovery`);
  console.log(`    requested            ${leadsRequested}`);
  console.log(`    new businesses       ${r.discovered}`);
  console.log(`      no website at all  ${r.noWebsite}`);
  console.log(`      has a website      ${r.hasWebsite}`);

  console.log(`\n  UNKNOWN 1 — qualify rate`);
  console.log(`    qualified            ${r.qualified}/${r.discovered}   ${pct(r.qualifyRate)}`);
  if (r.qualifyRateIsFloor) {
    console.log(`    ⚠ this is a FLOOR. Vision scoring is configured on but did not run`);
    console.log(`      (no headless browser), so a site that is technically sound and`);
    console.log(`      merely looks dated was counted as a pass. The true rate is higher.`);
  }

  console.log(`\n  UNKNOWN 2 — mobile rate`);
  if (!r.phoneVerificationEnabled) {
    console.log(`    skipped — phone verification is off (email is the default channel)`);
    console.log(`    set quarry.phone.enabled: true in the client config to measure this`);
  } else {
    console.log(`    numbers checked      ${r.phoneChecked}`);
    console.log(`      mobile             ${r.mobile}   ${pct(r.mobileRate)}`);
    console.log(`      landline           ${r.landline}`);
    console.log(`      holdout (VOIP/?)   ${r.holdout}`);
  }

  console.log(`\n  UNKNOWN 3 — email reach (email is now a send channel)`);
  console.log(`    published email      ${r.withEmail}/${r.qualified}   ${pct(r.emailRate)}`);

  console.log(`\n  By category`);
  for (const [category, c] of Object.entries(r.byCategory)) {
    console.log(
      `    ${category.padEnd(18)} ${String(c.discovered).padStart(3)} found  ` +
        `${String(c.qualified).padStart(3)} qualified  ${String(c.mobile).padStart(3)} mobile`
    );
  }

  console.log(`\n  Set aside (kept, not worked)`);
  console.log(`    landline             ${r.landline}`);
  console.log(`    VOIP / unclassified  ${r.holdout}`);

  console.log(`\n  Projection`);
  console.log(`    textable leads per ${r.discovered}-business run: ${r.projectedSendsPerRun}`);
  if (r.discovered > 0 && r.projectedSendsPerRun > 0) {
    const perTextable = r.discovered / r.projectedSendsPerRun;
    console.log(`    → ${perTextable.toFixed(1)} businesses discovered per textable lead`);
    console.log(`    → ${Math.ceil(perTextable * 175)} discoveries/wk to sustain 175 sends/wk`);
  }

  const cost = r.phoneChecked * 0.008;
  console.log(`\n  Spent`);
  console.log(`    Twilio Lookup        ${r.phoneChecked} × $0.008 = $${cost.toFixed(2)}`);
  console.log(`    Google Places        $0.00 (inside free caps at this volume)`);

  if (r.errors.length) {
    console.log(`\n  Errors (${r.errors.length}) — leads skipped, batch continued`);
    for (const e of r.errors.slice(0, 10)) {
      console.log(`    ${e.step.padEnd(9)} ${e.name ?? "—"}: ${e.message.slice(0, 70)}`);
    }
    if (r.errors.length > 10) console.log(`    … ${r.errors.length - 10} more (see quarry_runs.errors)`);
  }
  console.log(`\n  run id ${r.runId} — rows are in quarry_leads for review\n`);
}

async function main() {
  const leads = Number(arg("leads") ?? 50);
  const stopAfter = (arg("stop") ?? "phone") as StopAfter;
  const clientId = arg("client") ?? "eden";

  console.log(
    `\nCalibration batch: ${leads} leads, stopping after "${stopAfter}".\n` +
      `No sites generated, no GHL writes, nothing sent.\n` +
      `Maximum spend: ${leads} × $0.008 = $${(leads * 0.008).toFixed(2)} of Twilio Lookup.`
  );

  // --no-vision skips the Claude vision pass and the browser it needs, for a
  // run that costs nothing but Twilio. With it on, the qualify rate is a real
  // measurement rather than a floor.
  const capturer = process.argv.includes("--no-vision") ? undefined : new PlaywrightCapturer();

  const report = await run({
    clientId,
    stopAfter,
    triggeredBy: "cli",
    maxLeads: leads,
    capturer,
    // Calibration is the reason the kill switch can be bypassed: the switch
    // exists to stop generation and sending, neither of which happens here.
    overrideKillSwitch: true,
  });

  await capturer?.close();
  printReport(report, leads);
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
