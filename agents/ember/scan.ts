/**
 * The periodic dormancy scan. One pass over a client's pipeline does two
 * jobs:
 *
 *   1. Enroll opportunities that have gone quiet — open, not won/lost/active,
 *      not in an excluded column, no stage change for dormancyThresholdDays,
 *      reachable by phone or email. (Consent is checked at the first touch,
 *      with history in hand.)
 *   2. Notice tracked leads that have come back to life — the card moved
 *      columns, or a renewed-interest tag appeared — and alert on them.
 *
 * (2) is the backstop for the GHL webhooks in webhooks/ghl-webhook.ts,
 * which only ever fire if a human built a workflow for them in the GHL UI
 * (gotcha 4 in CLAUDE.md). The scan works whether or not that exists.
 *
 * The scan never sends anything itself. The scheduler only runs it for
 * clients with ember.enabled on; with it off, the only way in is a manual
 * dryRun, which reads GHL and writes nothing.
 */
import { deriveWon, derivePipelineActive, OutcomeStageMap } from "../forge/ads/attribution";
import { getGhlConfig, listOpportunitiesInStage, listPipelines } from "../../shared/ghl";
import { EmberConfig, loadEmberConfig, loadEmberOutcomeStages } from "./config";
import { AlertFn, markExited, markReactivated, REACTIVATABLE, slackAlert } from "./alerts";
import { enrollLead, hasPendingIrisCall, trackedByOpportunity } from "./store";
import { GhlOpportunityLite, LeadIntent, NurtureLead } from "./types";
import { readFileSync } from "fs";
import { join } from "path";

const DAY_MS = 86_400_000;

export interface EnrollContext {
  config: EmberConfig;
  outcomeStages?: OutcomeStageMap;
  stageNames: Record<string, string>;
  now: Date;
  thresholdDays: number;
  /** true when thresholdDays came from a test override — it then wins over stageDormancyDays. */
  forceThreshold?: boolean;
}

export type EnrollDecision = { eligible: true } | { eligible: false; reason: string };

