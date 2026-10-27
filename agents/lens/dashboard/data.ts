/**
 * Reads what the dashboard needs from our own database and hands it to the pure metric code. Meta and GHL
 * data are copied into the database by the existing hourly syncs (and the appointment sync here), so a page
 * load never waits on either API.
 */
import { query } from "../../../shared/db";
import { clientTimezone, getLensClient, loadDashboardConfig, LensClient, memo } from "./clients";
import { AppointmentRow, compareMetrics, computeMetrics, LeadRow, MetaRow, MetricChange, MetricsInput, MetricsResult, OtherCostRow } from "./metrics";
import { MetricKey } from "./definitions";
import { addDays, DateRange, previousRange } from "./ranges";
import { AppointmentStatus } from "./appointments-sync";

/** Meta's "lead" result for one row of insights. Other lead-ish action types (grouped, offsite) are not added: they repeat it. */
export function leadsFromActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  const lead = actions.find((a) => a?.action_type === "lead");
  const n = Number(lead?.value);
  return Number.isFinite(n) ? n : 0;
}

/** Daily campaign-level Meta rows, one per campaign per day (never mixed with ad set or ad rows, which would double the spend). */
export async function loadMetaRows(clientId: string, from: string, to: string): Promise<MetaRow[]> {
  const rows = await query<any>(
    `SELECT DISTINCT ON (date_start, campaign_id)
            date_start::text AS date, campaign_id, campaign_name, spend, impressions, clicks, reach, raw->'actions' AS actions
     FROM meta_performance_snapshots
     WHERE client_id = $1 AND level = 'campaign' AND campaign_id IS NOT NULL AND date_start >= $2 AND date_start <= $3
     ORDER BY date_start, campaign_id, fetched_at DESC`,
    [clientId, from, to]
  );
  return rows.map((r) => ({
    date: r.date,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    reach: Number(r.reach) || 0,
    leads: leadsFromActions(r.actions),
  }));
}

export async function loadKnownCampaignIds(clientId: string): Promise<Set<string>> {
  const rows = await query<{ campaign_id: string }>(`SELECT DISTINCT campaign_id FROM meta_performance_snapshots WHERE client_id = $1 AND campaign_id IS NOT NULL`, [clientId]);
  return new Set(rows.map((r) => r.campaign_id));
}

/** The latest name of every campaign we hold Meta data for, in any period. */
export async function loadCampaignNames(clientId: string): Promise<Map<string, string>> {
  const rows = await query<{ campaign_id: string; campaign_name: string | null }>(
    `SELECT DISTINCT ON (campaign_id) campaign_id, campaign_name FROM meta_performance_snapshots
     WHERE client_id = $1 AND campaign_id IS NOT NULL AND campaign_name IS NOT NULL ORDER BY campaign_id, date_start DESC`,
    [clientId]
  );
  return new Map(rows.map((r) => [r.campaign_id, r.campaign_name!]));
}

/**
 * All of the client's GHL leads. When a deal closed comes from the card's own "last stage change" time, never
 * from our sync time, which would make every deal look like it closed on the day of the last sync.
 */
export async function loadLeads(clientId: string): Promise<LeadRow[]> {
  const rows = await query<any>(
    `SELECT ghl_contact_id, created_at, meta_campaign_id, pipeline_stage, deal_value,
            raw->'opportunity'->>'lastStageChangeAt' AS last_stage_change, raw->'opportunity'->>'updatedAt' AS opp_updated,
            raw->'contact'->'tags' AS tags
     FROM ad_leads WHERE client_id = $1`,
    [clientId]
  );
  return rows.map((r) => {
    const closedRaw = r.last_stage_change ?? r.opp_updated ?? null;
    const closedAt = closedRaw ? new Date(closedRaw) : null;
    return {
      contactId: r.ghl_contact_id,
      createdAt: new Date(r.created_at),
      campaignId: r.meta_campaign_id || null,
      stage: r.pipeline_stage ?? null,
      dealValue: r.deal_value === null || r.deal_value === undefined ? null : Number(r.deal_value),
      closedAt: closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : null,
      tags: Array.isArray(r.tags) ? r.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    };
  });
}

