/**
 * Lead funnel for Lens's reports: how many leads reached each stage
 * (live transferred, appointment booked, showed up, signed/closed), split
 * buyer/seller. Mark asked for it 2026-10-20 to see how many leads have
 * actually converted since August 2026, not just how many came in.
 *
 * Reads ad_leads (GHL contacts + their opportunity, synced hourly by
 * runLeadSync), so it covers every lead that came from an ad or sits in the
 * client's pipeline.
 *
 * What counts as each stage is per-client config (lens.funnel), because it
 * lives in tags and pipeline column names that differ by client. 3% marks
 * progress both ways: a tag ("appt booked") that stays on the contact, and
 * the card's column ("Appointment Set"), which moves on as the lead
 * progresses. So a step matches on either, and a step's stage list includes
 * the later columns too: a card sitting in "Showed Up" was also booked.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";

export interface FunnelStep {
  label: string;
  /** Contact tags that mean the lead reached this step. Case-insensitive. */
  tags?: string[];
  /** Opportunity stages (pipeline columns) at or past this step. Case-insensitive. */
  stages?: string[];
}

export interface FunnelSide {
  /** e.g. "Buyers". */
  name: string;
  /** Contact tags marking a lead as this side. */
  tags: string[];
}

export interface FunnelConfig {
  /** YYYY-MM-DD: the "since" date for the running total. */
  since: string;
  sides: FunnelSide[];
  steps: FunnelStep[];
}

export interface LeadOutcome {
  tags: string[];
  stage: string | null;
}

export interface FunnelCounts {
  /** Leads added in the period, per side name plus "Total". */
  leads: Record<string, number>;
  /** step label → side name (plus "Total") → count. */
  steps: { label: string; counts: Record<string, number> }[];
}

const TOTAL = "Total";

export function loadFunnelConfig(clientId: string): FunnelConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
    const f = raw?.lens?.funnel;
    if (!f || typeof f.since !== "string" || !Array.isArray(f.steps) || !Array.isArray(f.sides)) return null;
    return f;
  } catch {
    return null;
  }
}

const lowerSet = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.trim().toLowerCase()));

export function reachedStep(lead: LeadOutcome, step: FunnelStep): boolean {
  const tags = lowerSet(lead.tags);
  if ((step.tags ?? []).some((t) => tags.has(t.trim().toLowerCase()))) return true;
  return lead.stage !== null && lowerSet(step.stages).has(lead.stage.trim().toLowerCase());
}

export function sideOf(lead: LeadOutcome, sides: FunnelSide[]): string | null {
  const tags = lowerSet(lead.tags);
  return sides.find((s) => s.tags.some((t) => tags.has(t.trim().toLowerCase())))?.name ?? null;
}

/** Pure so the counting is unit-testable without the DB. */
export function countFunnel(leads: LeadOutcome[], config: FunnelConfig): FunnelCounts {
  const keys = [...config.sides.map((s) => s.name), TOTAL];
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
  const out: FunnelCounts = { leads: zero(), steps: config.steps.map((s) => ({ label: s.label, counts: zero() })) };

  for (const lead of leads) {
    const side = sideOf(lead, config.sides);
    out.leads[TOTAL]++;
    if (side) out.leads[side]++;
    config.steps.forEach((step, i) => {
      if (!reachedStep(lead, step)) return;
      out.steps[i].counts[TOTAL]++;
      if (side) out.steps[i].counts[side]++;
    });
  }
  return out;
}

/** Leads added from `since` (inclusive) to `until` (exclusive), YYYY-MM-DD; no `until` = up to now. */
export async function computeFunnel(clientId: string, config: FunnelConfig, since: string, until?: string): Promise<FunnelCounts> {
  const rows = await query<{ tags: string[] | null; stage: string | null }>(
    `SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(raw->'contact'->'tags') = 'array' THEN raw->'contact'->'tags' ELSE '[]'::jsonb END)), '{}') AS tags,
            pipeline_stage AS stage
     FROM ad_leads
     WHERE client_id = $1 AND created_at >= $2::date AND ($3::date IS NULL OR created_at < $3::date)`,
    [clientId, since, until ?? null]
  );
  return countFunnel(rows.map((r) => ({ tags: r.tags ?? [], stage: r.stage })), config);
}

/** e.g. "Live transferred: 11 (10 buyers, 1 seller)". */
export function formatFunnelLines(counts: FunnelCounts, config: FunnelConfig): string[] {
  const split = (c: Record<string, number>) =>
    config.sides.map((s) => `${c[s.name] ?? 0} ${(c[s.name] ?? 0) === 1 ? s.name.replace(/s$/, "").toLowerCase() : s.name.toLowerCase()}`).join(", ");
  return [
    `New leads: ${counts.leads[TOTAL]} (${split(counts.leads)})`,
    ...counts.steps.map((s) => `${s.label}: ${s.counts[TOTAL]} (${split(s.counts)})`),
  ];
}