function daysBetween(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : (now.getTime() - ms) / DAY_MS;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function hasRenewedInterestTag(tags: string[] | undefined, config: EmberConfig): string | null {
  for (const tag of tags ?? []) {
    if (config.renewedInterestTags.some((t) => sameName(t, tag))) return tag;
  }
  return null;
}

/**
 * Whether one opportunity should be enrolled. Pure — the Iris check is the
 * one async condition and runs separately in the caller. Reasons are short
 * and stable so the scan report can count them.
 */
export function classifyForEnrollment(opp: GhlOpportunityLite, ctx: EnrollContext): EnrollDecision {
  const { config, outcomeStages, stageNames, now } = ctx;
  if (opp.pipelineId !== config.pipelineId) return { eligible: false, reason: "other pipeline" };
  if ((opp.status || "").toLowerCase() !== "open") return { eligible: false, reason: `status ${opp.status}` };

  const stageName = stageNames[opp.pipelineStageId];
  if (!stageName) return { eligible: false, reason: "unknown stage" };
  // 3% never sets GHL's won/lost status (gotcha 6) — the column is the outcome.
  if (deriveWon(opp.status, stageName, outcomeStages) !== null) return { eligible: false, reason: "won/lost stage" };
  if (derivePipelineActive(opp.status, stageName, outcomeStages)) return { eligible: false, reason: "active stage" };
  if (config.excludeStages.some((s) => sameName(s, stageName))) return { eligible: false, reason: "excluded stage" };
  if (config.includeStages?.length && !config.includeStages.some((s) => sameName(s, stageName))) {
    return { eligible: false, reason: "not a nurture stage" };
  }

  // A renewed-interest tag on a quiet card means someone's already on it.
  if (hasRenewedInterestTag(opp.contact?.tags, config)) return { eligible: false, reason: "renewed-interest tag" };

  // lastStageChangeAt is the dormancy clock. updatedAt is deliberately NOT
  // used: GHL bumps it for edits that aren't deal activity (a follower
  // added, a custom field synced), which would keep a truly dead card
  // looking fresh forever. createdAt is the fallback for a card that has
  // never changed stage at all.
  const quietDays = daysBetween(opp.lastStageChangeAt ?? opp.createdAt, now);
  if (quietDays === null) return { eligible: false, reason: "no activity timestamp" };
  const stageDays = Object.entries(config.stageDormancyDays ?? {}).find(([name]) => sameName(name, stageName))?.[1];
  const threshold = ctx.forceThreshold || stageDays === undefined ? ctx.thresholdDays : stageDays;
  if (quietDays < threshold) return { eligible: false, reason: "not dormant yet" };

  // No consent check here on purpose (Mark, 2026-09-24: leads 6+ months
  // old must still be considered). Consent is measured at the first touch
  // from the LATEST real inquiry — which needs the conversation history
  // this scan doesn't read — see planTouch in outreach.ts.

  if (!opp.contact?.phone && !opp.contact?.email) return { eligible: false, reason: "no phone or email" };
  return { eligible: true };
}

/**
 * Buy/sell intent at enrollment: tags first, then the enrolled stage's
 * name. Unknown gets the neutral script — never a guess, since a seller
 * getting "a few new listings came up" reads as not listening.
 */
export function detectIntent(opp: GhlOpportunityLite, stageName: string | undefined, config: EmberConfig): LeadIntent {
  const tags = (opp.contact?.tags ?? []).map((t) => t.trim().toLowerCase());
  const has = (list: string[]) => list.some((t) => tags.includes(t.trim().toLowerCase()));
  const buyer = has(config.intentTags?.buyer ?? []);
  const seller = has(config.intentTags?.seller ?? []);
  if (buyer && !seller) return "buyer";
  if (seller && !buyer) return "seller";
  if (stageName) {
    for (const [name, intent] of Object.entries(config.intentStages ?? {})) {
      if (sameName(name, stageName)) return intent;
    }
  }
  return "unknown";
}

export type TrackedChange =
  | { kind: "none" }
  | { kind: "exited"; reason: string }
  | { kind: "reactivated"; reason: string };

/** What, if anything, has happened to an already-tracked lead's card. */
export function detectChange(
  lead: NurtureLead,
  opp: GhlOpportunityLite,
  ctx: Pick<EnrollContext, "config" | "outcomeStages" | "stageNames">
): TrackedChange {
  const stageName = ctx.stageNames[opp.pipelineStageId] ?? opp.pipelineStageId;
  const won = deriveWon(opp.status, stageName, ctx.outcomeStages);
  if (won === true) return { kind: "exited", reason: `deal won (${stageName})` };
  if (won === false) return { kind: "exited", reason: `marked lost (${stageName})` };

  const tag = hasRenewedInterestTag(opp.contact?.tags, ctx.config);
  if (tag) return { kind: "reactivated", reason: `tagged "${tag}"` };

  if (lead.enrolledStageId && opp.pipelineStageId !== lead.enrolledStageId) {
    const from = lead.enrolledStageName ?? "its old stage";
    return { kind: "reactivated", reason: `card moved from "${from}" to "${stageName}"` };
  }
  // Same column, but GHL recorded a stage change after enrollment — moved
  // out and back again. Still a human touching the deal.
  if (
    lead.lastGhlActivityAt &&
    opp.lastStageChangeAt &&
    new Date(opp.lastStageChangeAt).getTime() > new Date(lead.lastGhlActivityAt).getTime()
  ) {
    return { kind: "reactivated", reason: `card was moved again in "${stageName}"` };
  }
  return { kind: "none" };
}

/** Touch 0 goes out at enrollment + touchScheduleDays[0]. Later touches are
 *  scheduled from the previous send — see nextTouchAfterSend in outreach.ts. */
export function firstTouchAt(enteredAt: Date, schedule: number[]): Date | null {
  if (schedule.length === 0) return null;
  return new Date(enteredAt.getTime() + schedule[0] * DAY_MS);
}

export interface ScanDeps {
  listOpportunities(): AsyncIterable<any>;
  stageNames(): Promise<Record<string, string>>;
  hasPendingIrisCall(contactId: string): Promise<boolean>;
  alert: AlertFn;
}

export interface ScanReport {
  clientId: string;
  dryRun: boolean;
  scanned: number;
  enrolled: { opportunityId: string; name: string | null; stage: string }[];
  /** Would-be enrollments in a dry run, with what a preview needs. */
  eligible: { opportunityId: string; name: string | null; stage: string; contactId: string; intent: LeadIntent; inquiryAt: string | null }[];
  reactivated: { leadId: number; name: string | null; reason: string }[];
  exited: { leadId: number; name: string | null; reason: string }[];
  skipped: Record<string, number>;
}

function toLite(o: any): GhlOpportunityLite {
  return {
    id: o.id,
    status: o.status,
    pipelineId: o.pipelineId,
    pipelineStageId: o.pipelineStageId,
    contactId: o.contactId ?? o.contact?.id,
    lastStageChangeAt: o.lastStageChangeAt ?? null,
    createdAt: o.createdAt ?? null,
    updatedAt: o.updatedAt ?? null,
    contact: o.contact ?? null,
  };
}

function clientName(clientId: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
    return raw?.clientName || clientId;
  } catch {
    return clientId;
  }
}

export async function buildScanDeps(clientId: string, config: EmberConfig): Promise<ScanDeps> {
  const ghl = await getGhlConfig(clientId);
  if (!ghl) throw new Error(`No GHL credentials configured for client "${clientId}"`);
  return {
    // Stage by stage, not listOpportunitiesPaginated — that one silently
    // returned 106 of 280 on 3%'s real pipeline (see listOpportunitiesInStage).
    listOpportunities: async function* () {
      for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
        if (p.id !== config.pipelineId) continue;
        for (const stage of p.stages || []) {
          for (const o of await listOpportunitiesInStage(ghl.locationId, config.pipelineId, stage.id, ghl.apiKey)) yield o;
        }
      }
    },
    stageNames: async () => {
      const names: Record<string, string> = {};
      for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
        if (p.id !== config.pipelineId) continue;
        for (const s of p.stages || []) names[s.id] = s.name;
      }
      return names;
    },
    hasPendingIrisCall: (contactId) => hasPendingIrisCall(clientId, contactId),
    alert: slackAlert(config.alertChannel),
  };
}

