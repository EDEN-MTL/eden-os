/**
 * All quarry_* database access. Every other module in this agent goes
 * through here rather than writing SQL, so the DB shape (snake_case) and the
 * domain shape (camelCase) only meet in one file.
 */
import { randomUUID } from "crypto";
import { query } from "../../shared/db";
import {
  ApprovalStatus,
  PhoneLookup,
  PlacesResult,
  QuarryCategory,
  QuarryLead,
  QuarryRun,
  RunError,
  SendStep,
} from "./types";

interface LeadRow {
  id: string | number;
  client_id: string;
  place_id: string;
  name: string;
  formatted_address: string | null;
  phone: string | null;
  phone_line_type: string | null;
  is_mobile: boolean | null;
  email: string | null;
  email_source: string | null;
  has_public_email: boolean;
  website: string | null;
  category: string | null;
  search_query: string | null;
  rating: number | null;
  user_ratings_total: number | null;
  business_status: string | null;
  photo_refs: string[];
  is_candidate: boolean | null;
  reasons: string[];
  outdated_score: number | null;
  outdated_reasoning: string | null;
  preview_url: string | null;
  preview_image_url: string | null;
  generator: string | null;
  generation_error: string | null;
  ghl_contact_id: string | null;
  ghl_opportunity_id: string | null;
  pipeline_stage: string | null;
  approval_status: string;
  dncl_checked: boolean;
  holdout_reason: string | null;
  sent_at: string | null;
  replied_at: string | null;
  email_sent_at: string | null;
  email_replied_at: string | null;
  email_opted_out: boolean;
  email_nudge_count: number;
  email_unsubscribe_token: string | null;
  last_lookup_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToLead(r: LeadRow): QuarryLead {
  return {
    // BIGSERIAL comes back from node-postgres as a string, because a bigint
    // can exceed Number.MAX_SAFE_INTEGER. Coerced here so callers can compare
    // ids with === without tripping over "42" !== 42.
    id: Number(r.id),
    clientId: r.client_id,
    placeId: r.place_id,
    name: r.name,
    formattedAddress: r.formatted_address,
    phone: r.phone,
    phoneLineType: r.phone_line_type,
    isMobile: r.is_mobile,
    email: r.email,
    emailSource: r.email_source,
    hasPublicEmail: r.has_public_email,
    website: r.website,
    category: (r.category as QuarryCategory) ?? null,
    searchQuery: r.search_query,
    rating: r.rating,
    userRatingsTotal: r.user_ratings_total,
    businessStatus: r.business_status,
    photoRefs: r.photo_refs ?? [],
    isCandidate: r.is_candidate,
    reasons: r.reasons ?? [],
    outdatedScore: r.outdated_score,
    outdatedReasoning: r.outdated_reasoning,
    previewUrl: r.preview_url,
    previewImageUrl: r.preview_image_url,
    generator: r.generator,
    generationError: r.generation_error,
    ghlContactId: r.ghl_contact_id,
    ghlOpportunityId: r.ghl_opportunity_id,
    pipelineStage: r.pipeline_stage,
    approvalStatus: r.approval_status as ApprovalStatus,
    dnclChecked: r.dncl_checked,
    holdoutReason: r.holdout_reason,
    sentAt: r.sent_at,
    repliedAt: r.replied_at,
    emailSentAt: r.email_sent_at,
    emailRepliedAt: r.email_replied_at,
    emailOptedOut: r.email_opted_out,
    emailNudgeCount: r.email_nudge_count,
    emailUnsubscribeToken: r.email_unsubscribe_token,
    lastLookupAt: r.last_lookup_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * place_ids already looked at recently enough to skip.
 *
 * Dedup is by place_id and not by name — chains and near-duplicate listings
 * share names, and a business that moves keeps its place_id. Anything older
 * than the window comes back into the pool, because a business that had no
 * site last quarter may have one now (and vice versa).
 */
export async function recentlySeenPlaceIds(
  recheckAfterDays: number,
  clientId = "eden"
): Promise<Set<string>> {
  const rows = await query<{ place_id: string }>(
    `SELECT place_id FROM quarry_leads
      WHERE client_id = $1
        AND created_at > now() - ($2 || ' days')::interval`,
    [clientId, String(recheckAfterDays)]
  );
  return new Set(rows.map((r) => r.place_id));
}

/**
 * Inserts freshly discovered places. Returns only the rows that were actually
 * new — ON CONFLICT DO NOTHING means an existing place_id yields no row, so
 * the caller never re-triages or re-generates a business it has already seen.
 */
export async function insertDiscovered(
  places: PlacesResult[],
  clientId = "eden"
): Promise<QuarryLead[]> {
  const inserted: QuarryLead[] = [];
  for (const p of places) {
    // Generated up front rather than lazily at first send — every lead gets
    // an unsubscribe token whether or not it ends up going down the email
    // path, so sendEmailOne never has to branch on "does one exist yet".
    const rows = await query<LeadRow>(
      `INSERT INTO quarry_leads (
         client_id, place_id, name, formatted_address, phone, website,
         category, search_query, rating, user_ratings_total, business_status,
         photo_refs, email_unsubscribe_token
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (client_id, place_id) DO NOTHING
       RETURNING *`,
      [
        clientId,
        p.placeId,
        p.name,
        p.formattedAddress,
        p.phone,
        p.website,
        p.category,
        p.searchQuery,
        p.rating,
        p.userRatingsTotal,
        p.businessStatus,
        JSON.stringify(p.photoRefs),
        randomUUID(),
      ]
    );
    if (rows.length > 0) inserted.push(rowToLead(rows[0]));
  }
  return inserted;
}

/** Column names allowed through updateLead, so a caller typo can't build SQL. */
const UPDATABLE: Record<string, string> = {
  phone: "phone",
  phoneLineType: "phone_line_type",
  isMobile: "is_mobile",
  email: "email",
  emailSource: "email_source",
  hasPublicEmail: "has_public_email",
  isCandidate: "is_candidate",
  reasons: "reasons",
  outdatedScore: "outdated_score",
  outdatedReasoning: "outdated_reasoning",
  previewUrl: "preview_url",
  previewImageUrl: "preview_image_url",
  generator: "generator",
  generationError: "generation_error",
  ghlContactId: "ghl_contact_id",
  ghlOpportunityId: "ghl_opportunity_id",
  pipelineStage: "pipeline_stage",
  approvalStatus: "approval_status",
  dnclChecked: "dncl_checked",
  holdoutReason: "holdout_reason",
  sentAt: "sent_at",
  repliedAt: "replied_at",
  emailSentAt: "email_sent_at",
  emailRepliedAt: "email_replied_at",
  emailOptedOut: "email_opted_out",
  emailNudgeCount: "email_nudge_count",
  lastLookupAt: "last_lookup_at",
};

const JSON_COLUMNS = new Set(["reasons"]);

export async function updateLead(
  id: number,
  patch: Partial<Record<keyof typeof UPDATABLE, unknown>>
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATABLE[key];
    if (!column) throw new Error(`updateLead: unknown field "${key}"`);
    values.push(JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return;
  values.push(id);
  await query(
    `UPDATE quarry_leads SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
    values
  );
}

export async function getLead(id: number): Promise<QuarryLead | null> {
  const rows = await query<LeadRow>("SELECT * FROM quarry_leads WHERE id = $1", [id]);
  return rows[0] ? rowToLead(rows[0]) : null;
}

/** Looks up a lead by its GHL contact id — how an inbound reply webhook finds who replied. */
export async function getLeadByGhlContactId(
  contactId: string,
  clientId = "eden"
): Promise<QuarryLead | null> {
  const rows = await query<LeadRow>(
    "SELECT * FROM quarry_leads WHERE client_id = $1 AND ghl_contact_id = $2",
    [clientId, contactId]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

export async function getLeadByUnsubscribeToken(token: string): Promise<QuarryLead | null> {
  const rows = await query<LeadRow>(
    "SELECT * FROM quarry_leads WHERE email_unsubscribe_token = $1",
    [token]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

/**
 * Marks a lead opted out of email by its unsubscribe token. Idempotent.
 * Returns the full lead (not just a boolean) so the caller can mirror the
 * opt-out onto the GHL contact too — that needs ghlContactId + clientId,
 * which only the row itself carries.
 */
export async function unsubscribeByToken(token: string): Promise<QuarryLead | null> {
  const rows = await query<LeadRow>(
    `UPDATE quarry_leads SET email_opted_out = true, updated_at = now()
      WHERE email_unsubscribe_token = $1 RETURNING *`,
    [token]
  );
  return rows[0] ? rowToLead(rows[0]) : null;
}

export async function listLeads(
  filter: { clientId?: string; approvalStatus?: ApprovalStatus; stage?: string; category?: string } = {}
): Promise<QuarryLead[]> {
  const where: string[] = ["client_id = $1"];
  const values: unknown[] = [filter.clientId ?? "eden"];
  if (filter.approvalStatus) {
    values.push(filter.approvalStatus);
    where.push(`approval_status = $${values.length}`);
  }
  if (filter.stage) {
    values.push(filter.stage);
    where.push(`pipeline_stage = $${values.length}`);
  }
  if (filter.category) {
    values.push(filter.category);
    where.push(`category = $${values.length}`);
  }
  const rows = await query<LeadRow>(
    `SELECT * FROM quarry_leads WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    values
  );
  return rows.map(rowToLead);
}

// ─── Runs ───

export async function startRun(triggeredBy: string, clientId = "eden"): Promise<number> {
  const rows = await query<{ id: string }>(
    `INSERT INTO quarry_runs (client_id, triggered_by) VALUES ($1, $2) RETURNING id`,
    [clientId, triggeredBy]
  );
  return Number(rows[0].id);
}

export async function finishRun(
  runId: number,
  counts: Partial<Omit<QuarryRun, "id" | "clientId" | "startedAt" | "finishedAt" | "errors" | "triggeredBy" | "status">>,
  errors: RunError[],
  status: "ok" | "failed"
): Promise<void> {
  await query(
    `UPDATE quarry_runs SET
       finished_at = now(), status = $2, errors = $3,
       leads_found = $4, leads_qualified = $5, leads_mobile = $6,
       leads_generated = $7, leads_screenshotted = $8, leads_synced = $9
     WHERE id = $1`,
    [
      runId,
      status,
      JSON.stringify(errors),
      counts.leadsFound ?? 0,
      counts.leadsQualified ?? 0,
      counts.leadsMobile ?? 0,
      counts.leadsGenerated ?? 0,
      counts.leadsScreenshotted ?? 0,
      counts.leadsSynced ?? 0,
    ]
  );
}

// ─── Design briefs ───

/**
 * Seeds the briefs table from the markdown files on first run only. After
 * that the DB copy is authoritative, so edits made in the console are not
 * clobbered by a redeploy — the files are the starting point, not the source
 * of truth.
 */
export async function seedBriefIfAbsent(
  category: QuarryCategory,
  label: string,
  markdown: string,
  clientId = "eden"
): Promise<void> {
  await query(
    `INSERT INTO quarry_design_briefs (client_id, category, label, brief_markdown)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, category) DO NOTHING`,
    [clientId, category, label, markdown]
  );
}

export async function getBrief(
  category: QuarryCategory,
  clientId = "eden"
): Promise<string | null> {
  const rows = await query<{ brief_markdown: string }>(
    `SELECT brief_markdown FROM quarry_design_briefs WHERE client_id = $1 AND category = $2`,
    [clientId, category]
  );
  return rows[0]?.brief_markdown ?? null;
}

export async function saveBrief(
  category: QuarryCategory,
  markdown: string,
  clientId = "eden"
): Promise<void> {
  await query(
    `UPDATE quarry_design_briefs SET brief_markdown = $3, updated_at = now()
      WHERE client_id = $1 AND category = $2`,
    [clientId, category, markdown]
  );
}

// ─── Phone lookup cache ───

export async function getCachedLookup(
  phone: string,
  maxAgeDays: number
): Promise<PhoneLookup | null> {
  const rows = await query<{
    phone: string;
    line_type: string;
    is_mobile: boolean;
    carrier: string | null;
    provider: string;
    checked_at: string;
  }>(
    `SELECT phone, line_type, is_mobile, carrier, provider, checked_at
       FROM quarry_phone_lookups
      WHERE phone = $1 AND checked_at > now() - ($2 || ' days')::interval`,
    [phone, String(maxAgeDays)]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    phone: r.phone,
    lineType: r.line_type,
    isMobile: r.is_mobile,
    carrier: r.carrier,
    provider: r.provider,
    checkedAt: r.checked_at,
  };
}

export async function cacheLookup(lookup: PhoneLookup): Promise<void> {
  await query(
    `INSERT INTO quarry_phone_lookups (phone, line_type, is_mobile, carrier, provider, raw)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (phone) DO UPDATE SET
       line_type = excluded.line_type, is_mobile = excluded.is_mobile,
       carrier = excluded.carrier, provider = excluded.provider,
       raw = excluded.raw, checked_at = now()`,
    [
      lookup.phone,
      lookup.lineType,
      lookup.isMobile,
      lookup.carrier,
      lookup.provider,
      JSON.stringify(lookup.raw ?? {}),
    ]
  );
}

// ─── Send log ───

export async function logSend(entry: {
  leadId: number;
  step: SendStep;
  messageContent: string;
  attachmentUrl?: string | null;
  ghlMessageId?: string | null;
  error?: string | null;
  clientId?: string;
}): Promise<void> {
  await query(
    `INSERT INTO quarry_send_log
       (client_id, lead_id, step, message_content, attachment_url, ghl_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.clientId ?? "eden",
      entry.leadId,
      entry.step,
      entry.messageContent,
      entry.attachmentUrl ?? null,
      entry.ghlMessageId ?? null,
      entry.error ?? null,
    ]
  );
}

/** Sends today, for the daily cap. Failed sends are excluded — a message that
 *  never left should not consume the day's allowance. */
export async function sendsToday(clientId = "eden"): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) AS count FROM quarry_send_log
      WHERE client_id = $1 AND error IS NULL AND sent_at > now() - interval '1 day'`,
    [clientId]
  );
  return Number(rows[0]?.count ?? 0);
}
