import crypto from "crypto";
import { Request, Response, Router } from "express";
import { getGhlConfig, addContactTags, updateContact, getCustomFieldDefs, getCalendarSlots, createAppointment, getLocationTimezone } from "../shared/ghl";
import { buildKeyToId } from "../agents/scout/intake";
import { loadIrisConfig } from "../agents/iris";
import { scheduleExplicitCallback } from "../agents/iris/dial-pending";
import { isWithinLegalCallingWindow } from "../agents/iris/cadence";

/**
 * Server-side handler for the schedule_callback function tool Vapi calls
 * back to mid-call — see agents/iris/calling.ts's buildCallPayload for how
 * it gets wired into an assistant, and shared/vapi/index.ts's
 * VapiFunctionTool for the request/response shape this implements (Vapi
 * POSTs {message: {toolCallList: [...]}}, expects {results: [{toolCallId,
 * result}]} back). Each toolCallList entry's arguments arrive as a
 * JSON-ENCODED STRING under `.function.arguments`, not a parsed object
 * directly on the entry — see ToolCall's own doc comment below for how that
 * was missed for this tool's entire lifetime.
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

/**
 * `arguments` is documented on Vapi's own OpenAPI schema (api.vapi.ai/api-json)
 * as a JSON-ENCODED STRING — but that's wrong. Round two of this bug, 2026-09-08:
 * fixed this file once already to read `call.function.arguments` instead of a
 * flat `call.arguments` (which never existed on the real payload), assuming
 * the schema's "it's a string" claim was correct. Deployed, then a live call
 * STILL hit "No requestedTime was given" every time. Added temporary debug
 * logging (createToolHandler below), captured a REAL production webhook body,
 * and found the actual shape: `function.arguments` arrives as an
 * ALREADY-PARSED OBJECT (`{"requestedTime":"2026-09-08T08:45:00"}`), not a
 * string at all. `JSON.parse()` on a non-string argument coerces it via
 * `.toString()` first (producing `"[object Object]"`, invalid JSON), which
 * threw, and the old parseToolArguments's catch-all silently returned `{}` —
 * reproducing the exact same symptom in a new form. This is now handled for
 * both real shapes seen (object OR string), rather than trusting either the
 * vendor's doc or a single prior observation. Confirmed by querying every
 * historical iris_call_log row with a schedule_callback/check_and_book_appointment
 * tool result before this fix: 100% of them, across every call for every
 * client since this was built, came back with the "no valid time" error path.
 */
export interface ToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

/**
 * Handles both real shapes Vapi has been observed sending for
 * `function.arguments` — see ToolCall's own doc comment. Falls back to {} on
 * malformed JSON or an unexpected type rather than throwing, so a bad payload
 * degrades to the tool's own "missing argument" error message (which the
 * model can recover from) instead of a 500.
 */
export function parseToolArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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

  const timeZone = loadIrisConfig(clientId)?.timezone || "America/St_Johns";
  // Mark's instruction, 2026-09-11: real calling-hours compliance — a lead's
  // own stated preferred callback time was never checked against business
  // hours before. Reject rather than silently move it: the lead chose this
  // time on purpose, so ask again instead of surprising them with a
  // different one they never agreed to.
  if (!isWithinLegalCallingWindow(when, timeZone)) {
    return `That time is outside legal calling hours (8am-9pm, ${timeZone}) — do not schedule it. Ask the lead for a different time within that window instead, and call this tool again once they give one. Do not tell them there's a technical issue — this is a real business-hours rule, not an error.`;
  }

  const scheduled = await scheduleExplicitCallback(clientId, contactId, when);
  if (!scheduled) {
    return "Could not schedule the callback — could not verify the lead's record right now. Do not claim to have scheduled anything; tell the lead a teammate will follow up directly instead.";
  }

  await recordCallbackNote(clientId, contactId, when);

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

/**
 * Fetches live GHL calendar slots for the standard search window and
 * resolves the requester's timezone — shared by both check_availability
 * and book_appointment below, since both need the exact same "what's
 * actually open right now" data. Returns null (with the caller's own
 * "could not check" message already logged) on any GHL failure.
 */
