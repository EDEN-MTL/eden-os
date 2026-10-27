/**
 * Iris's morning summary in #backend-ops: yesterday in numbers, what is lined up today, and anything that
 * needs a person. Mark, 2026-10-27: one post a day instead of asking "any update?" and checking by hand.
 * Read-only against our own tables; it never calls GHL, so it cannot slow anything down or change anything.
 */
import { readdirSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { sendMessage } from "../../shared/slack";
import { loadIrisConfig } from "./index";
import { formatLocal } from "./cadence";
import { localDayBounds } from "./teammate-calls";
import { reviewCall } from "./call-review";
import { callAnswered } from "./followup-cohort";

export interface SummaryCall {
  name: string;
  endedReason: string | null;
  transcript: string | null;
  durationSeconds: number | null;
  /** Flags the automatic review raised for this call (empty when it was fine). */
  flags: string[];
}

export interface SummaryData {
  dayLabel: string;
  calls: SummaryCall[];
  appointments: string[];
  liveTransfers: number;
  newLeads: string[];
  handedToAPerson: string[];
  skippedForTeammate: number;
  todayCalls: { name: string; at: string }[];
  waitingOnText: number;
  cohortActive: number;
  watchdogAlerts: number;
}

const names = (list: string[], max = 6): string => (list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`);

/** The post itself, pure. */
export function formatDailySummary(d: SummaryData): string {
  const answered = d.calls.filter((c) => callAnswered({ ended_reason: c.endedReason, transcript: c.transcript }));
  const unanswered = d.calls.filter((c) => /did-not-answer|voicemail/i.test(c.endedReason ?? ""));
  const other = d.calls.length - answered.length - unanswered.length;
  const lines: string[] = [`☀️ *Iris morning summary* — ${d.dayLabel}`, "", "*Yesterday*"];

  if (d.calls.length === 0) lines.push("• No calls were placed.");
  else
    lines.push(
      `• Calls: ${d.calls.length} placed · ${answered.length} reached a person · ${unanswered.length} no answer or voicemail` +
        (other > 0 ? ` · ${other} other (answered with no conversation, or ended early)` : "")
    );
  if (answered.length > 0) lines.push(`• Spoke with: ${names(answered.map((c) => c.name))}`);
  lines.push(`• Appointments booked: ${d.appointments.length}${d.appointments.length ? ` (${names(d.appointments)})` : ""} · Live transfers: ${d.liveTransfers}`);
  if (d.newLeads.length > 0) lines.push(`• New leads: ${d.newLeads.length} (${names(d.newLeads)})`);
  if (d.handedToAPerson.length > 0) lines.push(`• *Needs a person:* ${names(d.handedToAPerson)}`);
  if (d.skippedForTeammate > 0) lines.push(`• Left alone because a teammate is already talking to them: ${d.skippedForTeammate}`);

  lines.push("", "*Today*");
  if (d.todayCalls.length === 0) lines.push("• No calls lined up yet.");
  else lines.push(`• Calls lined up: ${d.todayCalls.length} — ${names(d.todayCalls.map((c) => `${c.name} ${c.at}`), 8)}`);
  if (d.waitingOnText > 0) lines.push(`• Waiting on a text reply: ${d.waitingOnText}`);
  if (d.cohortActive > 0) lines.push(`• In this week's follow-up group: ${d.cohortActive}`);

  const flagged = d.calls.filter((c) => c.flags.length > 0);
  if (flagged.length > 0 || d.watchdogAlerts > 0) {
    lines.push("", "*Worth a look*");
    for (const c of flagged.slice(0, 5)) lines.push(`• ${c.name}: ${c.flags[0]}`);
    if (flagged.length > 5) lines.push(`• …and ${flagged.length - 5} more flagged calls`);
    if (d.watchdogAlerts > 0) lines.push(`• The watchdog raised ${d.watchdogAlerts} alert${d.watchdogAlerts === 1 ? "" : "s"} in the last 24 hours`);
  } else {
    lines.push("", "✅ Nothing flagged: every call passed its automatic review and the watchdog is quiet.");
  }
  return lines.join("\n");
}

/** Turns a stored end-of-call report into the transcript lines the review reads. */
function linesOf(raw: any): { role: string; message: string }[] {
  return ((raw?.messages ?? raw?.artifact?.messages ?? []) as any[])
    .filter((m) => typeof m?.message === "string" && m.message.trim() !== "" && ["user", "bot", "assistant"].includes(m?.role))
    .map((m) => ({ role: m.role as string, message: m.message as string }));
}

export async function gatherSummary(clientId: string, now: Date, timeZone: string, isMachine: (raw: any) => boolean): Promise<SummaryData> {
  const y = localDayBounds(now, 1, timeZone);
  const t = localDayBounds(now, 0, timeZone);

  const callRows = await query<{ contact_id: string; ended_reason: string | null; transcript: string | null; raw: any; name: string | null }>(
    `SELECT l.contact_id, l.ended_reason, l.transcript, l.raw, p.lead->>'name' AS name
     FROM iris_call_log l LEFT JOIN iris_pending_calls p ON p.client_id = l.client_id AND p.contact_id = l.contact_id
     WHERE l.client_id = $1 AND l.status = 'ended' AND l.created_at >= $2 AND l.created_at < $3
     ORDER BY l.created_at`,
    [clientId, y.start, y.end]
  );
  const calls: SummaryCall[] = callRows.map((r) => {
    const duration = Number(r.raw?.durationSeconds ?? 0) || null;
    const review = reviewCall({ lines: linesOf(r.raw), endedReason: r.ended_reason, durationSeconds: duration, machineOnly: isMachine(r.raw) });
    return { name: r.name ?? r.contact_id, endedReason: r.ended_reason, transcript: r.transcript, durationSeconds: duration, flags: review.verdict === "attention" ? review.flags : [] };
  });

  const nameOf = (rows: { name: string | null; contact_id: string }[]) => rows.map((r) => r.name ?? r.contact_id);
  const appts = await query<{ name: string | null; contact_id: string }>(
    `SELECT p.lead->>'name' AS name, a.contact_id FROM appointment_posts a LEFT JOIN iris_pending_calls p ON p.client_id = a.client_id AND p.contact_id = a.contact_id
     WHERE a.client_id = $1 AND a.posted_at >= $2 AND a.posted_at < $3`,
    [clientId, y.start, y.end]
  );
  const transfers = await query<{ n: number }>(`SELECT count(*)::int AS n FROM live_transfer_posts WHERE client_id = $1 AND posted_at >= $2 AND posted_at < $3`, [clientId, y.start, y.end]);
  const fresh = await query<{ name: string | null; contact_id: string }>(
    `SELECT lead->>'name' AS name, contact_id FROM iris_pending_calls WHERE client_id = $1 AND created_at >= $2 AND created_at < $3 AND source IS NULL ORDER BY created_at`,
    [clientId, y.start, y.end]
  );
  const handed = await query<{ name: string | null; contact_id: string }>(
    `SELECT lead->>'name' AS name, contact_id FROM iris_pending_calls
     WHERE client_id = $1 AND resolved_at >= $2 AND resolved_at < $3 AND resolution_reason ~* '(handed off|needs a human|human follow)'`,
    [clientId, y.start, y.end]
  );
  const skipped = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM iris_pending_calls WHERE client_id = $1 AND resolved_at >= $2 AND resolved_at < $3 AND resolution_reason ~* 'teammate'`,
    [clientId, y.start, y.end]
  );
  const today = await query<{ name: string | null; contact_id: string; call_after: Date }>(
    `SELECT lead->>'name' AS name, contact_id, call_after FROM iris_pending_calls
     WHERE client_id = $1 AND status = 'pending' AND call_after >= $2 AND call_after < $3 ORDER BY call_after`,
    [clientId, now, t.end]
  );
  const waiting = await query<{ n: number }>(`SELECT count(*)::int AS n FROM iris_pending_calls WHERE client_id = $1 AND status = 'pending' AND call_after = 'infinity'`, [clientId]);
  const cohort = await query<{ n: number }>(`SELECT count(*)::int AS n FROM iris_followup_cohort WHERE client_id = $1 AND status = 'active'`, [clientId]).catch(() => [{ n: 0 }]);
  const alerts = await query<{ n: number }>(`SELECT count(*)::int AS n FROM watchdog_alerts WHERE last_alert_at > now() - interval '24 hours'`).catch(() => [{ n: 0 }]);

  return {
    dayLabel: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now),
    calls,
    appointments: nameOf(appts),
    liveTransfers: transfers[0]?.n ?? 0,
    newLeads: nameOf(fresh),
    handedToAPerson: nameOf(handed),
    skippedForTeammate: skipped[0]?.n ?? 0,
    todayCalls: today.map((r) => ({ name: r.name ?? r.contact_id, at: formatLocal(new Date(r.call_after).toISOString(), timeZone).replace(/^.* at /, "") })),
    waitingOnText: waiting[0]?.n ?? 0,
    cohortActive: cohort[0]?.n ?? 0,
    watchdogAlerts: alerts[0]?.n ?? 0,
  };
}

function clientIdsWithSummary(): string[] {
  try {
    return readdirSync(join(process.cwd(), "config", "clients"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => loadIrisConfig(id)?.dailySummary);
  } catch {
    return [];
  }
}

/** Scheduler entry point (once each morning). Posts once per client per local day, even if it runs twice. */
export async function runDailySummary(now: Date = new Date()): Promise<void> {
  for (const clientId of clientIdsWithSummary()) {
    try {
      const config = loadIrisConfig(clientId)!;
      const timeZone = config.timezone || "America/St_Johns";
      const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const claim = await query<{ client_id: string }>(
        `INSERT INTO daily_summaries (client_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING client_id`,
        [clientId, day]
      );
      if (claim.length === 0) continue;
      // Loaded here, not at the top: the webhook module is large and imports a lot.
      const hooks = await import("../../webhooks/vapi-webhook");
      const isMachine = (raw: any) => hooks.hitCallScreener(raw) || hooks.hitVoicemailGreeting(raw);
      const data = await gatherSummary(clientId, now, timeZone, isMachine);
      await sendMessage("iris", { channel: config.dailySummary!.channel, text: formatDailySummary(data) });
    } catch (error) {
      console.error(`[SUMMARY] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
