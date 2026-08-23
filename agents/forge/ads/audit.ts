/**
 * The audit trail. Every action taken or recommended — auto-executed,
 * manually approved, or rejected — gets exactly one row here: what
 * changed, which rule triggered it (if any), and the before/after state.
 * This is the system's memory; nothing bypasses it.
 */
import { query } from "../../../shared/db";

export type AuditResult = "success" | "failure" | "rejected" | "held";

export interface AuditEntry {
  id: number;
  client_id: string;
  timestamp: string;
  actor: string; // 'rule:<rule_id>' | 'human:<slack_user_or_cli_user>' | 'system'
  rule_id: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  auto_executed: boolean;
  pending_action_id: number | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  result: AuditResult;
  detail: string | null;
}

export async function record(params: {
  clientId?: string;
  actor: string;
  actionType: string;
  entityType: string;
  entityId: string;
  entityName?: string | null;
  ruleId?: string | null;
  autoExecuted?: boolean;
  pendingActionId?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  result?: AuditResult;
  detail?: string;
}): Promise<number> {
  const {
    clientId = "eden", actor, actionType, entityType, entityId,
    entityName = null, ruleId = null, autoExecuted = false, pendingActionId = null,
    beforeState = null, afterState = null, result = "success", detail = "",
  } = params;

  const rows = await query<{ id: number }>(
    `INSERT INTO ad_audit_log (
       client_id, actor, rule_id, action_type, entity_type, entity_id, entity_name,
       auto_executed, pending_action_id, before_state, after_state, result, detail
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      clientId, actor, ruleId, actionType, entityType, entityId, entityName,
      autoExecuted, pendingActionId,
      beforeState !== null ? JSON.stringify(beforeState) : null,
      afterState !== null ? JSON.stringify(afterState) : null,
      result, detail,
    ]
  );
  return rows[0].id;
}

export async function listRecent(clientId = "eden", limit = 200): Promise<AuditEntry[]> {
  return query<AuditEntry>(
    "SELECT * FROM ad_audit_log WHERE client_id = $1 ORDER BY timestamp DESC LIMIT $2",
    [clientId, limit]
  );
}

export async function forEntity(entityId: string, limit = 100): Promise<AuditEntry[]> {
  return query<AuditEntry>(
    "SELECT * FROM ad_audit_log WHERE entity_id = $1 ORDER BY timestamp DESC LIMIT $2",
    [entityId, limit]
  );
}
