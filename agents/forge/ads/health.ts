/**
 * Campaign health check: sorts every delivering campaign, ad set and ad into
 * kill / refresh_creative / scale / watch / healthy / too_early, with the
 * reasoning and a concrete next step — what a media buyer does when they open
 * Ads Manager in the morning.
 *
 * Why this exists separately from the rules engine (./engine.ts): a rule is a
 * single metric vs a single threshold over a fixed window. That works on a
 * high-volume account, but a real-estate client on $50/day gets less than one
 * lead per ad set per day, so "CPL > X over 7 days" is mostly noise — one lead
 * landing a day early flips it. The judgement here is spend-relative instead:
 * an ad hasn't failed until it has burned a multiple of the target CPL with
 * nothing to show, and hasn't won until it has several leads under target.
 *
 * Like the engine, this NEVER touches the Meta write API. It only reads and
 * recommends; Forge (or Jacob) acts through the audited executor.
 *
 * All thresholds are per-client (config/clients/<id>.json forge.health) —
 * DEFAULT_PLAYBOOK below is only generic media-buying practice, used where a
 * client hasn't set its own.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { MetaClient } from "../../../shared/meta";
import { computeMetrics } from "./metrics";
import { EntityMetrics, RuleScope } from "./types";

export type HealthVerdict = "kill" | "refresh_creative" | "scale" | "watch" | "healthy" | "too_early";

export interface FunnelTarget {
  /** e.g. "buyer", "seller". */
  name: string;
  /** Case-insensitive substring of the campaign (or entity) name. */
  match: string;
  targetCpl: number;
}

export interface HealthPlaybook {
  /** Target CPL for anything that matches no funnel. */
  targetCpl: number;
  funnels: FunnelTarget[];
  /** Kill once spend reaches this many target CPLs with no leads (or with CPL far over target). */
  killSpendMultiple: number;
  /** With leads, kill once CPL is at least this multiple of target (and the spend floor above is met). */
  killCplMultiple: number;
  scaleMinLeads: number;
  /** Scale only when CPL is at or below this multiple of target. */
  scaleCplMultiple: number;
  /** Per-step budget increase. Meta treats bigger jumps as a significant edit and resets learning. */
  scaleStepPercent: number;
  fatigueFrequency: number;
  /** Delivered days needed before judging anything short of a fast burn. */
  minActiveDays: number;
  lookbackDays: number;
  /** Ceiling for total daily spend across delivering campaigns; scaling past it is flagged, not suggested. */
  dailyBudgetCap: number | null;
}

export const DEFAULT_PLAYBOOK: Omit<HealthPlaybook, "targetCpl" | "funnels" | "dailyBudgetCap"> = {
  killSpendMultiple: 2.5,
  killCplMultiple: 1.75,
  scaleMinLeads: 3,
  scaleCplMultiple: 0.8,
  scaleStepPercent: 20,
  fatigueFrequency: 3.0,
  minActiveDays: 3,
  // 14, not 7: at under one lead/day per ad set, a 7-day window rarely holds
  // enough leads to separate a bad ad from an unlucky week.
  lookbackDays: 14,
};

