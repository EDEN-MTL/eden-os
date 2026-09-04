/**
 * Module 8 — orchestration.
 *
 * One runner, stoppable at any stage. `stopAfter: "phone"` is the calibration
 * run: it measures the three rates the whole business case depends on and
 * spends almost nothing, because it stops before site generation — the only
 * expensive step.
 *
 * The three unknowns, and why they matter more than any other number here:
 *
 *   qualifyRate — of businesses discovered, how many actually have a bad site.
 *   mobileRate  — of those, how many list a number that can receive a text.
 *   emailRate   — fallback channel size for everyone who cannot.
 *
 * Sends/week is qualifyRate x mobileRate x discovery volume. Get those two
 * wrong and every cost and volume projection downstream is wrong with them.
 */
import { loadQuarryConfig, QuarryConfig, SearchSpec } from "./config";
import { discover } from "./discovery";
import { enrichContact } from "./enrich";
import { TwilioLookupProvider, verifyPhone } from "./phone";
import {
  finishRun,
  insertDiscovered,
  recentlySeenPlaceIds,
  startRun,
  updateLead,
} from "./store";
import { applyVisionScore, isHighConfidenceCandidate, triage } from "./triage";
import { openOpportunity, resolvePipeline, upsertProspectContact } from "./sync";
import { getGhlConfig } from "../../shared/ghl";
import { PlaywrightCapturer, scoreSiteAppearance, ScreenshotCapturer } from "./screenshot";
import { QuarryCategory, QuarryLead, RunError } from "./types";
import { quarryAgent } from "./index";

export type StopAfter = "discover" | "triage" | "phone" | "enrich";

export interface RunOptions {
  clientId?: string;
  stopAfter: StopAfter;
  triggeredBy: string;
  /** Overrides config.discovery.maxLeadsPerRun — used to size a calibration batch. */
  maxLeads?: number;
  /** Set to run despite `quarry.enabled: false`. Calibration passes this. */
  overrideKillSwitch?: boolean;
  /** Overrides config.searches — how a location-targeted discovery request runs against a city that isn't in the fixed list. */
  searches?: SearchSpec[];
  /**
   * Pushes every qualified lead into GHL as a contact + opportunity once
   * this run reaches "enrich". Off by default so calibration (cli.ts) keeps
   * its documented promise of never touching GHL — only a caller that
   * explicitly wants real contacts created (currently the Slack discovery
   * tool) opts in.
   */
  syncToGhl?: boolean;
  log?: (line: string) => void;
  /**
   * Supplies the vision pass. Omit to skip it — the run still works and the
   * reported qualify rate is then a floor, which the report says explicitly
   * rather than passing a partial number off as a measurement.
   */
  capturer?: ScreenshotCapturer;
}

export interface CategoryBreakdown {
  discovered: number;
  qualified: number;
  mobile: number;
}

export interface CalibrationReport {
  runId: number;
  discovered: number;
  noWebsite: number;
  hasWebsite: number;
  qualified: number;
  /** Of everything discovered, the share worth pitching. */
  qualifyRate: number;
  phoneChecked: number;
  mobile: number;
  landline: number;
  holdout: number;
  /** Of qualified leads with a checkable number, the share that can be texted. */
  mobileRate: number;
  withEmail: number;
  emailRate: number;
  byCategory: Record<string, CategoryBreakdown>;
  /** Sends per week this discovery config would sustain at the observed rates. */
  projectedSendsPerRun: number;
  errors: RunError[];
  /**
   * True when the vision pass did not run, which it currently never does —
   * see the note in run(). The qualify rate is then a FLOOR, not a measurement.
   */
  qualifyRateIsFloor: boolean;
  /** False means Twilio was never called — mobile/landline counts are not "0 mobiles found", they are "not checked". */
  phoneVerificationEnabled: boolean;
  /** Qualified on a hard technical fact and cleared automatically — config.autoApprove must be on. */
  autoApproved: number;
  /** Qualified only by the vision pass's opinion — left pending and posted to reviewChannel. */
  needsReview: number;
  /** Qualified leads pushed into GHL as a contact + opportunity — only non-zero when syncToGhl was set. */
  syncedToGhl: number;
}

