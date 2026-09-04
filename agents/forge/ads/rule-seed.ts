/**
 * Turns each client's `forge.{cplThreshold,fatigueThreshold,roasTarget}`
 * config into real, enforced `ad_rules` rows.
 *
 * Before this, those numbers were display-only — clients-api.ts surfaced
 * them to the dashboard as "forgeRules" but nothing ever read them back to
 * decide anything, and `ad_rules` (what the rules engine actually
 * evaluates) had no seed data anywhere. A client could set a tight CPL cap
 * in their config and nothing would happen.
 *
 * Every rule here starts as a `notify_only` action — this only ever flags
 * a finding for a human to look at (via Slack + the pending-actions queue),
 * it never proposes a specific pause/budget change. That's deliberate: the
 * right remedy (pause vs. cut budget vs. leave it) depends on account
 * structure (CBO vs. ABO budgets live at different levels) and on how much
 * to trust an unvalidated threshold, both of which vary per client and
 * aren't safe to guess at from a config number alone.
 *
 * Idempotent and safe to run on every boot: re-running only refreshes the
 * config-derived fields (threshold, scope, metric, notes) on conflict —
 * `enabled`/`auto_execute` are only set on first insert, so a human's own
 * override (e.g. flipping a rule on/off from the dashboard) survives a
 * redeploy instead of being silently reset back to config defaults.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../../shared/db";
import { RuleMetric, RuleOperator, RuleScope } from "./types";

interface DefaultRuleSpec {
  id: string;
  name: string;
  scope: RuleScope;
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  minSpend: number;
  lookbackDays: number;
  cooldownHours: number;
  notes: string;
}

async function listMetaClientIds(): Promise<string[]> {
  const rows = await query<{ client_id: string }>(`SELECT DISTINCT client_id FROM meta_credentials`);
  return rows.map((r) => r.client_id);
}

function loadClientJson(clientId: string): any | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

/** Pure so it's directly unit-testable without touching the DB or filesystem. */
export function buildDefaultRuleSpecs(forgeConfig: any): DefaultRuleSpec[] {
  const specs: DefaultRuleSpec[] = [];
  if (typeof forgeConfig?.cplThreshold === "number") {
    specs.push({
      id: "auto-cpl-high",
      name: "CPL above config threshold",
      scope: "adset",
      metric: "cpl",
      operator: "gt",
      threshold: forgeConfig.cplThreshold,
      minSpend: 30,
      lookbackDays: 7,
      cooldownHours: 24,
      notes: "Auto-seeded from config/clients/<id>.json forge.cplThreshold.",
    });
  }
  if (typeof forgeConfig?.fatigueThreshold === "number") {
    specs.push({
      id: "auto-fatigue-high",
      name: "Ad frequency above config fatigue threshold",
      scope: "ad",
      metric: "frequency",
      operator: "gt",
      threshold: forgeConfig.fatigueThreshold,
      minSpend: 20,
      lookbackDays: 7,
      cooldownHours: 48,
      notes: "Auto-seeded from config/clients/<id>.json forge.fatigueThreshold.",
    });
  }
  if (forgeConfig?.roasEnabled === true && typeof forgeConfig?.roasTarget === "number") {
    specs.push({
      id: "auto-roas-low",
      name: "ROAS below config target",
      scope: "adset",
      metric: "roas",
      operator: "lt",
      threshold: forgeConfig.roasTarget,
      minSpend: 50,
      lookbackDays: 14,
      cooldownHours: 48,
      notes: "Auto-seeded from config/clients/<id>.json forge.roasTarget (only while forge.roasEnabled is true).",
    });
  }
  return specs;
}

async function upsertRule(clientId: string, spec: DefaultRuleSpec): Promise<void> {
  await query(
    `INSERT INTO ad_rules (
       id, client_id, name, scope, metric, operator, threshold, action,
       auto_execute, enabled, min_spend, lookback_days, cooldown_hours, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, TRUE, $9, $10, $11, $12)
     ON CONFLICT (client_id, id) DO UPDATE SET
       name = excluded.name,
       scope = excluded.scope,
       metric = excluded.metric,
       operator = excluded.operator,
       threshold = excluded.threshold,
       min_spend = excluded.min_spend,
       lookback_days = excluded.lookback_days,
       cooldown_hours = excluded.cooldown_hours,
       notes = excluded.notes,
       updated_at = now()`,
    [
      spec.id,
      clientId,
      spec.name,
      spec.scope,
      spec.metric,
      spec.operator,
      spec.threshold,
      JSON.stringify({ type: "notify_only" }),
      spec.minSpend,
      spec.lookbackDays,
      spec.cooldownHours,
      spec.notes,
    ]
  );
}

/** Call once at server startup, after initDb(). */
export async function ensureDefaultAdRules(): Promise<void> {
  const clientIds = await listMetaClientIds();
  for (const clientId of clientIds) {
    const cfg = loadClientJson(clientId);
    const specs = buildDefaultRuleSpecs(cfg?.forge);
    if (specs.length === 0) continue;
    for (const spec of specs) {
      try {
        await upsertRule(clientId, spec);
      } catch (e) {
        console.error(`[FORGE] Failed to seed rule ${spec.id} for ${clientId}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`[FORGE] Ensured ${specs.length} default ad rule(s) for ${clientId}`);
  }
}