/** Pure so it's directly unit-testable. Returns null when there's no CPL target to judge against at all. */
export function buildPlaybook(forgeConfig: any): HealthPlaybook | null {
  const health = forgeConfig?.health ?? {};
  const targetCpl = num(health.targetCpl) ?? num(forgeConfig?.cplThreshold);
  if (targetCpl === null) return null;

  const funnels: FunnelTarget[] = Array.isArray(health.funnels)
    ? health.funnels.filter(
        (f: any) => typeof f?.name === "string" && typeof f?.match === "string" && num(f?.targetCpl) !== null
      )
    : [];

  return {
    targetCpl,
    funnels,
    killSpendMultiple: num(health.killSpendMultiple) ?? DEFAULT_PLAYBOOK.killSpendMultiple,
    killCplMultiple: num(health.killCplMultiple) ?? DEFAULT_PLAYBOOK.killCplMultiple,
    scaleMinLeads: num(health.scaleMinLeads) ?? DEFAULT_PLAYBOOK.scaleMinLeads,
    scaleCplMultiple: num(health.scaleCplMultiple) ?? DEFAULT_PLAYBOOK.scaleCplMultiple,
    scaleStepPercent: num(health.scaleStepPercent) ?? DEFAULT_PLAYBOOK.scaleStepPercent,
    fatigueFrequency: num(health.fatigueFrequency) ?? num(forgeConfig?.fatigueThreshold) ?? DEFAULT_PLAYBOOK.fatigueFrequency,
    minActiveDays: num(health.minActiveDays) ?? DEFAULT_PLAYBOOK.minActiveDays,
    lookbackDays: num(health.lookbackDays) ?? DEFAULT_PLAYBOOK.lookbackDays,
    dailyBudgetCap: num(forgeConfig?.dailyBudgetCap),
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function resolveFunnel(playbook: HealthPlaybook, ...names: (string | null | undefined)[]): { funnel: string | null; targetCpl: number } {
  for (const name of names) {
    if (!name) continue;
    const lower = name.toLowerCase();
    const hit = playbook.funnels.find((f) => lower.includes(f.match.toLowerCase()));
    if (hit) return { funnel: hit.name, targetCpl: hit.targetCpl };
  }
  return { funnel: null, targetCpl: playbook.targetCpl };
}

/** Live state from Meta that the snapshot table doesn't carry. */
export interface LiveEntityState {
  effectiveStatus?: string;
  campaignId?: string;
  campaignName?: string;
  /** Daily budget in account currency (Meta returns minor units; already converted). */
  dailyBudget?: number | null;
  /** Ad sets only. */
  learning?: { status: string; conversions: number | null; lastSignificantEditDaysAgo: number | null } | null;
  /** For an ad set: whether its campaign holds the budget (CBO), so scaling happens there instead. */
  campaignHoldsBudget?: boolean;
}

export interface EntityHealth {
  scope: RuleScope;
  id: string;
  name: string | null;
  campaignName: string | null;
  funnel: string | null;
  targetCpl: number;
  verdict: HealthVerdict;
  reasons: string[];
  recommendation: string;
  metrics: Pick<EntityMetrics, "spend" | "lead_count" | "lead_source" | "cpl" | "ctr" | "cpm" | "frequency" | "active_days">;
  learning?: LiveEntityState["learning"];
  dailyBudget?: number | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The verdict for one entity. Pure — all live state is passed in — so the
 * decision table is unit-testable on its own.
 *
 * Order matters: a fast burn is a kill even before minActiveDays (waiting
 * three days to stop an ad that spent 3x target on day one just spends more),
 * and fatigue outranks scale (scaling a fatigued ad buys more of the same
 * people seeing it again).
 */
export function assessEntity(
  scope: RuleScope,
  row: EntityMetrics,
  playbook: HealthPlaybook,
  live: LiveEntityState = {}
): EntityHealth {
  const { funnel, targetCpl } = resolveFunnel(playbook, live.campaignName, row.entity_name);
  const killSpend = targetCpl * playbook.killSpendMultiple;
  const leads = row.lead_count;
  const cpl = row.cpl;
  const reasons: string[] = [];
  let verdict: HealthVerdict;

  if (row.lead_source === "meta") {
    reasons.push("Leads are Meta's own count; none are attributed in GHL yet, so lead quality and won deals are unknown.");
  }

  if (leads === 0 && row.spend >= killSpend) {
    verdict = "kill";
    reasons.push(`Spent ${money(row.spend)} with 0 leads, past the ${money(killSpend)} kill line (${playbook.killSpendMultiple}× the ${money(targetCpl)} target).`);
  } else if (cpl !== null && row.spend >= killSpend && cpl >= targetCpl * playbook.killCplMultiple) {
    verdict = "kill";
    reasons.push(`CPL ${money(cpl)} is ${(cpl / targetCpl).toFixed(1)}× the ${money(targetCpl)} target on ${money(row.spend)} spend, ${leads} lead(s).`);
  } else if (row.active_days < playbook.minActiveDays || row.spend < targetCpl) {
    verdict = "too_early";
    if (row.active_days >= playbook.minActiveDays) {
      // Ran for days but barely spent: Meta's auction is favouring its
      // siblings. Seen live on 3-percent-east-coast (13 days, $19) — calling
      // that "only 13 days" read as nonsense.
      reasons.push(
        `Meta has only spent ${money(row.spend)} on it in ${row.active_days} days; it's losing delivery to sibling ads. Nothing to fix here, judge the siblings.`
      );
    } else {
      reasons.push(
        `Only ${row.active_days} delivered day(s) and ${money(row.spend)} spent. Needs ${playbook.minActiveDays}+ days and at least one target CPL (${money(targetCpl)}) of spend to judge.`
      );
    }
    if (cpl !== null && cpl <= targetCpl) {
      reasons.push(`Early signal is good: ${leads} lead(s) at ${money(cpl)}. Worth watching closely.`);
    }
  } else if (row.frequency !== null && row.frequency >= playbook.fatigueFrequency) {
    verdict = "refresh_creative";
    reasons.push(`Frequency ${row.frequency.toFixed(2)} is at or above ${playbook.fatigueFrequency}; the same people are seeing it repeatedly.`);
  } else if (cpl !== null && leads >= playbook.scaleMinLeads && cpl <= targetCpl * playbook.scaleCplMultiple) {
    verdict = "scale";
    reasons.push(`${leads} leads at ${money(cpl)} CPL, ${Math.round((1 - cpl / targetCpl) * 100)}% under the ${money(targetCpl)} target.`);
  } else if (cpl !== null && cpl <= targetCpl) {
    verdict = "healthy";
    reasons.push(
      `${leads} lead(s) at ${money(cpl)} CPL, under the ${money(targetCpl)} target` +
        (leads < playbook.scaleMinLeads ? ` (needs ${playbook.scaleMinLeads} leads before scaling).` : ".")
    );
  } else {
    verdict = "watch";
    reasons.push(
      leads === 0
        ? `0 leads on ${money(row.spend)}, short of the ${money(killSpend)} kill line. Give it until then.`
        : `CPL ${money(cpl!)} is over the ${money(targetCpl)} target but not yet a kill (${money(row.spend)} spent, ${leads} lead(s)).`
    );
  }

  if (live.learning?.status === "LEARNING") {
    const ago = live.learning.lastSignificantEditDaysAgo;
    reasons.push(
      `Ad set is in Meta's learning phase${ago !== null ? ` (last significant edit ${ago} day(s) ago)` : ""}. Budget, targeting or creative edits restart it.`
    );
  } else if (live.learning?.status === "FAIL") {
    reasons.push(
      "Meta marks this ad set Learning Limited: not enough conversions per week to exit learning. Normal on a small budget; consolidating ad sets helps more than editing this one."
    );
  }

  return {
    scope,
    id: row.entity_id,
    name: row.entity_name,
    campaignName: live.campaignName ?? null,
    funnel,
    targetCpl,
    verdict,
    reasons,
    recommendation: recommend(scope, verdict, playbook, live),
    metrics: {
      spend: row.spend,
      lead_count: row.lead_count,
      lead_source: row.lead_source,
      cpl: row.cpl,
      ctr: row.ctr,
      cpm: row.cpm,
      frequency: row.frequency,
      active_days: row.active_days,
    },
    ...(live.learning !== undefined ? { learning: live.learning } : {}),
    ...(live.dailyBudget !== undefined ? { dailyBudget: live.dailyBudget } : {}),
  };
}

function recommend(scope: RuleScope, verdict: HealthVerdict, playbook: HealthPlaybook, live: LiveEntityState): string {
  const step = playbook.scaleStepPercent;
  switch (verdict) {
    case "kill":
      if (scope === "ad") return "Pause this ad. Its budget shifts to the sibling ads in the same ad set automatically.";
      if (scope === "adset") return "Pause this ad set, or replace its creative if the targeting is one you want to keep.";
      return "Pause the campaign or cut its budget; check which ad sets inside it are dragging it down first.";
    case "refresh_creative":
      return "Launch a new creative (new hook or image) in this ad set rather than pausing; keep the audience.";
    case "scale":
      if (scope === "ad")
        return "Winning ad. Pause the weakest siblings in its ad set so it gets more of the budget, or duplicate it into a new ad set.";
      if (scope === "adset" && live.campaignHoldsBudget)
        return `Budget lives at the campaign (CBO). Raise the campaign budget by ${step}% rather than this ad set's.`;
      return `Raise the daily budget by ${step}%. Wait 3–4 days before the next step; larger jumps restart learning.`;
    case "watch":
      return "No action yet. Re-check in 2–3 days.";
    case "healthy":
      return "Leave it running. No edits; changes would restart learning.";
    case "too_early":
      return "Leave it alone until it has enough spend and days to judge.";
  }
}

const VERDICT_ORDER: HealthVerdict[] = ["kill", "refresh_creative", "scale", "watch", "healthy", "too_early"];

export function sortByUrgency(items: EntityHealth[]): EntityHealth[] {
  return [...items].sort(
    (a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.metrics.spend - a.metrics.spend
  );
}

function loadForgeConfig(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"))?.forge ?? null;
  } catch {
    return null;
  }
}

const centsToUnits = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v) / 100);

/**
 * Pulls the live state the snapshot table lacks: which entities are actually
 * ACTIVE right now, where the budget lives, and learning-phase status.
 *
 * Meta reports a campaign as effective_status ACTIVE long after it stopped
 * delivering — 3-percent-east-coast has a dozen boosted posts from 2024–25
 * still marked ACTIVE with no spend — so the snapshot spend (not this status)
 * decides what gets judged; status only removes what's been paused since.
 */
export async function fetchLiveState(client: MetaClient): Promise<Map<string, LiveEntityState>> {
  const [campaigns, adsets, ads] = await Promise.all([
    client.listCampaigns(["id", "name", "effective_status", "daily_budget", "lifetime_budget"]),
    client.listAdsets(undefined, ["id", "name", "effective_status", "campaign_id", "daily_budget", "learning_stage_info"]),
    client.listAds(undefined, ["id", "effective_status", "campaign_id", "adset_id"]),
  ]);

  const out = new Map<string, LiveEntityState>();
  const campaignById = new Map<string, any>(campaigns.map((c: any) => [c.id, c]));
  const nowSec = Date.now() / 1000;

  for (const c of campaigns) {
    out.set(c.id, { effectiveStatus: c.effective_status, campaignId: c.id, campaignName: c.name, dailyBudget: centsToUnits(c.daily_budget) });
  }
  for (const s of adsets) {
    const parent = campaignById.get(s.campaign_id);
    const info = s.learning_stage_info;
    out.set(s.id, {
      effectiveStatus: s.effective_status,
      campaignId: s.campaign_id,
      campaignName: parent?.name,
      dailyBudget: centsToUnits(s.daily_budget),
      campaignHoldsBudget: Boolean(parent?.daily_budget || parent?.lifetime_budget),
      learning: info?.status
        ? {
            status: info.status,
            conversions: typeof info.conversions === "number" ? info.conversions : null,
            lastSignificantEditDaysAgo: info.last_sig_edit_ts ? Math.floor((nowSec - info.last_sig_edit_ts) / 86400) : null,
          }
        : null,
    });
  }
  for (const a of ads) {
    const parent = campaignById.get(a.campaign_id);
    out.set(a.id, { effectiveStatus: a.effective_status, campaignId: a.campaign_id, campaignName: parent?.name });
  }
  return out;
}

export interface CampaignHealthReport {
  clientId: string;
  lookbackDays: number;
  playbook: HealthPlaybook;
  totals: { spend: number; leads: number; cpl: number | null; leadSource: EntityMetrics["lead_source"] };
  /** Sum of daily budgets on delivering, still-active campaigns/ad sets, vs the config cap. */
  dailyBudget: { current: number | null; cap: number | null };
  counts: Record<HealthVerdict, number>;
  entities: EntityHealth[];
  /** Set when live Meta state couldn't be fetched; verdicts then rest on snapshots alone. */
  liveStateError?: string;
}

/**
 * Builds the report from already-fetched inputs. Pure, so the whole report
 * shape — filtering, totals, budget sum — is testable without Meta or the DB.
 */
export function buildHealthReport(
  clientId: string,
  playbook: HealthPlaybook,
  rowsByScope: Record<RuleScope, EntityMetrics[]>,
  live: Map<string, LiveEntityState> | null,
  lookbackDays: number
): CampaignHealthReport {
  const entities: EntityHealth[] = [];
  let budgetSum = 0;
  let budgetKnown = false;

  for (const scope of ["campaign", "adset", "ad"] as RuleScope[]) {
    for (const row of rowsByScope[scope]) {
      if (row.spend <= 0) continue;
      const state = live?.get(row.entity_id);
      // Paused/archived since: nothing to decide. Unknown to Meta (deleted) also drops out.
      if (live && state?.effectiveStatus !== "ACTIVE") continue;
      entities.push(assessEntity(scope, row, playbook, state ?? {}));

      // Count each budget once, at whichever level holds it.
      if (state?.dailyBudget && (scope === "campaign" || (scope === "adset" && !state.campaignHoldsBudget))) {
        budgetSum += state.dailyBudget;
        budgetKnown = true;
      }
    }
  }

  // Totals come from campaign level so nothing is counted three times.
  const campaignRows = rowsByScope.campaign;
  const spend = campaignRows.reduce((s, r) => s + r.spend, 0);
  const leads = campaignRows.reduce((s, r) => s + r.lead_count, 0);
  const leadSource = campaignRows.some((r) => r.lead_source === "crm")
    ? "crm"
    : campaignRows.some((r) => r.lead_source === "meta")
      ? "meta"
      : "none";

  const counts = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0])) as Record<HealthVerdict, number>;
  for (const e of entities) counts[e.verdict]++;

  return {
    clientId,
    lookbackDays,
    playbook,
    totals: { spend, leads, cpl: leads ? spend / leads : null, leadSource },
    dailyBudget: { current: budgetKnown ? budgetSum : null, cap: playbook.dailyBudgetCap },
    counts,
    entities: sortByUrgency(entities),
  };
}

export async function getCampaignHealth(clientId: string, client: MetaClient | null, lookbackDays?: number): Promise<CampaignHealthReport> {
  const playbook = buildPlaybook(loadForgeConfig(clientId));
  if (!playbook) {
    throw new Error(
      `No CPL target configured for client "${clientId}" (forge.health.targetCpl or forge.cplThreshold in config/clients/${clientId}.json). Can't judge health without one.`
    );
  }
  const days = lookbackDays ?? playbook.lookbackDays;

  const [campaign, adset, ad] = await Promise.all(
    (["campaign", "adset", "ad"] as RuleScope[]).map((scope) => computeMetrics(scope, days, clientId))
  );

  let live: Map<string, LiveEntityState> | null = null;
  let liveStateError: string | undefined;
  if (client) {
    try {
      live = await fetchLiveState(client);
    } catch (e) {
      liveStateError = e instanceof Error ? e.message : String(e);
    }
  } else {
    liveStateError = "No Meta account configured; judged on synced snapshots only (may include paused entities).";
  }

  const report = buildHealthReport(clientId, playbook, { campaign, adset, ad }, live, days);
  return liveStateError ? { ...report, liveStateError } : report;
}
