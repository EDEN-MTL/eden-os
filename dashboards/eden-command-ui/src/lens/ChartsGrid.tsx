import { useMemo } from "react";
import TrendChart, { ChartSeries } from "./Charts";
import { CampaignBars } from "./CampaignTable";
import { bucketLabel } from "./format";
import type { Report } from "./useLensReport";

const GREEN = "var(--lens-green)";
const GREY = "var(--lens-grey-bar)";
const WHITE = "var(--lens-white)";

/** The trend charts for one report; shared by the page and the PDF so they cannot drift apart. */
export default function ChartsGrid({ report }: { report: Report }) {
  const { series, kpis, campaigns } = report;
  const labels = useMemo(() => series.points.map((p) => bucketLabel(p.from, p.to, series.granularity)), [series]);
  const col = <K extends keyof (typeof series.points)[number]>(k: K) => series.points.map((p) => p[k] as number | null);
  const bucket = series.granularity === "day" ? "Daily" : series.granularity === "week" ? "Weekly" : "Monthly";
  const pipeline = kpis.appointmentBasis === "pipeline";
  const byLeadDate = pipeline ? " · by the day the lead arrived" : "";
  const line = (key: string, label: string, color: string, values: (number | null)[], unit: ChartSeries["unit"], axis: ChartSeries["axis"] = "left"): ChartSeries => ({ key, label, color, kind: "line", axis, values, unit });
  const bar = (key: string, label: string, color: string, values: (number | null)[], unit: ChartSeries["unit"], axis: ChartSeries["axis"] = "left"): ChartSeries => ({ key, label, color, kind: "bar", axis, values, unit });

  return (
    <div className="lens-charts">
      <TrendChart title="Ad spend vs leads generated" subtitle={bucket} labels={labels} series={[bar("spend", "Ad spend", GREY, col("spend"), "currency"), line("meta", "Leads (Meta)", GREEN, col("metaLeads"), "count", "right"), line("ghl", "Leads (GHL)", WHITE, col("totalLeads"), "count", "right")]} />
      <TrendChart title="Cost per lead over time" subtitle={`${bucket} · ad spend ÷ Meta leads`} labels={labels} series={[line("cpl", "Cost per lead", GREEN, col("cpl"), "currency")]} />
      <TrendChart title="Appointments booked over time" subtitle={`${bucket}${byLeadDate}`} labels={labels} series={[bar("booked", "Booked", GREY, col("appointmentsBooked"), "count"), line("attended", "Attended", GREEN, col("attendedAppointments"), "count")]} />
      <TrendChart title="Appointment show-up rate" subtitle={`${bucket}${byLeadDate}`} labels={labels} series={[line("show", "Show-up rate", GREEN, col("showUpRate"), "percent")]} />
      <TrendChart title="Lead-to-appointment conversion" subtitle={`${bucket}${byLeadDate}`} labels={labels} series={[line("l2a", "Lead to appointment", GREEN, col("leadToAppointment"), "percent")]} />
      <TrendChart title="Closed deals from ads over time" subtitle={`${bucket} · by the day the deal closed`} labels={labels} series={[bar("deals", "Closed deals", GREEN, col("closedDealsAttributed"), "count")]} />
      <TrendChart title="Revenue attributed to marketing" subtitle={`${bucket} · deal value recorded in GHL`} labels={labels} series={[bar("rev", "Revenue from ads", GREEN, col("revenueAttributed"), "currency"), line("spend2", "Ad spend", GREY, col("spend"), "currency")]} />
      <CampaignBars rows={campaigns.rows} />
    </div>
  );
}
