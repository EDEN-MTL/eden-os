import { useEffect, useMemo, useState } from "react";
import "./lens.css";
import ClientSelect from "./ClientSelect";
import PeriodPicker from "./PeriodPicker";
import KpiGrid from "./KpiGrid";
import TrendChart, { ChartSeries } from "./Charts";
import CampaignTable, { CampaignBars } from "./CampaignTable";
import { bucketLabel } from "./format";
import { Report, useLensClients, useLensReport } from "./useLensReport";
import type { LensClient, PeriodChoice } from "./types";

const STORAGE_KEY = "lens.client";
const GREEN = "var(--lens-green)";
const GREY = "var(--lens-grey-bar)";
const WHITE = "var(--lens-white)";

function remembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function remember(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode: fine, nothing is lost but the memory */
  }
}

function ymdDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Skeleton() {
  return (
    <div className="lens-skeleton" aria-busy="true" aria-label="Loading the report">
      <div className="lens-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <div className="lens-card is-skeleton" key={i} />
        ))}
      </div>
      <div className="lens-charts">
        {Array.from({ length: 2 }, (_, i) => (
          <div className="lens-chart is-skeleton" key={i} />
        ))}
      </div>
    </div>
  );
}

function ChartsGrid({ report }: { report: Report }) {
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

function ClientBanner({ client, kpis }: { client: LensClient | undefined; kpis: Report["kpis"] | null }) {
  const missing = kpis?.client.missing ?? client?.missing ?? [];
  if (missing.length === 0) return null;
  return (
    <div className="lens-banner is-warn" role="status">
      <strong>Not everything is connected for this client.</strong>
      <ul>
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <span>Numbers that depend on it show N/A instead of zero.</span>
    </div>
  );
}

export default function LensDashboard() {
  const clients = useLensClients();
  const [clientId, setClientId] = useState<string | null>(remembered());
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days", from: ymdDaysAgo(30), to: ymdDaysAgo(1), compare: true });

  useEffect(() => {
    if (clients.state.status !== "ready") return;
    const list = clients.state.clients;
    if (clientId && list.some((c) => c.clientId === clientId)) return;
    const first = list.find((c) => c.meta.connected && c.ghl.connected) ?? list[0];
    if (first) setClientId(first.clientId);
  }, [clients.state, clientId]);

  const { state, retry } = useLensReport(clientId, period);
  const client = clients.state.status === "ready" ? clients.state.clients.find((c) => c.clientId === clientId) : undefined;
  const shown: Report | null = state.status === "ready" ? state.report : state.status === "loading" || state.status === "error" ? state.previous : null;
  const kpis = shown?.kpis ?? null;
  const loading = state.status === "loading";

  function pickClient(id: string) {
    setClientId(id);
    remember(id);
  }

  return (
    <div className="lens">
      <header className="lens-header">
        <div>
          <div className="lens-eyebrow">LENS · CLIENT PERFORMANCE</div>
          <h1 className="lens-title">Reporting dashboard</h1>
          <p className="lens-context" aria-live="polite">
            {kpis ? (
              <>
                <strong>{kpis.client.name}</strong> · {kpis.period.label} ({kpis.client.timezone})
                {kpis.previousPeriod && <> · compared with {kpis.previousPeriod.label}</>}
                {kpis.client.meta.lastDay && <> · Meta data through {kpis.client.meta.lastDay}</>}
              </>
            ) : (
              "Choose a client and a period."
            )}
          </p>
        </div>
        <button type="button" className="lens-button is-primary" disabled title="CSV and PDF export arrive in a later step" aria-describedby="lens-export-note">
          Export report
        </button>
        <span id="lens-export-note" className="lens-export-note">CSV and PDF export: coming next</span>
      </header>

      <div className="lens-controls">
        {clients.state.status === "ready" ? <ClientSelect clients={clients.state.clients} value={clientId} onChange={pickClient} /> : <div className="lens-field"><span className="lens-label">Client</span><div className="lens-select-button is-skeleton" /></div>}
        <PeriodPicker value={period} onChange={setPeriod} />
        {loading && <span className="lens-updating" role="status">{kpis ? "Updating…" : "Loading…"}</span>}
      </div>

      {clients.state.status === "error" && (
        <div className="lens-banner is-error" role="alert">
          <strong>Could not load the client list.</strong> {clients.state.message}
          <button type="button" className="lens-button" onClick={clients.retry}>Try again</button>
        </div>
      )}

      {clients.state.status === "ready" && clients.state.clients.length === 0 && <div className="lens-empty">No clients are set up yet.</div>}

      {state.status === "error" && (
        <div className="lens-banner is-error" role="alert">
          <strong>Could not build this report.</strong> {state.message}
          <button type="button" className="lens-button" onClick={retry}>Try again</button>
        </div>
      )}

      {(clientId && (state.status === "loading" || state.status === "error" || state.status === "ready")) && <ClientBanner client={client} kpis={kpis} />}

      {kpis && shown && (
        <>
          {kpis.notes.length > 0 && (
            <div className="lens-banner" role="note">
              <strong>Read this with the numbers</strong>
              <ul>
                {kpis.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <KpiGrid sections={kpis.sections} compared={Boolean(kpis.previousPeriod)} dim={loading} />
          <section className={`lens-section${loading ? " lens-dim" : ""}`} aria-labelledby="lens-trends">
            <h2 className="lens-h2" id="lens-trends">Trends</h2>
            <ChartsGrid report={shown} />
          </section>
          <section className={`lens-section${loading ? " lens-dim" : ""}`} aria-labelledby="lens-campaigns">
            <h2 className="lens-h2" id="lens-campaigns">Campaign performance</h2>
            <CampaignTable data={shown.campaigns} />
          </section>
          <section className="lens-section" aria-labelledby="lens-attribution">
            <h2 className="lens-h2" id="lens-attribution">How closed deals are attributed</h2>
            <div className="lens-attribution">
              <div><b>{kpis.attribution.confirmed}</b><span>leads with a confirmed Meta campaign ID</span></div>
              <div><b>{kpis.attribution.partial}</b><span>with only a typed campaign label (partial)</span></div>
              <div><b>{kpis.attribution.unknown}</b><span>with no campaign recorded (unknown)</span></div>
            </div>
            <p className="lens-method">{kpis.attribution.note}</p>
          </section>
        </>
      )}

      {!kpis && loading && <Skeleton />}
    </div>
  );
}
