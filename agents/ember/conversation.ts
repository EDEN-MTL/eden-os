/**
 * Ember's own text conversation with an old lead who replied to a
 * reactivation text. Mark, 2026-10-06: Ember replies itself — "the goal is
 * get their information if they have any plan to buy or sell, what would be
 * their timeline, budget, etc... see if they are qualified... hand the lead
 * over to Iris so Iris can call the lead for live transfer."
 *
 * So Ember owns the texting and Iris owns only the call:
 *   - Ember asks the client's own qualification questions (iris.
 *     qualificationQuestions in config — the same list Iris asks new leads),
 *     one per text, re-confirming buy/sell first since their plans are old.
 *   - Qualified-or-not is decided by Iris's qualify(), never by the model,
 *     so an old lead is scored exactly like a new one.
 *   - A qualified lead who says now (or a time) works gets an Iris call
 *     queued (iris_pending_calls, source 'ember', sms_scheduled) — Iris
 *     dials, opens with "following up on our text conversation", and
 *     live-transfers. Any later texts still come to Ember, not Iris.
 *
 * Clear "no"s never reach this module — status.ts / outreach.ts handle them
 * (Not Interested + one courtesy reply) before a model turn runs.
 */
import { serviceAreaRule } from "../iris/service-area";
import { ChatMessage, chatWithTools, ToolDef } from "../../shared/claude";
import { appendHistory, loadHistory } from "../../shared/conversation-memory";
import { callbackCalendarForIntent, IrisConfig, qualify, QualificationAnswers } from "../iris/qualification";
import { clampToLegalCallingWindow } from "../iris/cadence";
import { EDGE_CASE_RESPONSES, NATURAL_TRANSITIONS, expandBudgetShorthand } from "../iris/scripts";
import { AlertFn, formatReactivationAlert } from "./alerts";
import { EmberConfig } from "./config";
import { NurtureLead } from "./types";
import { fitOneSegment, smsSafe } from "./outreach";

export const EMBER_AGENT_ID = "ember";
const MAX_TOOL_TURNS = 6;
const CALL_MIN_DELAY_MINUTES = 2;
const CALL_MAX_DAYS_OUT = 7;
const DAY_MS = 86_400_000;

export function conversationKey(clientId: string, contactId: string): string {
  return `sms:${clientId}:${contactId}`;
}

/** What GHL already has on them, for "confirm, don't re-ask cold". */
export interface KnownAnswers {
  propertyInterest?: string | null;
  bedrooms?: string | null;
  timeline?: string | null;
  budget?: string | null;
  financing?: string | null;
}

export interface ConversationDeps {
  chat: typeof chatWithTools;
  loadHistory(key: string): Promise<ChatMessage[]>;
  appendHistory(key: string, role: "user" | "assistant", content: string): Promise<void>;
  /**
   * Sends one text to the lead this conversation is with. Takes ONLY the text: the dependency is already bound
   * to the lead. It used to take (contactId, text) while the real one took just (text), so every Ember reply
   * went out with the lead's contact id as its body (Marcia Wiseman, 2026-10-23: "oTCjDHG2AP4okGSGUsYs").
   */
  sendSMS(text: string): Promise<unknown>;
  /** Waits the human-like gap before a reply (iris/sms humanReplyDelayMs). */
  pauseLikeAHuman(reply: string): Promise<void>;
  /** Writes the qualification summary to the contact's notes field. */
  saveNotes(contactId: string, notes: string): Promise<boolean>;
  /** Queues Iris's live-transfer call (store.upsertIrisHandoff, sms_scheduled). */
  queueIrisCall(lead: NurtureLead, answers: QualificationAnswers, when: Date): Promise<void>;
  /** Ember-row state changes (store.updateLead). */
  updateLead(id: number, patch: Record<string, unknown>): Promise<void>;
  /** Real open times on an agent calendar (webhooks/vapi-tools handleCheckAvailability — same as Iris). */
  checkAvailability(calendarId: string, requestedTime: unknown): Promise<string>;
  /** Books a real appointment (handleBookAppointment — same as Iris). */
  bookAppointment(calendarId: string, intent: string, isoTime: unknown, notes: string): Promise<{ success: boolean; result: string }>;
  alert: AlertFn;
}

