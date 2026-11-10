/**
 * What an exported report contains, built once from the report on screen so the CSV and the PDF can never say
 * different things. Pure: no DOM, no fetching. Everything here comes from the same responses the page shows, so
 * an export always matches the client and period it was made from, and "N/A" stays "N/A" (never 0).
 */
import { formatChange, formatValue, NA, toneOf, Tone } from "./format";
import type { Report } from "./useLensReport";
import type { AttributionStatus, DealRow, PeriodJson, Unit } from "./types";

export interface Num {
  v: number | null;
  unit: Unit;
}
export type Cell = string | Num;

export interface ExportTable {
  id: string;
  title: string;
  /** One line under the title, when the table needs a reading note. */
  caption?: string;
  columns: string[];
  rows: Cell[][];
  footer?: Cell[];
  /** What to say instead of the table when there are no rows. */
  empty?: string;
  /** Tables of raw chart data are for spreadsheets only; the PDF shows the charts themselves. */
  csvOnly?: boolean;
}

export interface ExportModel {
  clientId: string;
  client: string;
  timezone: string;
  period: PeriodJson;
  previousPeriod: PeriodJson | null;
  generatedAt: string;
  basis: "calendar" | "pipeline";
  includeNames: boolean;
  /** Label and value pairs for the header block. */
  meta: [string, string][];
  tables: ExportTable[];
  /** Plain sentences about missing or partial data, always exported. */
  notes: string[];
  fileBase: string;
}

export interface ExportOptions {
  /** Show lead names in the closed-deal ledger. Off by default: a report for a client is not a customer list. */
  includeNames: boolean;
}

const num = (v: number | null | undefined, unit: Unit): Num => ({ v: v ?? null, unit });

export interface Tile {
  key: string;
  label: string;
  /** The value as the reader sees it ("$9,335.66", "N/A"). */
  text: string;
  /** "+12.5% vs $8,300.00" style, only when the period was compared and the change is known. */
  change: string | null;
  tone: Tone;
}

/** The numbers worth a big tile on the first page, in reading order. A metric a client hides, or that the report lacks, is skipped. */
const TILE_KEYS: { key: string; label?: string }[] = [
  { key: "spend" },
  { key: "totalLeads", label: "Leads" },
  { key: "cpl" },
  { key: "appointmentsBooked" },
  { key: "showUpRate" },
  { key: "closedDeals" },
  { key: "revenueAll", label: "Revenue" },
  { key: "roas" },
];

export function headlineTiles(report: Report): Tile[] {
  const byKey = new Map(report.kpis.sections.flatMap((s) => s.metrics).map((m) => [m.key, m]));
  return TILE_KEYS.flatMap(({ key, label }) => {
    const m = byKey.get(key);
    if (!m) return [];
    const change = report.kpis.previousPeriod ? formatChange(m.change, m.changePct, m.unit) : null;
    return [{ key, label: label ?? m.label, text: formatValue(m.value, m.unit), change: change ? `${change} vs ${formatValue(m.previous ?? null, m.unit)}` : null, tone: toneOf(key, m.change) }];
  });
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "client";
}

/** "Lead 1", "Lead 2" in the order shown, unless names were asked for. */
export function leadLabel(deal: Pick<DealRow, "name">, index: number, includeNames: boolean): string {
  return includeNames ? deal.name?.trim() || "Unnamed lead" : `Lead ${index + 1}`;
}

const STATUS_LABEL: Record<AttributionStatus, string> = { confirmed: "Confirmed", partial: "Partial", unknown: "Unknown" };

