/**
 * The dashboard's numbers: every KPI computed from plain rows, no database or network in here, so each
 * definition (see definitions.ts) is covered by tests and cannot drift quietly.
 *
 * Rules that apply to every metric:
 *   - A ratio whose denominator is zero is null, shown as "N/A", never 0 or Infinity.
 *   - Nothing is invented: a closed deal with no recorded value adds no revenue and is counted as missing.
 *   - "Attributed" means CONFIRMED attribution: the lead carries a real Meta campaign id. A lead with only a
 *     campaign name or utm text is "partial", one with nothing is "unknown", and neither is counted as coming
 *     from ads.
 *   - Cancelled, invalid and deleted appointments never count. An appointment is one GHL record, so a
 *     reschedule (same record, new time) is not counted twice.
 */
import { AppointmentStatus } from "./appointments-sync";
import { MetricKey } from "./definitions";
import { DateRange, inRange } from "./ranges";

export interface MetaRow {
  /** YYYY-MM-DD, the Meta account's day. */
  date: string;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  /** Leads Meta recorded (its "lead" result). */
  leads: number;
}

export interface LeadRow {
  contactId: string;
  createdAt: Date;
  campaignId: string | null;
  stage: string | null;
  dealValue: number | null;
  /** When the card reached its current stage (for closed deals: when it closed). */
  closedAt: Date | null;
}

export interface AppointmentRow {
  id: string;
  contactId: string | null;
  start: Date;
  bookedAt: Date | null;
  status: AppointmentStatus;
}

export interface OtherCostRow {
  /** YYYY-MM-DD */
  date: string;
  amount: number;
}

export interface MetricsConfig {
  closedStages: string[];
  qualifiedStages: string[];
  unqualifiedStages: string[];
}

export interface MetricsInput {
  range: DateRange;
  /**
   * Every Meta campaign id this client has ever had (not just those that ran in the period), so a lead from an
   * older campaign still counts as confirmed. Defaults to the campaigns in `meta`.
   */
  knownCampaignIds?: Set<string>;
  /** Which source systems actually have data for this client; a metric from a missing source is N/A, not zero. Default: all present. */
  sources?: { meta: boolean; appointments: boolean };
  timeZone: string;
  now: Date;
  meta: MetaRow[];
  leads: LeadRow[];
  appointments: AppointmentRow[];
  otherCosts: OtherCostRow[];
  config: MetricsConfig;
}

export type Unit = "currency" | "count" | "percent" | "ratio";
export interface MetricValue {
  key: MetricKey;
  /** null = N/A. */
  value: number | null;
  unit: Unit;
  /** Why this is N/A or partial, when there is something to say. */
  note?: string;
}

export type Attribution = "confirmed" | "partial" | "unknown";