export interface ConversationContext {
  config: EmberConfig;
  irisConfig: IrisConfig;
  brandName: string;
  city: string;
  timezone: string;
  firstName: string;
  /** The reactivation text they're replying to. */
  opener: string | null;
  known: KnownAnswers;
  now?: Date;
}

const TOOLS: ToolDef[] = [
  {
    name: "save_qualification_notes",
    description:
      "Saves a short structured summary of what they told you to the CRM. Call it ONCE, right before schedule_transfer_call or request_human_followup — only facts they actually gave this conversation.",
    input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  },
  {
    name: "schedule_transfer_call",
    description:
      "ONLY when they're free to talk RIGHT NOW: queues an immediate call from our team that connects them live with an agent. Call ONCE, after save_qualification_notes. If they're not free right now, use check_availability and book_appointment instead.",
    input_schema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["buyer", "seller", "downsize", "upgrading", "unknown"] },
        area: { type: ["string", "null"] },
        propertyDetails: { type: ["string", "null"], description: "Home type + beds/baths, or null." },
        timeline: { type: ["string", "null"], description: "Their timeline in their own words, or null." },
        budget: { type: ["string", "null"] },
        financing: { type: ["string", "null"], enum: ["cash", "pre-approved", "in-progress", "not-approved", null], description: '"cash" also covers paying with savings or the money from selling their current home.' },
        when: { type: "string", enum: ["now"], description: 'Always "now" — a later time is booked with book_appointment.' },
      },
      required: ["intent", "when"],
    },
  },
  {
    name: "request_human_followup",
    description:
      "Hands the conversation to a human on the team — they're not ready for an agent call, they asked something you can't answer, or they'd rather not get a call. Call ONCE; then text them briefly that someone from the team will follow up, and stop.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
  {
    name: "pause_for_now",
    description:
      "They're interested but not now (e.g. 'reach out in the spring', 'after the holidays'). Pauses texting until then. Pass resumeInDays if they named a time; otherwise leave it out. Then text them a short, warm sign-off.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" }, resumeInDays: { type: "number" } },
      required: ["reason"],
    },
  },
];

const CHECK_AVAILABILITY_TOOL: ToolDef = {
  name: "check_availability",
  description:
    "Real open times for a call with one of our agents. Read-only — never books. Use as soon as they're not free right now: pass the day/time they mentioned, or if they didn't name one, tomorrow at 10:00. Returns that exact time if open, or the nearest real open times.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["buyer", "seller", "downsize", "upgrading"] },
      requestedTime: { type: "string", description: 'In THEIR local time, ISO 8601 WITHOUT an offset (e.g. "2026-11-12T14:30:00"), worked out from the current date/time at the top of your instructions.' },
    },
    required: ["intent", "requestedTime"],
  },
};

const BOOK_APPOINTMENT_TOOL: ToolDef = {
  name: "book_appointment",
  description:
    "Books the call with an agent as a real calendar appointment, for a time check_availability returned and they picked — pass its isoTime VERBATIM. Returns whether it was really booked.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["buyer", "seller", "downsize", "upgrading"] },
      isoTime: { type: "string", description: "The exact isoTime check_availability gave, copied verbatim." },
      notes: { type: "string", description: "One line for the agent: home type, area, timeline, budget, financing — only what they told you." },
    },
    required: ["intent", "isoTime"],
  },
};

TOOLS.push(CHECK_AVAILABILITY_TOOL, BOOK_APPOINTMENT_TOOL);

