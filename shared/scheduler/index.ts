/**
 * The one place anything in EDEN OS runs on its own. Before this, every
 * automation that existed in code — the Meta performance sync, Forge's
 * rule engine, Lens's reporting — only ever executed when someone ran a
 * script by hand. Nothing was actually operating without a human.
 *
 * Deliberately in-process (node-cron) rather than a separate Render cron
 * service: this is a single long-running Express process already, and
 * that's the simplest thing that closes the "nothing runs itself" gap.
 * Revisit if the web dyno ever moves to scale-to-zero, which would kill
 * these jobs silently.
 */
import cron from "node-cron";
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../db";
import { getMetaConfig, MetaClient } from "../meta";
import { getGhlConfig } from "../ghl";
import { syncGhl, syncMetaPerformance } from "../../agents/forge/ads/sync";
import * as ruleEngine from "../../agents/forge/ads/engine";
import * as ruleQueue from "../../agents/forge/ads/queue";
import { fetchLiveState, getCampaignHealth } from "../../agents/forge/ads/health";
import { formatHealthDigest } from "../../agents/forge/ads/health-digest";
import { computeTotals, computeWeeklyTotals, formatAllClientsReport, previousMonth, ReportEntry } from "../../agents/lens/report";
import { computeFunnel, formatFunnelLines, loadFunnelConfig } from "../../agents/lens/funnel";
import { runDialPendingCalls } from "../../agents/iris/dial-pending";
import { runNoShowScan } from "../../agents/iris/no-show";
import { runFollowUpCohortCheck } from "../../agents/iris/followup-cohort";
import { sendBlocks, sendMessage } from "../slack";
import { canApproveFromSlack, flagBlocks, runApprovalNudges } from "../../agents/forge/ads/approval";
import { listEmberClientIds, loadEmberConfig } from "../../agents/ember/config";
import { runEmberScanForClient } from "../../agents/ember/scan";
import { sendPendingForClient } from "../../agents/ember/send";
import { pollRepliesForClient } from "../../agents/ember/replies";

const TIMEZONE = "America/Toronto";

async function listMetaClientIds(): Promise<string[]> {
  const rows = await query<{ client_id: string }>(`SELECT DISTINCT client_id FROM meta_credentials`);
  return rows.map((r) => r.client_id);
}

