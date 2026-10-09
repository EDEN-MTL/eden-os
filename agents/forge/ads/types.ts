export type RuleScope = "campaign" | "adset" | "ad";
export type RuleOperator = "gt" | "gte" | "lt" | "lte";
export type RuleMetric = "cpl" | "roas" | "ctr" | "cpc" | "spend" | "frequency" | "lead_count";

export const VALID_SCOPES: ReadonlySet<string> = new Set(["campaign", "adset", "ad"]);
export const VALID_OPERATORS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"]);

export interface RuleAction {
  type: string;
  [key: string]: unknown;
}

export interface Rule {
  id: string;
  clientId: string;
  name: string;
  scope: RuleScope;
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  action: RuleAction;
  autoExecute: boolean;
  enabled: boolean;
  minSpend: number;
  lookbackDays: number;
  cooldownHours: number;
  notes: string;
}

export interface EntityMetrics {
  entity_id: string;
  entity_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  /** Best available lead count: the CRM's when it has any, else Meta's own. See lead_source. */
  lead_count: number;
  /** Leads in GHL attributed to this entity. */
  crm_lead_count: number;
  /** Leads Meta itself reports for this entity (the `lead` action). */
  meta_lead_count: number;
  lead_source: "crm" | "meta" | "none";
  won_count: number;
  revenue: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
  roas: number | null;
  /** YYYY-MM-DD of the first/last day it delivered inside the lookback window. */
  first_date: string | null;
  last_date: string | null;
  /** Days it actually delivered inside the window (not calendar days). */
  active_days: number;
  [key: string]: unknown;
}

export interface ProposedAction {
  rule: Rule;
  entityType: RuleScope;
  entityId: string;
  entityName: string | null;
  actionType: string;
  actionPayload: RuleAction;
  reasoning: string;
  metricsSnapshot: EntityMetrics;
  autoExecuteEligible: boolean;
}

export function validateRule(rule: Pick<Rule, "id" | "scope" | "operator" | "action">): void {
  if (!VALID_SCOPES.has(rule.scope)) {
    throw new Error(`Rule ${rule.id}: invalid scope ${JSON.stringify(rule.scope)}, must be one of campaign/adset/ad`);
  }
  if (!VALID_OPERATORS.has(rule.operator)) {
    throw new Error(`Rule ${rule.id}: invalid operator ${JSON.stringify(rule.operator)}, must be one of gt/gte/lt/lte`);
  }
  if (!rule.action || typeof rule.action.type !== "string") {
    throw new Error(`Rule ${rule.id}: action must include a 'type'`);
  }
}
