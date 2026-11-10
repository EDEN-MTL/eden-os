import { useMemo, useState } from "react";
import { formatValue } from "./format";
import type { CampaignRow, CampaignsResponse, Unit } from "./types";

type Key = "name" | "spend" | "leads" | "metaLeads" | "cpl" | "appointmentsBooked" | "attendedAppointments" | "closedDeals" | "costPerAppointment" | "costPerClosedDeal" | "revenue" | "roas";

const COLUMNS: { key: Key; label: string; unit?: Unit; title?: string }[] = [
  { key: "name", label: "Campaign" },
  { key: "spend", label: "Spend", unit: "currency" },
  { key: "leads", label: "Leads (GHL)", unit: "count", title: "GHL leads created in the period that carry this campaign's ID" },
  { key: "metaLeads", label: "Leads (Meta)", unit: "count" },
  { key: "cpl", label: "Cost per lead", unit: "currency" },
  { key: "appointmentsBooked", label: "Appointments", unit: "count" },
  { key: "attendedAppointments", label: "Attended", unit: "count" },
  { key: "costPerAppointment", label: "Cost per appt", unit: "currency" },
  { key: "closedDeals", label: "Closed deals", unit: "count" },
  { key: "costPerClosedDeal", label: "Cost per deal", unit: "currency" },
  { key: "revenue", label: "Revenue", unit: "currency" },
  { key: "roas", label: "ROAS", unit: "ratio" },
];

/** Sortable campaign performance table with a totals row. N/A sorts last whichever way you sort. */
export default function CampaignTable({ data }: { data: CampaignsResponse }) {
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" });
  const rows = useMemo(() => {
    const tied = data.rows.filter((r) => r.campaignId !== null);
    const untied = data.rows.filter((r) => r.campaignId === null);
    const cmp = (a: CampaignRow, b: CampaignRow) => {
      const av = a[sort.key] as number | string | null;
      const bv = b[sort.key] as number | string | null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const d = typeof av === "string" ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
      return sort.dir === "asc" ? d : -d;
    };
    return [...tied].sort(cmp).concat(untied); // the "not tied to a campaign" row always stays last
  }, [data.rows, sort]);

  if (data.rows.length === 0) return <div className="lens-empty">No campaign activity in this period.</div>;

  return (
    <div className="lens-table-wrap">
      <table className="lens-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={c.key === "name" ? "is-name" : undefined} title={c.title}>
                <button type="button" onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.key === "name" ? "asc" : "desc" }))}>
                  {c.label}
                  <span aria-hidden="true">{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.campaignId ?? "untied"} className={r.campaignId === null ? "is-untied" : undefined}>
              {COLUMNS.map((c) =>
                c.key === "name" ? (
                  <th key="name" scope="row" className="is-name">
                    {r.name}
                    {r.noMetaData && <span className="lens-tag" title="This campaign ran before our synced Meta history, so spend is not shown.">no Meta data</span>}
                  </th>
                ) : (
                  <td key={c.key}>{formatValue(r[c.key] as number | null, c.unit!)}</td>
                )
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="is-name">All campaigns</th>
            <td>{formatValue(data.totals.spend, "currency")}</td>
            <td>{formatValue(data.totals.leads, "count")}</td>
            <td colSpan={5} />
            <td>{formatValue(data.totals.closedDeals, "count")}</td>
            <td />
            <td>{formatValue(data.totals.revenue, "currency")}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Spend beside revenue for each campaign, scaled to one shared maximum so the bars compare honestly. */
export function CampaignBars({ rows }: { rows: CampaignRow[] }) {
  const tied = rows.filter((r) => r.campaignId !== null && ((r.spend ?? 0) > 0 || (r.revenue ?? 0) > 0)).slice(0, 8);
  const max = Math.max(1, ...tied.flatMap((r) => [r.spend ?? 0, r.revenue ?? 0]));
  if (tied.length === 0) return <div className="lens-chart-empty">No campaign spend or revenue in this period.</div>;
  return (
    <figure className="lens-chart">
      <figcaption>
        <span className="lens-chart-title">Campaign performance comparison</span>
        <span className="lens-chart-sub">Spend and revenue per campaign</span>
      </figcaption>
      <div className="lens-legend">
        <span className="lens-legend-item"><i style={{ background: "var(--lens-grey-bar)" }} />Spend</span>
        <span className="lens-legend-item"><i style={{ background: "var(--lens-green)" }} />Revenue</span>
      </div>
      <ul className="lens-hbars">
        {tied.map((r) => (
          <li key={r.campaignId}>
            <span className="lens-hbar-name" title={r.name}>{r.name}</span>
            <span className="lens-hbar-bars">
              <span className="lens-hbar is-spend" style={{ width: `${((r.spend ?? 0) / max) * 100}%` }} />
              <span className="lens-hbar is-rev" style={{ width: `${((r.revenue ?? 0) / max) * 100}%` }} />
            </span>
            <span className="lens-hbar-val">{formatValue(r.spend, "currency")} / {formatValue(r.revenue, "currency")}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