async function fetchLiveSlots(
  clientId: string,
  calendarId: string,
  configTimezone: string | undefined
): Promise<{ timeZone: string | undefined; allSlots: string[] } | null> {
  const ghlConfig = await getGhlConfig(clientId);
  if (!ghlConfig) return null;

  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + APPOINTMENT_SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // getLocationTimezone and getCalendarSlots don't depend on each other —
  // the slots window is plain epoch ms, timezone-independent — so they run
  // in parallel rather than sequentially. Mark's live feedback, 2026-09-08:
  // a real call's second check_and_book_appointment invocation took long
  // enough to blow past Vapi's 20-second webhook timeout; three sequential
  // GHL round-trips (timezone, slots, create) is exactly the kind of
  // latency that adds up to that. This cuts one round-trip off the
  // critical path.
  let liveTimezone: string | null;
  let slotsResp: Record<string, { slots?: string[] }>;
  try {
    [liveTimezone, slotsResp] = await Promise.all([
      getLocationTimezone(ghlConfig.locationId, ghlConfig.apiKey).catch(() => null),
      getCalendarSlots(calendarId, windowStart.getTime().toString(), windowEnd.getTime().toString(), ghlConfig.locationId, ghlConfig.apiKey),
    ]);
  } catch (error) {
    console.error(`[VAPI-TOOLS] getCalendarSlots failed for ${clientId}/${calendarId}:`, error instanceof Error ? error.message : error);
    return null;
  }
  // Follow GHL's own configured location timezone live, rather than a
  // static config value that can drift out of sync with whatever's
  // actually set there — same discipline as dial-pending.ts's prompt-time
  // reference. Falls back to config.timezone, then the hardcoded default.
  const timeZone = liveTimezone || configTimezone;

  // GHL's own response mixes a "traceId" string key in with the real
  // per-date entries — confirmed live, 2026-09-06.
  const allSlots = Object.entries(slotsResp)
    .filter(([key, value]) => key !== "traceId" && Array.isArray(value?.slots))
    .flatMap(([, day]) => day.slots as string[])
    .sort();

  return { timeZone, allSlots };
}

/**
 * Read-only half of what used to be handleCheckAndBookAppointment — never
 * creates anything, only ever reports what's real. Split out 2026-09-11
 * specifically so book_appointment below (the ONLY thing that actually
 * creates a calendar event) can carry Vapi's own guaranteed
 * `messages: [{type: "request-complete", ...}]` confirmation — see
 * agents/iris/calling.ts's buildCallPayload and VapiToolMessage's own doc
 * comment for why that couldn't safely live on a combined check-and-book
 * tool (Vapi has no way to conditionally speak that message only on the
 * "actually booked" branch of a single tool's response; splitting the
 * tool in two makes "this tool call succeeded" and "a real booking was
 * made" the same fact).
 */