export interface MetricsResult {
  range: DateRange;
  kpis: Record<MetricKey, MetricValue>;
  /** Counts behind the numbers, for the transparency panel and the exports. */
  detail: {
    leadsByAttribution: Record<Attribution, number>;
    closedDealsMissingValue: number;
    appointmentsWithoutOutcome: number;
    costsIncluded: "ad spend" | "ad spend + other costs";
  };
  /** Things a reader needs to know to interpret these numbers (missing config, incomplete data). */
  notes: string[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const div = (a: number, b: number): number | null => (b > 0 && Number.isFinite(a / b) ? a / b : null);
const pct = (a: number, b: number): number | null => {
  const r = div(a, b);
  return r === null ? null : r * 100;
};
const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

/**
 * A Meta campaign id is a long number (e.g. 120239794885580259) written by Meta's own tracking onto the lead.
 * utm text such as "Seller Campaign - EDEN" is a label someone typed into a link, not proof of the ad.
 */
export function looksLikeMetaCampaignId(value: string | null | undefined): boolean {
  return /^\d{12,}$/.test(String(value ?? "").trim());
}

/**
 * confirmed = the lead carries a real Meta campaign id (it need not be a campaign we hold data for: leads from
 *             a campaign that ran before our synced history began are still ads leads).
 * partial   = only text (a utm label or campaign name): probably from ads, not proven.
 * unknown   = nothing recorded.
 */
export function attributionOf(lead: Pick<LeadRow, "campaignId">, knownCampaignIds: Set<string>): Attribution {
  if (!lead.campaignId) return "unknown";
  return knownCampaignIds.has(lead.campaignId) || looksLikeMetaCampaignId(lead.campaignId) ? "confirmed" : "partial";
}

const VOID: ReadonlySet<AppointmentStatus> = new Set(["cancelled", "invalid", "deleted"]);

export function computeMetrics(input: MetricsInput): MetricsResult {
  const { range, timeZone, now, config } = input;
  const notes: string[] = [];
  const knownCampaignIds = input.knownCampaignIds ?? new Set(input.meta.map((r) => r.campaignId));
  const attributionByContact = new Map<string, Attribution>();
  for (const lead of input.leads) attributionByContact.set(lead.contactId, attributionOf(lead, knownCampaignIds));
  const isConfirmed = (contactId: string | null) => (contactId ? attributionByContact.get(contactId) === "confirmed" : false);

  // ── Meta, from the days in the period ──
  const metaRows = input.meta.filter((r) => r.date >= range.from && r.date <= range.to);
  const spend = sum(metaRows.map((r) => r.spend));
  const impressions = sum(metaRows.map((r) => r.impressions));
  const clicks = sum(metaRows.map((r) => r.clicks));
  const reach = sum(metaRows.map((r) => r.reach));
  const metaLeads = sum(metaRows.map((r) => r.leads));

  // ── Leads created in the period ──
  const leadsInRange = input.leads.filter((l) => inRange(l.createdAt, range, timeZone));
  const leadsByAttribution: Record<Attribution, number> = { confirmed: 0, partial: 0, unknown: 0 };
  for (const l of leadsInRange) leadsByAttribution[attributionOf(l, knownCampaignIds)]++;

  const inStages = (stage: string | null, list: string[]) => list.map(norm).includes(norm(stage));
  const haveQualification = config.qualifiedStages.length > 0 || config.unqualifiedStages.length > 0;
  const qualified = haveQualification ? leadsInRange.filter((l) => inStages(l.stage, config.qualifiedStages)).length : null;
  const unqualified = haveQualification ? leadsInRange.filter((l) => inStages(l.stage, config.unqualifiedStages)).length : null;
  if (!haveQualification) notes.push("Qualified and unqualified leads are N/A: no qualified/unqualified pipeline stages are set for this client.");

  // ── Appointments ──
  const valid = input.appointments.filter((a) => !VOID.has(a.status));
  const bookedInRange = valid.filter((a) => inRange(a.bookedAt, range, timeZone));
  const bookedAttributed = bookedInRange.filter((a) => isConfirmed(a.contactId));
  const scheduledInRange = valid.filter((a) => inRange(a.start, range, timeZone));
  const due = scheduledInRange.filter((a) => a.start.getTime() <= now.getTime());
  const confirmed = scheduledInRange.filter((a) => a.status === "confirmed");
  const attended = due.filter((a) => a.status === "attended");
  const noShows = due.filter((a) => a.status === "no_show");
  const attendedAttributed = attended.filter((a) => isConfirmed(a.contactId));
  const withoutOutcome = due.filter((a) => a.status === "booked" || a.status === "confirmed").length;
  if (withoutOutcome > 0) notes.push(`${withoutOutcome} past appointment${withoutOutcome === 1 ? " has" : "s have"} no outcome recorded in GHL (not marked showed or no-show), which lowers the show-up rate.`);

  const leadsWithAppointment = new Set(valid.map((a) => a.contactId).filter((id): id is string => Boolean(id)));
  const leadsThatBooked = leadsInRange.filter((l) => leadsWithAppointment.has(l.contactId)).length;

  // ── Closed deals ──
  const haveClosedStage = config.closedStages.length > 0;
  const closed = haveClosedStage ? input.leads.filter((l) => inStages(l.stage, config.closedStages) && inRange(l.closedAt, range, timeZone)) : [];
  const closedAttributed = closed.filter((l) => attributionByContact.get(l.contactId) === "confirmed");
  const value = (l: LeadRow) => (l.dealValue && l.dealValue > 0 ? l.dealValue : 0);
  const closedMissingValue = closed.filter((l) => !(l.dealValue && l.dealValue > 0)).length;
  if (!haveClosedStage) notes.push("Closed deals and revenue are N/A: no closed-deal stage is set for this client.");
  if (closedMissingValue > 0) notes.push(`${closedMissingValue} closed deal${closedMissingValue === 1 ? " has" : "s have"} no value recorded in GHL, so revenue is understated by those.`);

  // Of the ad leads who had an appointment in the period, how many have closed a deal (to date). Counting leads, not
  // appointments, so a lead with two appointments is one; and a cohort, so the rate can never pass 100%.
  const appointmentLeads = new Set(due.map((a) => a.contactId).filter((id): id is string => Boolean(id) && isConfirmed(id)));
  const closedNow = new Set(input.leads.filter((l) => inStages(l.stage, config.closedStages)).map((l) => l.contactId));
  const soldAmongAppointments = haveClosedStage ? [...appointmentLeads].filter((id) => closedNow.has(id)).length : 0;

  const revenueAll = haveClosedStage ? sum(closed.map(value)) : null;
  const revenueAttributed = haveClosedStage ? sum(closedAttributed.map(value)) : null;

  // ── Costs and returns ──
  const otherRows = input.otherCosts.filter((c) => c.date >= range.from && c.date <= range.to);
  const otherCosts = otherRows.length > 0 ? sum(otherRows.map((c) => c.amount)) : null;
  const includedCosts = spend + (otherCosts ?? 0);
  const costsIncluded = otherCosts === null ? "ad spend" : "ad spend + other costs";

  const roas = revenueAttributed === null ? null : div(revenueAttributed, spend);
  const roi = revenueAttributed === null || includedCosts <= 0 ? null : ((revenueAttributed - includedCosts) / includedCosts) * 100;

  const n = (key: MetricKey, v: number | null, unit: Unit, note?: string): MetricValue => ({ key, value: v, unit, ...(note ? { note } : {}) });
  const kpis = {
    spend: n("spend", spend, "currency"),
    impressions: n("impressions", impressions, "count"),
    reach: n("reach", reach, "count", "Sum of daily reach; higher than true unique reach over several days."),
    clicks: n("clicks", clicks, "count"),
    ctr: n("ctr", pct(clicks, impressions), "percent"),
    cpc: n("cpc", div(spend, clicks), "currency"),
    metaLeads: n("metaLeads", metaLeads, "count"),
    cpl: n("cpl", div(spend, metaLeads), "currency"),

    totalLeads: n("totalLeads", leadsInRange.length, "count"),
    attributedLeads: n("attributedLeads", leadsByAttribution.confirmed, "count"),
    qualifiedLeads: n("qualifiedLeads", qualified, "count", haveQualification ? "Provisional: stages set in config." : "No qualified stages set."),
    unqualifiedLeads: n("unqualifiedLeads", unqualified, "count", haveQualification ? undefined : "No unqualified stages set."),
    leadToAppointment: n("leadToAppointment", pct(leadsThatBooked, leadsInRange.length), "percent"),

    appointmentsBooked: n("appointmentsBooked", bookedInRange.length, "count"),
    appointmentsBookedAttributed: n("appointmentsBookedAttributed", bookedAttributed.length, "count"),
    costPerAppointment: n("costPerAppointment", div(spend, bookedAttributed.length), "currency"),
    confirmedAppointments: n("confirmedAppointments", confirmed.length, "count"),
    attendedAppointments: n("attendedAppointments", attended.length, "count"),
    noShowAppointments: n("noShowAppointments", noShows.length, "count"),
    showUpRate: n("showUpRate", pct(attended.length, due.length), "percent"),
    costPerAttended: n("costPerAttended", div(spend, attendedAttributed.length), "currency"),

    closedDeals: n("closedDeals", haveClosedStage ? closed.length : null, "count"),
    closedDealsAttributed: n("closedDealsAttributed", haveClosedStage ? closedAttributed.length : null, "count"),
    appointmentToSale: n("appointmentToSale", haveClosedStage ? pct(soldAmongAppointments, appointmentLeads.size) : null, "percent"),
    revenueAttributed: n("revenueAttributed", revenueAttributed, "currency", closedMissingValue > 0 ? "Some closed deals have no value recorded." : undefined),
    revenueAll: n("revenueAll", revenueAll, "currency"),
    otherCosts: n("otherCosts", otherCosts, "currency", otherCosts === null ? "None entered for this period." : undefined),
    roas: n("roas", roas, "ratio", "Advertising only."),
    roi: n("roi", roi, "percent", `Costs included: ${costsIncluded}.`),
    costPerClosedDeal: n("costPerClosedDeal", haveClosedStage ? div(spend, closedAttributed.length) : null, "currency"),
  } satisfies Record<MetricKey, MetricValue>;

  // A metric that depends on a source with no data for this client is N/A, not a convincing zero.
  const sources = input.sources ?? { meta: true, appointments: true };
  const mask = (keys: MetricKey[], why: string) => {
    for (const k of keys) kpis[k] = { key: k, value: null, unit: kpis[k].unit, note: why };
    notes.push(why);
  };
  if (!sources.meta) {
    mask(["spend", "impressions", "reach", "clicks", "ctr", "cpc", "metaLeads", "cpl", "costPerAppointment", "costPerAttended", "roas", "roi", "costPerClosedDeal"], "Ad metrics are N/A: no Meta ad data is connected for this client.");
  }
  if (!sources.appointments) {
    mask(["appointmentsBooked", "appointmentsBookedAttributed", "costPerAppointment", "confirmedAppointments", "attendedAppointments", "noShowAppointments", "showUpRate", "costPerAttended", "leadToAppointment", "appointmentToSale"], "Appointment metrics are N/A: no GHL appointments have synced for this client yet.");
  }

  return { range, kpis, detail: { leadsByAttribution, closedDealsMissingValue: closedMissingValue, appointmentsWithoutOutcome: withoutOutcome, costsIncluded }, notes };
}

export interface MetricChange {
  previous: number | null;
  /** current − previous; null if either side is N/A. */
  change: number | null;
  /** Percent change against the previous value; null when that is zero or N/A. */
  changePct: number | null;
}

/** How each metric moved against the previous period. A zero or N/A starting point gives no percentage. */
export function compareMetrics(current: MetricsResult, previous: MetricsResult): Record<MetricKey, MetricChange> {
  const out = {} as Record<MetricKey, MetricChange>;
  for (const key of Object.keys(current.kpis) as MetricKey[]) {
    const c = current.kpis[key].value;
    const p = previous.kpis[key].value;
    out[key] = {
      previous: p,
      change: c === null || p === null ? null : c - p,
      changePct: c === null || p === null || p === 0 ? null : ((c - p) / Math.abs(p)) * 100,
    };
  }
  return out;
}
