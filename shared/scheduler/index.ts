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
import { syncMetaPerformance } from "../../agents/forge/ads/sync";
import * as ruleEngine from "../../agents/forge/ads/engine";
import * as ruleQueue from "../../agents/forge/ads/queue";
import { computeWeeklyTotals, formatAllClientsReport, WeeklyTotals } from "../../agents/lens/report";
import { runDialPendingCalls } from "../../agents/iris/dial-pending";
import { sendMessage } from "../slack";

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
 * One combined report, every client, sent ONLY to Eden's internal ops
 * channel — never to a client's own Slack channel. Jacob was explicit
 * about this after the scheduler shipped: clients don't get an automated
 * weekly message, the team does.
 */
export async function runWeeklyLensReport(): Promise<void> {
  const opsChannel = process.env.LENS_OPS_CHANNEL;
  if (!opsChannel) {
    console.warn("[SCHEDULER] LENS_OPS_CHANNEL not set, skipping weekly Lens report");
    return;
  }

  const clientIds = await listMetaClientIds();
  const entries: { clientName: string; totals: WeeklyTotals }[] = [];
  for (const clientId of clientIds) {
    try {
      const cfg = loadClientJson(clientId);
      const totals = await computeWeeklyTotals(clientId);
      entries.push({ clientName: cfg?.clientName || clientId, totals });
    } catch (e) {
      console.error(`[SCHEDULER] Lens totals failed for ${clientId}:`, e instanceof Error ? e.message : e);
    }
  }
  if (!entries.length) {
    console.log("[SCHEDULER] no client totals computed, skipping Lens report");
    return;
  }

  try {
    const text = formatAllClientsReport(entries);
    await sendMessage("lens", { channel: opsChannel, text });
    console.log(`[SCHEDULER] Lens weekly report sent to internal ops channel (${entries.length} clients)`);
  } catch (e) {
    console.error("[SCHEDULER] Lens weekly report failed:", e instanceof Error ? e.message : e);
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
      proposed = await ruleEngine.evaluate(clientId);
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
        const text =
          `🔔 *Forge flagged something* — ${clientName}\n` +
          `${action.entityName ?? action.entityId} (${action.entityType})\n` +
          `${action.reasoning}\n` +
          `Review in the dashboard's pending actions, or ask Forge in chat.`;
        const { ts } = await sendMessage("forge", { channel: opsChannel, text });
        if (ts) await ruleQueue.recordSlackMessage(pendingId, opsChannel, ts);
      } catch (e) {
        console.error(`[SCHEDULER] Failed to queue/notify proposed action for ${clientId}:`, e instanceof Error ? e.message : e);
      }
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
  cron.schedule("0 8 * * 1", runWeeklyLensReport, { timezone: TIMEZONE });
  // Every minute, not hourly — this is resolving a 5-minute wait
  // (agents/iris/index.ts's CALL_DELAY_MINUTES), so it needs to actually
  // catch rows close to when they become due, not up to an hour late.
  cron.schedule("* * * * *", runDialPendingCalls, { timezone: TIMEZONE });
  console.log(
    "[SCHEDULER] hourly Meta sync, rule evaluation (5 past), weekly Lens report (Mon 08:00), and per-minute Iris dial queue scheduled"
  );
}