async function handleCheckAvailability(clientId: string, calendarId: string, requestedTime: unknown): Promise<string> {
  // Addressed to the MODEL, not the lead — confirmed live, 2026-09-06: a
  // real call had Iris repeatedly telling the lead "I'm having trouble
  // with the time format" on a loop, even after they clearly reconfirmed
  // the same time twice. That phrase never came from this handler; the
  // model invented it while trying to explain one of these messages in
  // its own words. Being explicit that THIS is an internal formatting
  // problem — not a real availability check, and nothing the lead did
  // wrong — should stop it from surfacing a fake "technical issue" to them.
  if (typeof requestedTime !== "string" || !requestedTime) {
    return "No requestedTime was given — this is an error in how you called the tool, not a real availability check. Recompute the moment the lead named relative to the current date and time given at the top of your instructions, then call this tool again. Do not tell the lead there's a technical issue or problem with time format.";
  }

  const config = loadIrisConfig(clientId);
  if (!config) {
    return "Could not check the calendar right now — tell the lead a teammate will confirm a time directly.";
  }

  // Cheap, local, no network — validate the timestamp is parseable at all
  // BEFORE spending any GHL round-trips on it. resolveRequestedTime's
  // parseability check doesn't depend on which timezone name it's given
  // (that only affects the offset applied to an already-valid timestamp),
  // so config.timezone here is just a placeholder for this pre-check — the
  // real, live-timezone-informed resolution happens below once we have it.
  if (!resolveRequestedTime(requestedTime, config.timezone || "America/St_Johns")) {
    return `"${requestedTime}" is not a valid ISO 8601 timestamp — this is an error in how you called the tool, not a real availability check. Recompute the moment the lead named relative to the current date and time given at the top of your instructions (e.g. "2026-09-07T18:00:00"), then call this tool again with a properly formatted timestamp. Do not tell the lead there's a technical issue or problem with time format — they did nothing wrong.`;
  }

  const live = await fetchLiveSlots(clientId, calendarId, config.timezone);
  if (!live) {
    return "Could not check the calendar right now — tell the lead a teammate will confirm a time directly.";
  }
  const { timeZone, allSlots } = live;

  // Re-resolve with the real (live) timezone now that we have it — matters
  // when it differs from config.timezone (e.g. a DST edge, or the two
  // genuinely disagree), since that changes the exact UTC instant a naive
  // "2026-09-07T18:00:00" string resolves to. Already known parseable from
  // the pre-check above, so this can't fail here.
  const requested = resolveRequestedTime(requestedTime, timeZone || "America/St_Johns")!;

  const exactMatch = allSlots.find((s) => new Date(s).getTime() === requested.getTime());
  if (exactMatch) {
    return `That time is available. To lock it in, call book_appointment with isoTime: "${new Date(exactMatch).toISOString()}" — copy that value verbatim, do not recompute it. This tool alone never books anything.`;
  }

  const alternatives = allSlots.filter((s) => new Date(s).getTime() >= requested.getTime()).slice(0, MAX_ALTERNATIVES_OFFERED);
  if (alternatives.length === 0) {
    return "That time isn't available and nothing else real is open in the next few days. Do not invent a time — tell the lead a teammate will follow up directly to find one.";
  }
  // Each alternative is given as BOTH a spoken phrase (say this part to the
  // lead) and its exact ISO instant (pass this back verbatim, do not
  // recompute it). Confirmed live, 2026-09-09: without the ISO string here,
  // the model had nothing but the bare spoken phrase ("Thursday 9:00 AM")
  // to reconstruct a timestamp from on the next call — it kept rebuilding
  // "9:00 AM" as literal UTC ("...T09:00:00.000Z", 4 hours off from the
  // real America/Toronto instant this same response had just resolved),
  // so every subsequent attempt missed the real slot and the same three
  // "unavailable" alternatives kept coming back in an infinite loop. Since
  // the model already has the real instant right here, there is no reason
  // to make it redo that conversion itself.
  return (
    "That exact time isn't available. Real open times instead (say the spoken part to the lead; if they pick one, call book_appointment directly with its exact isoTime value, copied verbatim — do not recompute a timestamp from the spoken time yourself): " +
    alternatives.map((s) => `{spoken: "${formatSpoken(s, timeZone)}", isoTime: "${new Date(s).toISOString()}"}`).join(", ") +
    "."
  );
}

/**
 * The ONLY function in this file that creates a real GHL appointment.
 * Takes an exact isoTime — never a bare "2pm"-style guess — since the
 * model is expected to have already gotten it from check_availability
 * (either as the confirmed exact match, or as one of the real
 * alternatives). Re-validates against the LIVE calendar right before
 * creating, since time has passed since that earlier check and the slot
 * could theoretically have been taken in the meantime.
 *
 * Returns `{success: false, ...}` (not an exception) for "the slot's gone"
 * — this is a real, if rare, possible outcome, not a bug — and the router
 * below turns that into an HTTP error status so Vapi's own `messages`
 * config never fires request-complete (the "you're booked!" line) for a
 * booking that didn't actually happen. Only a genuine `success: true`
 * ever reaches that guarantee.
 */
