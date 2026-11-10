/**
 * The campaign performance table: one row per Meta campaign with spend, leads, appointments, attended
 * appointments, closed deals, cost per appointment and attributed revenue, plus a row for everything that
 * cannot be tied to a campaign. Each row is the same computeMetrics run on only that campaign's data, so
 * the numbers follow the KPI definitions exactly, and because every lead belongs to exactly one row, the
 * rows add up to the totals with nothing counted twice.
 */
import { attributionOf, computeMetrics, LeadRow, MetricsInput, MetricValue } from "./metrics";

export interface CampaignRow {
  /** Meta campaign id, or null for the "not tied to a campaign" row. */
  campaignId: string | null;
  name: string;
  /** True when we hold no Meta data for this campaign (it ran before our synced history). */
  noMetaData: boolean;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  metaLeads: number | null;
  cpl: number | null;
  leads: number;
  appointmentsBooked: number | null;
  attendedAppointments: number | null;
  costPerAppointment: number | null;
  closedDeals: number | null;
  revenue: number | null;
  costPerClosedDeal: number | null;
  roas: number | null;
}

const val = (m: MetricValue) => m.value;

export function computeCampaignTable(input: MetricsInput): CampaignRow[] {
  const known = input.knownCampaignIds ?? new Set(input.meta.map((r) => r.campaignId));
  const names = new Map<string, string>(input.campaignNames ?? []);
  for (const r of input.meta) if (r.campaignName) names.set(r.campaignId, r.campaignName);

  const inPeriod = (date: string) => date >= input.range.from && date <= input.range.to;
  // Every campaign with spend in the period, plus any campaign a lead or closed deal is tied to.
  const ids = new Set(input.meta.filter((r) => inPeriod(r.date)).map((r) => r.campaignId));
  const confirmedLeads = input.leads.filter((l) => attributionOf(l, known) === "confirmed" && l.campaignId);
  for (const l of confirmedLeads) ids.add(l.campaignId!);

  const leadsOf = (id: string) => confirmedLeads.filter((l) => l.campaignId === id);
  const row = (id: string | null, leads: LeadRow[], meta: MetricsInput["meta"]): CampaignRow => {
    const contacts = new Set(leads.map((l) => l.contactId));
    const k = computeMetrics({
      ...input,
      meta,
      leads,
      appointments: input.appointments.filter((a) => a.contactId && contacts.has(a.contactId)),
      // A campaign we hold Meta data for has spend 0 in a period it didn't run; one we hold none for is N/A, never a zero.
      sources: { meta: id !== null && known.has(id), appointments: input.sources?.appointments ?? true },
    }).kpis;
    const inRangeLeads = val(k.totalLeads) ?? 0;
    return {
      campaignId: id,
      name: id === null ? "Not tied to a campaign" : names.get(id) ?? `Campaign ${id}`,
      noMetaData: id !== null && !known.has(id),
      spend: val(k.spend),
      impressions: val(k.impressions),
      clicks: val(k.clicks),
      metaLeads: val(k.metaLeads),
      cpl: val(k.cpl),
      leads: inRangeLeads,
      appointmentsBooked: val(k.appointmentsBooked),
      attendedAppointments: val(k.attendedAppointments),
      costPerAppointment: val(k.costPerAppointment),
      // Every lead is in exactly one row, so all-deals equals from-ads for a campaign row and is the full count for the untied row.
      closedDeals: val(k.closedDeals),
      revenue: val(k.revenueAll),
      costPerClosedDeal: val(k.costPerClosedDeal),
      roas: val(k.roas),
    };
  };

  const rows = [...ids].map((id) => row(id, leadsOf(id), input.meta.filter((r) => r.campaignId === id)));
  // Leads with only a typed label, or nothing: counted here, never as ads, and never in two places.
  const untied = input.leads.filter((l) => attributionOf(l, known) !== "confirmed");
  const untiedRow = row(null, untied, []);
  const out = rows.filter((r) => (r.spend ?? 0) > 0 || r.leads > 0 || (r.closedDeals ?? 0) > 0 || (r.appointmentsBooked ?? 0) > 0);
  out.sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || b.leads - a.leads);
  if (untiedRow.leads > 0 || (untiedRow.appointmentsBooked ?? 0) > 0) out.push(untiedRow);
  return out;
}