export class QuarryDisabledError extends Error {
  constructor() {
    super(
      "quarry.enabled is false in the client config. This is the kill switch for " +
        "every billable call in this agent — pass overrideKillSwitch to run anyway."
    );
    this.name = "QuarryDisabledError";
  }
}

export class MissingCredentialsError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(", ")}`);
    this.name = "MissingCredentialsError";
  }
}

function requireEnv(stopAfter: StopAfter, phoneEnabled: boolean): void {
  const missing: string[] = [];
  if (!process.env.GOOGLE_PLACES_API_KEY) missing.push("GOOGLE_PLACES_API_KEY");
  // Twilio is only actually needed if phone verification is going to run.
  // Email is the default channel now — demanding Twilio credentials for a
  // step the config has switched off would block a calibration run over
  // keys nobody needs yet.
  if (stopAfter === "phone" && phoneEnabled) {
    if (!process.env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
    if (!process.env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  }
  if (missing.length) throw new MissingCredentialsError(missing);
}

// Stale note from an earlier design: this comment used to say enrichment
// only ran on mobile leads, to avoid fetching a landline's contact page for
// nothing. Email is now the primary channel and enrichment runs on every
// qualified lead regardless of phone status — see the enrichment loop below.
// Phone verification stays before enrich in the ordering only because that
// was already the shape; it has no bearing on which leads get enriched now.
const STAGE_ORDER: StopAfter[] = ["discover", "triage", "phone", "enrich"];
const reaches = (stopAfter: StopAfter, stage: StopAfter) =>
  STAGE_ORDER.indexOf(stopAfter) >= STAGE_ORDER.indexOf(stage);

export async function run(options: RunOptions): Promise<CalibrationReport> {
  const clientId = options.clientId ?? "eden";
  const log = options.log ?? ((line: string) => console.log(`[QRY] ${line}`));
  const config = loadQuarryConfig(clientId);
  if (!config) throw new Error(`No quarry config for client "${clientId}"`);
  if (!config.enabled && !options.overrideKillSwitch) throw new QuarryDisabledError();
  requireEnv(options.stopAfter, config.phone.enabled);

  const errors: RunError[] = [];
  const note = (step: string, lead: { placeId: string; name: string } | null, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({
      step,
      placeId: lead?.placeId ?? null,
      name: lead?.name ?? null,
      message,
      at: new Date().toISOString(),
    });
    log(`  ! ${step} failed${lead ? ` for ${lead.name}` : ""}: ${message}`);
  };

  const maxLeads = options.maxLeads ?? config.discovery.maxLeadsPerRun;
  const runId = await startRun(options.triggeredBy, clientId);
  log(`run ${runId} — stopAfter=${options.stopAfter}, maxLeads=${maxLeads}`);

  // ── Discovery ──
  const alreadySeen = await recentlySeenPlaceIds(config.discovery.recheckAfterDays, clientId);
  log(`${alreadySeen.size} place_ids already seen within ${config.discovery.recheckAfterDays} days`);

  const outcome = await discover(
    options.searches ?? (config.searches as SearchSpec[]),
    process.env.GOOGLE_PLACES_API_KEY!,
    alreadySeen,
    maxLeads,
    (spec, error) => note("discover", null, `${spec.query}: ${error.message}`)
  );
  log(
    `discovery: ${outcome.searched} search hits, ${outcome.detailsCalls} details calls, ` +
      `${outcome.results.length} new (${outcome.skippedAlreadySeen} seen before, ${outcome.skippedClosed} closed)`
  );

  const leads = await insertDiscovered(outcome.results, clientId);
  log(`${leads.length} rows written`);

  const report: CalibrationReport = {
    runId,
    discovered: leads.length,
    noWebsite: leads.filter((l) => !l.website).length,
    hasWebsite: leads.filter((l) => !!l.website).length,
    qualified: 0,
    qualifyRate: 0,
    phoneChecked: 0,
    mobile: 0,
    landline: 0,
    holdout: 0,
    mobileRate: 0,
    withEmail: 0,
    emailRate: 0,
    byCategory: {},
    projectedSendsPerRun: 0,
    errors,
    // Vision scoring needs a screenshot of the prospect's EXISTING site, which
    // needs a headless browser this run does not have. So a site that is
    // technically sound and merely looks like 2009 is currently counted as a
    // pass. The real qualify rate is therefore at least this, never less.
    qualifyRateIsFloor: false,
    phoneVerificationEnabled: true,
    autoApproved: 0,
    needsReview: 0,
    syncedToGhl: 0,
  };

  const bump = (category: string | null, key: keyof CategoryBreakdown) => {
    const c = category ?? "uncategorised";
    report.byCategory[c] ??= { discovered: 0, qualified: 0, mobile: 0 };
    report.byCategory[c][key]++;
  };
  for (const lead of leads) bump(lead.category, "discovered");

  if (!reaches(options.stopAfter, "triage")) {
    await persist(runId, report, errors);
    return finalise(report);
  }

  // ── Triage ──
  const visionOn = config.triage.visionScoring && !!options.capturer;
  report.qualifyRateIsFloor = config.triage.visionScoring && !visionOn;
  if (report.qualifyRateIsFloor) {
    log("vision scoring is configured on but no capturer was supplied — qualify rate will be a floor");
  }

  const qualified: QuarryLead[] = [];
  const needsReview: QuarryLead[] = [];
  for (const lead of leads) {
    try {
      let result = await triage(lead.website, {
        outdatedSignals: config.triage.outdatedSignals,
        copyrightYearBefore: config.triage.copyrightYearBefore,
      });

      // The vision pass runs ONLY on sites the technical checks cleared.
      // A site already qualified needs no second opinion, and scoring it
      // anyway would spend a model call and a page load to change nothing.
      if (visionOn && lead.website && !result.isCandidate) {
        try {
          const shot = await options.capturer!.capture(lead.website);
          const scored = await scoreSiteAppearance(shot);
          if (scored) {
            result = applyVisionScore(
              result,
              scored.score,
              scored.reasoning,
              config.triage.visionScoreThreshold
            );
          }
        } catch (error) {
          // A screenshot failure must not disqualify a lead that the
          // technical checks already judged. Logged, then carry on.
          note("vision", lead, error);
        }
      }

      // Auto-approval, if the config allows it, is decided here rather
      // than later — this is the one place both the reasons array and a
      // fresh DB write already exist together, so it costs nothing extra.
      // A lead qualified only by the vision pass's opinion is deliberately
      // left pending; everything else clears immediately.
      const patch: Record<string, unknown> = {
        isCandidate: result.isCandidate,
        reasons: result.reasons,
        outdatedScore: result.outdatedScore ?? null,
        outdatedReasoning: result.outdatedReasoning ?? null,
      };
      if (result.isCandidate && config.autoApprove) {
        if (isHighConfidenceCandidate(result.reasons)) {
          patch.approvalStatus = "approved";
          report.autoApproved++;
        } else {
          needsReview.push(lead);
          report.needsReview++;
        }
      }
      await updateLead(lead.id, patch);

      if (result.isCandidate) {
        qualified.push(lead);
        bump(lead.category, "qualified");
        log(`  ✓ ${lead.name} — ${result.reasons.join("; ")}`);
      }
    } catch (error) {
      note("triage", lead, error);
    }
  }

  await notifyNeedsReview(needsReview, config.reviewChannel, log);
  report.qualified = qualified.length;
  log(`triage: ${qualified.length}/${leads.length} qualified${visionOn ? " (vision on)" : ""}`);

  if (!reaches(options.stopAfter, "phone")) {
    await persist(runId, report, errors);
    return finalise(report);
  }

  // ── Phone verification ──
  // Off by default — email is now the primary channel (2026-08-27), and
  // phone verification's only consumer was gating the SMS send path. Running
  // it anyway would spend real Twilio money determining mobile status for a
  // channel nobody sends on by default. Flip quarry.phone.enabled back on in
  // the client config to resume it — nothing else needs to change; isMobile
  // simply stays null on every lead while this is off, which is also exactly
  // what keeps sendPending's SMS candidate filter naturally empty.
  report.phoneVerificationEnabled = config.phone.enabled;
  if (!config.phone.enabled) {
    log("phone verification disabled (email is the default channel) — skipping, isMobile stays unset");
  } else {
    const provider = new TwilioLookupProvider(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    );
    for (const lead of qualified) {
      try {
        const result = await verifyPhone(lead.phone, provider, {
          cacheDays: config.phone.cacheDays,
          voipPolicy: config.phone.voipPolicy,
        });
        if (!result.lookup) {
          report.holdout++;
          await updateLead(lead.id, { holdoutReason: result.problem ?? "No lookup result" });
          continue;
        }
        report.phoneChecked++;
        await updateLead(lead.id, {
          phoneLineType: result.lookup.lineType,
          isMobile: result.decision === "send",
          lastLookupAt: result.lookup.checkedAt,
          holdoutReason:
            result.decision === "holdout"
              ? `Line type "${result.lookup.lineType}" — needs a human call on whether it takes SMS`
              : null,
        });
        if (result.decision === "send") {
          report.mobile++;
          bump(lead.category, "mobile");
        } else if (result.decision === "reject") {
          report.landline++;
        } else {
          report.holdout++;
        }
      } catch (error) {
        note("phone", lead, error);
      }
    }
    log(`phone: ${report.mobile} mobile, ${report.landline} landline, ${report.holdout} holdout`);
  }

  if (!reaches(options.stopAfter, "enrich")) {
    await persist(runId, report, errors);
    return finalise(report);
  }

  // ── Enrichment ──
  // Every qualified lead, mobile or not. This ran mobile-only for one turn —
  // when email was captured but not sent on, enriching a lead about to be set
  // aside as a landline wasted a fetch. Now email is a real send channel and a
  // landline/VOIP lead is its main audience, so the old restriction would
  // silently starve email of the leads it exists to reach.
  for (const lead of qualified) {
    try {
      const enrichment = await enrichContact(lead.website);
      await updateLead(lead.id, {
        email: enrichment.email,
        emailSource: enrichment.emailSource,
        hasPublicEmail: enrichment.hasPublicEmail,
      });
      if (enrichment.hasPublicEmail) report.withEmail++;
    } catch (error) {
      note("enrich", lead, error);
    }
  }
  log(`enrichment: ${report.withEmail}/${qualified.length} qualified leads have a published business email`);

  await syncToGhl(qualified, config, clientId, options.syncToGhl ?? false, report, note, log);

  await persist(runId, report, errors);
  return finalise(report);
}

/**
 * Pushes every qualified lead into GHL as a contact + opportunity in the
 * configured pipeline's "New Lead" stage. Best-effort per lead — one bad
 * contact must not stop the rest of a batch from landing — and the whole
 * step is a no-op unless the caller explicitly opted in (see syncToGhl on
 * RunOptions).
 */
async function syncToGhl(
  qualified: QuarryLead[],
  config: QuarryConfig,
  clientId: string,
  enabled: boolean,
  report: CalibrationReport,
  note: (step: string, lead: { placeId: string; name: string } | null, error: unknown) => void,
  log: (line: string) => void
): Promise<void> {
  if (!enabled || qualified.length === 0) return;

  const ghlConfig = await getGhlConfig(clientId);
  if (!ghlConfig) {
    log(`  ! GHL sync requested but no GHL credentials configured for "${clientId}" — skipping`);
    return;
  }

  let pipeline;
  try {
    pipeline = await resolvePipeline(
      config.ghlPipeline.name,
      config.ghlPipeline.stages,
      ghlConfig.locationId,
      ghlConfig.apiKey
    );
  } catch (error) {
    note("sync", null, error);
    return;
  }

  for (const lead of qualified) {
    if (!lead.phone) {
      note("sync", lead, "no phone number — cannot match/create a GHL contact");
      continue;
    }
    try {
      const { contactId } = await upsertProspectContact(
        {
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          category: (lead.category as QuarryCategory) ?? null,
          previewUrl: lead.previewUrl,
          previewImageUrl: lead.previewImageUrl,
          outdatedScore: lead.outdatedScore,
        },
        ghlConfig.locationId,
        ghlConfig.apiKey
      );
      const opportunityId = await openOpportunity(
        { contactId, businessName: lead.name, pipeline, stage: "New Lead" },
        ghlConfig.locationId,
        ghlConfig.apiKey
      );
      await updateLead(lead.id, {
        ghlContactId: contactId,
        ghlOpportunityId: opportunityId,
        pipelineStage: "New Lead",
      });
      report.syncedToGhl++;
    } catch (error) {
      note("sync", lead, error);
    }
  }
  log(`GHL sync: ${report.syncedToGhl}/${qualified.length} qualified leads synced`);
}

/**
 * Posts judgment-call leads to Slack. Best-effort and non-throwing on
 * purpose — a Slack outage (or a local run with no bot token configured at
 * all) must never take down a discovery run over something that is
 * genuinely optional. Nothing is skipped if this fails; the leads still
 * sit in the database as pending, exactly as if auto-approve were off.
 */
async function notifyNeedsReview(
  leads: QuarryLead[],
  channel: string,
  log: (line: string) => void
): Promise<void> {
  if (leads.length === 0) return;
  try {
    const lines = leads
      .slice(0, 15)
      .map((l) => `• #${l.id} ${l.name} — ${l.outdatedReasoning ?? "looks dated"} (${l.outdatedScore}/10)`)
      .join("\n");
    const more = leads.length > 15 ? `\n…and ${leads.length - 15} more.` : "";
    await quarryAgent.post(
      channel,
      `${leads.length} lead(s) need a human read before I send anything — the site passed every ` +
        `technical check, so this is the vision pass's opinion alone, not a fact I can point to:\n${lines}${more}\n\n` +
        `Approve the ones worth pitching whenever you get a chance.`
    );
  } catch (error) {
    log(`  ! failed to post needs-review leads to Slack: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function persist(runId: number, report: CalibrationReport, errors: RunError[]): Promise<void> {
  await finishRun(
    runId,
    {
      leadsFound: report.discovered,
      leadsQualified: report.qualified,
      leadsMobile: report.mobile,
    },
    errors,
    errors.length > 0 && report.discovered === 0 ? "failed" : "ok"
  );
}

function finalise(report: CalibrationReport): CalibrationReport {
  report.qualifyRate = report.discovered ? report.qualified / report.discovered : 0;
  // Denominator is leads whose number actually reached the carrier lookup, not
  // every qualified lead. A business with no listed number says nothing about
  // how Montreal businesses split between mobile and landline, and counting it
  // as a non-mobile would understate the rate we are trying to measure.
  report.mobileRate = report.phoneChecked ? report.mobile / report.phoneChecked : 0;
  report.emailRate = report.qualified ? report.withEmail / report.qualified : 0;
  report.projectedSendsPerRun = Math.round(
    report.discovered * report.qualifyRate * report.mobileRate
  );
  return report;
}