export function buildEmberSmsPrompt(ctx: ConversationContext): string {
  const k = ctx.known;
  const known: string[] = [];
  if (k.propertyInterest) known.push(`home type: ${k.propertyInterest}`);
  if (k.bedrooms) known.push(`bedrooms: ${k.bedrooms}`);
  if (k.timeline) known.push(`timeline: ${k.timeline}`);
  if (k.budget) known.push(`budget: ${expandBudgetShorthand(k.budget)}`);
  if (k.financing) known.push(`financing: ${k.financing}`);
  const name = ctx.firstName !== "there" ? ctx.firstName : "the lead";

  return `You are texting ${name} on behalf of ${ctx.brandName}, a real estate team in ${ctx.city}. This is a REAL text conversation. ${name} inquired with us a while ago, went quiet, and has just replied to a check-in text we sent${ctx.opener ? `: "${ctx.opener}"` : ""}.

## Your goal
Find out whether they still plan to buy or sell, and if so qualify them so one of our agents can talk to them live by phone. Their plans may have changed since they first reached out — confirm whether they're still thinking about buying or selling BEFORE anything else, and treat anything we knew months ago as possibly out of date.

## How to text
Short — one or two sentences, like a real person texting, never a paragraph. Every text under 160 characters (that's one SMS; longer bills as 2-3). ONE question per text, then wait. Warm and casual, not a script. Vary acknowledgments (${NATURAL_TRANSITIONS.sms.map((t) => `"${t}"`).join(", ")}). No links, no prices or market claims, never invent listings or availability. Plain characters only: a normal hyphen "-" (never a long dash), straight quotes, no emoji, no extra spaces or filler words — special characters make the text bill as 2-3 messages.

## What we may already know (possibly stale — confirm in passing, never re-ask cold)
${known.length ? known.map((x) => `- ${x}`).join("\n") : "- nothing on file"}

## Questions to work through, one at a time, in your own words
${ctx.irisConfig.questions.map((q) => `- ${q}`).join("\n")}

## Situations
- Asked if you're a real person / a bot: "I'm the ${ctx.brandName} team's virtual assistant — happy to get one of our agents on the phone with you."
- Already working with an agent: "${EDGE_CASE_RESPONSES.buyerHasAgent[0]}"
- Not pre-approved yet: "${EDGE_CASE_RESPONSES.notPreApproved[0]}"
- Interested but not now: use pause_for_now, then a short warm sign-off.
- A question you can't answer (prices, specific homes, legal/financial advice): "${EDGE_CASE_RESPONSES.dontKnowAnswer}", and request_human_followup.
- ${serviceAreaRule(ctx.city, ctx.irisConfig.serviceArea, EDGE_CASE_RESPONSES.outOfServiceArea(ctx.city)[0])}

## Ending
Once the questions are answered (or they've declined some):
1. save_qualification_notes.
2. Ask if now is a good time for a quick call with one of our agents.
3. Free RIGHT NOW: schedule_transfer_call with "now", and follow what it tells you to text.
4. NOT free right now, for any reason (busy, out, at work, "tomorrow"): don't hand off — right away offer to book a call with one of our agents. Call check_availability (the day/time they mentioned, or tomorrow 10:00 if they didn't say), then text them 2-3 of the real open times it returns as a short choice ("I can book you with one of our agents - Tue 2:30pm or 3:00pm?"). When they pick one, book_appointment with its exact isoTime and send one short confirmation.
5. If none of the times work, check_availability again for what they suggest. If there's no calendar, the booking fails twice, or they don't want a call at all: request_human_followup, tell them someone from the team will follow up, and stop.
Once booked, never book again — if they want a different time, request_human_followup. Never offer a time check_availability didn't give you, never say they're booked before book_appointment confirms it, never call schedule_transfer_call for a later time.`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Code, not the model, decides qualified-or-not — same qualify() as voice. */
async function scheduleTransferCall(lead: NurtureLead, input: any, ctx: ConversationContext, deps: ConversationDeps): Promise<string> {
  const now = ctx.now ?? new Date();
  const answers: QualificationAnswers = {
    intent: ["buyer", "seller", "downsize", "upgrading"].includes(input?.intent) ? input.intent : "unknown",
    area: str(input?.area),
    propertyDetails: str(input?.propertyDetails),
    timeline: str(input?.timeline),
    budget: str(input?.budget),
    financing: ["cash", "pre-approved", "in-progress", "not-approved"].includes(input?.financing) ? input.financing : null,
  };
  // No score bar (Mark, 2026-11-11): a lead still buying or selling who's
  // free to talk now gets the call. The score is kept for the alert and Iris.
  const result = qualify(ctx.irisConfig, answers);
  const asked = str(input?.when);
  if (asked && asked.toLowerCase() !== "now") {
    return "NOT scheduled — this is only for a call right now. For a later time, use check_availability and book_appointment.";
  }
  let when = new Date(now.getTime() + CALL_MIN_DELAY_MINUTES * 60_000);
  when = clampToLegalCallingWindow(when, ctx.timezone);

  await deps.queueIrisCall(lead, answers, when);
  await deps.updateLead(lead.id, { status: "handed_off", statusReason: `qualified by text (score ${result.score}) — call queued`, nextTouchAt: null });
  const local = when.toLocaleString("en-US", { timeZone: ctx.timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  try {
    await deps.alert(formatReactivationAlert(lead, `qualified over text (score ${result.score}) — our assistant will call ${local} for a live transfer`, ctx.brandName, now, "iris"));
  } catch (error) {
    console.error(`[EMB] call-queued alert failed for lead ${lead.id}:`, error);
  }
  const minutes = Math.round((when.getTime() - now.getTime()) / 60_000);
  return minutes <= 10
    ? "Scheduled — they'll get a call in the next few minutes. Tell them to expect a quick call from our team shortly, then stop."
    : `Scheduled for ${local} their time. Confirm that time in one short text, then stop.`;
}

/** Which agent calendar a lead is booked on: ember.bookingCalendarIds, else Iris's callback calendars. */
export function bookingCalendarFor(ctx: ConversationContext, intent: string): string | null {
  const own = ctx.config.bookingCalendarIds;
  if (intent === "seller" || intent === "downsize") return own?.seller || callbackCalendarForIntent(ctx.irisConfig, "seller");
  if (intent === "buyer" || intent === "upgrading") return own?.buyer || callbackCalendarForIntent(ctx.irisConfig, "buyer");
  return null;
}

/**
 * Booking a call with an agent for a lead who isn't free right now (Mark,
 * 2026-11-11 — Eileen Hillier said "not now, tomorrow around 2:30" and got
 * only "someone will follow up"). Same live-calendar check and booking Iris
 * uses on calls and by text.
 */
async function bookingTool(name: string, lead: NurtureLead, input: any, ctx: ConversationContext, deps: ConversationDeps): Promise<string> {
  const intent = ["buyer", "seller", "downsize", "upgrading"].includes(input?.intent) ? input.intent : lead.intent;
  const calendarId = bookingCalendarFor(ctx, intent);
  if (!calendarId) return "There's no agent calendar set up to book on — don't offer times. Call request_human_followup so a teammate books them.";
  if (name === "check_availability") return deps.checkAvailability(calendarId, input?.requestedTime);

  const notes = str(input?.notes) ?? "";
  const outcome = await deps.bookAppointment(calendarId, intent, input?.isoTime, notes);
  if (!outcome.success) return outcome.result.replace(/Do not tell the lead there's a technical issue\.?/g, "");
  const when = outcome.result.match(/^Booked for (.+?)\. /)?.[1] ?? "the time you agreed";
  await deps.updateLead(lead.id, { status: "handed_off", statusReason: `booked a call with an agent for ${when}`, nextTouchAt: null });
  try {
    await deps.alert(formatReactivationAlert(lead, `booked a call with an agent over text for ${when}`, ctx.brandName, ctx.now ?? new Date(), "human"));
  } catch (error) {
    console.error(`[EMB] booking alert failed for lead ${lead.id}:`, error);
  }
  return `Booked for ${when} — a real appointment. Send ONE short text confirming it ("You're all set for ${when} - one of our agents will call you then.") and stop. Never mention a different time.`;
}

async function runTool(name: string, input: any, lead: NurtureLead, ctx: ConversationContext, deps: ConversationDeps): Promise<string> {
  const now = ctx.now ?? new Date();
  switch (name) {
    case "save_qualification_notes": {
      const notes = str(input?.notes);
      if (!notes) return "No notes given — compose the summary and call again.";
      return (await deps.saveNotes(lead.ghlContactId, notes)) ? "Notes saved. Carry on; don't mention it." : "Couldn't reach the CRM — carry on normally.";
    }
    case "schedule_transfer_call":
      return scheduleTransferCall(lead, input, ctx, deps);
    case "check_availability":
    case "book_appointment":
      return bookingTool(name, lead, input, ctx, deps);
    case "request_human_followup": {
      const summary = str(input?.summary) ?? "(no summary)";
      await deps.updateLead(lead.id, { status: "replied", statusReason: `needs a human: ${summary.slice(0, 160)}`, nextTouchAt: null });
      try {
        await deps.alert(formatReactivationAlert(lead, `texted with Ember and needs a human to follow up — ${summary}`, ctx.brandName, now));
      } catch (error) {
        console.error(`[EMB] human-followup alert failed for lead ${lead.id}:`, error);
      }
      return "Handed to the team. Tell them briefly someone will follow up — never promise a time — then stop.";
    }
    case "pause_for_now": {
      const days = typeof input?.resumeInDays === "number" && input.resumeInDays >= 7 && input.resumeInDays <= 365
        ? Math.round(input.resumeInDays)
        : ctx.config.reApproachAfterDays;
      const until = new Date(now.getTime() + days * DAY_MS);
      await deps.updateLead(lead.id, {
        status: "nurturing",
        touchCount: 0,
        nextTouchAt: until.toISOString(),
        statusReason: `paused until ${until.toISOString().slice(0, 10)}: ${str(input?.reason) ?? "not now"}`,
      });
      return `Paused until ${until.toISOString().slice(0, 10)}. Send a short, warm sign-off and stop.`;
    }
    default:
      throw new Error(`Unknown Ember SMS tool: ${name}`);
  }
}

/**
 * One reply turn: the lead's text in, Ember's reply out (sent after the
 * human-like pause). Returns the reply sent, or null if none was.
 */
/** Ember replies in one conversation before it hands the lead to a person. */
export const MAX_EMBER_REPLIES = 15;

export async function emberConverse(
  lead: NurtureLead,
  text: string,
  ctx: ConversationContext,
  deps: ConversationDeps
): Promise<string | null> {
  const key = conversationKey(lead.clientId, lead.ghlContactId);
  const history = await deps.loadHistory(key).catch(() => [] as ChatMessage[]);
  // Qualifying takes 6-8 texts. Far past that, something's off — an
  // auto-responder texting back, or a lead Ember can't satisfy — and more
  // automated texts make it worse (Mark, 2026-10-09: pause and fix itself).
  const repliesSoFar = history.filter((m) => m.role === "assistant").length;
  if (repliesSoFar >= MAX_EMBER_REPLIES) {
    await deps.updateLead(lead.id, { status: "replied", statusReason: `long conversation (${repliesSoFar} Ember replies) — handed to a person`, nextTouchAt: null });
    await deps.alert(`💬 Ember has sent *${lead.contactName ?? lead.ghlContactId}* ${repliesSoFar} replies without wrapping up, so it stopped texting them. Latest from them: "${text.slice(0, 200)}" — please take it from here in GHL.`).catch(() => {});
    return null;
  }
  if (lead.status !== "conversing" && lead.status !== "handed_off") {
    await deps.updateLead(lead.id, { status: "conversing", statusReason: "texting with Ember", nextTouchAt: null });
  }

  const system = buildEmberSmsPrompt(ctx);
  let working: ChatMessage[] = [...history, { role: "user", content: text }];
  let reply = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await deps.chat(system, working, TOOLS, { maxTokens: 512, temperature: 0.6 });
    working = [...working, { role: "assistant", content: response.content }];
    reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const uses = response.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: any }[];
    if (response.stop_reason !== "tool_use" || uses.length === 0) break;
    const results = [];
    for (const u of uses) {
      let content: string;
      try {
        content = await runTool(u.name, u.input, lead, ctx, deps);
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      results.push({ type: "tool_result" as const, tool_use_id: u.id, content });
    }
    working = [...working, { role: "user", content: results }];
  }

  // A model turn that produced no text sends nothing — silence beats a
  // canned line a human would never have written.
  if (!reply) {
    await deps.appendHistory(key, "user", text).catch(() => {});
    return null;
  }
  reply = fitOneSegment(smsSafe(reply));
  await deps.pauseLikeAHuman(reply);
  await deps.sendSMS(reply);
  await deps.appendHistory(key, "user", text).catch(() => {});
  await deps.appendHistory(key, "assistant", reply).catch(() => {});
  return reply;
}
