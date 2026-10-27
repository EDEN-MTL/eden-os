import { createPortal } from "react-dom";
import ChartsGrid from "./ChartsGrid";
import RevenueByCampaign from "./RevenueByCampaign";
import { Step } from "./Attribution";
import { cellText, ExportModel, ExportTable, headlineTiles } from "./export-model";
import { NA } from "./format";
import type { Report } from "./useLensReport";

/** Columns the PDF leaves out of a table (the CSV keeps them): long evidence text that a reader skims past. */
const PDF_HIDDEN: Record<string, string[]> = { deals: ["Evidence", "Form", "Appointments"] };

function Table({ table: full }: { table: ExportTable }) {
  const hidden = PDF_HIDDEN[full.id] ?? [];
  const keep = full.columns.map((c, i) => (hidden.includes(c) ? -1 : i)).filter((i) => i >= 0);
  const table: ExportTable = hidden.length === 0 ? full : { ...full, columns: keep.map((i) => full.columns[i]), rows: full.rows.map((r) => keep.map((i) => r[i])), footer: full.footer ? keep.map((i) => full.footer![i]) : undefined };
  // A column is right-aligned when any cell in it is a number; text columns (names, evidence) stay left.
  const numeric = (i: number) => table.rows.some((r) => typeof r[i] !== "string") || (table.footer ? typeof table.footer[i] !== "string" : false);
  return (
    <section className="lens-print-block">
      <h2>{table.title}</h2>
      {table.caption && <p className="lens-print-caption">{table.caption}</p>}
      {table.rows.length === 0 && table.empty ? (
        <p className="lens-print-empty">{table.empty}</p>
      ) : (
        <table className={`lens-print-table is-${table.id}${table.id.startsWith("kpi-") ? " is-kpi" : ""}`}>
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
  const tiles = headlineTiles(report);
  return createPortal(
    <div className="lens-print-root" aria-hidden="true">
      <header className="lens-print-header">
        <div className="lens-print-eyebrow">LENS · CLIENT PERFORMANCE REPORT</div>
        <h1>{model.client}</h1>
        <p className="lens-print-sub">
          {model.period.label}
          {model.previousPeriod ? ` · compared with ${model.previousPeriod.label}` : ""} · report made {model.meta.find(([k]) => k === "Report made")?.[1]}
        </p>
      </header>

      {tiles.length > 0 && (
        <section className="lens-print-tiles" aria-label="Key numbers">
          {tiles.map((t) => (
            <div key={t.key} className="lens-print-tile">
              <span className="lens-print-tile-label">{t.label}</span>
              <span className={`lens-print-tile-value${t.text === NA ? " is-na" : ""}`}>{t.text}</span>
              {t.change && <span className={`lens-print-tile-change tone-${t.tone}`}>{t.change}</span>}
            </div>
          ))}
        </section>
      )}

      <section className="lens-print-block">
        <h2>From lead to revenue</h2>
        <ol className="lens-chain">
          {report.attribution.chain.map((s) => (
            <Step key={s.id} step={s} />
          ))}
        </ol>
      </section>

      {model.notes.length > 0 && <p className="lens-print-strip">{model.notes.length} notes about how to read these numbers are on the last page. N/A means the number can't be worked out from the data we hold.</p>}

      <section className="lens-print-block">
        <RevenueByCampaign data={report.campaigns} />
      </section>

      <div className="lens-print-page">
        <Table table={byId("deals")} />
      </div>

      <section className="lens-print-block lens-print-page">
        <h2>Trends</h2>
        <ChartsGrid report={report} />
      </section>

      <div className="lens-print-page">
        <Table table={byId("campaigns")} />
        <Table table={byId("sources")} />
      </div>

      <div className="lens-print-page">
        <h2 className="lens-print-part">All the numbers</h2>
        {kpiTables.map((t) => (
          <Table key={t.id} table={t} />
        ))}
      </div>

      <div className="lens-print-page">
        <h2 className="lens-print-part">Notes</h2>
        <section className="lens-print-block lens-print-notes">
          <ul>
            {model.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
        <Table table={byId("methodology")} />
        <Table table={byId("definitions")} />
      </div>
    </div>,
    document.body
  );
}
