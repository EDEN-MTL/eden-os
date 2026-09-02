import crypto from "crypto";
import { Request, Response, Router } from "express";
import { getGhlConfig, getCalendarSlots, createAppointment } from "../shared/ghl";

/**
 * Server-side handlers for the check_availability / book_appointment
 * function tools Vapi calls back to mid-call — see agents/iris/calling.ts's
 * buildCallPayload for how these get wired into an assistant, and
 * shared/vapi/index.ts's VapiFunctionTool for the request/response shape
 * this implements (Vapi POSTs {message: {toolCallList: [...]}}, expects
 * {results: [{toolCallId, result}]} back).
 *
 * clientId/contactId/calendarId travel as query params on the tool's own
 * server URL (baked in per-call at payload-build time) rather than as
 * arguments the model has to supply — Iris already knows nothing about
 * internal ids, and shouldn't need to.
 */

const CALLBACK_SLOT_MINUTES = 15;
const CALLBACK_WINDOW_DAYS = 5;

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

async function handleCheckAvailability(clientId: string, calendarId: string): Promise<string> {
  const ghlConfig = await getGhlConfig(clientId);
  if (!ghlConfig) return "Could not check availability — no GHL configuration found for this client.";

  const startDate = String(Date.now());
  const endDate = String(Date.now() + CALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let raw: Record<string, { slots?: string[] }>;
  try {
    raw = await getCalendarSlots(calendarId, startDate, endDate, ghlConfig.locationId, ghlConfig.apiKey);
  } catch (error) {
    return `Could not check availability — the calendar lookup failed (${
      error instanceof Error ? error.message : String(error)
    }). Do not invent a time; tell the lead a teammate will follow up to schedule instead.`;
  }

  const slots = Object.values(raw || {})
    .flatMap((day) => day?.slots || [])
    .sort();

  if (slots.length === 0) {
    return "No open callback slots in the next few days. Do not invent a time; tell the lead a teammate will follow up to schedule instead.";
  }

  const offered = slots.slice(0, 2);
  const described = offered.map((iso) => `${iso} (${formatLocal(iso)})`).join(", or ");
  return (
    `Real available callback times: ${described}. Offer these two to the lead in plain, natural language ` +
    `(not the raw timestamps). Once they pick one, call book_appointment with that slot's exact ISO string ` +
    `from this list — do not alter it.`
  );
}

async function handleBookAppointment(clientId: string, contactId: string, calendarId: string, startTime: unknown): Promise<string> {
  if (typeof startTime !== "string" || !startTime) {
    return "Booking failed — no valid startTime was provided. Do not claim to have booked anything.";
  }

  const ghlConfig = await getGhlConfig(clientId);
  if (!ghlConfig) return "Booking failed — no GHL configuration found for this client. Do not claim to have booked anything.";

  const endTime = new Date(new Date(startTime).getTime() + CALLBACK_SLOT_MINUTES * 60 * 1000).toISOString();

  try {
    await createAppointment(
      calendarId,
      {
        contactId,
        startTime,
        endTime,
        title: "Iris callback",
        notes: "Booked automatically by Iris after a live transfer attempt found nobody available.",
      },
      ghlConfig.locationId,
      ghlConfig.apiKey
    );
    return `Booked successfully for ${formatLocal(startTime)}. Confirm this back to the lead.`;
  } catch (error) {
    return (
      `Booking failed (${error instanceof Error ? error.message : String(error)}). Do not claim to have ` +
      `booked anything — apologize and say a teammate will follow up directly to get them scheduled instead.`
    );
  }
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
    "/check-availability",
    createToolHandler(async (query) => handleCheckAvailability(query.clientId, query.calendarId))
  );

  router.post(
    "/book-appointment",
    createToolHandler(async (query, call) => handleBookAppointment(query.clientId, query.contactId, query.calendarId, call.arguments?.startTime))
  );

  return router;
}
