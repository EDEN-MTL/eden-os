import { createPortal } from "react-dom";
import ChartsGrid from "./ChartsGrid";
import RevenueByCampaign from "./RevenueByCampaign";
import { cellText, ExportModel, ExportTable } from "./export-model";
import type { Report } from "./useLensReport";

function Table({ table }: { table: ExportTable }) {
  // A column is right-aligned when any cell in it is a number; text columns (names, evidence) stay left.
  const numeric = (i: number) => table.rows.some((r) => typeof r[i] !== "string") || (table.footer ? typeof table.footer[i] !== "string" : false);
  return (
    <section className="lens-print-block">
      <h2>{table.title}</h2>
      {table.caption && <p className="lens-print-caption">{table.caption}</p>}
      {table.rows.length === 0 && table.empty ? (
        <p className="lens-print-empty">{table.empty}</p>
      ) : (
        <table className={`lens-print-table${table.id.startsWith("kpi-") ? " is-kpi" : ""}`}>
          <thead>
            <tr>
              {table.columns.map((c, i) => (
                <th key={c} scope="col" className={numeric(i) ? "is-num" : undefined}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, i) => (
                  <td key={i} className={numeric(i) ? "is-num" : typeof c === "string" && c.length <= 12 ? "is-text is-short" : "is-text"}>{cellText(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {table.footer && (
            <tfoot>
              <tr>
                {table.footer.map((c, i) => (
                  <td key={i} className={numeric(i) ? "is-num" : "is-text"}>{cellText(c)}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </section>
  );
}

/**
 * The PDF. Rendered into <body> only while printing (the page's own screen is hidden by the print stylesheet), in
 * a light theme with the same green, black and grey, so the browser's "Save as PDF" produces a clean landscape
 * report: a header that names the client and period, the key numbers, the charts, the tables, and the notes about
 * missing data.
 */
export default function PrintReport({ model, report }: { model: ExportModel; report: Report }) {
  const kpiTables = model.tables.filter((t) => t.id.startsWith("kpi-"));
  const byId = (id: string) => model.tables.find((t) => t.id === id)!;
  return createPortal(
    <div className="lens-print-root" aria-hidden="true">
      <header className="lens-print-header">
        <div className="lens-print-eyebrow">LENS · CLIENT PERFORMANCE REPORT</div>
        <h1>{model.client}</h1>
        <dl>
          {model.meta.filter(([k]) => k !== "Client").map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      {model.notes.length > 0 && (
        <section className="lens-print-block lens-print-notes">
          <h2>Read this with the numbers</h2>
          <ul>
            {model.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {kpiTables.map((t) => (
        <Table key={t.id} table={t} />
      ))}

      <section className="lens-print-block lens-print-page">
        <h2>Trends</h2>
        <ChartsGrid report={report} />
      </section>

      <section className="lens-print-block lens-print-page">
        <RevenueByCampaign data={report.campaigns} />
      </section>
      <Table table={byId("campaigns")} />
      <Table table={byId("chain")} />
      <Table table={byId("deals")} />
      <Table table={byId("sources")} />
      <Table table={byId("methodology")} />
      <Table table={byId("definitions")} />
    </div>,
    document.body
  );
}
