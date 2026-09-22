import crypto from "crypto";
import { Request, Response, Router } from "express";
import { query } from "../shared/db";
import { getGhlConfig, getContact, addContactTags, findOpenOpportunitiesForContact, updateOpportunityStage } from "../shared/ghl";
import { sendMessage } from "../shared/slack";
import { appendHistory } from "../shared/conversation-memory";
import { loadIrisConfig } from "../agents/iris";
import { reopenForNextAttempt } from "../agents/iris/dial-pending";

/**
 * Every Iris call — real or test — gets posted here so the team can watch
 * without checking our own DB. Mark, 2026-09-20: created #iris-call-logs and
 * added the Iris Slack app to it. A literal default (not an env var like
 * LENS_OPS_CHANNEL) because setting a new env var on Render isn't something
 * this session can do remotely — still overridable via IRIS_CALL_LOG_CHANNEL
 * if that ever needs to change without a code deploy.
 */
const CALL_LOG_CHANNEL = process.env.IRIS_CALL_LOG_CHANNEL || "iris-call-logs";

/**
 * Vapi's endedReason for a warm transfer that actually connected — the
 * destination answered and the call was hand off, as opposed to any of the
 * various call.in-progress.error-warm-transfer-* / customer-ended-call-*
 * reasons for a failed or abandoned one. Confirmed against Vapi's own
 * call-ended-reason docs (docs.vapi.ai/calls/call-ended-reason) rather than
 * assumed — there is no separate "reason" that means "transfer succeeded"
 * other than this one.
 */
const TRANSFER_SUCCEEDED_REASON = "assistant-forwarded-call";

/**
 * The ONLY endedReason values (or prefixes) that mean a real person was
 * genuinely on the line at some point — confirmed against every
 * endedReason actually seen on a real call in iris_call_log, plus Vapi's
 * documented transfer/duration outcomes.
 *
 * Design flipped, 2026-09-08 (was a NOT_ANSWERED blocklist, defaulting to
 * "answered" — no retry — for anything unrecognized): a real test call hit
 * `call.start.error-get-transport` (cost $0 — the call never actually
 * connected), which fell through that blocklist as "answered" and
 * permanently starved the lead of a retry — exactly the "called twice"
 * bug this classifier exists to prevent, just inverted. Checked Vapi's own
 * OpenAPI schema: the real endedReason enum has 629 possible values —
 * dozens of call.start.error-* variants alone, plus a pipeline-error-*
 * entry per voice provider (elevenlabs, playht, deepgram, azure, ...) —
 * and grows every time Vapi adds a provider or failure mode. No blocklist
 * can keep up with that. A small ANSWERED allowlist, defaulting everything
 * else to "not answered," is the only classification that stays correct
 * as Vapi adds new codes rather than silently regressing each time.
 */
const ANSWERED_REASON_PREFIXES = ["customer-ended-call", "assistant-ended-call"];
const ANSWERED_REASONS = new Set(["assistant-forwarded-call", "exceeded-max-duration"]);

/**
 * Fails toward RETRYING on anything ambiguous now (an unrecognized or
 * missing endedReason) — inverted from the old direction along with the
 * allowlist above. The cost of wrongly retrying a lead who was actually
 * reached (one extra call) is far smaller than a lead silently never
 * getting called again because of an infrastructure failure that wasn't
 * on an explicit list.
 */
export function wasAnswered(endedReason: string | null): boolean {
  if (!endedReason) return false;
  if (ANSWERED_REASONS.has(endedReason)) return true;
  if (ANSWERED_REASON_PREFIXES.some((prefix) => endedReason.startsWith(prefix))) return true;
  return false;
}

/**
 * True if the customer actually said real words at some point in the
 * call. Added 2026-09-22 alongside calling.ts's new idle-timeout endCall
 * hook (gives up on a lead who never responds even after the "are you
 * still there?" nudge) — Vapi reports that exactly the same way as any
 * other assistant-initiated wrap-up, endedReason "assistant-ended-call",
 * which wasAnswered's own allowlist already (correctly, for the normal
 * case) treats as a real conversation. Without this check, a lead who
 * NEVER said a word would get silently starved of a retry, the exact
 * "called twice" bug wasAnswered's own design already guards against,
 * just via a new path. Only ever consulted for that one ambiguous reason
 * (see genuinelyAnswered below) — every other reason's classification is
 * untouched by this.
 */
