/**
 * All ember_* database access. Every other module in this agent goes
 * through here rather than writing SQL, so the DB shape (snake_case) and the
 * domain shape (camelCase) only meet in one file — same split as
 * agents/quarry/store.ts.
 */
import { randomUUID } from "crypto";
import { query } from "../../shared/db";
import { NurtureChannel, NurtureLead, NurtureStatus } from "./types";

interface LeadRow {
  id: string | number;
  client_id: string;
  ghl_contact_id: string;
  ghl_opportunity_id: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  status_reason: string | null;
  enrolled_stage_id: string | null;
  enrolled_stage_name: string | null;
  last_ghl_activity_at: Date | string | null;
  inquiry_at: Date | string | null;
  entered_at: Date | string;
  touch_count: number;
  last_touch_at: Date | string | null;
  next_touch_at: Date | string | null;
  replied_at: Date | string | null;
  reactivated_at: Date | string | null;
  unsubscribe_token: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** node-postgres returns TIMESTAMPTZ as a Date; the domain type is ISO strings. */
function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export function rowToLead(r: LeadRow): NurtureLead {
  return {
    // BIGSERIAL comes back as a string — coerced so === comparisons work.
    id: Number(r.id),
    clientId: r.client_id,
    ghlContactId: r.ghl_contact_id,
    ghlOpportunityId: r.ghl_opportunity_id,
    contactName: r.contact_name,
    phone: r.phone,
    email: r.email,
    status: r.status as NurtureStatus,
    statusReason: r.status_reason,
    enrolledStageId: r.enrolled_stage_id,
    enrolledStageName: r.enrolled_stage_name,
    lastGhlActivityAt: iso(r.last_ghl_activity_at),
    inquiryAt: iso(r.inquiry_at),
    enteredAt: iso(r.entered_at)!,
    touchCount: r.touch_count,
    lastTouchAt: iso(r.last_touch_at),
    nextTouchAt: iso(r.next_touch_at),
    repliedAt: iso(r.replied_at),
    reactivatedAt: iso(r.reactivated_at),
    unsubscribeToken: r.unsubscribe_token,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export interface EnrollInput {
  clientId: string;
  ghlContactId: string;
  ghlOpportunityId: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  enrolledStageId: string;
  enrolledStageName: string | null;
  lastGhlActivityAt: string | null;
  inquiryAt: string | null;
  nextTouchAt: string | null;
}

/**
 * Enrolls a dormant opportunity. ON CONFLICT DO NOTHING on
 * (client_id, ghl_opportunity_id), so an opportunity is enrolled at most
 * once ever — a lead that finished the cadence or opted out is never
 * silently re-enrolled by the next hourly scan. Returns null on conflict.
 */
export async function enrollLead(input: EnrollInput): Promise<NurtureLead | null> {
  const rows = await query<LeadRow>(
    `INSERT INTO ember_nurture_leads (
       client_id, ghl_contact_id, ghl_opportunity_id, contact_name, phone, email,
       enrolled_stage_id, enrolled_stage_name, last_ghl_activity_at, inquiry_at,
       next_touch_at, unsubscribe_token
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_id, ghl_opportunity_id) DO NOTHING
     RETURNING *`,
    [
      input.clientId,
      input.ghlContactId,
      input.ghlOpportunityId,
      input.contactName,
      input.phone,
      input.email,
      input.enrolledStageId,
      input.enrolledStageName,
      input.lastGhlActivityAt,
      input.inquiryAt,
      input.nextTouchAt,
      randomUUID(),
    ]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

/** Column names allowed through updateLead, so a caller typo can't build SQL. */
const UPDATABLE: Record<string, string> = {
  status: "status",
  statusReason: "status_reason",
  phone: "phone",
  email: "email",
  touchCount: "touch_count",
  lastTouchAt: "last_touch_at",
  nextTouchAt: "next_touch_at",
  repliedAt: "replied_at",
  reactivatedAt: "reactivated_at",
};

export type LeadPatch = Partial<Record<keyof typeof UPDATABLE, unknown>>;

export async function updateLead(id: number, patch: LeadPatch): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATABLE[key];
    if (!column) throw new Error(`ember updateLead: unknown field "${key}"`);
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return;
  values.push(id);
  await query(
    `UPDATE ember_nurture_leads SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
    values
  );
}

/**
 * Applies `patch` only if the row is still in one of `from` — a
 * compare-and-set in one statement. The scan, a webhook and the pre-send
 * recheck can all notice the same stage move within seconds; whichever
 * lands first wins and the others see false, so the team gets one alert,
 * not three.
 */
export async function transitionStatus(id: number, from: string[], patch: LeadPatch): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATABLE[key];
    if (!column) throw new Error(`ember transitionStatus: unknown field "${key}"`);
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  values.push(id, from);
  const rows = await query<{ id: string }>(
    `UPDATE ember_nurture_leads SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${values.length - 1} AND status = ANY($${values.length}::text[])
      RETURNING id`,
    values
  );
  return rows.length > 0;
}

export async function getLead(id: number): Promise<NurtureLead | null> {
  const rows = await query<LeadRow>("SELECT * FROM ember_nurture_leads WHERE id = $1", [id]);
  return rows[0] ? rowToLead(rows[0]) : null;
}

/**
 * Every tracked opportunity for a client, keyed by opportunity id — the
 * scan diffs GHL's live pipeline against this in one pass.
 */
export async function trackedByOpportunity(clientId: string): Promise<Map<string, NurtureLead>> {
  const rows = await query<LeadRow>("SELECT * FROM ember_nurture_leads WHERE client_id = $1", [clientId]);
  return new Map(rows.map((r) => [r.ghl_opportunity_id, rowToLead(r)]));
}

export async function getLeadByOpportunityId(opportunityId: string): Promise<NurtureLead | null> {
  const rows = await query<LeadRow>(
    "SELECT * FROM ember_nurture_leads WHERE ghl_opportunity_id = $1 ORDER BY id DESC LIMIT 1",
    [opportunityId]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

/**
 * Leads still in play for a contact. GHL contact ids are unique across
 * locations, so this needs no client id — the webhook handlers only have
 * the contact id to go on. `completed` is included so a reply to the LAST
 * touch (sent moments before the row flips to completed) is still caught.
 */
export async function listOpenLeadsByContactId(contactId: string): Promise<NurtureLead[]> {
  const rows = await query<LeadRow>(
    `SELECT * FROM ember_nurture_leads
      WHERE ghl_contact_id = $1 AND status IN ('nurturing', 'paused', 'completed')
      ORDER BY id`,
    [contactId]
  );
  return rows.map(rowToLead);
}

export async function listLeads(options: {
  clientId: string;
  status?: NurtureStatus;
  limit?: number;
}): Promise<NurtureLead[]> {
  const values: unknown[] = [options.clientId];
  let where = "client_id = $1";
  if (options.status) {
    values.push(options.status);
    where += ` AND status = $${values.length}`;
  }
  values.push(options.limit ?? 50);
  const rows = await query<LeadRow>(
    `SELECT * FROM ember_nurture_leads WHERE ${where}
      ORDER BY next_touch_at NULLS LAST, id LIMIT $${values.length}`,
    values
  );
  return rows.map(rowToLead);
}

/** Nurturing leads whose next touch is due, oldest-due first. */
export async function listDue(clientId: string, now: Date = new Date()): Promise<NurtureLead[]> {
  const rows = await query<LeadRow>(
    `SELECT * FROM ember_nurture_leads
      WHERE client_id = $1 AND status = 'nurturing'
        AND next_touch_at IS NOT NULL AND next_touch_at <= $2
      ORDER BY next_touch_at, id`,
    [clientId, now.toISOString()]
  );
  return rows.map(rowToLead);
}

/**
 * Whether Iris still has a pending first-contact call queued for this
 * contact. A lead Iris is about to phone is not dormant, whatever its card
 * says — and a nurture text landing minutes before Iris's call reads as
 * two unrelated systems, because it is.
 */
export async function hasPendingIrisCall(clientId: string, contactId: string): Promise<boolean> {
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM iris_pending_calls
      WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`,
    [clientId, contactId]
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function logSend(entry: {
  clientId: string;
  leadId: number;
  touchIndex: number;
  channel: NurtureChannel;
  messageContent: string;
  ghlMessageId?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO ember_send_log
       (client_id, lead_id, touch_index, channel, message_content, ghl_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.clientId,
      entry.leadId,
      entry.touchIndex,
      entry.channel,
      entry.messageContent,
      entry.ghlMessageId ?? null,
      entry.error ?? null,
    ]
  );
}

/** Successful sends in the last 24h, for the daily cap. Failed sends don't count. */
export async function sendsToday(clientId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ember_send_log
      WHERE client_id = $1 AND error IS NULL AND sent_at > now() - interval '1 day'`,
    [clientId]
  );
  return Number(rows[0]?.count ?? 0);
}

export interface EmberStats {
  byStatus: Record<string, number>;
  dueNow: number;
  sentToday: { sms: number; email: number; failed: number };
  sentTotal: number;
  reactivatedLast30Days: number;
}

export async function getStats(clientId: string): Promise<EmberStats> {
  const [statusRows, dueRows, todayRows, totalRows, reactRows] = await Promise.all([
    query<{ status: string; count: string }>(
      `SELECT status, count(*) FROM ember_nurture_leads WHERE client_id = $1 GROUP BY status`,
      [clientId]
    ),
    query<{ count: string }>(
      `SELECT count(*) FROM ember_nurture_leads
        WHERE client_id = $1 AND status = 'nurturing' AND next_touch_at <= now()`,
      [clientId]
    ),
    query<{ channel: string; failed: boolean; count: string }>(
      `SELECT channel, (error IS NOT NULL) AS failed, count(*) FROM ember_send_log
        WHERE client_id = $1 AND sent_at > now() - interval '1 day'
        GROUP BY channel, (error IS NOT NULL)`,
      [clientId]
    ),
    query<{ count: string }>(
      `SELECT count(*) FROM ember_send_log WHERE client_id = $1 AND error IS NULL`,
      [clientId]
    ),
    query<{ count: string }>(
      `SELECT count(*) FROM ember_nurture_leads
        WHERE client_id = $1 AND reactivated_at > now() - interval '30 days'`,
      [clientId]
    ),
  ]);

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.count);
  const sentToday = { sms: 0, email: 0, failed: 0 };
  for (const r of todayRows) {
    if (r.failed) sentToday.failed += Number(r.count);
    else if (r.channel === "sms") sentToday.sms += Number(r.count);
    else if (r.channel === "email") sentToday.email += Number(r.count);
  }
  return {
    byStatus,
    dueNow: Number(dueRows[0]?.count ?? 0),
    sentToday,
    sentTotal: Number(totalRows[0]?.count ?? 0),
    reactivatedLast30Days: Number(reactRows[0]?.count ?? 0),
  };
}

/**
 * Marks a lead opted out by its unsubscribe token and returns it, or null
 * for an unknown token. Opt-out is terminal — nothing flips it back.
 */
export async function unsubscribeByToken(token: string): Promise<NurtureLead | null> {
  const rows = await query<LeadRow>(
    `UPDATE ember_nurture_leads
        SET status = 'opted_out', status_reason = 'unsubscribe link', next_touch_at = NULL, updated_at = now()
      WHERE unsubscribe_token = $1
      RETURNING *`,
    [token]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}
