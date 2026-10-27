import { useEffect, useMemo, useRef, useState } from "react";
import { downloadText, toCsv } from "./csv";
import { buildExportModel, ExportModel } from "./export-model";
import PrintReport from "./PrintReport";
import type { Report } from "./useLensReport";

/**
 * Export button for the report on screen. It exports exactly what is shown (that client, that period), and is
 * switched off, with the reason beside it, while the numbers are loading or if there is nothing to export, so a
 * file can never mix one period's numbers with another's label. Lead names are left out unless asked for.
 */
export default function ExportMenu({ report, unavailable }: { report: Report | null; unavailable: string | null }) {
  const [open, setOpen] = useState(false);
  const [includeNames, setIncludeNames] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [printing, setPrinting] = useState<{ model: ExportModel; report: Report } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const disabled = !report || unavailable !== null;
  const model = useMemo(() => (report ? buildExportModel(report, { includeNames }) : null), [report, includeNames]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Closes the menu if the numbers change underneath it (a new period or client started loading).
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Printing: the PDF is the browser's own "Save as PDF" of a print-only copy of the report. The page title becomes
  // the suggested file name, and everything is put back when the print dialog closes.
  useEffect(() => {
    if (!printing) return;
    const title = document.title;
    const restore = () => {
      document.body.classList.remove("lens-printing");
      document.title = title;
    };
    const done = () => {
      restore();
      setPrinting(null);
    };
    document.title = printing.model.fileBase;
    document.body.classList.add("lens-printing");
    window.addEventListener("afterprint", done, { once: true });
    // A beat for the charts to mount before the browser takes its snapshot.
    const timer = window.setTimeout(() => window.print(), 150);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      restore();
    };
  }, [printing]);

  function downloadCsv() {
    if (!model) return;
    try {
      setProblem(null);
      downloadText(`${model.fileBase}.csv`, toCsv(model));
      setOpen(false);
    } catch (e) {
      setProblem(`Could not create the CSV: ${e instanceof Error ? e.message : "unknown error"}.`);
    }
  }

  function savePdf() {
    if (!model || !report) return;
    setProblem(null);
    setOpen(false);
    setPrinting({ model, report });
  }

  return (
    <div className="lens-export" ref={box}>
      <button type="button" className="lens-button is-primary" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-describedby="lens-export-note" onClick={() => setOpen((o) => !o)}>
        Export report
      </button>
      <span id="lens-export-note" className="lens-export-note">
        {unavailable ?? (report && model ? `Exports ${model.client}, ${model.period.label}` : "Choose a client and a period first")}
      </span>
      {open && model && (
        <div className="lens-export-pop" role="dialog" aria-label="Export report">
          <p className="lens-export-what">
            <strong>{model.client}</strong>
            <span>{model.period.label}{model.previousPeriod ? `, compared with ${model.previousPeriod.label}` : ""}</span>
          </p>
          <label className="lens-check">
            <input type="checkbox" checked={includeNames} onChange={(e) => setIncludeNames(e.target.checked)} />
            <span>Include lead names</span>
          </label>
          <p className="lens-export-hint">{includeNames ? "Names of leads who closed a deal will appear. Only share this with people who should see them." : "Leads who closed a deal appear as Lead 1, Lead 2 and so on. Best for sending to a client."}</p>
          <div className="lens-export-actions">
            <button type="button" className="lens-button" onClick={downloadCsv}>Download CSV</button>
            <button type="button" className="lens-button" onClick={savePdf}>Save as PDF</button>
          </div>
          <p className="lens-export-hint">The CSV opens in Excel or Google Sheets and includes the chart data. For the PDF, choose "Save as PDF" as the destination in the print window.</p>
          {problem && <p className="lens-hint" role="alert">{problem}</p>}
        </div>
      )}
      {printing && <PrintReport model={printing.model} report={printing.report} />}
    </div>
  );
}
