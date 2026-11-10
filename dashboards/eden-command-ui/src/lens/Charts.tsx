import { useMemo, useRef, useState } from "react";
import { linearScale, nearestIndex, niceTicks, segments } from "./chart-math";
import { formatCompact, formatValue } from "./format";
import type { Unit } from "./types";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  kind: "bar" | "line";
  axis: "left" | "right";
  values: (number | null)[];
  unit: Unit;
}

const W = 640;
const H = 250;
const M = { top: 14, bottom: 30, left: 56, right: 56 };

/**
 * One trend chart: bars and/or lines over the period's buckets, a left axis and an optional right axis, a hover
 * readout, and a plain table of the same numbers underneath for anyone who can't use the picture. A gap in the
 * data (N/A) breaks a line instead of dropping it to zero.
 */
export default function TrendChart({ title, subtitle, labels, series }: { title: string; subtitle?: string; labels: string[]; series: ChartSeries[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const hasRight = series.some((s) => s.axis === "right");
  const left = M.left;
  const right = W - (hasRight ? M.right : 14);
  const top = M.top;
  const bottom = H - M.bottom;
  const slot = n > 0 ? (right - left) / n : 0;
  const cx = (i: number) => left + (i + 0.5) * slot;

  const axes = useMemo(() => {
    const build = (side: "left" | "right") => {
      const group = series.filter((s) => s.axis === side);
      if (group.length === 0) return null;
      const all = group.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
      const max = all.length ? Math.max(...all) : 0;
      const min = all.length ? Math.min(...all, 0) : 0;
      const ticks = niceTicks(min, max <= 0 ? 1 : max, 4);
      const domain: [number, number] = [ticks[0], ticks[ticks.length - 1]];
      return { ticks, scale: linearScale(domain, [bottom, top]), unit: group[0].unit };
    };
    return { left: build("left"), right: build("right") };
  }, [series, bottom, top]);

  const empty = series.every((s) => s.values.every((v) => v === null || v === 0));
  const stride = Math.max(1, Math.ceil(n / 8));
  const bars = series.filter((s) => s.kind === "bar");
  const barW = bars.length ? Math.min(34, (slot * 0.7) / bars.length) : 0;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    setHover(nearestIndex(x, n, cx(0), cx(n - 1)));
  }

  return (
    <figure className="lens-chart">
      <figcaption>
        <span className="lens-chart-title">{title}</span>
        {subtitle && <span className="lens-chart-sub">{subtitle}</span>}
      </figcaption>
      <div className="lens-legend">
        {series.map((s) => (
          <span key={s.key} className="lens-legend-item">
            <i style={{ background: s.color }} className={s.kind === "line" ? "is-line" : ""} />
            {s.label}
          </span>
        ))}
      </div>
      {empty ? (
        <div className="lens-chart-empty">No data for this period.</div>
      ) : (
        <div className="lens-chart-wrap">
          <svg
            ref={ref}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${title}. ${series.map((s) => s.label).join(", ")} by ${labels.length} periods. A table of the numbers follows.`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {(axes.left?.ticks ?? []).map((t) => (
              <g key={`l${t}`}>
                <line x1={left} x2={right} y1={axes.left!.scale(t)} y2={axes.left!.scale(t)} className="lens-grid-line" />
                <text x={left - 8} y={axes.left!.scale(t) + 4} textAnchor="end" className="lens-axis">{formatCompact(t, axes.left!.unit)}</text>
              </g>
            ))}
            {hasRight && (axes.right?.ticks ?? []).map((t) => (
              <text key={`r${t}`} x={right + 8} y={axes.right!.scale(t) + 4} className="lens-axis">{formatCompact(t, axes.right!.unit)}</text>
            ))}
            {labels.map((l, i) =>
              i % stride === 0 ? (
                <text key={`x${i}`} x={cx(i)} y={H - 10} textAnchor="middle" className="lens-axis">{l}</text>
              ) : null
            )}
            {bars.map((s, bi) =>
              s.values.map((v, i) => {
                if (v === null || v <= 0) return null;
                const axis = s.axis === "right" ? axes.right! : axes.left!;
                const x = cx(i) - (bars.length * barW) / 2 + bi * barW;
                return <rect key={`${s.key}${i}`} x={x} y={axis.scale(v)} width={Math.max(1, barW - 1)} height={Math.max(0, bottom - axis.scale(v))} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} rx={1.5} />;
              })
            )}
            {series.filter((s) => s.kind === "line").map((s) => {
              const axis = s.axis === "right" ? axes.right! : axes.left!;
              return segments(s.values).map((run, ri) => (
                <g key={`${s.key}${ri}`}>
                  {run.length > 1 && <polyline fill="none" stroke={s.color} strokeWidth={2.25} strokeLinejoin="round" points={run.map((p) => `${cx(p.index)},${axis.scale(p.value)}`).join(" ")} />}
                  {(run.length === 1 || n <= 40) && run.map((p) => <circle key={p.index} cx={cx(p.index)} cy={axis.scale(p.value)} r={run.length === 1 ? 3.5 : 2.5} fill={s.color} />)}
                </g>
              ));
            })}
            {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={top} y2={bottom} className="lens-guide" />}
          </svg>
          {hover !== null && (
            <div className="lens-tooltip" style={{ left: `${(cx(hover) / W) * 100}%` }} role="status">
              <strong>{labels[hover]}</strong>
              {series.map((s) => (
                <div key={s.key}>
                  <i style={{ background: s.color }} /> {s.label}: <b>{formatValue(s.values[hover], s.unit)}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <details className="lens-chart-data">
        <summary>View the numbers</summary>
        <table>
          <thead>
            <tr><th>Period</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l + i}>
                <td>{l}</td>
                {series.map((s) => <td key={s.key}>{formatValue(s.values[i], s.unit)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
