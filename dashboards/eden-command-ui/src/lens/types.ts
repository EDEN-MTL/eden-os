/** The Lens API's response shapes (server/lens-api.ts), as the page reads them. */

export type Unit = "currency" | "count" | "percent" | "ratio";

export interface LensClient {
  clientId: string;
  name: string;
  timezone: string;
  meta: { connected: boolean; adAccountId: string | null; lastDay: string | null };
  ghl: { connected: boolean; lastLeadSync: string | null; lastAppointmentSync: string | null; leads: number; appointments: number };
  missing: string[];
}

export interface MetricJson {
  key: string;
  label: string;
  definition: string;
  source: string;
  unit: Unit;
  value: number | null;
  note?: string;
  previous?: number | null;
  change?: number | null;
  changePct?: number | null;
}

export interface SectionJson {
  id: string;
  title: string;
  metrics: MetricJson[];
}

export interface PeriodJson {
  from: string;
  to: string;
  label: string;
  timezone?: string;
}

export interface KpiResponse {
  client: { clientId: string; name: string; timezone: string; meta: { connected: boolean; lastDay: string | null }; ghl: { connected: boolean }; missing: string[] };
  period: PeriodJson;
  previousPeriod: PeriodJson | null;
  generatedAt: string;
  appointmentBasis: "calendar" | "pipeline";
  sections: SectionJson[];
  attribution: { confirmed: number; partial: number; unknown: number; note: string };
  notes: string[];
}

export interface SeriesPoint {
  from: string;
  to: string;
  label: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  metaLeads: number | null;
  cpl: number | null;
  totalLeads: number | null;
  appointmentsBooked: number | null;
  attendedAppointments: number | null;
  showUpRate: number | null;
  leadToAppointment: number | null;
  closedDealsAttributed: number | null;
  revenueAttributed: number | null;
  roas: number | null;
}

export interface SeriesResponse {
  period: PeriodJson;
  granularity: "day" | "week" | "month";
  points: SeriesPoint[];
}

export interface CampaignRow {
  campaignId: string | null;
  name: string;
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

export interface CampaignsResponse {
  period: PeriodJson;
  rows: CampaignRow[];
  totals: { spend: number | null; leads: number | null; closedDeals: number | null; revenue: number | null };
}

export type Preset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "this_month" | "custom";

export interface PeriodChoice {
  preset: Preset;
  from: string;
  to: string;
  compare: boolean;
}
