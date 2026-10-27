import { useState } from "react";
import { PRESET_LABELS } from "./format";
import type { PeriodChoice, Preset } from "./types";

const PRESETS: Preset[] = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "custom"];

/** Preset periods, a custom start and end date, and the compare toggle. Custom dates apply on "Apply". */
export default function PeriodPicker({ value, onChange }: { value: PeriodChoice; onChange: (p: PeriodChoice) => void }) {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const invalid = value.preset === "custom" && (!from || !to || from > to);

  return (
    <div className="lens-field lens-period">
      <label className="lens-label" htmlFor="lens-preset">Reporting period</label>
      <div className="lens-period-row">
        <select
          id="lens-preset"
          className="lens-select"
          value={value.preset}
          onChange={(e) => {
            const preset = e.target.value as Preset;
            onChange({ ...value, preset, ...(preset === "custom" ? { from, to } : {}) });
          }}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>{PRESET_LABELS[p]}</option>
          ))}
        </select>
        {value.preset === "custom" && (
          <div className="lens-custom">
            <input type="date" className="lens-input lens-date" aria-label="Start date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span aria-hidden="true">to</span>
            <input type="date" className="lens-input lens-date" aria-label="End date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            <button type="button" className="lens-button" disabled={invalid || (from === value.from && to === value.to)} onClick={() => onChange({ ...value, from, to })}>
              Apply
            </button>
          </div>
        )}
        <label className="lens-check">
          <input type="checkbox" checked={value.compare} onChange={(e) => onChange({ ...value, compare: e.target.checked })} />
          <span>Compare with previous period</span>
        </label>
      </div>
      {invalid && <div className="lens-hint" role="alert">Pick a start date that is on or before the end date.</div>}
    </div>
  );
}
