/**
 * Lens's first real capability. Everything it reports rolls up from
 * attributionReport() — the same query Forge's rule engine and the
 * dashboard's attribution numbers are meant to use — so this can't drift
 * from what Forge sees. Lens does not compute anything new, it only totals
 * and formats what already exists in meta_performance_snapshots + ad_leads.
 */
import { attributionReport } from "../forge/ads/attribution";

export interface WeeklyTotals {
  spend: number;
  leads: number;
  won: number;
  revenue: number;
  pipelineValue: number;
  activeCount: number;
  cpl: number | null;
  roas: number | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Trailing 7-day window ending today, in the client's ad account currency. */
export async function computeWeeklyTotals(clientId: string): Promise<WeeklyTotals> {
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await attributionReport(isoDate(since), isoDate(until), clientId);

  const totals = rows.reduce(
    (acc, r) => {
      acc.spend += r.spend;
      acc.leads += r.lead_count;
      acc.won += r.won_count;
      acc.revenue += r.revenue;
      acc.pipelineValue += r.pipeline_value;
      acc.activeCount += r.active_count;
      return acc;
    },
    { spend: 0, leads: 0, won: 0, revenue: 0, pipelineValue: 0, activeCount: 0 }
  );

  return {
    ...totals,
    cpl: totals.leads ? Math.round((totals.spend / totals.leads) * 100) / 100 : null,
    // Revenue-only, matching attributionReport's own ROAS — pipeline value
    // is forecastable, not banked, and shouldn't inflate this number.
    roas: totals.spend ? Math.round((totals.revenue / totals.spend) * 100) / 100 : null,
  };
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** The three stat lines shared by both the single-client and all-clients report. */
function statLines(t: WeeklyTotals): string[] {
  return [
    `Spend: ${money(t.spend)}  ·  Leads: ${t.leads}  ·  Blended CPL: ${t.cpl !== null ? money(t.cpl) : "n/a"}`,
    `Won: ${t.won}  ·  Revenue: ${money(t.revenue)}  ·  ROAS: ${t.roas !== null ? `${t.roas}x` : "n/a"}`,
    `In pipeline: ${t.activeCount} deal${t.activeCount === 1 ? "" : "s"} worth ${money(t.pipelineValue)} (not yet counted in ROAS)`,
  ];
}

export function formatWeeklyReport(clientName: string, t: WeeklyTotals): string {
  return [`*${clientName} — weekly ad performance (last 7 days)*`, ...statLines(t)].join("\n");
}

/**
 * One message covering every client, for the internal ops channel only.
 * Never sent to a client's own channel — see runWeeklyLensReport.
 */
export function formatAllClientsReport(entries: { clientName: string; totals: WeeklyTotals }[]): string {
  const sections = entries.map(({ clientName, totals }) => [`*${clientName}*`, ...statLines(totals)].join("\n"));
  return [`*Weekly ad performance — all clients (last 7 days)*`, "", sections.join("\n\n")].join("\n");
}
