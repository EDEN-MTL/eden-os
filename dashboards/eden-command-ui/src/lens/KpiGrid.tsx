import { useState } from "react";
import { formatChange, formatValue, NA, toneOf } from "./format";
import type { MetricJson, SectionJson } from "./types";

function KpiCard({ metric, compared }: { metric: MetricJson; compared: boolean }) {
  const [open, setOpen] = useState(false);
  const na = metric.value === null;
  const tone = toneOf(metric.key, metric.change);
  const change = compared ? formatChange(metric.change, metric.changePct, metric.unit) : null;
  const arrow = metric.change && metric.change > 0 ? "▲" : metric.change && metric.change < 0 ? "▼" : "";

  return (
    <div className={`lens-card${na ? " is-na" : ""}`}>
      <div className="lens-card-head">
        <span className="lens-card-label">{metric.label}</span>
        <button type="button" className="lens-info" aria-expanded={open} aria-label={`What ${metric.label} means`} onClick={() => setOpen((o) => !o)}>
          i
        </button>
      </div>
      <div className="lens-card-value" aria-label={na ? `${metric.label}: not available` : undefined}>{formatValue(metric.value, metric.unit)}</div>
      {compared && (
        <div className={`lens-card-change tone-${tone}`}>
          {change ? (
            <>
              {arrow && <span aria-hidden="true">{arrow} </span>}
              {change}
              <span className="lens-card-prev"> vs {formatValue(metric.previous ?? null, metric.unit)}</span>
            </>
          ) : (
            <span className="lens-card-prev">{metric.previous === undefined ? "" : `vs ${formatValue(metric.previous ?? null, metric.unit)}`}</span>
          )}
        </div>
      )}
      {metric.note && <div className="lens-card-note">{metric.note}</div>}
      {open && (
        <div className="lens-def" role="note">
          <p>{metric.definition}</p>
          <p className="lens-def-source">Source: {metric.source}</p>
        </div>
      )}
    </div>
  );
}

export default function KpiGrid({ sections, compared, dim }: { sections: SectionJson[]; compared: boolean; dim: boolean }) {
  return (
    <div className={dim ? "lens-dim" : undefined}>
      {sections.map((s) => (
        <section key={s.id} className="lens-section" aria-labelledby={`lens-sec-${s.id}`}>
          <h2 className="lens-h2" id={`lens-sec-${s.id}`}>{s.title}</h2>
          <div className="lens-grid">
            {s.metrics.map((m) => (
              <KpiCard key={`${s.id}-${m.key}`} metric={m} compared={compared} />
            ))}
          </div>
        </section>
      ))}
      <p className="lens-footnote">{NA} means the number cannot be worked out from the data available (a zero denominator, or a source that is not connected). It is never shown as 0.</p>
    </div>
  );
}
