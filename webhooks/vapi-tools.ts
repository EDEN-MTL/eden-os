import crypto from "crypto";
import { Request, Response, Router } from "express";
import { getGhlConfig, addContactTags, updateContact, getCustomFieldDefs, getCalendarSlots, createAppointment, getLocationTimezone } from "../shared/ghl";
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

/**
 * Full precision, for the GHL contact-note write only (recordCallbackNote)
 * — a database record a human might read later, not something Iris speaks
 * aloud. Defaults to St. John's for back-compat with existing callers that
 * never pass one — real per-client callers below resolve config.timezone
 * first (see IrisConfig.timezone's own doc comment for why this was wrong
 * for any client other than 3% East Coast).
 */
function formatLocal(iso: string, timeZone: string = "America/St_Johns"): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * What Iris actually says back to the lead — day of week + time only (e.g.
 * "Saturday at 5:00 PM"), never the full "Monday, September 7 at 7:30 PM"
 * formatLocal produces. Mark, 2026-09-06: reading the full formal date out
 * loud sounds exactly like reading a database field — the same complaint
 * that led to dropping the raw lead-source string from the opening line
 * and no longer speaking a timezone offset. The full date is still one
 * question away — nothing here prevents Iris from answering "what date is
 * that?" if the lead actually asks; it's just not volunteered by default.
 */
function formatSpoken(iso: string, timeZone: string = "America/St_Johns"): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
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
      { customFields: [{ id: fieldId, value: `Iris scheduled a callback for ${formatLocal(when.toISOString(), config.timezone)} — lead asked to be called back at this time.` }] },
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

  const timeZone = loadIrisConfig(clientId)?.timezone;
  return `Callback scheduled for ${formatSpoken(when.toISOString(), timeZone)}. Confirm this back to the lead in plain language — just the day and time (e.g. "Saturday at 5 PM"), and only give the exact date if they ask for it.`;
}

/**
 * Real-time equivalent of handleScheduleCallback — only wired when a real
 * callbackCalendarId resolved for this client/intent (calling.ts's
 * buildCallPayload), so a client on the simple note+redial system never
 * has this called against it. Checks the requested moment against GHL's
 * actual free-slots for this calendar and books it immediately if open;
 * otherwise returns the nearest REAL open times instead of ever asserting
 * availability that wasn't actually confirmed. Mark, 2026-09-06: built and
 * verified live against a real test calendar before trusting it, same
 * discipline as everything else in this codebase.
 */
const APPOINTMENT_DURATION_MINUTES = 30;
const APPOINTMENT_SEARCH_WINDOW_DAYS = 3;
const MAX_ALTERNATIVES_OFFERED = 3;

/**
 * Confirmed live, 2026-09-06: the model's requestedTime argument routinely
 * comes back with no UTC offset at all (e.g. "2026-09-05T18:00:00"), and
 * bare `new Date(...)` on a string like that parses it as the SERVER's own
 * local time, not the client's timezone — a Render server runs in UTC, so
 * a lead-intended "6 PM Toronto" silently became 6 PM UTC (2 PM Toronto),
 * missing every real slot by 4 hours. Iris kept saying "trouble booking"
 * because nothing ever matched, real slots included. If the string already
 * carries an offset/Z, trust it outright; otherwise treat the wall-clock
 * numbers as being in `timeZone` and convert properly — same round-trip
 * technique as agents/iris/cadence.ts's zonedHourToUtc, generalized here
 * to include minutes since a requested callback is rarely on the hour.
 */
