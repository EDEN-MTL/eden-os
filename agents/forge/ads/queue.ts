/**
 * The pending-approval queue. Every ProposedAction the rules engine
 * produces becomes one row here — including auto-execute-eligible ones,
 * so there's always a durable record of "the engine decided this, here's
 * why" even when nothing waits for a human.
 *
 * Status lifecycle: pending -> (approved | rejected | expired) -> executed | failed
 */
import { query } from "../../../shared/db";
import { ProposedAction } from "./types";

export type PendingStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface PendingAction {
  id: number;
  client_id: string;
  rule_id: string;
  rule_name: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  action_type: string;
  action_payload: Record<string, unknown>;
  reasoning: string;
  metrics_snapshot: Record<string, unknown>;
  auto_execute_eligible: boolean;
  status: PendingStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
}

export async function enqueue(proposed: ProposedAction, clientId = "eden"): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO ad_pending_actions (
       client_id, rule_id, rule_name, entity_type, entity_id, entity_name,
       action_type, action_payload, reasoning, metrics_snapshot,
       auto_execute_eligible, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     RETURNING id`,
    [
      clientId,
      proposed.rule.id,
      proposed.rule.name,
      proposed.entityType,
      proposed.entityId,
      proposed.entityName,
      proposed.actionType,
      JSON.stringify(proposed.actionPayload),
      proposed.reasoning,
      JSON.stringify(proposed.metricsSnapshot),
      proposed.autoExecuteEligible,
    ]
  );
  return rows[0].id;
}

export async function listPending(clientId = "eden"): Promise<PendingAction[]> {
  return query<PendingAction>(
    "SELECT * FROM ad_pending_actions WHERE client_id = $1 AND status = 'pending' ORDER BY created_at ASC",
    [clientId]
  );
}

export async function listAll(clientId = "eden", limit = 200): Promise<PendingAction[]> {
  return query<PendingAction>(
    "SELECT * FROM ad_pending_actions WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2",
    [clientId, limit]
  );
}

export async function get(pendingActionId: number): Promise<PendingAction | null> {
  const rows = await query<PendingAction>("SELECT * FROM ad_pending_actions WHERE id = $1", [pendingActionId]);
  return rows[0] ?? null;
}

export async function recordSlackMessage(pendingActionId: number, channel: string, messageTs: string): Promise<void> {
  await query("UPDATE ad_pending_actions SET slack_channel = $1, slack_message_ts = $2 WHERE id = $3", [
    channel,
    messageTs,
    pendingActionId,
  ]);
}

export async function decide(
  pendingActionId: number,
  decision: "approved" | "rejected",
  decidedBy: string
): Promise<void> {
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`decision must be 'approved' or 'rejected', got ${JSON.stringify(decision)}`);
  }
  await query(
    "UPDATE ad_pending_actions SET status = $1, decided_at = now(), decided_by = $2 WHERE id = $3 AND status = 'pending'",
    [decision, decidedBy, pendingActionId]
  );
}

export async function markExecuted(pendingActionId: number): Promise<void> {
  await query("UPDATE ad_pending_actions SET status = 'executed', executed_at = now() WHERE id = $1", [
    pendingActionId,
  ]);
}

export async function markFailed(pendingActionId: number): Promise<void> {
  await query("UPDATE ad_pending_actions SET status = 'failed' WHERE id = $1", [pendingActionId]);
}