export async function runEmberScanForClient(
  clientId: string,
  options: {
    dryRun?: boolean;
    thresholdDaysOverride?: number;
    now?: Date;
    deps?: ScanDeps;
    /** Live tests only: consider just these opportunities, ignore the rest of the pipeline. */
    onlyOpportunityIds?: string[];
  } = {}
): Promise<ScanReport> {
  const config = loadEmberConfig(clientId);
  if (!config) throw new Error(`No ember config for client "${clientId}"`);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const deps = options.deps ?? (await buildScanDeps(clientId, config));

  const ctx: EnrollContext = {
    config,
    outcomeStages: loadEmberOutcomeStages(clientId),
    stageNames: await deps.stageNames(),
    now,
    thresholdDays: options.thresholdDaysOverride ?? config.dormancyThresholdDays,
    forceThreshold: options.thresholdDaysOverride !== undefined,
  };
  if (Object.keys(ctx.stageNames).length === 0) {
    // A wrong pipelineId never errors in GHL — it just returns nothing, and
    // an empty scan looks exactly like "no dormant leads" (CLAUDE.md's
    // "verify against live data" rule). Fail loudly instead.
    throw new Error(`ember.pipelineId "${config.pipelineId}" resolved to no stages for ${clientId}`);
  }

  let tracked: Map<string, NurtureLead>;
  try {
    tracked = await trackedByOpportunity(clientId);
  } catch (error: any) {
    // 42P01 = relation does not exist: schema.sql hasn't been applied to
    // this database yet (it runs on server boot). A dry run is read-only
    // and useful before that first deploy, so it treats that as "nothing
    // tracked yet". A real run must not — it would enroll into nowhere.
    if (!(dryRun && error?.code === "42P01")) throw error;
    tracked = new Map();
  }
  const name = clientName(clientId);
  const report: ScanReport = {
    clientId,
    dryRun,
    scanned: 0,
    enrolled: [],
    eligible: [],
    reactivated: [],
    exited: [],
    skipped: {},
  };
  const skip = (reason: string) => (report.skipped[reason] = (report.skipped[reason] ?? 0) + 1);

  for await (const raw of deps.listOpportunities()) {
    const opp = toLite(raw);
    if (options.onlyOpportunityIds && !options.onlyOpportunityIds.includes(opp.id)) continue;
    report.scanned++;
    const existing = tracked.get(opp.id);

    if (existing) {
      // replied/opted_out/exited/reactivated are already final — a human
      // owns those now, and re-reporting them every hour is noise.
      if (!REACTIVATABLE.includes(existing.status)) continue;
      const change = detectChange(existing, opp, ctx);
      if (change.kind === "none") continue;
      if (dryRun) {
        (change.kind === "exited" ? report.exited : report.reactivated).push({
          leadId: existing.id, name: existing.contactName, reason: change.reason,
        });
        continue;
      }
      if (change.kind === "exited" && (await markExited(existing, change.reason))) {
        report.exited.push({ leadId: existing.id, name: existing.contactName, reason: change.reason });
      } else if (
        change.kind === "reactivated" &&
        (await markReactivated(existing, change.reason, { clientName: name, alert: deps.alert, now }))
      ) {
        report.reactivated.push({ leadId: existing.id, name: existing.contactName, reason: change.reason });
      }
      continue;
    }

    const decision = classifyForEnrollment(opp, ctx);
    if (!decision.eligible) {
      skip(decision.reason);
      continue;
    }
    if (await deps.hasPendingIrisCall(opp.contactId)) {
      skip("iris call pending");
      continue;
    }

    const stage = ctx.stageNames[opp.pipelineStageId];
    const entry = { opportunityId: opp.id, name: opp.contact?.name ?? null, stage };
    if (dryRun) {
      report.eligible.push({ ...entry, contactId: opp.contactId, intent: detectIntent(opp, stage, config), inquiryAt: opp.createdAt });
      continue;
    }
    const lead = await enrollLead({
      clientId,
      ghlContactId: opp.contactId,
      ghlOpportunityId: opp.id,
      contactName: opp.contact?.name ?? null,
      phone: opp.contact?.phone ?? null,
      email: opp.contact?.email ?? null,
      intent: detectIntent(opp, stage, config),
      enrolledStageId: opp.pipelineStageId,
      enrolledStageName: stage,
      lastGhlActivityAt: opp.lastStageChangeAt ?? opp.createdAt,
      inquiryAt: opp.createdAt,
      nextTouchAt: firstTouchAt(now, config.outreach.touchScheduleDays)?.toISOString() ?? null,
    });
    if (lead) report.enrolled.push(entry);
  }
  return report;
}