export function resolveRequestedTime(raw: string, timeZone: string): Date | null {
  const hasOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(raw.trim());
  if (hasOffset) {
    const direct = new Date(raw);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }

  const naiveAsUtc = new Date(`${raw}Z`);
  if (Number.isNaN(naiveAsUtc.getTime())) return null;

  const renderedInZone = new Date(naiveAsUtc.toLocaleString("en-US", { timeZone }));
  const renderedInUtc = new Date(naiveAsUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = renderedInUtc.getTime() - renderedInZone.getTime();
  return new Date(naiveAsUtc.getTime() + offsetMs);
}

async function handleCheckAndBookAppointment(
  clientId: string,
  contactId: string,
  calendarId: string,
  intent: string,
  requestedTime: unknown
): Promise<string> {
  // These two messages are addressed to the MODEL, not the lead — confirmed
  // live, 2026-09-06: a real call had Iris repeatedly telling the lead
  // "I'm having trouble with the time format" on a loop, even after they
  // clearly reconfirmed the same time twice. That phrase never came from
  // this handler; the model invented it while trying to explain one of
  // these two messages in its own words. Being explicit that THIS is an
  // internal formatting problem — not a real availability check, and
  // nothing the lead did wrong — should stop it from surfacing a fake
  // "technical issue" to them.
  if (typeof requestedTime !== "string" || !requestedTime) {
    return "No requestedTime was given — this is an error in how you called the tool, not a real availability check. Recompute the moment the lead named relative to the current date and time given at the top of your instructions, then call this tool again. Do not tell the lead there's a technical issue or problem with time format.";
  }

  const ghlConfig = await getGhlConfig(clientId);
  const config = loadIrisConfig(clientId);
  if (!ghlConfig || !config) {
    return "Could not check the calendar right now — tell the lead a teammate will confirm a time directly.";
  }
  // Follow GHL's own configured location timezone live, rather than a
  // static config value that can drift out of sync with whatever's
  // actually set there — same discipline as dial-pending.ts's prompt-time
  // reference. Falls back to config.timezone, then the hardcoded default.
  const liveTimezone = await getLocationTimezone(ghlConfig.locationId, ghlConfig.apiKey).catch(() => null);
  const timeZone = liveTimezone || config.timezone;

  const requested = resolveRequestedTime(requestedTime, timeZone || "America/St_Johns");
  if (!requested) {
    return `"${requestedTime}" is not a valid ISO 8601 timestamp — this is an error in how you called the tool, not a real availability check. Recompute the moment the lead named relative to the current date and time given at the top of your instructions (e.g. "2026-09-07T18:00:00"), then call this tool again with a properly formatted timestamp. Do not tell the lead there's a technical issue or problem with time format — they did nothing wrong.`;
  }

  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + APPOINTMENT_SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let slotsResp: Record<string, { slots?: string[] }>;
  try {
    slotsResp = await getCalendarSlots(
      calendarId,
      windowStart.getTime().toString(),
      windowEnd.getTime().toString(),
      ghlConfig.locationId,
      ghlConfig.apiKey
    );
  } catch (error) {
    console.error(`[VAPI-TOOLS] getCalendarSlots failed for ${clientId}/${calendarId}:`, error instanceof Error ? error.message : error);
    return "Could not check the calendar right now — tell the lead a teammate will confirm a time directly.";
  }

  // GHL's own response mixes a "traceId" string key in with the real
  // per-date entries — confirmed live, 2026-09-06.
  const allSlots = Object.entries(slotsResp)
    .filter(([key, value]) => key !== "traceId" && Array.isArray(value?.slots))
    .flatMap(([, day]) => day.slots as string[])
    .sort();

  const exactMatch = allSlots.find((s) => new Date(s).getTime() === requested.getTime());

  if (exactMatch) {
    const endTime = new Date(new Date(exactMatch).getTime() + APPOINTMENT_DURATION_MINUTES * 60_000).toISOString();
    try {
      await createAppointment(
        calendarId,
        {
          contactId,
          startTime: exactMatch,
          endTime,
          title: `${intent === "seller" ? "Seller" : "Buyer"} callback`,
          notes: "Booked automatically by Iris during a live call.",
        },
        ghlConfig.locationId,
        ghlConfig.apiKey
      );
    } catch (error) {
      console.error(`[VAPI-TOOLS] createAppointment failed for ${clientId}/${contactId}:`, error instanceof Error ? error.message : error);
      return "That time showed as open but the booking failed — do not claim it's booked. Tell the lead a teammate will confirm directly instead.";
    }
    return `Booked for ${formatSpoken(exactMatch, timeZone)}. Confirm this back to the lead simply — just the day and time (e.g. "Saturday at 5 PM"), and only give the exact date if they ask for it.`;
  }

  const alternatives = allSlots.filter((s) => new Date(s).getTime() >= requested.getTime()).slice(0, MAX_ALTERNATIVES_OFFERED);
  if (alternatives.length === 0) {
    return "That time isn't available and nothing else real is open in the next few days. Do not invent a time — tell the lead a teammate will follow up directly to find one.";
  }
  return (
    "That exact time isn't available. Real open times instead: " +
    alternatives.map((s) => formatSpoken(s, timeZone)).join(", ") +
    ". Offer these to the lead and call this tool again with whichever one they pick to actually book it."
  );
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

  router.post(
    "/check-and-book-appointment",
    createToolHandler(async (query, call) =>
      handleCheckAndBookAppointment(query.clientId, query.contactId, query.calendarId, query.intent, call.arguments?.requestedTime)
    )
  );

  return router;
}