export async function loadAppointments(clientId: string): Promise<AppointmentRow[]> {
  const rows = await query<any>(`SELECT appointment_id, contact_id, start_time, booked_at, status FROM ghl_appointments WHERE client_id = $1`, [clientId]);
  return rows.map((r) => ({
    id: r.appointment_id,
    contactId: r.contact_id,
    start: new Date(r.start_time),
    bookedAt: r.booked_at ? new Date(r.booked_at) : null,
    status: r.status as AppointmentStatus,
  }));
}

export async function loadOtherCosts(clientId: string, from: string, to: string): Promise<OtherCostRow[]> {
  const rows = await query<any>(`SELECT cost_date::text AS date, amount FROM lens_other_costs WHERE client_id = $1 AND cost_date >= $2 AND cost_date <= $3`, [clientId, from, to]);
  return rows.map((r) => ({ date: r.date, amount: Number(r.amount) || 0 }));
}

export interface DashboardKpis {
  client: LensClient;
  timezone: string;
  range: DateRange;
  current: MetricsResult;
  previousRange?: DateRange;
  previous?: MetricsResult;
  changes?: Record<MetricKey, MetricChange>;
}

export interface DashboardInputs {
  client: LensClient;
  timezone: string;
  range: DateRange;
  previousRange: DateRange | null;
  /** Everything computeMetrics needs except the period. */
  base: Omit<MetricsInput, "range">;
}

/** Loads what one client's dashboard needs for a period (and the one before it, when comparing). One place, so every endpoint agrees. */
export async function loadDashboardInputs(clientId: string, range: DateRange, options: { compare?: boolean; now?: Date } = {}): Promise<DashboardInputs | null> {
  const now = options.now ?? new Date();
  const client = await getLensClient(clientId);
  if (!client) return null;
  const timeZone = await clientTimezone(clientId);
  const previous = options.compare ? previousRange(range) : null;
  const earliest = previous ? previous.from : range.from;
  // A day of slack either side: Meta rows are keyed by the account's own day, which can sit a day off the client's.
  const [meta, knownCampaignIds, campaignNames, leads, appointments, otherCosts] = await Promise.all([
    loadMetaRows(clientId, addDays(earliest, -1), addDays(range.to, 1)),
    memo(`campaigns:${clientId}`, 30_000, () => loadKnownCampaignIds(clientId)),
    memo(`campaign-names:${clientId}`, 30_000, () => loadCampaignNames(clientId)),
    memo(`leads:${clientId}`, 30_000, () => loadLeads(clientId)),
    memo(`appointments:${clientId}`, 30_000, () => loadAppointments(clientId)),
    loadOtherCosts(clientId, earliest, range.to),
  ]);
  const config = loadDashboardConfig(clientId);
  return {
    client,
    timezone: timeZone,
    range,
    previousRange: previous,
    base: {
      timeZone,
      now,
      meta,
      knownCampaignIds,
      campaignNames,
      leads,
      appointments,
      otherCosts,
      config,
      sources: { meta: client.meta.connected && meta.length > 0, appointments: config.appointmentSource === "pipeline" ? client.ghl.leads > 0 : client.ghl.appointments > 0 },
    },
  };
}

/** KPIs for one client over one period, and optionally against the period of equal length just before it. */
export async function buildDashboardKpis(clientId: string, range: DateRange, options: { compare?: boolean; now?: Date } = {}): Promise<DashboardKpis | null> {
  const inputs = await loadDashboardInputs(clientId, range, options);
  if (!inputs) return null;
  const current = computeMetrics({ ...inputs.base, range });
  if (!inputs.previousRange) return { client: inputs.client, timezone: inputs.timezone, range, current };
  const previous = computeMetrics({ ...inputs.base, range: inputs.previousRange });
  return { client: inputs.client, timezone: inputs.timezone, range, current, previousRange: inputs.previousRange, previous, changes: compareMetrics(current, previous) };
}
