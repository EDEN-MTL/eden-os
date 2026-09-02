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

/** Call once at server startup, after initDb() and initSlackClients(). */
export function startScheduler(): void {
  // Hourly rather than daily so Lens and the dashboard aren't reading
  // numbers that are up to a day stale. syncMetaPerformance is safe to run
  // this often — it deletes and reinserts per (level, day) on every call,
  // so an overlapping "last_7d" window each hour doesn't double-count.
  cron.schedule("0 * * * *", runMetaSync, { timezone: TIMEZONE });
  cron.schedule("0 8 * * 1", runWeeklyLensReport, { timezone: TIMEZONE });
  // Every minute, not hourly — this is resolving a 5-minute wait
  // (agents/iris/index.ts's CALL_DELAY_MINUTES), so it needs to actually
  // catch rows close to when they become due, not up to an hour late.
  cron.schedule("* * * * *", runDialPendingCalls, { timezone: TIMEZONE });
  console.log("[SCHEDULER] hourly Meta sync, weekly Lens report (Mon 08:00), and per-minute Iris dial queue scheduled");
}
