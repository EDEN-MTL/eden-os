import crypto from "crypto";
import { Request, Response, Router } from "express";
import { query } from "../shared/db";
import { getGhlConfig, getContact, addContactTags, findOpenOpportunitiesForContact, updateOpportunityStage, getCustomFieldDefs, updateContact } from "../shared/ghl";
import { sendMessage, uploadFile } from "../shared/slack";
import { appendHistory } from "../shared/conversation-memory";
import { loadIrisConfig } from "../agents/iris";
import { reopenForNextAttempt, scheduleExplicitCallback } from "../agents/iris/dial-pending";
import { buildKeyToId, readField } from "../agents/scout/intake";
import { clampToLegalCallingWindow, formatLocal } from "../agents/iris/cadence";
import { handleInboundCall } from "../agents/iris/inbound";
import { classifyMissedCallback } from "../agents/iris/call-signals";

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
 * A real near-miss: the lead was engaged all the way through a live
 * transfer attempt but got disconnected before it actually connected them
 * to a human — confirmed against Vapi's own endedReason enum
 * (api.vapi.ai/api-json), 2026-09-24, after a real qualified lead (Jalpesh
 * Patel) hit exactly this: fully qualified, agreed to the transfer, Iris
 * said "Transferring the call now," then disconnected. wasAnswered's
 * generic allowlist already (correctly) keeps this from being retried —
 * this only changes the Slack LABEL, so it doesn't get lumped in with a
 * lead who simply declined a transfer or wasn't offered one; it needs a
 * manual callback, not a shrug.
 */
const TRANSFER_ABANDONED_REASONS = new Set(["customer-ended-call-before-warm-transfer", "customer-ended-call-after-warm-transfer-attempt"]);

/**
 * A real gatekeeper/call-screening service picking up instead of the lead —
 * confirmed live 2026-09-26 against a real 3% Realty lead (contact
 * Yv2IP2sS51FuKGkinu4W, "Florida Lisa", vapi_call_id
 * 01a0dfe6-829c-7cce-8a8c-32089f2e2bf5): the "customer" side of the
 * transcript opened with "Hi. If you record your name and reason for
 * calling, I'll see if this person is available." and closed with
 * "...this person is not available. If you would like to leave an
 * additional message, please reply after the tone." Vapi's own
 * voicemailDetection (agents/iris/calling.ts) is trained on classic
 * answering-machine monologues and never flagged this — it's an
 * interactive screener, not a static greeting — so the call came back
 * endedReason "assistant-ended-call" with real transcribed "customer"
 * turns, which customerSpokeAtAll (correctly, for what IT'S checking)
 * reads as a genuine conversation. Left unhandled, genuinelyAnswered marked
 * this lead as reached: only 1 of the normal 8 automatic attempts ever
 * ran, iris_pending_calls resolved permanently, and the lead will never be
 * called again — confirmed live, same call.
 *
 * Keyed on the one distinctively robotic phrase actually seen rather than a
 * broad keyword list ("please stay on the line" / "not available" alone
 * are things a real human relaying a message could plausibly say too) —
 * "record your name and reason for calling" is not. Extend this the same
 * way TRANSFER_ABANDONED_REASONS grew, if a differently-worded screener
 * shows up on a future real call.
 */
const CALL_SCREENER_PHRASES = [/record(?:ing)? your name and reason for calling/i];

