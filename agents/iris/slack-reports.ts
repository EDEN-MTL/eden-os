import { query } from "../../shared/db";
import { getContact, getContactAppointments, listLocationUsers } from "../../shared/ghl";
import { formatLocal } from "./cadence";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { recentTexts } from "./text-signals";

/**
 * Read-only answers for Mark and Jacob in Slack (#iris-call-logs, DMs):
 * who's coming up, who was just captured, and everything Iris knows about one
 * lead. Mark, 2026-10-14: asked "who is on your list to call later?" and Iris
 * could only give counts, not names. Every function returns plain data for the
 * model to put into words — nothing here changes anything.
 */

export interface GhlAuth {
  locationId: string;
  apiKey: string;
}

interface QueueRow {
  contact_id: string;
  name: string | null;
  call_after: Date | string;
  status: string;
  attempts_made: number;
  callback_misses: number;
  is_explicit_callback: boolean;
  source: string | null;
  resolution_reason: string | null;
}

/**
 * Postgres hands a held row's call_after = 'infinity' back as the string
 * "infinity" (or Infinity / an invalid Date, depending on the driver path) —
 * never a usable Date. Normalise to epoch ms; non-finite means "waiting on the
 * lead's text reply, not on the clock".
 */
function callAfterMs(d: Date | string | number): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "number") return d;
  return /inf/i.test(d) ? Number.POSITIVE_INFINITY : Date.parse(d);
}
const isScheduled = (d: Date | string | number): boolean => Number.isFinite(callAfterMs(d));

function describeKind(row: QueueRow): string {
  if (row.source === "ember") return "Ember reactivation callback";
  if (row.source === "sweep") return "cold-lead sweep";
  if (row.is_explicit_callback) return row.callback_misses > 0 ? "callback (retry after a miss)" : "callback requested";
  return "regular outreach sequence";
}

export async function upcomingCalls(clientId: string, timezone: string, hoursAhead = 72) {
  const rows = await query<QueueRow>(
    `SELECT contact_id, lead->>'name' AS name, call_after, status, attempts_made, callback_misses, is_explicit_callback, source, resolution_reason
     FROM iris_pending_calls WHERE client_id = $1 AND status = 'pending' ORDER BY call_after ASC, id ASC`,
    [clientId]
  );
  const horizon = Date.now() + hoursAhead * 3_600_000;
  const scheduled = rows.filter((r) => isScheduled(r.call_after) && callAfterMs(r.call_after) <= horizon);
  const waiting = rows.filter((r) => !isScheduled(r.call_after));
  return {
    clientId,
    now: formatLocal(new Date().toISOString(), timezone),
    scheduledCount: scheduled.length,
    scheduled: scheduled.map((r) => ({
      name: r.name ?? "(unknown name)",
      when: formatLocal(new Date(callAfterMs(r.call_after)).toISOString(), timezone),
      overdue: callAfterMs(r.call_after) < Date.now(),
      kind: describeKind(r),
      attemptsSoFar: r.attempts_made,
      note: r.resolution_reason,
    })),
    waitingOnTextReply: waiting.map((r) => r.name ?? "(unknown name)"),
    note: `Scheduled = the next ${hoursAhead} hours. "waitingOnTextReply" leads have no call time: Iris texted them after a missed call and is waiting for their reply.`,
  };
}

export async function recentLeads(clientId: string, timezone: string, limit = 10) {
  const rows = await query<{ name: string | null; intent: string | null; created_at: Date; status: string; resolution_reason: string | null; attempts_made: number }>(
    `SELECT lead->>'name' AS name, lead->>'intent' AS intent, created_at, status, resolution_reason, attempts_made
     FROM iris_pending_calls WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [clientId, Math.min(Math.max(limit, 1), 25)]
  );
  return {
    clientId,
    leads: rows.map((r) => ({
      name: r.name ?? "(unknown name)",
      intent: r.intent,
      capturedAt: formatLocal(r.created_at.toISOString(), timezone),
      status: r.status,
      attemptsSoFar: r.attempts_made,
      note: r.resolution_reason,
    })),
  };
}

/** One lead, everything Iris knows — enough to answer "why isn't Iris calling X?". */
export async function leadOverview(clientId: string, contactId: string, timezone: string, ghl: GhlAuth, humanDays = DEFAULT_HUMAN_HANDS_OFF_DAYS) {
  const [contactResp, users, appointments, human, texts, pending, calls] = await Promise.all([
    getContact(contactId, ghl.locationId, ghl.apiKey).catch(() => null),
    listLocationUsers(ghl.locationId, ghl.apiKey).catch(() => []),
    getContactAppointments(contactId, ghl.locationId, ghl.apiKey).catch(() => []),
    checkHumanTouch(contactId, ghl.locationId, ghl.apiKey, humanDays),
    recentTexts(contactId, ghl.locationId, ghl.apiKey, 6),
    query<QueueRow>(
      `SELECT contact_id, lead->>'name' AS name, call_after, status, attempts_made, callback_misses, is_explicit_callback, source, resolution_reason
       FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`,
      [clientId, contactId]
    ),
    query<{ created_at: Date; ended_reason: string | null }>(
      `SELECT created_at, ended_reason FROM iris_call_log WHERE client_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 5`,
      [clientId, contactId]
    ),
  ]);
  const contact = (contactResp as any)?.contact ?? contactResp;
  const nameOf = (id?: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  const row = pending[0];
  const humanRaw = human.status === "human" ? { teammateTextedAt: formatLocal(new Date(human.at).toISOString(), timezone), by: nameOf(human.userId) ?? "a teammate" } : null;

  return {
    name: [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || contact?.name || null,
    phone: contact?.phone ?? null,
    tags: contact?.tags ?? [],
    assignedAgent: nameOf(contact?.assignedTo) ?? (contact?.assignedTo ? "(an agent not in the current user list)" : null),
    queue: row
      ? {
          status: row.status,
          nextCall: row.status === "pending" && isScheduled(row.call_after) ? formatLocal(new Date(callAfterMs(row.call_after)).toISOString(), timezone) : null,
          waitingOnTextReply: row.status === "pending" && !isScheduled(row.call_after),
          kind: describeKind(row),
          attemptsSoFar: row.attempts_made,
          reason: row.resolution_reason,
        }
      : "not in Iris's queue",
    recentCalls: calls.map((c) => ({ when: formatLocal(c.created_at.toISOString(), timezone), outcome: c.ended_reason })),
    teammateText: humanRaw ?? (human.status === "unknown" ? "couldn't read the text thread" : `none in the last ${humanDays} days`),
    appointments: appointments.map((a: any) => ({ when: a.startTime, status: a.appointmentStatus, with: nameOf(a.assignedUserId) })),
    recentTexts: texts.map((t) => ({ from: t.from === "lead" ? "lead" : t.source === "workflow" ? "automation" : "us", at: t.at ? formatLocal(t.at, timezone) : null, text: t.text.slice(0, 200) })),
  };
}
