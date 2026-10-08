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
import { ChatMessage, chatWithTools, ToolDef } from "../../shared/claude";
import { appendHistory, loadHistory } from "../../shared/conversation-memory";
import { IrisConfig, qualify, QualificationAnswers } from "../iris/qualification";
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
  sendSMS(contactId: string, text: string): Promise<unknown>;
  /** Waits the human-like gap before a reply (iris/sms humanReplyDelayMs). */
  pauseLikeAHuman(reply: string): Promise<void>;
  /** Writes the qualification summary to the contact's notes field. */
  saveNotes(contactId: string, notes: string): Promise<boolean>;
  /** Queues Iris's live-transfer call (store.upsertIrisHandoff, sms_scheduled). */
  queueIrisCall(lead: NurtureLead, answers: QualificationAnswers, when: Date): Promise<void>;
  /** Ember-row state changes (store.updateLead). */
  updateLead(id: number, patch: Record<string, unknown>): Promise<void>;
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
      "Queues a phone call to this lead from our team so they can be connected live with an agent. Call ONCE, after save_qualification_notes and after they've said when they can talk. It checks whether they're ready for an agent call and tells you exactly what to text next.",
    input_schema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["buyer", "seller", "downsize", "upgrading", "unknown"] },
        area: { type: ["string", "null"] },
        propertyDetails: { type: ["string", "null"], description: "Home type + beds/baths, or null." },
        timeline: { type: ["string", "null"], description: "Their timeline in their own words, or null." },
        budget: { type: ["string", "null"] },
        financing: { type: ["string", "null"], enum: ["cash", "pre-approved", "in-progress", "not-approved", null] },
        when: { type: "string", description: 'Either "now", or an ISO 8601 timestamp WITH timezone offset for the time they asked for.' },
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
- Outside ${ctx.city}: "${EDGE_CASE_RESPONSES.outOfServiceArea(ctx.city)[0]}"

## Ending
Once the questions are answered (or they've declined some):
1. save_qualification_notes.
2. Ask if now is a good time for a quick call with one of our agents — or when works better today or tomorrow.
3. When they answer, schedule_transfer_call with their answers and "now" or the time they gave. It decides whether they're ready for an agent and tells you what to text — follow it exactly.
4. If they aren't ready for a call or don't want one: request_human_followup, tell them someone from the team will follow up, and stop.
Never call a tool twice, never promise a call before schedule_transfer_call confirms it.`;
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
  const result = qualify(ctx.irisConfig, answers);
  if (result.outcome !== "transfer") {
    return (
      `NOT scheduled — they aren't ready for an agent call yet (score ${result.score}, needs ${ctx.irisConfig.warmScoreThreshold}). ` +
      `Do not promise a call. Call request_human_followup, and tell them someone from the team will follow up.`
    );
  }

  let when = new Date(now.getTime() + CALL_MIN_DELAY_MINUTES * 60_000);
  const asked = str(input?.when);
  if (asked && asked.toLowerCase() !== "now") {
    const t = new Date(asked);
    if (Number.isNaN(t.getTime())) return 'NOT scheduled — that time could not be read. Ask again, then call this with "now" or a full ISO 8601 timestamp.';
    if (t.getTime() - now.getTime() > CALL_MAX_DAYS_OUT * DAY_MS) return `NOT scheduled — more than ${CALL_MAX_DAYS_OUT} days out. Ask for a time in the next few days.`;
    if (t.getTime() > when.getTime()) when = t;
  }
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
export async function emberConverse(
  lead: NurtureLead,
  text: string,
  ctx: ConversationContext,
  deps: ConversationDeps
): Promise<string | null> {
  const key = conversationKey(lead.clientId, lead.ghlContactId);
  const history = await deps.loadHistory(key).catch(() => [] as ChatMessage[]);
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
  await deps.sendSMS(lead.ghlContactId, reply);
  await deps.appendHistory(key, "user", text).catch(() => {});
  await deps.appendHistory(key, "assistant", reply).catch(() => {});
  return reply;
}