export function customerSpokeAtAll(message: Record<string, any>): boolean {
  const msgs: any[] = message?.messages ?? [];
  return msgs.some((m) => m?.role === "user" && typeof m?.message === "string" && m.message.trim() !== "");
}

/**
 * The real "should this lead be retried" question — wasAnswered alone
 * isn't enough once "assistant-ended-call" can mean either a genuine
 * conversation OR the new idle-timeout giveup with zero lead speech. Every
 * other endedReason keeps wasAnswered's existing, already-correct verdict.
 */
export function genuinelyAnswered(endedReason: string | null, message: Record<string, any>): boolean {
  if (!wasAnswered(endedReason)) return false;
  if (endedReason === "assistant-ended-call") return customerSpokeAtAll(message);
  return true;
}

/**
 * Verifies the X-Vapi-Secret header against VAPI_WEBHOOK_SECRET, same
 * timing-safe-compare discipline as verifySlackSignature in
 * webhooks/slack-events.ts. Vapi also supports HMAC-signature and
 * bearer-token auth modes (configured via a Custom Credential in their
 * dashboard); this handler only implements the legacy shared-secret header,
 * which is what server.secret on a transient assistant sends. If the
 * assistant config is ever switched to one of the other auth modes, this
 * needs to change to match.
 */
function verifyVapiSecret(expectedSecret: string, req: Request): boolean {
  const provided = req.headers["x-vapi-secret"] as string | undefined;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Human-readable one-liner for a call's real outcome, for the Slack post below. */
export function describeOutcome(endedReason: string | null, message: Record<string, any>): string {
  if (endedReason === TRANSFER_SUCCEEDED_REASON) return "✅ Live transfer completed";
  if (endedReason === "voicemail") return "📵 Left voicemail";
  if (endedReason === "assistant-ended-call" && !customerSpokeAtAll(message)) return "🔇 No response (gave up after the idle nudge)";
  if (wasAnswered(endedReason)) return "💬 Answered (no transfer)";
  return `❌ No answer (\`${endedReason ?? "unknown"}\`)`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "unknown";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Posts every finished Iris call to #iris-call-logs — real or test, any
 * outcome — so the team has an ongoing eye on Iris's calls without
 * checking our own DB. Best-effort: a Slack failure here should never
 * affect the rest of end-of-call handling (cadence, tags, stage moves).
 * Looks the contact's current name up live via GHL rather than trusting
 * anything stale — falls back to the raw phone number when there's no
 * contactId at all (a manual test call) or the lookup fails.
 */
export async function postCallLogToSlack(clientId: string, contactId: string | null, message: Record<string, any>, endedReason: string | null): Promise<void> {
  try {
    const phone = message?.call?.customer?.number ?? "unknown number";
    let who = phone;
    if (contactId) {
      try {
        const ghlConfig = await getGhlConfig(clientId);
        if (ghlConfig) {
          const contactResp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
          const contact = contactResp?.contact ?? contactResp;
          const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim();
          if (name) who = `${name} (${phone})`;
        }
      } catch {
        // Name lookup is a nicety — fall back to the bare phone number.
      }
    }

    const text =
      `📞 *${who}* — ${clientId}\n` +
      `${describeOutcome(endedReason, message)}\n` +
      `Duration: ${formatDuration(message?.durationSeconds)}`;

    // Seeds this post into Iris's own conversation history, keyed by
    // Slack's real resolved channel id + this message's own ts — the
    // exact key a future THREAD REPLY under this post will look up (see
    // BaseAgent.post()'s doc comment for the full story; this call site
    // can't use that helper directly since it's a standalone webhook
    // function, not a method on an agent instance). Without this, Mark
    // asking a follow-up in the thread ("what time was that call?") finds
    // no history at all and Iris has zero idea which lead he means —
    // confirmed live 2026-09-23.
    const result = await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text });
    if (result?.channel && result?.ts) {
      await appendHistory("iris", `channel:${result.channel}:${result.ts}`, "assistant", text).catch((error) => {
        console.error("[VAPI] Failed to seed call-log thread history:", error instanceof Error ? error.message : error);
      });
    }
  } catch (error) {
    console.error("[VAPI] Failed to post call log to Slack:", error instanceof Error ? error.message : error);
  }
}

