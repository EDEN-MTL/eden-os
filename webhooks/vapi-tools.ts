import crypto from "crypto";
import { Request, Response, Router } from "express";
import { getGhlConfig, addContactTags, updateContact, getCustomFieldDefs } from "../shared/ghl";
import { buildKeyToId } from "../agents/scout/intake";
import { loadIrisConfig } from "../agents/iris";
import { scheduleExplicitCallback } from "../agents/iris/dial-pending";

/**
 * Server-side handler for the schedule_callback function tool Vapi calls
 * back to mid-call — see agents/iris/calling.ts's buildCallPayload for how
 * it gets wired into an assistant, and shared/vapi/index.ts's
 * VapiFunctionTool for the request/response shape this implements (Vapi
 * POSTs {message: {toolCallList: [...]}}, expects {results: [{toolCallId,
 * result}]} back).
 *
 * clientId/contactId travel as query params on the tool's own server URL
 * (baked in per-call at payload-build time) rather than as arguments the
 * model has to supply — Iris already knows nothing about internal ids, and
 * shouldn't need to.
 *
 * Mark, 2026-09-03: this replaced an earlier design that checked a GHL
 * calendar for real slots and booked one directly (check_availability /
 * book_appointment). That's on hold, not deleted — see
 * config/clients/*.json's iris.callbacks._comment. This version doesn't
 * touch a calendar at all: it leaves a note on the contact and schedules a
 * real follow-up dial through the same iris_pending_calls queue
 * lead.enriched uses, at the exact time the lead agreed to.
 */

const MIN_CALLBACK_MINUTES_OUT = 10;
const MAX_CALLBACK_DAYS_OUT = 14;

/** Same secret used for the end-of-call-report webhook — see webhooks/vapi-webhook.ts. */
function verifyVapiSecret(expectedSecret: string, req: Request): boolean {
  const provided = req.headers["x-vapi-secret"] as string | undefined;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface ToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/St_Johns",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Best-effort note write after a callback is actually scheduled — the real
 * follow-up dial is already queued by this point (scheduleExplicitCallback
 * succeeded), so a failure here must never surface as a scheduling failure
 * to the lead. Per Jacob's brief (config/clients/*.json's
 * iris.callbacks.writeContactNoteReason): this note IS meant to be
 * client-facing content in the isa_notes field, not the "never write prose
 * there" rule from qualification — that rule is about raw Q&A answers, not
 * a callback brief. It also happens to be what flips isFirstTouch false for
 * this contact, which is what stops the generic 2x/day cadence from also
 * trying to re-dial this lead in the meantime (see dial-pending.ts's
 * is_explicit_callback comment for the other half of that story).
 */
async function recordCallbackNote(clientId: string, contactId: string, when: Date): Promise<void> {
  try {
    const ghlConfig = await getGhlConfig(clientId);
    const config = loadIrisConfig(clientId);
    if (!ghlConfig || !config) return;

    const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
    const fieldId = buildKeyToId(defs).get(config.callbackNotesFieldKey);
    if (!fieldId) {
      console.warn(`[VAPI-TOOLS] callbackNotesFieldKey "${config.callbackNotesFieldKey}" did not resolve to a field id for ${clientId} — skipping note.`);
      return;
    }
    await updateContact(
      contactId,
      { customFields: [{ id: fieldId, value: `Iris scheduled a callback for ${formatLocal(when.toISOString())} — lead asked to be called back at this time.` }] },
      ghlConfig.locationId,
      ghlConfig.apiKey
    );
  } catch (error) {
    console.error(`[VAPI-TOOLS] Failed to write callback note for contact ${contactId}:`, error instanceof Error ? error.message : error);
  }
}

async function handleScheduleCallback(clientId: string, contactId: string, callbackTime: unknown): Promise<string> {
  if (typeof callbackTime !== "string" || !callbackTime) {
    return "Could not schedule the callback — no valid time was provided. Do not claim to have scheduled anything; tell the lead a teammate will follow up directly instead.";
  }

  const when = new Date(callbackTime);
  if (Number.isNaN(when.getTime())) {
    return "Could not schedule the callback — that wasn't a valid time. Do not claim to have scheduled anything; tell the lead a teammate will follow up directly instead.";
  }

  const minutesOut = (when.getTime() - Date.now()) / 60_000;
  if (minutesOut < MIN_CALLBACK_MINUTES_OUT) {
    return `That time is too soon to schedule automatically — pick a time at least ${MIN_CALLBACK_MINUTES_OUT} minutes from now. If the lead wants to talk right now instead, just keep going with this call.`;
  }
  if (minutesOut > MAX_CALLBACK_DAYS_OUT * 24 * 60) {
    return "That's too far out to schedule automatically. Do not claim to have scheduled anything — tell the lead a teammate will reach out directly to confirm a time that far ahead.";
  }

  const scheduled = await scheduleExplicitCallback(clientId, contactId, when);
  if (!scheduled) {
    return "Could not schedule the callback — could not verify the lead's record right now. Do not claim to have scheduled anything; tell the lead a teammate will follow up directly instead.";
  }

  await recordCallbackNote(clientId, contactId, when);

  return `Callback scheduled for ${formatLocal(when.toISOString())}. Confirm this back to the lead in plain language.`;
}

function createToolHandler(handler: (query: Record<string, string>, call: ToolCall) => Promise<string>) {
  return async (req: Request, res: Response) => {
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (secret && !verifyVapiSecret(secret, req)) {
      console.warn("[VAPI-TOOLS] Invalid or missing X-Vapi-Secret header");
      return res.status(401).send("Invalid signature");
    }

    try {
      const toolCalls: ToolCall[] = req.body?.message?.toolCallList || [];
      const query = req.query as Record<string, string>;
      const results = await Promise.all(
        toolCalls.map(async (call) => ({
          toolCallId: call.id,
          result: await handler(query, call),
        }))
      );
      res.json({ results });
    } catch (error) {
      console.error("[VAPI-TOOLS] Error handling tool call:", error);
      res.status(500).json({ results: [] });
    }
  };
}

export function createVapiToolsRouter(): Router {
  const router = Router();

  router.post(
    "/schedule-callback",
    createToolHandler(async (query, call) => handleScheduleCallback(query.clientId, query.contactId, call.arguments?.callbackTime))
  );

  return router;
}