export function hitCallScreener(message: Record<string, any>): boolean {
  const msgs: any[] = message?.messages ?? [];
  return msgs.some(
    (m) => m?.role === "user" && typeof m?.message === "string" && CALL_SCREENER_PHRASES.some((re) => re.test(m.message))
  );
}

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
  if (hitCallScreener(message)) return false;
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
  if (hitCallScreener(message)) return "🤖 Hit a call-screening service, not the actual lead — will retry";
  if (endedReason === "assistant-ended-call" && !customerSpokeAtAll(message)) return "🔇 No response (gave up after the idle nudge)";
  if (TRANSFER_ABANDONED_REASONS.has(endedReason ?? "")) return "⚠️ Disconnected right before transfer connected — needs a manual callback";
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
 * Attaches the real call recording as a threaded reply under the call-log
 * post — Mark's ask, 2026-09-27. Vapi records every call by default
 * (assistant.artifactPlan.recordingEnabled defaults to true) and hands back
 * short-lived (~30 min) presigned URLs on the SAME end-of-call-report
 * payload this function already receives — confirmed live against a real
 * call: the deprecated plain artifact.recordingUrl 400s (the bucket is
 * private), but presignedStereoUrl/presignedMonoUrl work with a real GET.
 * Uploads the actual audio to Slack (not a link) specifically because that
 * link expires — a permanent Slack-hosted file plays forever, a link
 * clicked even an hour later would already be dead. Best-effort and
 * entirely optional: a call with no recording (or a transiently-failed
 * fetch/upload) just skips this, never affecting the text post already sent.
 */
export async function attachRecording(message: Record<string, any>, channel: string, threadTs: string): Promise<void> {
  const recordingUrl: string | undefined = message?.artifact?.presignedStereoUrl ?? message?.artifact?.presignedMonoUrl;
  if (!recordingUrl) return;

  try {
    const audioResp = await fetch(recordingUrl);
    if (!audioResp.ok) {
      console.warn(`[VAPI] Recording fetch returned ${audioResp.status} — skipping Slack attachment.`);
      return;
    }
    const file = Buffer.from(await audioResp.arrayBuffer());
    const callId: string = message?.call?.id ?? "call";
    await uploadFile("iris", { channel, threadTs, file, filename: `${callId}.wav` });
  } catch (error) {
    console.error("[VAPI] Failed to attach call recording to Slack:", error instanceof Error ? error.message : error);
  }
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
      await attachRecording(message, result.channel, result.ts);
    }
  } catch (error) {
    console.error("[VAPI] Failed to post call log to Slack:", error instanceof Error ? error.message : error);
  }
}

/**
 * Guarantees every call leaves a trace on the lead's own GHL record, not
 * just Slack/our own DB — Mark's explicit instruction, 2026-09-24: the note
 * must update even when the call did NOT end in a transfer or booking.
 * Before this, the ONLY write to isa_notes was save_isa_notes, a tool the
 * MODEL chooses to call, timed to fire "right before presenting the live
 * transfer or scheduling fallback" (webhooks/vapi-tools.ts) — so a call
 * that ended earlier (no answer, voicemail, hung up mid-qualification, or
 * disconnected right before the transfer completed, like Jalpesh Patel)
 * left literally nothing on the contact record. A human opening that lead
 * in GHL had no way to know Iris had even tried.
 *
 * Deliberately APPENDS rather than overwrites: save_isa_notes may already
 * have written a real structured qualification summary moments earlier in
 * the SAME call (exactly Jalpesh Patel's case — qualified, then
 * disconnected before transfer) — clobbering that would destroy real,
 * gathered information right when it matters most. Reads the field's
 * current value first (getContact — CLAUDE.md gotcha 2: only a single
 * contact fetch returns populated customFields, never the list endpoint),
 * then writes existing + a new status line, or just the status line if the
 * field was empty. Runs unconditionally, every call, every outcome —
 * best-effort like every other post-call side effect in this handler, and
 * must never block or throw into the caller.
 */
/**
 * Reads the client's own callbackNotesFieldKey field on a contact and
 * appends one more line to it — never overwrites, since this field can
 * already carry a real qualification summary or an earlier call's status
 * line that matters just as much as whatever's being added now. Shared by
 * appendCallStatusNote (every call's generic status line) and
 * maybeHonorMissedCallback below (the specific "lead asked for a callback"
 * line Mark asked for, 2026-10-01: "store the callback time in the
 * lead/opportunity record... not just in Iris's conversational state" —
 * otherwise the next scheduled call loses all context for why it's
 * calling back).
 */
