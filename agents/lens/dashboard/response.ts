/**
 * Turns the computed numbers into the JSON the dashboard (and later the exports) read: every metric carries its
 * label, definition and source, its value for the period, and how it moved against the previous period.
 */
import { DashboardKpis } from "./data";
import { definitionsForBasis, MetricKey } from "./definitions";
import { Section, SECTIONS } from "./sections";
import { MetricValue } from "./metrics";
import { DateRange, rangeLabel } from "./ranges";

export interface MetricJson {
  key: MetricKey;
  label: string;
  definition: string;
  source: string;
  unit: MetricValue["unit"];
  value: number | null;
  note?: string;
  previous?: number | null;
  change?: number | null;
  changePct?: number | null;
}

export interface SectionJson {
  id: Section["id"];
  title: string;
  metrics: MetricJson[];
}

export interface KpiResponse {
  client: { clientId: string; name: string; timezone: string; meta: { connected: boolean; lastDay: string | null }; ghl: { connected: boolean }; missing: string[] };
  period: { from: string; to: string; label: string; timezone: string; daysAgoNote?: string };
  previousPeriod: { from: string; to: string; label: string } | null;
  generatedAt: string;
  appointmentBasis: "calendar" | "pipeline";
  sections: SectionJson[];
  attribution: { confirmed: number; partial: number; unknown: number; note: string };
  notes: string[];
}

const labelled = (r: DateRange) => ({ from: r.from, to: r.to, label: rangeLabel(r) });

export const ATTRIBUTION_NOTE =
  "A lead counts as coming from ads only when it carries a real Meta campaign ID (confirmed). A lead with only a typed campaign label, or a Facebook source but no campaign ID, is partial; one with nothing is unknown. Neither is counted as from ads. " +
  "Closed deals and revenue are counted in the period the deal closed, whenever the lead arrived. Revenue is the deal value recorded in GHL; a closed deal with no value adds nothing and is flagged.";

export function toKpiResponse(out: DashboardKpis, now: Date = new Date()): KpiResponse {
  const basis = out.current.detail.appointmentBasis;
  const defs = definitionsForBasis(basis);
  const metric = (key: MetricKey): MetricJson => {
    const m = out.current.kpis[key];
    const d = defs[key];
    const change = out.changes?.[key];
    return {
      key,
      label: d.label,
      definition: d.definition,
      source: d.source,
      unit: m.unit,
      value: m.value,
      ...(m.note ? { note: m.note } : {}),
      ...(change ? { previous: change.previous, change: change.change, changePct: change.changePct } : {}),
    };
  };
  return {
    client: {
      clientId: out.client.clientId,
      name: out.client.name,
      timezone: out.timezone,
      meta: { connected: out.client.meta.connected, lastDay: out.client.meta.lastDay },
      ghl: { connected: out.client.ghl.connected },
      missing: out.client.missing,
    },
    period: { ...labelled(out.range), timezone: out.timezone },
    previousPeriod: out.previousRange ? labelled(out.previousRange) : null,
    generatedAt: now.toISOString(),
    appointmentBasis: basis,
    sections: SECTIONS.map((s) => ({ id: s.id, title: s.title, metrics: s.keys.map(metric) })),
    attribution: { ...out.current.detail.leadsByAttribution, note: ATTRIBUTION_NOTE },
    notes: out.current.notes,
  };
}
