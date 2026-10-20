/**
 * Pause-from-Slack for Forge's flags, and the nudge when nobody has acted.
 *
 * Mark, 2026-10-21: on Oct 20 Forge flagged an ad set at 11:05 AM and Jacob paused it by hand
 * 12 minutes later. The rule only notifies (auto-execute is off), so a flag nobody sees keeps
 * spending. Now the flag carries a "Pause this ad set" button and a "Keep running" button for the
 * people named in the client's forge.approverUserIds, and if neither is pressed within two hours
 * Forge nudges them once in the thread.
 *
 * A person pressing the button is the approval, so the pause goes through the same executor and
 * audit trail as every other manual action. Nothing here pauses anything by itself.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../../shared/db";
import { getMetaConfig, MetaClient } from "../../../shared/meta";
import { ActionExecutor } from "./executor";
import { MetaActions } from "./actions";
import * as queue from "./queue";
import { PendingAction } from "./queue";

export const PAUSE_ACTION_ID = "forge_pause";
export const KEEP_ACTION_ID = "forge_keep";

/** How long a flag may sit before the one nudge, and how old a flag can be and still be nudged. */
export const NUDGE_AFTER_HOURS = 2;
const NUDGE_GIVE_UP_HOURS = 24;

const PAUSABLE = new Set(["campaign", "adset", "ad"]);
/** Meta effective_status values meaning it is not delivering any more. */
const NOT_RUNNING = new Set(["PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"]);

export function loadApprovers(clientId: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"));
    const ids = raw?.forge?.approverUserIds;
    return Array.isArray(ids) ? ids.filter((i: unknown): i is string => typeof i === "string" && i.length > 0) : [];
  } catch {
    return [];
  }
}

export function entityLabel(entityType: string): string {
  return entityType === "adset" ? "ad set" : entityType;
}

/** Whether a flag for this client and entity gets buttons. */
export function canApproveFromSlack(clientId: string, entityType: string): boolean {
  return PAUSABLE.has(entityType) && loadApprovers(clientId).length > 0;
}

/** The message body plus the two buttons. `pendingId` rides in each button's value. */
export function flagBlocks(text: string, pendingId: number, entityType: string): any[] {
  const label = entityLabel(entityType);
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: `forge_flag_${pendingId}`,
      elements: [
        {
          type: "button",
          action_id: PAUSE_ACTION_ID,
          style: "danger",
          text: { type: "plain_text", text: `Pause this ${label}` },
          value: String(pendingId),
          confirm: {
            title: { type: "plain_text", text: `Pause this ${label}?` },
            text: { type: "mrkdwn", text: "It stops spending right away. You can turn it back on in Ads Manager." },
            confirm: { type: "plain_text", text: "Pause it" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        { type: "button", action_id: KEEP_ACTION_ID, text: { type: "plain_text", text: "Keep running" }, value: String(pendingId) },
      ],
    },
  ];
}

export interface ApprovalDeps {
  executorFor: (clientId: string) => Promise<ActionExecutor>;
  /** Meta's effective_status for one ad entity, or null when it can't be read. */
  liveStatus: (clientId: string, entityId: string) => Promise<string | null>;
  now?: () => Date;
}

async function metaClientFor(clientId: string): Promise<MetaClient> {
  const cfg = await getMetaConfig(clientId);
  if (!cfg) throw new Error(`Meta isn't configured for ${clientId}`);
  return new MetaClient(cfg);
}

export const realDeps: ApprovalDeps = {
  executorFor: async (clientId) => new ActionExecutor(new MetaActions(await metaClientFor(clientId)), clientId),
  liveStatus: async (clientId, entityId) => {
    try {
      const obj = await (await metaClientFor(clientId)).getObject(entityId, ["id", "effective_status"]);
      return typeof obj?.effective_status === "string" ? obj.effective_status : null;
    } catch {
      return null;
    }
  },
};

export interface ClickOutcome {
  /** The new text for the message. */
  text: string;
  /** true: swap the flag message for `text` (buttons disappear). false: only the person who clicked sees it. */
  replace: boolean;
}

function flagSummary(row: PendingAction): string {
  return `*${row.entity_name ?? row.entity_id}* (${entityLabel(row.entity_type)})\n${row.reasoning}`;
}

/** Someone pressed Pause or Keep running. Refuses anyone who isn't an approver, and anything already handled. */
export async function handleApprovalClick(
  actionId: string,
  pendingId: number,
  slackUserId: string,
  deps: ApprovalDeps = realDeps
): Promise<ClickOutcome> {
  const row = await queue.get(pendingId);
  if (!row) return { text: "That flag no longer exists.", replace: false };

  const approvers = loadApprovers(row.client_id);
  if (!approvers.includes(slackUserId)) {
    return { text: `Only ${approvers.map((a) => `<@${a}>`).join(" and ") || "the approvers"} can do that.`, replace: false };
  }

  // Claim it first, so two people pressing at once can't both act.
  const by = `slack:${slackUserId}`;
  const claimed = await query<{ id: number }>(
    `UPDATE ad_pending_actions SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1 AND status = 'pending' RETURNING id`,
    [pendingId, actionId === PAUSE_ACTION_ID ? "approved" : "rejected", by]
  );
  if (claimed.length === 0) {
    const fresh = (await queue.get(pendingId)) ?? row;
    const who = fresh.decided_by?.startsWith("slack:") ? ` by <@${fresh.decided_by.slice(6)}>` : "";
    return { text: `${flagSummary(row)}\n_Already ${fresh.status}${who}._`, replace: true };
  }

  const executor = await deps.executorFor(row.client_id).catch(() => null);

  if (actionId === KEEP_ACTION_ID) {
    // Already claimed above, so reject() only writes the audit row.
    if (executor) await executor.reject(pendingId, by, "Kept running (Slack)").catch((e) => console.error("[FORGE] Could not audit the keep-running choice:", e));
    return { text: `${flagSummary(row)}\n✅ <@${slackUserId}> is keeping it running.`, replace: true };
  }

  // Pause
  const live = await deps.liveStatus(row.client_id, row.entity_id);
  if (live && NOT_RUNNING.has(live)) {
    await queue.markExecuted(pendingId);
    return { text: `${flagSummary(row)}\n⏸️ Already paused, so nothing to do.`, replace: true };
  }
  if (!executor) {
    await queue.markFailed(pendingId);
    return { text: `${flagSummary(row)}\n⚠️ I couldn't reach Meta, so nothing was paused. Pause it in Ads Manager.`, replace: true };
  }
  try {
    await executor.executeManual("pause", row.entity_type, row.entity_id, row.entity_name, {}, by, "Slack");
    await queue.markExecuted(pendingId);
    return { text: `${flagSummary(row)}\n⏸️ Paused by <@${slackUserId}>. It stops spending right away; turn it back on in Ads Manager if needed.`, replace: true };
  } catch (error) {
    await queue.markFailed(pendingId);
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `${flagSummary(row)}\n⚠️ Couldn't pause it: ${reason}. Nothing changed, so please pause it in Ads Manager.`, replace: true };
  }
}