/**
 * Handles Vapi's end-of-call-report event: fills in the iris_call_log row
 * that placeCall() created with 'initiated' status. Does NOT parse the
 * transcript into GHL qualification fields yet — that needs a transcript ->
 * QualificationAnswers mapping (see agents/iris/qualification.ts's
 * fieldWritesFor, which currently expects already-structured answers, not
 * raw text) that hasn't been built. The full transcript is kept in the DB
 * so nothing is lost while that's pending.
 */
async function handleEndOfCallReport(message: Record<string, any>): Promise<void> {
  const callId = message?.call?.id;
  if (!callId) {
    console.warn("[VAPI] end-of-call-report with no call.id, dropping");
    return;
  }

  const transcript = message?.artifact?.transcript ?? null;
  const endedReason = message?.endedReason ?? null;

  const rows = await query<{ client_id: string; contact_id: string | null; triggered_by: string }>(
    `UPDATE iris_call_log
     SET status = 'ended', ended_reason = $2, transcript = $3, ended_at = now(), raw = $4
     WHERE vapi_call_id = $1
     RETURNING client_id, contact_id, triggered_by`,
    [callId, endedReason, transcript, JSON.stringify(message)]
  );

  console.log(`[VAPI] Call ${callId} ended (${endedReason ?? "unknown reason"}).`);

  const row = rows[0];
  if (row) await postCallLogToSlack(row.client_id, row.contact_id, message, endedReason);

  if (endedReason === TRANSFER_SUCCEEDED_REASON && row?.contact_id) {
    await handleSuccessfulTransfer(row.client_id, row.contact_id);
  }

  // Only the automatic dial-pending queue's own retry cadence gets
  // reopened here — a manual test call (scripts/test-iris-call.ts etc.)
  // has no cadence to continue even if it happens to share a contactId.
  if (row?.contact_id && row.triggered_by === "automatic" && !genuinelyAnswered(endedReason, message)) {
    await maybeReopenPendingCall(row.client_id, row.contact_id);
  }
}

/**
 * Moves the lead's opportunity to the follow-up stage matching the attempt
 * that just went unanswered (config.followUpStageIds[attemptsMade-1]), so
 * the board visually shows how many times a lead has been tried without
 * anyone needing to check our own DB. Best-effort and silent when a client
 * has no followUpStageIds configured, or has fewer stages than attempts —
 * this is a visibility nicety, never something that should block the
 * actual cadence logic in reopenForNextAttempt.
 */
