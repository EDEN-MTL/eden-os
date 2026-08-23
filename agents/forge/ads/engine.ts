/**
 * The rules engine: evaluates every configured rule against current
 * performance/attribution metrics and produces ProposedAction objects.
 *
 * Crucially, this module NEVER touches the Meta API. It only decides what
 * *would* happen. Whether a ProposedAction executes immediately or waits
 * for a human is entirely the approval queue's job (./queue.ts) — this
 * keeps "decide" and "act" separable, which is what makes the approval
 * gate meaningful rather than cosmetic.
 */
import { query } from "../../../shared/db";
import { computeMetrics } from "./metrics";
import { readEmergencyHoldAll } from "./settings";
import { EntityMetrics, ProposedAction, Rule, RuleOperator, validateRule } from "./types";

export function applyOperator(operator: RuleOperator, value: number, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

function formatReasoning(rule: Rule, value: number, row: EntityMetrics): string {
  let reasoning =
    `[${rule.name}] ${rule.metric}=${value.toPrecision(4)} ${rule.operator} ${rule.threshold.toPrecision(4)} ` +
    `over last ${rule.lookbackDays}d (spend=$${row.spend.toFixed(2)}, leads=${row.lead_count ?? 0}).`;
  if (rule.notes) reasoning += ` Note: ${rule.notes}`;
  return reasoning;
}

/**
 * Pure decision logic — no DB access — so it's directly unit-testable.
 * `isInCooldown` is injected rather than queried here to keep this function
 * synchronous and side-effect-free.
 */
export function buildProposedActions(
  rule: Rule,
  rows: EntityMetrics[],
  emergencyHoldAll: boolean,
  isInCooldown: (entityId: string) => boolean
): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const row of rows) {
    if (row.spend < rule.minSpend) continue;
    const value = row[rule.metric] as number | null | undefined;
    if (value === null || value === undefined) continue;
    if (!applyOperator(rule.operator, value, rule.threshold)) continue;
    if (isInCooldown(row.entity_id)) continue;

    out.push({
      rule,
      entityType: rule.scope,
      entityId: row.entity_id,
      entityName: row.entity_name,
      actionType: rule.action.type,
      actionPayload: rule.action,
      reasoning: formatReasoning(rule, value, row),
      metricsSnapshot: row,
      autoExecuteEligible: rule.autoExecute && !emergencyHoldAll,
    });
  }
  return out;
}

interface RuleRow {
  id: string;
  client_id: string;
  name: string;
  scope: string;
  metric: string;
  operator: string;
  threshold: string;
  action: Rule["action"];
  auto_execute: boolean;
  enabled: boolean;
  min_spend: string;
  lookback_days: number;
  cooldown_hours: number;
  notes: string;
}

function rowToRule(row: RuleRow): Rule {
  const rule: Rule = {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    scope: row.scope as Rule["scope"],
    metric: row.metric as Rule["metric"],
    operator: row.operator as Rule["operator"],
    threshold: Number(row.threshold),
    action: row.action,
    autoExecute: row.auto_execute,
    enabled: row.enabled,
    minSpend: Number(row.min_spend),
    lookbackDays: row.lookback_days,
    cooldownHours: row.cooldown_hours,
    notes: row.notes,
  };
  validateRule(rule);
  return rule;
}

export async function loadRules(clientId = "eden"): Promise<Rule[]> {
  const rows = await query<RuleRow>("SELECT * FROM ad_rules WHERE client_id = $1 ORDER BY id", [clientId]);
  return rows.map(rowToRule);
}

async function isInCooldownDb(rule: Rule, entityId: string): Promise<boolean> {
  const rows = await query<{ last_triggered_at: string }>(
    "SELECT last_triggered_at FROM ad_rule_cooldowns WHERE client_id = $1 AND rule_id = $2 AND entity_id = $3",
    [rule.clientId, rule.id, entityId]
  );
  if (rows.length === 0) return false;
  const last = new Date(rows[0].last_triggered_at).getTime();
  const cooldownMs = rule.cooldownHours * 60 * 60 * 1000;
  return Date.now() - last < cooldownMs;
}

export async function markTriggered(rule: Rule, entityId: string): Promise<void> {
  await query(
    `INSERT INTO ad_rule_cooldowns (client_id, rule_id, entity_id, last_triggered_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client_id, rule_id, entity_id) DO UPDATE SET last_triggered_at = excluded.last_triggered_at`,
    [rule.clientId, rule.id, entityId]
  );
}

/**
 * Evaluates every enabled rule for a client against live metrics. A rule
 * that throws while evaluating is logged and skipped — one bad rule
 * shouldn't take down the whole evaluation run.
 */
export async function evaluate(clientId = "eden"): Promise<ProposedAction[]> {
  const emergencyHoldAll = await readEmergencyHoldAll(clientId);
  const rules = await loadRules(clientId);
  const proposed: ProposedAction[] = [];

  for (const rule of rules.filter((r) => r.enabled)) {
    try {
      const rows = await computeMetrics(rule.scope, rule.lookbackDays, clientId);
      const cooldownFlags = new Map<string, boolean>();
      for (const row of rows) {
        cooldownFlags.set(row.entity_id, await isInCooldownDb(rule, row.entity_id));
      }
      proposed.push(...buildProposedActions(rule, rows, emergencyHoldAll, (id) => cooldownFlags.get(id) ?? false));
    } catch (error) {
      console.error(`[FORGE] Rule ${rule.id} failed to evaluate — skipping it this run.`, error);
    }
  }
  return proposed;
}
