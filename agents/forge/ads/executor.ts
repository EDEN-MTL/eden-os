/**
 * Turns a queued action (pending or auto-eligible) into an actual Meta API
 * call, and unconditionally writes the audit trail — success or failure,
 * auto-executed or human-approved.
 *
 * This is the ONLY place in the system that both (a) calls actions.ts and
 * (b) writes to the audit log, by design: one choke point means "every
 * action gets audited" is structurally true, not just a convention every
 * caller has to remember.
 */
import { ComplianceError } from "../../../shared/meta/compliance";
import { MetaAPIError } from "../../../shared/meta";
import * as audit from "./audit";
import * as queue from "./queue";
import { ActionResult, MetaActions } from "./actions";

const CREATIVE_TEST_ACTION_TYPES = new Set(["creative_test_lock_winner", "creative_test_scale", "creative_test_refresh"]);

export class ExecutionError extends Error {}

function isExpectedError(error: unknown): error is Error {
  return error instanceof ComplianceError || error instanceof MetaAPIError || error instanceof ExecutionError || error instanceof Error;
}

export class ActionExecutor {
  constructor(private actions: MetaActions, private clientId = "eden") {}

  private async dispatch(actionType: string, entityType: string, entityId: string, payload: Record<string, any>): Promise<ActionResult> {
    switch (actionType) {
      case "pause":
        return this.actions.pause(entityId, entityType);
      case "resume":
        return this.actions.resume(entityId, entityType);
      case "set_budget":
        return this.actions.setDailyBudget(entityId, entityType, Number(payload.daily_budget_cents));
      case "increase_budget":
        return this.actions.adjustBudgetByPercent(entityId, entityType, Math.abs(Number(payload.percent)), payload.max_daily_budget_cents);
      case "decrease_budget":
        return this.actions.adjustBudgetByPercent(
          entityId, entityType, -Math.abs(Number(payload.percent)), undefined, Number(payload.min_daily_budget_cents ?? 100)
        );
      case "create_campaign":
        return this.actions.createCampaign(payload as any);
      case "create_adset":
        return this.actions.createAdset(payload as any);
      case "create_ad":
        return this.actions.createAd(payload.adset_id, payload.name, payload.creative_id);
      case "upload_image":
        return this.actions.uploadImage(payload.filename, payload.file_bytes);
      case "create_ad_creative":
        return this.actions.createAdCreative(payload as any);
      case "update_ad_creative":
        return this.actions.updateAdCreative(entityId, payload.creative_id);
      case "duplicate_adset":
        return this.actions.duplicateAdset(entityId, payload.rename_suffix, payload.status);
      case "set_adset_spend_targets":
        return this.actions.setAdsetSpendTargets(entityId, payload.daily_min_spend_target_cents, payload.daily_spend_cap_cents);
      default:
        throw new ExecutionError(`Unknown action_type ${JSON.stringify(actionType)}`);
    }
  }

  /** Executes a pending_actions row that is either freshly approved or auto-execute-eligible. Always writes exactly one audit log row. */
  async executePending(pendingActionId: number, decidedBy: string, auto = false): Promise<Record<string, unknown>> {
    const row = await queue.get(pendingActionId);
    if (!row) throw new ExecutionError(`No pending action with id ${pendingActionId}`);

    const actor = auto ? `rule:${row.rule_id}` : `human:${decidedBy}`;

    if (CREATIVE_TEST_ACTION_TYPES.has(row.action_type)) {
      throw new ExecutionError(
        `Creative-test action type ${JSON.stringify(row.action_type)} isn't ported yet — ` +
          "the creative-testing/scaling engine (agents/forge/ads/creative-testing.ts) is a later piece."
      );
    }

    if (row.action_type === "notify_only") {
      await audit.record({
        clientId: this.clientId, actor, actionType: "notify_only",
        entityType: row.entity_type, entityId: row.entity_id, entityName: row.entity_name,
        ruleId: row.rule_id, autoExecuted: true, pendingActionId,
        result: "success", detail: "Notification only — no write against the Meta account.",
      });
      await queue.markExecuted(pendingActionId);
      return { status: "executed", actionType: "notify_only" };
    }

    let result: ActionResult;
    try {
      result = await this.dispatch(row.action_type, row.entity_type, row.entity_id, row.action_payload);
    } catch (error) {
      if (!isExpectedError(error)) throw error;
      console.error(`[FORGE] Execution failed for pending_action ${pendingActionId}:`, error);
      await audit.record({
        clientId: this.clientId, actor, actionType: row.action_type,
        entityType: row.entity_type, entityId: row.entity_id, entityName: row.entity_name,
        ruleId: row.rule_id, autoExecuted: auto, pendingActionId,
        result: "failure", detail: error.message,
      });
      await queue.markFailed(pendingActionId);
      throw error;
    }

    await audit.record({
      clientId: this.clientId, actor, actionType: row.action_type,
      entityType: result.entityType, entityId: result.entityId || row.entity_id, entityName: row.entity_name,
      ruleId: row.rule_id, autoExecuted: auto, pendingActionId,
      beforeState: result.before, afterState: result.after, result: "success",
      detail: `request=${JSON.stringify(result.requestPayload)}`,
    });
    await queue.markExecuted(pendingActionId);
    return { status: "executed", actionType: row.action_type, result };
  }

  /**
   * For actions a human directly initiates in the Campaigns browser (not
   * something a rule proposed) — there's nothing to "hold for approval"
   * against since the human clicking the button IS the approval, same as
   * clicking pause directly in Meta Ads Manager. Still goes through the
   * same compliance gate and audit trail as everything else; just skips
   * the pending_actions queue entirely (no ruleId, no pendingActionId).
   */
  async executeManual(
    actionType: string,
    entityType: string,
    entityId: string,
    entityName: string | null,
    payload: Record<string, any>,
    decidedBy: string
  ): Promise<Record<string, unknown>> {
    const actor = `human:${decidedBy}`;
    let result: ActionResult;
    try {
      result = await this.dispatch(actionType, entityType, entityId, payload);
    } catch (error) {
      if (!isExpectedError(error)) throw error;
      console.error(`[FORGE] Manual execution failed (${actionType} on ${entityType} ${entityId}):`, error);
      await audit.record({
        clientId: this.clientId, actor, actionType, entityType, entityId, entityName,
        autoExecuted: false, result: "failure", detail: error.message,
      });
      throw error;
    }

    await audit.record({
      clientId: this.clientId, actor, actionType,
      entityType: result.entityType, entityId: result.entityId || entityId, entityName,
      autoExecuted: false, beforeState: result.before, afterState: result.after, result: "success",
      detail: `Manual action via dashboard. request=${JSON.stringify(result.requestPayload)}`,
    });
    return { status: "executed", actionType, result };
  }

  async reject(pendingActionId: number, decidedBy: string, reason = ""): Promise<void> {
    const row = await queue.get(pendingActionId);
    if (!row) throw new ExecutionError(`No pending action with id ${pendingActionId}`);
    await queue.decide(pendingActionId, "rejected", decidedBy);
    await audit.record({
      clientId: this.clientId, actor: `human:${decidedBy}`, actionType: row.action_type,
      entityType: row.entity_type, entityId: row.entity_id, entityName: row.entity_name,
      ruleId: row.rule_id, autoExecuted: false, pendingActionId,
      result: "rejected", detail: reason,
    });
  }
}