function loadClientJson(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

export async function runMetaSync(): Promise<void> {
  const clientIds = await listMetaClientIds();
  for (const clientId of clientIds) {
    try {
      const cfg = await getMetaConfig(clientId);
      if (!cfg) {
        console.warn(`[SCHEDULER] no Meta config resolved for ${clientId}, skipping sync`);
        continue;
      }
      const n = await syncMetaPerformance(new MetaClient(cfg), "last_7d", clientId);
      console.log(`[SCHEDULER] synced ${n} rows for ${clientId}`);
    } catch (e) {
      console.error(`[SCHEDULER] Meta sync failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Pulls GHL leads into ad_leads with their Meta campaign/ad set/ad attached,
 * which is what lets CPL, ROAS and the Lens report count leads GHL can trace
 * to an ad (and their outcomes), not just Meta's own lead count.
 *
 * This existed (syncGhl / runFullSync) but nothing ever called it: found
 * 2026-10-14 that ad_leads hadn't been written since a manual run on
 * 2026-08-24, so every lead since then was invisible to Forge and Lens.
 *
 * Only for clients with both a Meta account and a GHL config, since a lead is
 * only useful here if there are ads to attribute it to.
 */
export async function runLeadSync(): Promise<void> {
  for (const clientId of await listMetaClientIds()) {
    try {
      const ghl = await getGhlConfig(clientId);
      if (!ghl) continue;
      const n = await syncGhl(ghl.locationId, clientId, ghl.attributionPipelineName, ghl.apiKey);
      console.log(`[SCHEDULER] GHL lead sync ${clientId}: ${n} leads`);
    } catch (e) {
      console.error(`[SCHEDULER] GHL lead sync failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * One combined report, every client, sent ONLY to Eden's internal ops
 * channel — never to a client's own Slack channel. Jacob was explicit
 * about this after the scheduler shipped: clients don't get an automated
 * weekly message, the team does.
 */
export async function runWeeklyLensReport(): Promise<void> {
  await runLensReport("weekly");
}

/**
 * Same report for the previous calendar month, on the 1st (Mark, 2026-10-20).
 * Adds the funnel of leads added that month next to the running total.
 */
export async function runMonthlyLensReport(): Promise<void> {
  await runLensReport("monthly");
}

const sinceLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Lead-funnel blocks for one client, only when it has a lens.funnel config:
 * the running total since the configured date in both reports, and, in the
 * monthly one, the leads added in that month.
 */
async function funnelSections(clientId: string, month: ReturnType<typeof previousMonth> | null): Promise<ReportEntry["sections"]> {
  const config = loadFunnelConfig(clientId);
  if (!config) return [];
  const sections: NonNullable<ReportEntry["sections"]> = [];
  if (month) {
    const m = await computeFunnel(clientId, config, month.since, month.nextMonthStart);
    sections.push({ heading: `Lead funnel: leads added in ${month.label}`, lines: formatFunnelLines(m, config) });
  }
  const all = await computeFunnel(clientId, config, config.since);
  sections.push({ heading: `Lead funnel: all leads since ${sinceLabel(config.since)}`, lines: formatFunnelLines(all, config) });
  return sections;
}

async function runLensReport(kind: "weekly" | "monthly"): Promise<void> {
  const opsChannel = process.env.LENS_OPS_CHANNEL;
  if (!opsChannel) {
    console.warn(`[SCHEDULER] LENS_OPS_CHANNEL not set, skipping ${kind} Lens report`);
    return;
  }

  const month = kind === "monthly" ? previousMonth() : null;
  const clientIds = await listMetaClientIds();
  const entries: ReportEntry[] = [];
  for (const clientId of clientIds) {
    try {
      const cfg = loadClientJson(clientId);
      const totals = month ? await computeTotals(clientId, month.since, month.until) : await computeWeeklyTotals(clientId);
      let sections: ReportEntry["sections"] = [];
      try {
        sections = await funnelSections(clientId, month);
      } catch (e) {
        // The funnel is an add-on; a failure there shouldn't drop the client's spend numbers.
        console.error(`[SCHEDULER] Lens funnel failed for ${clientId}:`, e instanceof Error ? e.message : e);
      }
      entries.push({ clientName: cfg?.clientName || clientId, totals, sections });
    } catch (e) {
      console.error(`[SCHEDULER] Lens totals failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
  if (!entries.length) {
    console.log(`[SCHEDULER] no client totals computed, skipping ${kind} Lens report`);
    return;
  }

  try {
    const title = month ? `Monthly ad performance — all clients (${month.label})` : undefined;
    const text = formatAllClientsReport(entries, title);
    await sendMessage("lens", { channel: opsChannel, text });
    console.log(`[SCHEDULER] Lens ${kind} report sent to internal ops channel (${entries.length} clients)`);
  } catch (e) {
    console.error(`[SCHEDULER] Lens ${kind} report failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Runs Forge's rules engine for every client with a Meta account and
 * queues + Slack-notifies anything a rule flags. This is what makes Forge
 * an actual full-time media buyer rather than a chat-only tool: the engine
 * and approval queue existed already (agents/forge/ads/engine.ts,
 * ./queue.ts) but nothing ever called them outside tests — a rule could be
 * enabled with autoExecute:true and it would still never fire, because
 * evaluate() was simply never invoked in production.
 *
 * Every rule seeded by rule-seed.ts is a notify_only action, so this never
 * touches the Meta API itself — it only decides something's worth a human
 * look and makes sure a human actually sees it, instead of it sitting
 * silent in ad_pending_actions until someone happens to check the
 * dashboard.
 */
export async function runRuleEvaluation(): Promise<void> {
  const opsChannel = process.env.LENS_OPS_CHANNEL;
  const clientIds = await listMetaClientIds();

  for (const clientId of clientIds) {
    let proposed: Awaited<ReturnType<typeof ruleEngine.evaluate>>;
    try {
      // Read what is running on Meta right now, so a flag stops coming back once the ad is turned off.
      // If Meta can't be read, judge on the snapshots as before rather than skip the check.
      let live: Awaited<ReturnType<typeof fetchLiveState>> | null = null;
      let metaClient: MetaClient | null = null;
      try {
        const metaConfig = await getMetaConfig(clientId);
        if (metaConfig) {
          metaClient = new MetaClient(metaConfig);
          live = await fetchLiveState(metaClient);
        }
      } catch (e) {
        console.warn(`[SCHEDULER] Couldn't read live ad status for ${clientId}; judging on snapshots only:`, e instanceof Error ? e.message : e);
      }
      // The CPL-threshold flag follows the health check: only what it calls a kill (see engine.gateByHealth).
      // No health target for this client, or Meta unreadable: the flat threshold rule works as before.
      let healthVerdicts: Map<string, { verdict: string; reasons: string[]; recommendation: string }> | null = null;
      if (live && metaClient) {
        try {
          const report = await getCampaignHealth(clientId, metaClient);
          healthVerdicts = new Map(report.entities.map((e) => [e.id, { verdict: e.verdict, reasons: e.reasons, recommendation: e.recommendation }]));
        } catch (e) {
          console.warn(`[SCHEDULER] No health verdicts for ${clientId}; CPL flags use the flat threshold:`, e instanceof Error ? e.message : e);
        }
      }
      proposed = await ruleEngine.evaluate(clientId, live, { healthVerdicts });
    } catch (e) {
      console.error(`[SCHEDULER] Rule evaluation failed for ${clientId}:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (proposed.length === 0) continue;

    const cfg = loadClientJson(clientId);
    const clientName = cfg?.clientName || clientId;

    for (const action of proposed) {
      try {
        const pendingId = await ruleQueue.enqueue(action, clientId);
        await ruleEngine.markTriggered(action.rule, action.entityId);
        console.log(`[SCHEDULER] Queued pending action ${pendingId} (${action.rule.id}) for ${clientId}`);

        if (!opsChannel) {
          console.warn("[SCHEDULER] LENS_OPS_CHANNEL not set, skipping Slack notification for queued action");
          continue;
        }
        // With approvers named for this client the flag carries Pause / Keep running buttons; without, it is the plain flag as before.
        const buttons = canApproveFromSlack(clientId, action.entityType);
        const text =
          `🔔 *Forge flagged something* — ${clientName}\n` +
          `${action.entityName ?? action.entityId} (${action.entityType})\n` +
          `${action.reasoning}\n` +
          (buttons ? "Pause it, or keep it running?" : "Review in the dashboard's pending actions, or ask Forge in chat.");
        const { ts } = buttons
          ? await sendBlocks("forge", opsChannel, flagBlocks(text, pendingId, action.entityType), text)
          : await sendMessage("forge", { channel: opsChannel, text });
        if (ts) await ruleQueue.recordSlackMessage(pendingId, opsChannel, ts);
      } catch (e) {
        console.error(`[SCHEDULER] Failed to queue/notify proposed action for ${clientId}:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

/**
 * Forge's morning health check, posted to Eden's internal ops channel, never
 * to a client's (same rule as the Lens weekly report).
 *
 * Opt-in per client: only clients whose config has a forge.health block get
 * one. The playbook's buyer/seller funnels and spend-relative kill lines are
 * built for realtor lead gen; running them on a client nobody calibrated
 * them for would post confident verdicts on the wrong yardstick.
 *
 * Skips a client with nothing delivering in the window rather than posting
 * an empty report every morning for a paused account.
 */
export async function runDailyForgeHealthReport(): Promise<void> {
  const opsChannel = process.env.LENS_OPS_CHANNEL;
  if (!opsChannel) {
    console.warn("[SCHEDULER] LENS_OPS_CHANNEL not set, skipping daily Forge health report");
    return;
  }

  for (const clientId of await listMetaClientIds()) {
    const cfg = loadClientJson(clientId);
    if (!cfg?.forge?.health) continue;
    try {
      const metaConfig = await getMetaConfig(clientId);
      const report = await getCampaignHealth(clientId, metaConfig ? new MetaClient(metaConfig) : null);
      if (report.entities.length === 0) {
        console.log(`[SCHEDULER] Forge health ${clientId}: nothing delivering, no report sent`);
        continue;
      }
      await sendMessage("forge", { channel: opsChannel, text: formatHealthDigest(cfg.clientName || clientId, report) });
      console.log(`[SCHEDULER] Forge health report sent for ${clientId} (${report.entities.length} entities)`);
    } catch (e) {
      console.error(`[SCHEDULER] Forge health report failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Ember only runs for clients with ember.enabled on — the scan as well as
 * sends, since the scan can post reactivation alerts. A client with the
 * block present but disabled is skipped silently every hour.
 */
function emberEnabledClientIds(): string[] {
  return listEmberClientIds().filter((id) => loadEmberConfig(id)?.enabled === true);
}

export async function runEmberScan(): Promise<void> {
  for (const clientId of emberEnabledClientIds()) {
    try {
      const r = await runEmberScanForClient(clientId);
      console.log(
        `[SCHEDULER] Ember scan ${clientId}: ${r.scanned} scanned, ${r.enrolled.length} enrolled, ` +
          `${r.reactivated.length} reactivated, ${r.exited.length} exited`
      );
    } catch (e) {
      console.error(`[SCHEDULER] Ember scan failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function runEmberSendPending(): Promise<void> {
  for (const clientId of emberEnabledClientIds()) {
    try {
      const r = await sendPendingForClient(clientId);
      if (r.ran) console.log(`[SCHEDULER] Ember sends ${clientId}: ${r.sent}/${r.due} sent, ${r.failed.length} failed`);
    } catch (e) {
      console.error(`[SCHEDULER] Ember send run failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function runEmberReplyPoll(): Promise<void> {
  for (const clientId of emberEnabledClientIds()) {
    try {
      const r = await pollRepliesForClient(clientId);
      if (r.routedToEmber || r.routedToIris) {
        console.log(`[SCHEDULER] Ember replies ${clientId}: ${r.routedToEmber} to Ember, ${r.routedToIris} to Iris (${r.checked} checked)`);
      }
    } catch (e) {
      console.error(`[SCHEDULER] Ember reply poll failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Call once at server startup, after initDb() and initSlackClients(). */
export function startScheduler(): void {
  // Hourly rather than daily so Lens and the dashboard aren't reading
  // numbers that are up to a day stale. syncMetaPerformance is safe to run
  // this often — it deletes and reinserts per (level, day) on every call,
  // so an overlapping "last_7d" window each hour doesn't double-count.
  cron.schedule("0 * * * *", runMetaSync, { timezone: TIMEZONE });
  // 5 minutes after the sync, not the same minute — gives runMetaSync time
  // to finish writing fresh numbers for every client before the engine
  // reads them.
  cron.schedule("5 * * * *", runRuleEvaluation, { timezone: TIMEZONE });
  // :50, so fresh lead attribution is in before the next :05 rule run and the
  // 08:15 health report. Clear of Ember's :40 sends and :20 scan.
  cron.schedule("50 * * * *", runLeadSync, { timezone: TIMEZONE });
  cron.schedule("0 8 * * 1", runWeeklyLensReport, { timezone: TIMEZONE });
  // 08:00 on the 1st, covering the month just ended.
  cron.schedule("0 8 1 * *", runMonthlyLensReport, { timezone: TIMEZONE });
  // 08:15 daily: after the 08:00 Meta sync has written fresh numbers, before
  // the team's working day. Same channel as the 08:00 Monday Lens report.
  cron.schedule("15 8 * * *", runDailyForgeHealthReport, { timezone: TIMEZONE });
  // Every minute, not hourly — this is resolving a 5-minute wait
  // (agents/iris/index.ts's CALL_DELAY_MINUTES), so it needs to actually
  // catch rows close to when they become due, not up to an hour late.
  cron.schedule("* * * * *", runDialPendingCalls, { timezone: TIMEZONE });
  // Every 10 minutes: one nudge in the thread of any Forge flag still unanswered after 2 hours (agents/forge/ads/approval.ts).
  cron.schedule("*/10 * * * *", () => runApprovalNudges().catch((e) => console.error("[SCHEDULER] Approval nudges failed:", e instanceof Error ? e.message : e)), { timezone: TIMEZONE });
  // Every 5 minutes: finds cards the team just moved to No-Show and starts Iris's follow-up (text now,
  // calls later). The first scan only records what is already in the column. See agents/iris/no-show.ts.
  cron.schedule("*/5 * * * *", runNoShowScan, { timezone: TIMEZONE });
  // Hourly at :35: the week-long follow-up on a hand-picked group (next call rounds, and the final move to
  // Not Ready / Not Interested). Does nothing while no group is enrolled. See agents/iris/followup-cohort.ts.
  cron.schedule("35 * * * *", () => runFollowUpCohortCheck(), { timezone: TIMEZONE });
  // 20 past, clear of the Meta sync (:00) and rule evaluation (:05) — the
  // scan paginates a whole pipeline through GHL and shouldn't compete.
  cron.schedule("20 * * * *", runEmberScan, { timezone: TIMEZONE });
  // Every 30 min; the send window itself is per-client local time (see
  // inSendWindow), so this can run around the clock and simply no-op at
  // night. sendPendingForClient's in-flight lock covers a batch that runs
  // longer than 30 minutes.
  cron.schedule("10,40 * * * *", runEmberSendPending, { timezone: TIMEZONE });
  // Every 2 minutes: a lead texting back expects an answer in minutes, not
  // half an hour. Cheap — two GHL reads per lead Ember has texted.
  cron.schedule("*/2 * * * *", runEmberReplyPoll, { timezone: TIMEZONE });
  console.log(
    "[SCHEDULER] hourly Meta sync, rule evaluation (5 past), GHL lead sync (50 past), weekly Lens report (Mon 08:00), monthly Lens report (1st, 08:00), daily Forge health report (08:15), per-minute Iris dial queue, " +
      "and Ember scan (20 past) / sends (10 & 40 past) / reply poll (every 2 min), enabled clients only, scheduled"
  );
}