async function appendNoteToContact(clientId: string, contactId: string, line: string): Promise<void> {
  const ghlConfig = await getGhlConfig(clientId);
  const config = loadIrisConfig(clientId);
  if (!ghlConfig || !config) return;

  const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
  const keyToId = buildKeyToId(defs);
  const fieldId = keyToId.get(config.callbackNotesFieldKey);
  if (!fieldId) {
    console.warn(`[VAPI] callbackNotesFieldKey "${config.callbackNotesFieldKey}" did not resolve to a field id for ${clientId} — skipping note.`);
    return;
  }

  const contactResp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
  const contact = contactResp?.contact ?? contactResp;
  const existing = readField(contact?.customFields, config.callbackNotesFieldKey, keyToId);
  const notes = existing ? `${existing}\n\n${line}` : line;

  await updateContact(contactId, { customFields: [{ id: fieldId, value: notes }] }, ghlConfig.locationId, ghlConfig.apiKey);
}

export async function appendCallStatusNote(
  clientId: string,
  contactId: string,
  endedReason: string | null,
  message: Record<string, any>
): Promise<void> {
  try {
    const config = loadIrisConfig(clientId);
    if (!config) return;
    const timezone = config.timezone || "America/St_Johns";
    const statusLine =
      `Iris call ${formatLocal(new Date().toISOString(), timezone)} — ${describeOutcome(endedReason, message)}. ` +
      `Duration: ${formatDuration(message?.durationSeconds)}.`;
    await appendNoteToContact(clientId, contactId, statusLine);
  } catch (error) {
    console.error(`[VAPI] Failed to append call-status note for contact ${contactId}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Handles Vapi's end-of-call-report event: fills in the iris_call_log row
 * that placeCall() created with 'initiated' status. Does NOT parse the
 * transcript into GHL qualification fields yet — that needs a transcript ->
 * QualificationAnswers mapping (see agents/iris/qualification.ts's
 * fieldWritesFor, which currently expects already-structured answers, not
 * raw text) that hasn't been built. The full transcript is kept in the DB
 * so nothing is lost while that's pending. appendCallStatusNote below does
 * guarantee a one-line status trace on the GHL contact itself for every
 * call regardless of outcome, even without that mapping.
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
  if (row?.contact_id) await appendCallStatusNote(row.client_id, row.contact_id, endedReason, message);

  if (endedReason === TRANSFER_SUCCEEDED_REASON && row?.contact_id) {
    await handleSuccessfulTransfer(row.client_id, row.contact_id);
  }

  // Only the automatic dial-pending queue's own retry cadence gets
  // reopened here — a manual test call (scripts/test-iris-call.ts etc.)
  // has no cadence to continue even if it happens to share a contactId.
  if (row?.contact_id && row.triggered_by === "automatic") {
    if (!genuinelyAnswered(endedReason, message)) {
      await maybeReopenPendingCall(row.client_id, row.contact_id);
    } else if (endedReason !== TRANSFER_SUCCEEDED_REASON) {
      // Real case found live 2026-10-01 (Saife Sarwar): "Ma'am, right now
      // is busy. Can I call you later?" then hung up mid-reply, before
      // schedule_callback ever got a turn to run. genuinelyAnswered is
      // true here (a real pickup), so the branch above never fires — this
      // is the ONLY place left that can catch a callback request the live
      // call itself missed.
      await maybeHonorMissedCallback(row.client_id, row.contact_id, transcript);
    }
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

/** Mark's spec, 2026-10-01: when the lead asked for a callback but gave no specific time, default to ~1 hour out — same constant the live schedule_callback tool uses for the identical scenario (webhooks/vapi-tools.ts). */
const DEFAULT_CALLBACK_DELAY_MINUTES = 60;

/**
 * Catches a callback request the LIVE call itself missed — the lead asked
 * to be called back (a specific time, or just "later") and the call ended
 * before Iris's own schedule_callback tool (webhooks/vapi-tools.ts) ever
 * got a turn to run. Real case found live 2026-10-01 (Saife Sarwar): "right
 * now is busy, can I call you later?" then hung up mid-reply — endedReason
 * was a genuine pickup, so maybeReopenPendingCall above never runs, and
 * without this the row just closes out with nothing scheduled, forever.
 *
 * Deliberately does NOT gate on is_explicit_callback the way
 * maybeReopenPendingCall does — that flag means something narrower here
 * ("this specific callback is already scheduled, don't let the AUTOMATIC
 * cadence re-trigger over it"), and reusing it as a blanket skip would
 * wrongly block this forever on any row that went through an earlier,
 * unrelated explicit-callback path (e.g. a lead who consented to the FIRST
 * call by text — agents/iris/dial-pending.ts's call_consent handling — and
 * so already carries is_explicit_callback: true for a completely different
 * reason by the time THIS call happens). Only gates on status === 'placed'
 * — the same structural "nothing else already moved this row" guard
 * maybeReopenPendingCall uses.
 *
 * Both signal types converge on the SAME scheduleExplicitCallback path the
 * live tool already uses — call_later just supplies a computed default
 * time instead of one the lead gave — and both leave a durable note on the
 * contact (appendNoteToContact, same append-never-overwrite field the
 * live tool's recordCallbackNote writes to, just appending instead of
 * replacing since a real call-status line may have just been written
 * moments earlier in this same handler). Mark's explicit instruction: the
 * callback time must live on the lead's own record, not just in internal
 * state — otherwise the next scheduled call loses all context for why
 * it's calling back.
 */
export async function maybeHonorMissedCallback(clientId: string, contactId: string, transcript: string | null): Promise<void> {
  if (!transcript) return;

  try {
    const rows = await query<{ id: number; status: string }>(
      `SELECT id, status FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`,
      [clientId, contactId]
    );
    const pending = rows[0];
    if (!pending || pending.status !== "placed") return;

    const config = loadIrisConfig(clientId);
    const timezone = config?.timezone || "America/St_Johns";
    const signal = await classifyMissedCallback(transcript, new Date(), timezone);
    if (signal.type === "none") return;

    const when =
      signal.type === "schedule_for" ? signal.when : clampToLegalCallingWindow(new Date(Date.now() + DEFAULT_CALLBACK_DELAY_MINUTES * 60_000), timezone);

    await scheduleExplicitCallback(clientId, contactId, when);
    console.log(
      `[VAPI] Contact ${contactId} asked to be called back but the call ended first — ${signal.type === "schedule_for" ? "scheduled for the time they gave" : "scheduled ~1h out (no time given)"}: ${when.toISOString()}.`
    );

    await appendNoteToContact(
      clientId,
      contactId,
      `Iris: lead asked to be called back — scheduled for ${formatLocal(when.toISOString(), timezone)}${signal.type === "call_later" ? " (no specific time given, default)" : ""}.`
    ).catch((error) => {
      console.error(`[VAPI] Failed to note the missed callback for contact ${contactId}:`, error instanceof Error ? error.message : error);
    });
  } catch (error) {
    console.error(`[VAPI] Failed to check for a missed callback request for ${contactId}:`, error instanceof Error ? error.message : error);
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

    const message = req.body?.message;

    // assistant-request is the ONE message type Vapi actually waits on — it
    // needs a real JSON body (an assistant to use) within ~7.5s, so this
    // must NOT get the blank "ack immediately, process later" treatment
    // every other message type below gets. Confirmed against Vapi's own
    // docs, 2026-09-29: fires when an inbound call hits a phone number with
    // no assistantId attached (agents/iris/inbound.ts).
    if (message?.type === "assistant-request") {
      try {
        const { assistant, error } = await handleInboundCall(message);
        return res.status(200).json(assistant ? { assistant } : { error });
      } catch (error) {
        console.error("[VAPI] Error handling assistant-request:", error);
        return res.status(200).json({ error: "Sorry, something went wrong on our end. Please try again shortly." });
      }
    }

    // Acknowledge immediately — Vapi doesn't wait around, same as the Slack handler.
    res.status(200).send();

    try {
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