async function handleBookAppointment(
  clientId: string,
  contactId: string,
  calendarId: string,
  intent: string,
  isoTime: unknown,
  leadSummary: string,
  conversationNotes: unknown
): Promise<{ result: string; success: boolean }> {
  if (typeof isoTime !== "string" || !isoTime) {
    return {
      success: false,
      result:
        "No isoTime was given — this is an error in how you called the tool, not a real availability problem. " +
        "Call check_availability first to get a real isoTime value, then call this tool with that exact value. " +
        "Do not tell the lead there's a technical issue.",
    };
  }
  const requested = new Date(isoTime);
  if (Number.isNaN(requested.getTime())) {
    return {
      success: false,
      result: `"${isoTime}" is not a valid timestamp — this is an error in how you called the tool. Call check_availability again and use its exact isoTime value verbatim, not a recomputed one. Do not tell the lead there's a technical issue.`,
    };
  }

  const ghlConfig = await getGhlConfig(clientId);
  const config = loadIrisConfig(clientId);
  if (!ghlConfig || !config) {
    return { success: false, result: "Could not reach the calendar right now — tell the lead a teammate will confirm a time directly." };
  }

  const live = await fetchLiveSlots(clientId, calendarId, config.timezone);
  if (!live) {
    return { success: false, result: "Could not reach the calendar right now — tell the lead a teammate will confirm a time directly." };
  }
  const { timeZone, allSlots } = live;

  const exactMatch = allSlots.find((s) => new Date(s).getTime() === requested.getTime());
  if (!exactMatch) {
    return {
      success: false,
      result:
        "That exact time is no longer available — it may have just been taken. Do not claim it's booked. Call " +
        "check_availability again for a fresh real time to offer instead.",
    };
  }

  const endTime = new Date(new Date(exactMatch).getTime() + APPOINTMENT_DURATION_MINUTES * 60_000).toISOString();
  // Mark's request, 2026-09-08: a booked appointment only ever carried a
  // generic "Booked automatically..." note — no lead details at all.
  // leadSummary is baked in at call-placement time from what's already
  // known (see calling.ts's buildAppointmentLeadSummary) — never left to
  // the model to retype. conversationNotes is an OPTIONAL model-supplied
  // sentence for whatever came up fresh during THIS call (a correction,
  // something specific mentioned) — appended, not trusted as the whole
  // note, since it's free text from the model rather than a structured
  // fact eden-os already tracked.
  const notes = [
    "Booked automatically by Iris during a live call.",
    leadSummary || null,
    typeof conversationNotes === "string" && conversationNotes.trim() ? conversationNotes.trim() : null,
  ]
    .filter(Boolean)
    .join(" ");
  try {
    await createAppointment(
      calendarId,
      {
        contactId,
        startTime: exactMatch,
        endTime,
        title: `${intent === "seller" ? "Seller" : "Buyer"} callback`,
        notes,
      },
      ghlConfig.locationId,
      ghlConfig.apiKey
    );
  } catch (error) {
    console.error(`[VAPI-TOOLS] createAppointment failed for ${clientId}/${contactId}:`, error instanceof Error ? error.message : error);
    return { success: false, result: "That time showed as open but the booking failed — do not claim it's booked. Tell the lead a teammate will confirm directly instead." };
  }
  return {
    success: true,
    result: `Booked for ${formatSpoken(exactMatch, timeZone)}. Vapi will confirm this to the lead automatically — you don't need to repeat it yourself.`,
  };
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

/**
 * Same shape as createToolHandler, except the handler reports success/
 * failure per call and this reflects that in the HTTP status — 200 only
 * when every call in the batch genuinely succeeded, else 409. That status
 * is the ONLY signal Vapi's own `messages: [{type: "request-complete"}]`
 * config (see book_appointment's wiring in calling.ts) uses to decide
 * whether to speak its guaranteed confirmation — a 200 on a call that
 * didn't actually book anything would make Vapi tell the lead they're
 * booked when they're not. In practice a batch is virtually always exactly
 * one call, so "any failure fails the batch" doesn't discard information a
 * real multi-call batch would need — Vapi still gets each call's own
 * result text either way, this only changes the outer status code.
 */
function createBookAppointmentHandler(handler: (query: Record<string, string>, call: ToolCall) => Promise<{ result: string; success: boolean }>) {
  return async (req: Request, res: Response) => {
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (secret && !verifyVapiSecret(secret, req)) {
      console.warn("[VAPI-TOOLS] Invalid or missing X-Vapi-Secret header");
      return res.status(401).send("Invalid signature");
    }

    try {
      const toolCalls: ToolCall[] = req.body?.message?.toolCallList || [];
      const query = req.query as Record<string, string>;
      const outcomes = await Promise.all(
        toolCalls.map(async (call) => {
          const { result, success } = await handler(query, call);
          return { toolCallId: call.id, result, success };
        })
      );
      const allSucceeded = outcomes.length > 0 && outcomes.every((o) => o.success);
      res.status(allSucceeded ? 200 : 409).json({ results: outcomes.map(({ toolCallId, result }) => ({ toolCallId, result })) });
    } catch (error) {
      console.error("[VAPI-TOOLS] Error handling book_appointment call:", error);
      res.status(500).json({ results: [] });
    }
  };
}

export function createVapiToolsRouter(): Router {
  const router = Router();

  router.post(
    "/schedule-callback",
    createToolHandler(async (query, call) => handleScheduleCallback(query.clientId, query.contactId, parseToolArguments(call).callbackTime))
  );

  router.post(
    "/check-availability",
    createToolHandler(async (query, call) => handleCheckAvailability(query.clientId, query.calendarId, parseToolArguments(call).requestedTime))
  );

  router.post(
    "/book-appointment",
    createBookAppointmentHandler(async (query, call) =>
      handleBookAppointment(
        query.clientId,
        query.contactId,
        query.calendarId,
        query.intent,
        parseToolArguments(call).isoTime,
        query.leadSummary,
        parseToolArguments(call).conversationNotes
      )
    )
  );

  return router;
}
