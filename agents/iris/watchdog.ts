/**
 * Iris's watchdog: finds trouble before a person has to. Mark, 2026-10-27: most of this month's problems (a
 * silent answered call, Iris speaking into a voicemail, a text that was just a contact id) were found because he
 * happened to look. This watches for the ones a machine can see, and DMs the people in iris.callAlerts.
 *
 *   - the call scheduler stopped running (it writes a heartbeat every minute)
 *   - a call that is due has sat unplaced for 30+ minutes
 *   - a call started but its end-of-call report never arrived (20+ minutes)
 *   - a text was refused by the outbound guard (shared/ghl/outbound-guard.ts)
 *   - the server restarted (a deploy or a crash), posted to #backend-ops
 *
 * Each kind of problem alerts once, then stays quiet for a cooldown, so a stuck row is not a flood.
 * Per-call checks (silent calls, speech into voicemail, odd figures) live in call-review.ts.
 */
import { readdirSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { sendMessage } from "../../shared/slack";
import { setBlockedTextHandler } from "../../shared/ghl/outbound-guard";
import { loadIrisConfig } from "./index";

/** #backend-ops */
const BACKEND_OPS_CHANNEL = process.env.WATCHDOG_CHANNEL || "C0BLPMHNXL1";

export const DUE_CALL_LATE_MINUTES = 30;
export const CALL_NO_REPORT_MINUTES = 20;
export const HEARTBEAT_STALE_MINUTES = 10;
/** A fresh deploy has not had a minute to write its first heartbeat. */
const STARTUP_GRACE_MINUTES = 10;

export interface WatchdogSnapshot {
  /** Minutes since the call scheduler last ran, or null when it never has. */
  heartbeatAgeMinutes: number | null;
  /** Minutes this server process has been up. */
  uptimeMinutes: number;
  lateCalls: { name: string; minutesLate: number }[];
  silentCalls: { name: string; minutesAgo: number }[];
}

export interface Problem {
  key: string;
  text: string;
  cooldownHours: number;
}

/** The whole judgement, pure. */
export function findProblems(s: WatchdogSnapshot): Problem[] {
  const out: Problem[] = [];
  if (s.uptimeMinutes >= STARTUP_GRACE_MINUTES && s.heartbeatAgeMinutes !== null && s.heartbeatAgeMinutes > HEARTBEAT_STALE_MINUTES) {
    out.push({
      key: "scheduler-stalled",
      text: `🛑 *Iris's call scheduler has not run for ${Math.round(s.heartbeatAgeMinutes)} minutes.* No calls are going out. The server is up, so the scheduled job is stuck — it needs a look (or a restart).`,
      cooldownHours: 1,
    });
  }
  if (s.lateCalls.length > 0) {
    out.push({
      key: "calls-overdue",
      text: `⏰ *${s.lateCalls.length} call${s.lateCalls.length === 1 ? " is" : "s are"} overdue* (due ${DUE_CALL_LATE_MINUTES}+ minutes ago and still not placed): ${s.lateCalls.slice(0, 8).map((c) => `${c.name} (${Math.round(c.minutesLate)} min late)`).join(", ")}.`,
      cooldownHours: 3,
    });
  }
  if (s.silentCalls.length > 0) {
    out.push({
      key: "calls-no-report",
      text: `📡 *${s.silentCalls.length} call${s.silentCalls.length === 1 ? "" : "s"} never reported back* (started ${CALL_NO_REPORT_MINUTES}+ minutes ago, no end-of-call report): ${s.silentCalls.slice(0, 8).map((c) => `${c.name} (${Math.round(c.minutesAgo)} min ago)`).join(", ")}. Vapi's report may not be reaching the server.`,
      cooldownHours: 3,
    });
  }
  return out;
}

function clientIds(): string[] {
  try {
    return readdirSync(join(process.cwd(), "config", "clients")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Everyone who is DMed about trouble: the union of iris.callAlerts across clients. */
export function alertRecipients(): string[] {
  const ids = new Set<string>();
  for (const id of clientIds()) for (const u of loadIrisConfig(id)?.callAlerts?.userIds ?? []) ids.add(u);
  return [...ids];
}

/** Sends the alert once per cooldown. Returns whether it went out. */
export async function alertOnce(key: string, text: string, cooldownHours: number): Promise<boolean> {
  const claimed = await query<{ key: string }>(
    `INSERT INTO watchdog_alerts (key, last_alert_at, times) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET last_alert_at = now(), times = watchdog_alerts.times + 1
       WHERE watchdog_alerts.last_alert_at < now() - ($2 || ' hours')::interval
     RETURNING key`,
    [key, String(cooldownHours)]
  );
  if (claimed.length === 0) return false;
  const recipients = alertRecipients();
  const targets = recipients.length > 0 ? recipients : [BACKEND_OPS_CHANNEL];
  for (const channel of targets) {
    await sendMessage("iris", { channel, text }).catch((error) => {
      console.error(`[WATCHDOG] Could not deliver an alert to ${channel}:`, error instanceof Error ? error.message : error);
    });
  }
  return true;
}

export async function recordHeartbeat(name: string): Promise<void> {
  await query(
    `INSERT INTO watchdog_heartbeats (name, at) VALUES ($1, now())
     ON CONFLICT (name) DO UPDATE SET at = now()`,
    [name]
  ).catch((error) => console.error("[WATCHDOG] heartbeat failed:", error instanceof Error ? error.message : error));
}

async function takeSnapshot(): Promise<WatchdogSnapshot> {
  const beat = await query<{ minutes: number }>(`SELECT extract(epoch FROM (now() - at)) / 60 AS minutes FROM watchdog_heartbeats WHERE name = 'dial-pending'`);
  const late = await query<{ name: string | null; contact_id: string; minutes: number }>(
    `SELECT lead->>'name' AS name, contact_id, extract(epoch FROM (now() - call_after)) / 60 AS minutes
     FROM iris_pending_calls
     WHERE status = 'pending' AND call_after < now() - ($1 || ' minutes')::interval
     ORDER BY call_after ASC LIMIT 20`,
    [String(DUE_CALL_LATE_MINUTES)]
  );
  const silent = await query<{ name: string | null; contact_id: string; minutes: number }>(
    `SELECT p.lead->>'name' AS name, l.contact_id, extract(epoch FROM (now() - l.created_at)) / 60 AS minutes
     FROM iris_call_log l LEFT JOIN iris_pending_calls p ON p.client_id = l.client_id AND p.contact_id = l.contact_id
     WHERE l.status = 'initiated' AND l.created_at < now() - ($1 || ' minutes')::interval AND l.created_at > now() - interval '2 days'
     ORDER BY l.created_at ASC LIMIT 20`,
    [String(CALL_NO_REPORT_MINUTES)]
  );
  return {
    heartbeatAgeMinutes: beat[0] ? Number(beat[0].minutes) : null,
    uptimeMinutes: process.uptime() / 60,
    lateCalls: late.map((r) => ({ name: r.name ?? r.contact_id, minutesLate: Number(r.minutes) })),
    silentCalls: silent.map((r) => ({ name: r.name ?? r.contact_id, minutesAgo: Number(r.minutes) })),
  };
}

/** Scheduler entry point. Never throws: a watchdog that crashes is worse than none. */
export async function runWatchdog(): Promise<void> {
  try {
    for (const problem of findProblems(await takeSnapshot())) await alertOnce(problem.key, problem.text, problem.cooldownHours);
  } catch (error) {
    console.error("[WATCHDOG] check failed:", error instanceof Error ? error.message : error);
  }
}

/** "Deployed" / "restarted" note in #backend-ops, so nobody has to poll the health check to know a deploy landed. */
export async function announceStartup(): Promise<void> {
  const commit = process.env.RENDER_GIT_COMMIT;
  if (!commit) return; // only on Render; a laptop dev server is not news
  try {
    await sendMessage("iris", { channel: BACKEND_OPS_CHANNEL, text: `🚀 EDEN OS is up on commit \`${commit.slice(0, 7)}\` (a deploy or a restart).` });
  } catch (error) {
    console.error("[WATCHDOG] startup note failed:", error instanceof Error ? error.message : error);
  }
}

// A text the outbound guard refuses is reported at once, once per distinct problem per contact per hour.
setBlockedTextHandler((info) => {
  void alertOnce(
    `blocked-text:${info.contactId}:${info.problem}`,
    `🛑 *Blocked a text that would have gone to a lead* (contact ${info.contactId}): ${info.problem}. It started with: “${info.body.slice(0, 80)}”. Nothing was sent; the code that built it needs a look.`,
    1
  ).catch(() => {});
});