function stamp(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function buildExportModel(report: Report, options: ExportOptions): ExportModel {
  const { kpis, series, campaigns, attribution } = report;
  const compared = Boolean(kpis.previousPeriod);
  const names = options.includeNames;

  const tables: ExportTable[] = [];

  for (const section of kpis.sections) {
    tables.push({
      id: `kpi-${section.id}`,
      title: section.title,
      columns: compared ? ["Metric", "Value", "Previous period", "Change", "Change %"] : ["Metric", "Value"],
      rows: section.metrics.map((m) => {
        const base: Cell[] = [m.label, num(m.value, m.unit)];
        return compared ? [...base, num(m.previous, m.unit), num(m.change, m.unit), num(m.changePct, "percent")] : base;
      }),
    });
  }

  tables.push({
    id: "campaigns",
    title: "Campaign performance",
    caption: "Spend and Meta's own lead count come from Meta; leads, appointments and deals come from GHL, matched to the campaign by the ID on the lead.",
    columns: ["Campaign", "Spend", "Leads (GHL)", "Leads (Meta)", "Cost per lead", "Appointments", "Attended", "Cost per appointment", "Closed deals", "Cost per closed deal", "Revenue", "ROAS"],
    rows: campaigns.rows.map((r) => [
      r.name + (r.noMetaData ? " (no Meta data)" : ""),
      num(r.spend, "currency"), num(r.leads, "count"), num(r.metaLeads, "count"), num(r.cpl, "currency"),
      num(r.appointmentsBooked, "count"), num(r.attendedAppointments, "count"), num(r.costPerAppointment, "currency"),
      num(r.closedDeals, "count"), num(r.costPerClosedDeal, "currency"), num(r.revenue, "currency"), num(r.roas, "ratio"),
    ]),
    footer: ["All campaigns", num(campaigns.totals.spend, "currency"), num(campaigns.totals.leads, "count"), "", "", "", "", "", num(campaigns.totals.closedDeals, "count"), "", num(campaigns.totals.revenue, "currency"), ""],
    empty: "No campaign activity in this period.",
  });

  tables.push({
    id: "chain",
    title: "Closed-deal attribution: lead to revenue",
    caption: "Each step counts a person once. Confirmed + partial + unknown always add up to the total.",
    columns: ["Step", "Total", "Confirmed from ads", "Partial", "Unknown"],
    rows: attribution.chain.map((s) => [s.label, num(s.total, s.unit), num(s.confirmed, s.unit), num(s.partial, s.unit), num(s.unknown, s.unit)]),
  });

  tables.push({
    id: "deals",
    title: "Deals closed in this period",
    caption: names ? undefined : "Lead names are left out of this report.",
    columns: ["Lead", "Closed", "Lead arrived", "Days to close", "Appointments", "Attribution", "Evidence", "Campaign", "Form", "Value"],
    rows: attribution.deals.map((d, i) => [
      leadLabel(d, i, names), d.closedDate, d.leadDate, num(d.daysToClose, "count"),
      attribution.basis === "calendar" ? (d.appointments.length ? `${d.appointments.length}${d.attended ? ", attended" : ""}` : "none") : d.attended ? "Attended" : d.booked ? "Booked" : "No",
      STATUS_LABEL[d.attribution], d.evidence, d.campaignName ?? (d.attribution === "confirmed" ? "" : "Not traced to a campaign"), d.formName ?? "",
      d.value === null ? "No value recorded" : num(d.value, "currency"),
    ]),
    // The sum of the values shown, so a reader can check it against the revenue tile. A deal with no value adds nothing.
    footer: attribution.deals.length ? ["Total", "", "", "", "", "", "", "", "", num(attribution.deals.reduce((sum, d) => sum + (d.value ?? 0), 0), "currency")] : undefined,
    empty: "No deals closed in this period.",
  });

  tables.push({
    id: "sources",
    title: "Leads by original source",
    columns: ["Source", "Leads", "Confirmed", "Partial", "Unknown", "Booked", "Closed deals", "Revenue"],
    rows: attribution.sources.map((s) => [s.source, num(s.leads, "count"), num(s.confirmed, "count"), num(s.partial, "count"), num(s.unknown, "count"), num(s.booked, "count"), num(s.closedDeals, "count"), num(s.revenue, "currency")]),
    empty: "No leads in this period.",
  });

  tables.push({
    id: "trend",
    title: `Trend data (${series.granularity === "day" ? "daily" : series.granularity === "week" ? "weekly" : "monthly"})`,
    columns: ["From", "To", "Spend", "Impressions", "Clicks", "Leads (Meta)", "Cost per lead", "Leads (GHL)", "Appointments", "Attended", "Show-up rate", "Lead to appointment", "Closed deals from ads", "Revenue from ads", "ROAS"],
    rows: series.points.map((p) => [
      p.from, p.to, num(p.spend, "currency"), num(p.impressions, "count"), num(p.clicks, "count"), num(p.metaLeads, "count"), num(p.cpl, "currency"), num(p.totalLeads, "count"),
      num(p.appointmentsBooked, "count"), num(p.attendedAppointments, "count"), num(p.showUpRate, "percent"), num(p.leadToAppointment, "percent"),
      num(p.closedDealsAttributed, "count"), num(p.revenueAttributed, "currency"), num(p.roas, "ratio"),
    ]),
    empty: "No data in this period.",
    csvOnly: true,
  });

  tables.push({
    id: "methodology",
    title: "How attribution is worked out",
    columns: ["Rule", "What it means"],
    rows: attribution.methodology.map((m) => [m.title, m.text]),
  });

  tables.push({
    id: "definitions",
    title: "What each metric means",
    columns: ["Metric", "Definition", "Source"],
    rows: kpis.sections.flatMap((s) => s.metrics.map((m): Cell[] => [m.label, m.definition, m.source])),
  });

  const q = attribution.quality;
  const notes: string[] = [
    ...kpis.client.missing.map((m) => `Not connected: ${m}. Anything that depends on it shows ${NA} instead of zero.`),
    ...kpis.notes,
    kpis.attribution.note,
    ...(q.closedDealsMissingValue.length
      ? [`${q.closedDealsMissingValue.length} closed deal${q.closedDealsMissingValue.length === 1 ? " has" : "s have"} no value recorded in GHL${names ? ` (${q.closedDealsMissingValue.map((d) => d.name ?? "a lead with no name").join(", ")})` : ""}, so revenue is understated by ${q.closedDealsMissingValue.length === 1 ? "it" : "them"}.`]
      : []),
    ...(q.closedDealsNotConfirmed > 0
      ? [
          attribution.allLeadsFromAds
            ? `${q.closedDealsNotConfirmed} closed deal${q.closedDealsNotConfirmed === 1 ? " has" : "s have"} no exact campaign recorded (partial or unknown). ${q.closedDealsNotConfirmed === 1 ? "It still counts" : "They still count"} in ROAS and cost per closed deal but cannot be placed on a campaign.`
            : `${q.closedDealsNotConfirmed} closed deal${q.closedDealsNotConfirmed === 1 ? " is" : "s are"} not confirmed from ads (partial or unknown) and ${q.closedDealsNotConfirmed === 1 ? "is" : "are"} left out of ROAS and cost per closed deal.`,
        ]
      : []),
    q.metaHistoryStarts ? `Meta spend is held from ${q.metaHistoryStarts}; earlier spend is not in these figures.` : "No Meta spend history is held for this client.",
    `${NA} means the number cannot be worked out from the data available (a zero denominator, or a source that is not connected). It is never shown as 0.`,
    ...(compared ? ["Change is the difference from the previous period; for rates it is in percentage points. Change % is relative to the previous period's value."] : []),
  ];

  return {
    clientId: kpis.client.clientId,
    client: kpis.client.name,
    timezone: kpis.client.timezone,
    period: kpis.period,
    previousPeriod: kpis.previousPeriod,
    generatedAt: kpis.generatedAt,
    basis: kpis.appointmentBasis,
    includeNames: names,
    meta: [
      ["Client", kpis.client.name],
      ["Period", `${kpis.period.label} (${kpis.period.from} to ${kpis.period.to})`],
      ["Compared with", kpis.previousPeriod ? `${kpis.previousPeriod.label} (${kpis.previousPeriod.from} to ${kpis.previousPeriod.to})` : "Not compared"],
      ["Timezone", kpis.client.timezone],
      ["Report made", stamp(kpis.generatedAt, kpis.client.timezone)],
      ["Meta data through", kpis.client.meta.lastDay ?? NA],
      ["Appointments counted by", kpis.appointmentBasis === "pipeline" ? "Pipeline stage and tags, by the day the lead arrived" : "Calendar bookings, by the day of the appointment"],
      ["Lead names", names ? "Included" : "Left out"],
    ],
    tables,
    notes,
    fileBase: `lens-${slug(kpis.client.name)}-${kpis.period.from}_to_${kpis.period.to}`,
  };
}

/** A cell as the reader sees it. */
export function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : formatValue(cell.v, cell.unit);
}