/**
 * One nudge per flag, in its thread, when it is still pending two hours on and still running.
 * A flag whose ad was paused some other way meanwhile (Jacob in Ads Manager) is closed quietly.
 * Returns how many nudges went out.
 */
export async function runApprovalNudges(
  deps: ApprovalDeps = realDeps,
  post: (channel: string, text: string, blocks: any[], threadTs: string) => Promise<void> = defaultPost
): Promise<number> {
  const due = await query<PendingAction & { nudged_at: string | null }>(
    `SELECT * FROM ad_pending_actions
     WHERE status = 'pending' AND slack_message_ts IS NOT NULL AND slack_channel IS NOT NULL AND nudged_at IS NULL
       AND created_at < now() - ($1 || ' hours')::interval AND created_at > now() - ($2 || ' hours')::interval`,
    [String(NUDGE_AFTER_HOURS), String(NUDGE_GIVE_UP_HOURS)]
  );

  let sent = 0;
  for (const row of due) {
    try {
      const approvers = loadApprovers(row.client_id);
      if (approvers.length === 0 || !PAUSABLE.has(row.entity_type)) continue;

      const live = await deps.liveStatus(row.client_id, row.entity_id);
      if (live === null) continue; // can't tell: try again next run rather than nag about something already off
      if (NOT_RUNNING.has(live)) {
        await query(`UPDATE ad_pending_actions SET status = 'expired', decided_at = now(), decided_by = 'auto: already paused' WHERE id = $1 AND status = 'pending'`, [row.id]);
        continue;
      }

      const claim = await query<{ id: number }>(`UPDATE ad_pending_actions SET nudged_at = now() WHERE id = $1 AND nudged_at IS NULL RETURNING id`, [row.id]);
      if (claim.length === 0) continue;

      const text =
        `⏰ ${approvers.map((a) => `<@${a}>`).join(" ")} this is still running ${NUDGE_AFTER_HOURS} hours after Forge flagged it:\n` +
        `${flagSummary(row)}\nPause it, or keep it running?`;
      await post(row.slack_channel!, text, flagBlocks(text, row.id, row.entity_type), row.slack_message_ts!);
      sent++;
    } catch (error) {
      console.error(`[FORGE] Nudge for pending action ${row.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

async function defaultPost(channel: string, text: string, blocks: any[], threadTs: string): Promise<void> {
  const { getClient } = await import("../../../shared/slack");
  await getClient("forge").chat.postMessage({ channel, text, blocks, thread_ts: threadTs, unfurl_links: false });
}

