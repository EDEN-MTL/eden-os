import { NA } from "./format";
import type { Cell, ExportModel } from "./export-model";

/**
 * One CSV cell. Quoted when it holds a comma, quote or line break. A text cell that starts with = + - @ is
 * prefixed with an apostrophe so a spreadsheet shows it as text instead of running it as a formula (lead names
 * and form names are typed by other people).
 */
export function csvField(value: string | number | null): string {
  if (value === null) return NA;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : NA;
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A number goes in raw (so a spreadsheet can sum it), N/A as the text N/A. */
function cell(c: Cell): string {
  if (typeof c === "string") return csvField(c);
  // Two decimals: the sums behind money and rates carry floating-point dust (9335.659999999987) that means nothing.
  return csvField(c.v === null || c.unit === "count" ? c.v : Math.round(c.v * 100) / 100);
}

/**
 * The whole report as one CSV: a header block, then each table with its title row, column row, rows and total,
 * separated by blank lines, then the data notes. Opens in Excel and Sheets; numbers are raw values with the unit
 * in the column's meaning (dollars, counts, percent points, ratios).
 */
export function toCsv(model: ExportModel): string {
  const lines: string[] = [];
  const row = (cells: (string | number | null)[]) => lines.push(cells.map(csvField).join(","));
  const blank = () => lines.push("");

  row(["EDEN LENS CLIENT REPORT"]);
  for (const [label, value] of model.meta) row([label, value]);
  blank();

  for (const t of model.tables) {
    row([t.title]);
    if (t.caption) row([t.caption]);
    if (t.rows.length === 0 && t.empty) {
      row([t.empty]);
    } else {
      row(t.columns);
      for (const r of t.rows) lines.push(r.map(cell).join(","));
      if (t.footer) lines.push(t.footer.map(cell).join(","));
    }
    blank();
  }

  row(["Data notes"]);
  for (const n of model.notes) row([n]);

  // Windows line endings and a byte-order mark: the combination Excel needs to read the file as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Hands the file to the browser as a download. */
export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
