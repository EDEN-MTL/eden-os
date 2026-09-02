import crypto from "crypto";
import { Request, Response, Router } from "express";
import { query } from "../shared/db";
import { getGhlConfig, addContactTags } from "../shared/ghl";

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

  const rows = await query<{ client_id: string; contact_id: string | null }>(
    `UPDATE iris_call_log
     SET status = 'ended', ended_reason = $2, transcript = $3, ended_at = now(), raw = $4
     WHERE vapi_call_id = $1
     RETURNING client_id, contact_id`,
    [callId, endedReason, transcript, JSON.stringify(message)]
  );

  console.log(`[VAPI] Call ${callId} ended (${endedReason ?? "unknown reason"}).`);

  const row = rows[0];
  if (endedReason === TRANSFER_SUCCEEDED_REASON && row?.contact_id) {
    await tagLiveTransferred(row.client_id, row.contact_id);
  }
}

/**
 * Best-effort — the transfer already happened by the time this runs, so a
 * tagging failure must not be treated as the transfer having failed.
 */
async function tagLiveTransferred(clientId: string, contactId: string): Promise<void> {
  try {
    const ghlConfig = await getGhlConfig(clientId);
    if (!ghlConfig) return;
    await addContactTags(contactId, ["live transferred"], ghlConfig.locationId, ghlConfig.apiKey);
  } catch (error) {
    console.error(`[VAPI] Failed to tag contact ${contactId} as live transferred:`, error instanceof Error ? error.message : error);
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
