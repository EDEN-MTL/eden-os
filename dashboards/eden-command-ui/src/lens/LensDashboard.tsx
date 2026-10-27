import { useEffect, useState } from "react";
import "./lens.css";
import ClientSelect from "./ClientSelect";
import PeriodPicker from "./PeriodPicker";
import KpiGrid from "./KpiGrid";
import ChartsGrid from "./ChartsGrid";
import CampaignTable from "./CampaignTable";
import RevenueByCampaign from "./RevenueByCampaign";
import Attribution from "./Attribution";
import ExportMenu from "./ExportMenu";
import LensBoundary from "./LensBoundary";
import { freshnessNotes } from "./freshness";
import { Report, useLensClients, useLensReport } from "./useLensReport";
import type { LensClient, PeriodChoice } from "./types";

const STORAGE_KEY = "lens.client";

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

function LensDashboardInner() {
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
  // When a reload fails the old numbers stay up, so they are dimmed and named, never passed off as the new selection.
  const stale = state.status === "error" && state.previous !== null;
  const dim = loading || stale;
  const freshness = kpis ? freshnessNotes({ periodTo: kpis.period.to, metaConnected: kpis.client.meta.connected, metaLastDay: kpis.client.meta.lastDay }) : [];

  // An export must match the client and period chosen, so it waits for the report that belongs to them.
  const exportBlocked = state.status === "loading" ? "Wait for the report to finish loading" : state.status === "error" ? "Reload the report first, then export" : state.status === "idle" ? "Choose a client and a period first" : null;

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
        <ExportMenu report={state.status === "ready" ? state.report : null} unavailable={exportBlocked} />
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
          {stale && kpis && <span>The numbers below are the last report that loaded ({kpis.client.name}, {kpis.period.label}), not what is selected above.</span>}
          <button type="button" className="lens-button" onClick={retry}>Try again</button>
        </div>
      )}

      {(clientId && (state.status === "loading" || state.status === "error" || state.status === "ready")) && <ClientBanner client={client} kpis={kpis} />}

      {kpis && shown && (
        <>
          {freshness.length > 0 && (
            <div className="lens-banner is-warn" role="note">
              <strong>Data stops early</strong>
              <ul>
                {freshness.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
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
          <KpiGrid sections={kpis.sections} compared={Boolean(kpis.previousPeriod)} dim={dim} />
          <section className={`lens-section${dim ? " lens-dim" : ""}`} aria-labelledby="lens-trends">
            <h2 className="lens-h2" id="lens-trends">Trends</h2>
            <ChartsGrid report={shown} />
          </section>
          <section className={`lens-section${dim ? " lens-dim" : ""}`} aria-labelledby="lens-campaigns">
            <h2 className="lens-h2" id="lens-campaigns">Campaign performance</h2>
            <RevenueByCampaign data={shown.campaigns} />
            <CampaignTable data={shown.campaigns} />
          </section>
          <section className={`lens-section${dim ? " lens-dim" : ""}`} aria-labelledby="lens-attribution">
            <h2 className="lens-h2" id="lens-attribution">Closed-deal attribution</h2>
            <Attribution data={shown.attribution} />
          </section>
        </>
      )}

      {!kpis && loading && <Skeleton />}
    </div>
  );
}

export default function LensDashboard() {
  return (
    <LensBoundary>
      <LensDashboardInner />
    </LensBoundary>
  );
}
