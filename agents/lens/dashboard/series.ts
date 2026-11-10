/**
 * Trend lines for the dashboard's charts. Each point is the period split into buckets (days, weeks or months,
 * by length) with every number worked out by the SAME computeMetrics used for the KPI cards, so a chart can
 * never disagree with a card about what a metric means.
 */
import { computeMetrics, MetricsInput } from "./metrics";
import { addDays, DateRange, daysInRange, historyCovers, rangeLabel } from "./ranges";

export type Granularity = "day" | "week" | "month";

/** Daily up to 45 days, weekly up to 200, monthly beyond. */
export function pickGranularity(r: DateRange): Granularity {
  const n = daysInRange(r);
  return n <= 45 ? "day" : n <= 200 ? "week" : "month";
}

/** Splits the period into consecutive buckets that exactly cover it, the first and last possibly shorter. */
export function bucketRanges(r: DateRange, granularity: Granularity): DateRange[] {
  const out: DateRange[] = [];
  let from = r.from;
  while (from <= r.to) {
    let to: string;
    if (granularity === "day") to = from;
    else if (granularity === "week") {
      // weeks end on Sunday
      const dow = new Date(`${from}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      to = addDays(from, dow === 0 ? 0 : 7 - dow);
    } else {
      const d = new Date(`${from}T00:00:00Z`);
      to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }
    if (to > r.to) to = r.to;
    out.push({ from, to });
    from = addDays(to, 1);
  }
  return out;
}

export interface SeriesPoint {
  from: string;
  to: string;
  label: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  metaLeads: number | null;
  /** Cost per lead. */
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

export function computeSeries(input: MetricsInput): { granularity: Granularity; points: SeriesPoint[] } {
  const granularity = pickGranularity(input.range);
  const points = bucketRanges(input.range, granularity).map((range) => {
    // A bucket that starts before the client's GHL data has no lead numbers (unknown), so its chart points are gaps, not zeros.
    const ghlStart = input.config.ghlDataStart ?? null;
    const ghl = ghlStart === null || historyCovers(ghlStart, range.from);
    const k = computeMetrics({ ...input, range, sources: { ...(input.sources ?? { meta: true, appointments: true }), ghl } }).kpis;
    return {
      from: range.from,
      to: range.to,
      label: rangeLabel(range),
      spend: k.spend.value,
      impressions: k.impressions.value,
      clicks: k.clicks.value,
      metaLeads: k.metaLeads.value,
      cpl: k.cpl.value,
      totalLeads: k.totalLeads.value,
      appointmentsBooked: k.appointmentsBooked.value,
      attendedAppointments: k.attendedAppointments.value,
      showUpRate: k.showUpRate.value,
      leadToAppointment: k.leadToAppointment.value,
      closedDealsAttributed: k.closedDealsAttributed.value,
      revenueAttributed: k.revenueAttributed.value,
      roas: k.roas.value,
    };
  });
  return { granularity, points };
}