export async function moveToFollowUpStage(clientId: string, contactId: string, attemptsMade: number): Promise<void> {
  const config = loadIrisConfig(clientId);
  const stageId = config?.followUpStageIds?.[attemptsMade - 1];
  if (!stageId) return;

  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (!ghlConfig) return;
    const opportunities = await findOpenOpportunitiesForContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
    const opportunity = opportunities[0];
    if (!opportunity) {
      console.warn(`[VAPI] No open opportunity found for contact ${contactId} — cannot move to follow-up stage.`);
      return;
    }
    await updateOpportunityStage(opportunity.id, stageId, ghlConfig.locationId, ghlConfig.apiKey);
  } catch (error) {
    console.error(`[VAPI] Failed to move contact ${contactId}'s opportunity to its follow-up stage:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Tags a lead once every scheduled attempt has gone unanswered, so a human
 * actually finds out this lead needs manual follow-up — before this, the
 * sequence just went silent internally with nothing visible in GHL at all.
 * Confirmed live 2026-09-20 that nothing else surfaces this today.
 */
export async function tagSequenceExhausted(clientId: string, contactId: string): Promise<void> {
  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (!ghlConfig) return;
    await addContactTags(contactId, ["iris no answer"], ghlConfig.locationId, ghlConfig.apiKey);
  } catch (error) {
    console.error(`[VAPI] Failed to tag contact ${contactId} as "iris no answer":`, error instanceof Error ? error.message : error);
  }
}

/**
 * Looks up the one iris_pending_calls row for this (client, contact) pair
 * — UNIQUE(client_id, contact_id), so there's at most one — and reopens it
 * for the next cadence attempt if it's still sitting in the 'placed'
 * state this same call left it in (dial-pending.ts's markPlaced). Explicit
 * callbacks are never reopened, same one-shot behavior as always.
 */
async function maybeReopenPendingCall(clientId: string, contactId: string): Promise<void> {
  try {
    const rows = await query<{ id: number; attempts_made: number; created_at: Date; is_explicit_callback: boolean; status: string }>(
      `SELECT id, attempts_made, created_at, is_explicit_callback, status FROM iris_pending_calls
       WHERE client_id = $1 AND contact_id = $2`,
      [clientId, contactId]
    );
    const pending = rows[0];
    if (!pending || pending.is_explicit_callback || pending.status !== "placed") return;

    const reopened = await reopenForNextAttempt(pending.id, clientId, pending.attempts_made, pending.created_at);
    console.log(
      `[VAPI] Contact ${contactId} didn't answer — ${reopened ? "requeued for the next attempt" : "cadence exhausted, not requeuing"}.`
    );

    await moveToFollowUpStage(clientId, contactId, pending.attempts_made);
    if (!reopened) await tagSequenceExhausted(clientId, contactId);
  } catch (error) {
    console.error(`[VAPI] Failed to check/reopen pending call for ${contactId}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Best-effort — the transfer already happened by the time this runs, so a
 * failure here must never be treated as the transfer itself having failed.
 * Two independent steps, each wrapped separately so one failing doesn't
 * skip the other: tag the contact (existing behavior), then move its
 * opportunity to the Live Transferred stage (Mark, 2026-09-04).
 */
async function handleSuccessfulTransfer(clientId: string, contactId: string): Promise<void> {
  const ghlConfig = await getGhlConfig(clientId).catch(() => null);
  if (!ghlConfig) return;

  try {
    await addContactTags(contactId, ["live transferred"], ghlConfig.locationId, ghlConfig.apiKey);
  } catch (error) {
    console.error(`[VAPI] Failed to tag contact ${contactId} as live transferred:`, error instanceof Error ? error.message : error);
  }

  try {
    const config = loadIrisConfig(clientId);
    if (!config?.liveTransferStageId) {
      console.log(`[VAPI] No liveTransferStageId configured for ${clientId} — skipping opportunity stage move.`);
      return;
    }
    const opportunities = await findOpenOpportunitiesForContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
    const opportunity = opportunities[0];
    if (!opportunity) {
      console.warn(`[VAPI] No open opportunity found for contact ${contactId} — cannot move to Live Transferred stage.`);
      return;
    }
    await updateOpportunityStage(opportunity.id, config.liveTransferStageId, ghlConfig.locationId, ghlConfig.apiKey);
    console.log(`[VAPI] Moved opportunity ${opportunity.id} for contact ${contactId} to Live Transferred.`);
  } catch (error) {
    console.error(`[VAPI] Failed to move contact ${contactId}'s opportunity to Live Transferred:`, error instanceof Error ? error.message : error);
  }
}

export function createVapiRouter(): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (secret && !verifyVapiSecret(secret, req)) {
      console.warn("[VAPI] Invalid or missing X-Vapi-Secret header");
      return res.status(401).send("Invalid signature");
    }

    // Acknowledge immediately — Vapi doesn't wait around, same as the Slack handler.
    res.status(200).send();

    try {
      const message = req.body?.message;
      if (!message) return;

      if (message.type === "end-of-call-report") {
        await handleEndOfCallReport(message);
      }
      // Other message types (status-update, transcript, etc.) are informational
      // only for now — nothing downstream consumes them yet.
    } catch (error) {
      console.error("[VAPI] Error handling webhook:", error);
    }
  });

  return router;
}
