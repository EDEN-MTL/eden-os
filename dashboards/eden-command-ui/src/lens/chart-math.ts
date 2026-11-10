/** Pure helpers for the SVG charts: nice axis ticks and linear scales. */

/** Round-number axis ticks covering [min, max], starting at 0 for non-negative data. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) max = min + (min === 0 ? 1 : Math.abs(min) * 0.1);
  const lo = min >= 0 ? 0 : min;
  const span = max - lo;
  const rough = span / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t < max + step * 0.999; t += step) ticks.push(Math.round(t / step) * step);
  return ticks;
}

export function linearScale(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** The index of the point nearest an x position among `count` evenly spaced points across [x0, x1]. */
export function nearestIndex(x: number, count: number, x0: number, x1: number): number {
  if (count <= 1) return 0;
  const frac = (x - x0) / (x1 - x0);
  return Math.min(count - 1, Math.max(0, Math.round(frac * (count - 1))));
}

/** Runs of consecutive non-null values, so a line breaks at a gap instead of dropping to zero. */
export function segments(values: (number | null)[]): { index: number; value: number }[][] {
  const out: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  values.forEach((v, index) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) out.push(run);
      run = [];
    } else run.push({ index, value: v });
  });
  if (run.length) out.push(run);
  return out;
}
