/**
 * Iris's text-channel qualification — Mark's confirmed scope, 2026-09-23:
 * "Full qualification via text," the same real depth as a live call, not
 * just a sentiment classifier (contrast agents/quarry/outreach.ts's
 * handleReply and agents/ember/webhooks.ts's emberHandleInboundMessage,
 * which only classify positive/negative/unclear).
 *
 * Entry point mirrors emberHandleInboundMessage's own shape on purpose —
 * webhooks/ghl-webhook.ts's /message route tries this FIRST (3% Realty is
 * Iris's live client today), then falls through to Ember unchanged if this
 * returns false. Self-scoped the same way Ember's handler is: a contact
 * with no iris_pending_calls row at all, or one already resolved, is simply
 * not Iris's to answer, and the caller falls through.
 */
import { query } from "../../shared/db";
import { NormalisedLead, buildKeyToId } from "../scout/intake";
import { loadIrisConfig, loadClientBranding } from "./index";
import { buildSmsQualificationPrompt } from "./scripts";
import { classifyInboundText } from "./text-signals";
import { IrisConfig, qualify, QualificationAnswers } from "./qualification";
import { clampToLegalCallingWindow } from "./cadence";
import { lastEmberTouchText } from "../ember/store";
import { chatWithTools, ChatMessage, ToolDef } from "../../shared/claude";
import { loadHistory, appendHistory } from "../../shared/conversation-memory";
import { sendMessage } from "../../shared/slack";
import { getGhlConfig, getLocationTimezone, getCustomFieldDefs, updateContact, addContactTags, sendSMS } from "../../shared/ghl";

const AGENT_ID = "iris";

// Same bounded round-trip cap as BaseAgent.runToolLoop (agents/base-agent.ts)
// — this loop isn't a BaseAgent (no Slack channel/thread, replies go out as
// SMS instead), so it can't reuse that method directly, but the same "don't
// let a confused model loop forever" reasoning applies here too.
const MAX_SMS_TOOL_TURNS = 6;

// Same env var/default as webhooks/vapi-webhook.ts's CALL_LOG_CHANNEL — kept
// as a separate local copy rather than importing across that boundary, same
// reasoning text-signals.ts already gives for its own local MIN_MINUTES_OUT
// copy: both name the same real Slack channel, but there's no shared owner
// worth introducing an import for.
const CALL_LOG_CHANNEL = process.env.IRIS_CALL_LOG_CHANNEL || "iris-call-logs";

function historyKey(clientId: string, contactId: string): string {
  return `sms:${clientId}:${contactId}`;
}

interface IrisLeadRow {
  client_id: string;
  contact_id: string;
  lead: NormalisedLead;
  status: string;
  /** 'ember' for an old lead Ember handed over; null for normal intake. */
  source: string | null;
}

async function loadIrisLeadRow(contactId: string): Promise<IrisLeadRow | null> {
  const rows = await query<IrisLeadRow>(
    `SELECT client_id, contact_id, lead, status, source FROM iris_pending_calls WHERE contact_id = $1 LIMIT 1`,
    [contactId]
  );
  return rows[0] ?? null;
}

/** Ends the calling sequence outright — a concluded text exchange (opted out or handed off) is not "gone cold," it's actually done. */
async function finishIrisLead(clientId: string, contactId: string, reason: string): Promise<void> {
  await query(
    `UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = $3, resolved_at = now() WHERE client_id = $1 AND contact_id = $2`,
    [clientId, contactId, reason]
  );
}

/**
 * Mark's instruction, 2026-09-25: never reply instantly — "so the lead
 * would not think they are chatting to an automation. Just like a human
 * taking some time to read and type." Applies to EVERY reply Iris sends
 * over text, not just a subset of leads. At least 30s, plus a little per
 * character (typing time, capped so a long reply doesn't take forever),
 * plus random jitter so the gap is never identical twice.
 *
 * Measured from when the lead's text ARRIVED (receivedAt), not from when
 * this function started running — a reply that took a while to generate
 * (a slow model call, a retry) shouldn't stack its own delay on top of
 * time that's already passed.
 */
const HUMAN_REPLY_MIN_MS = 30_000;
const HUMAN_TYPING_MS_PER_CHAR = 50; // ~1s per 20 characters
const HUMAN_TYPING_MAX_MS = 15_000;
const HUMAN_JITTER_MS = 10_000;

export function humanReplyDelayMs(
  receivedAt: Date,
  reply: string,
  now: Date = new Date(),
  random: () => number = Math.random
): number {
  const typing = Math.min(reply.length * HUMAN_TYPING_MS_PER_CHAR, HUMAN_TYPING_MAX_MS);
  const target = HUMAN_REPLY_MIN_MS + typing + Math.floor(random() * HUMAN_JITTER_MS);
  return Math.max(0, target - (now.getTime() - receivedAt.getTime()));
}

export interface InboundSmsOptions {
  /** When the lead's text arrived (GHL's dateAdded). Defaults to now — the webhook path. */
  receivedAt?: Date;
  /** Injected so tests don't actually wait. */
  wait?: (ms: number) => Promise<void>;
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SMS_TOOLS: ToolDef[] = [
  {
    name: "save_qualification_notes",
    description:
      "Saves a structured qualification summary to the CRM, visible to whoever picks up this lead. Call this ONCE, right before request_human_followup — after every question has been asked or declined, so the summary reflects everything actually gathered this conversation, never invented or guessed.",
    input_schema: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description:
            "A concise, structured note using ONLY information actually collected this conversation — line-per-fact, never a field that wasn't actually provided (leave it out rather than guessing).",
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "request_human_followup",
    description:
      "Ends this qualification conversation and hands the lead to a real team member to book a time — texting can't book or transfer live, so this is how a text conversation actually concludes. Call this ONCE, after save_qualification_notes.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One or two sentences a teammate can read at a glance — who this is and what they want.",
        },
      },
      required: ["summary"],
    },
  },
];

/**
 * Offered only when config.smsCallHandoff is on (Mark, 2026-09-24: the goal
 * for a lead who qualifies by text is a live transfer, not a human booking
 * later). The model supplies the answers it collected; the QUALIFIED-OR-NOT
 * decision is made here by the same qualify() voice calls use, never by the
 * model — so a lead is scored identically whether they answered on the
 * phone or by text.
 */
const SCHEDULE_TRANSFER_CALL_TOOL: ToolDef = {
  name: "schedule_transfer_call",
  description:
    "Queues a phone call from Iris to this lead so they can be live-transferred to an agent. Call ONCE, after save_qualification_notes and after the lead has said when they can talk. Returns whether the call was scheduled and exactly what to text back.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["buyer", "seller", "downsize", "upgrading", "unknown"] },
      area: { type: ["string", "null"], description: "Area/neighbourhood they named, or null if not given." },
      propertyDetails: { type: ["string", "null"], description: "Property type + beds/baths, or null." },
      timeline: { type: ["string", "null"], description: "Their timeline in their own words, or null." },
      budget: { type: ["string", "null"], description: "Budget/price range, or null." },
      financing: {
        type: ["string", "null"],
        enum: ["cash", "pre-approved", "in-progress", "not-approved", null],
        description: "Buyers only. null if not given or seller.",
      },
      when: {
        type: "string",
        description: 'Either "now", or an ISO 8601 timestamp WITH timezone offset for the time they asked for.',
      },
    },
    required: ["intent", "when"],
  },
};

/** Earliest a "now" call goes out — long enough for the confirmation text to land first. */
const TRANSFER_CALL_MIN_DELAY_MINUTES = 2;
const TRANSFER_CALL_MAX_DAYS_OUT = 7;

async function scheduleTransferCall(
  clientId: string,
  contactId: string,
  config: IrisConfig,
  timezone: string,
  input: any
): Promise<string> {
  const answers: QualificationAnswers = {
    intent: ["buyer", "seller", "downsize", "upgrading"].includes(input?.intent) ? input.intent : "unknown",
    area: typeof input?.area === "string" && input.area.trim() ? input.area.trim() : null,
    propertyDetails: typeof input?.propertyDetails === "string" && input.propertyDetails.trim() ? input.propertyDetails.trim() : null,
    timeline: typeof input?.timeline === "string" && input.timeline.trim() ? input.timeline.trim() : null,
    budget: typeof input?.budget === "string" && input.budget.trim() ? input.budget.trim() : null,
    financing: ["cash", "pre-approved", "in-progress", "not-approved"].includes(input?.financing) ? input.financing : null,
  };
  const result = qualify(config, answers);
  if (result.outcome !== "transfer") {
    return (
      `NOT scheduled — they aren't ready for an agent call yet (score ${result.score}, needs ${config.warmScoreThreshold}: ` +
      `${result.scoreReasons.join(", ") || "not enough information"}). Do not promise a call. ` +
      `Call request_human_followup instead and tell them someone from the team will follow up.`
    );
  }

  const now = Date.now();
  let when = new Date(now + TRANSFER_CALL_MIN_DELAY_MINUTES * 60_000);
  if (typeof input?.when === "string" && input.when.trim().toLowerCase() !== "now") {
    const asked = new Date(input.when);
    if (Number.isNaN(asked.getTime())) {
      return 'NOT scheduled — that time could not be read. Ask them again for a time, then call this tool with "now" or a full ISO 8601 timestamp.';
    }
    if (asked.getTime() - now > TRANSFER_CALL_MAX_DAYS_OUT * 86_400_000) {
      return `NOT scheduled — that's more than ${TRANSFER_CALL_MAX_DAYS_OUT} days out. Ask for a time within the next few days.`;
    }
    if (asked.getTime() > when.getTime()) when = asked;
  }
  // Never outside 8am–9pm local, same rule as every other Iris dial.
  when = clampToLegalCallingWindow(when, timezone);

  await query(
    `UPDATE iris_pending_calls
        SET call_after = $3, status = 'pending', is_explicit_callback = true, sms_scheduled = true,
            resolution_reason = 'qualified by text — live-transfer call scheduled', resolved_at = NULL
      WHERE client_id = $1 AND contact_id = $2`,
    [clientId, contactId, when]
  );

  const localTime = when.toLocaleString("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  await sendMessage(AGENT_ID, {
    channel: CALL_LOG_CHANNEL,
    text: `📞 Iris qualified a lead over text (score ${result.score}) and will call them ${localTime} for a live transfer — contact ${contactId}.`,
  }).catch((error) => {
    console.error(`[IRS-SMS] Failed to post transfer-call notice to Slack:`, error instanceof Error ? error.message : error);
  });

  const minutesOut = Math.round((when.getTime() - now) / 60_000);
  return minutesOut <= 10
    ? "Scheduled — Iris will call them in the next few minutes. Tell them to expect a call shortly from our team, then stop."
    : `Scheduled for ${localTime} (their local time). Confirm that time with them in one short text, then stop.`;
}

async function executeSmsTool(
  clientId: string,
  contactId: string,
  config: IrisConfig,
  ghlConfig: { locationId: string; apiKey: string },
  name: string,
  input: any,
  timezone: string
): Promise<string> {
  if (name === "schedule_transfer_call") {
    if (!config.smsCallHandoff) throw new Error("schedule_transfer_call is not enabled for this client");
    return scheduleTransferCall(clientId, contactId, config, timezone, input);
  }
  if (name === "save_qualification_notes") {
    const notes = typeof input?.notes === "string" ? input.notes.trim() : "";
    if (!notes) return "No notes were given — this is an error in how you called the tool. Compose the structured summary and call this tool again.";

    try {
      const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
      const fieldId = buildKeyToId(defs).get(config.callbackNotesFieldKey);
      if (!fieldId) {
        console.warn(`[IRS-SMS] callbackNotesFieldKey "${config.callbackNotesFieldKey}" did not resolve to a field id for ${clientId} — skipping.`);
        return "Could not reach the CRM right now — continue normally, a teammate will fill this in directly.";
      }
      await updateContact(contactId, { customFields: [{ id: fieldId, value: notes }] }, ghlConfig.locationId, ghlConfig.apiKey);
    } catch (error) {
      console.error(`[IRS-SMS] Failed to write qualification notes for ${contactId}:`, error instanceof Error ? error.message : error);
      return "Could not reach the CRM right now — continue normally, a teammate will fill this in directly.";
    }
    return "Notes saved. Continue normally — no need to mention this to the lead.";
  }

  if (name === "request_human_followup") {
    const summary = typeof input?.summary === "string" && input.summary.trim() ? input.summary.trim() : "(no summary given)";

    await addContactTags(contactId, ["iris sms qualified"], ghlConfig.locationId, ghlConfig.apiKey).catch((error) => {
      console.error(`[IRS-SMS] Failed to tag contact ${contactId}:`, error instanceof Error ? error.message : error);
    });
    await finishIrisLead(clientId, contactId, "qualified via text — handed off for human follow-up");
    await sendMessage(AGENT_ID, {
      channel: CALL_LOG_CHANNEL,
      text: `💬 Iris qualified a lead over text and needs a human to book them:\n${summary}`,
    }).catch((error) => {
      console.error(`[IRS-SMS] Failed to post handoff to Slack:`, error instanceof Error ? error.message : error);
    });

    return "Handed off to the team. Tell the lead briefly that someone will reach out to book a time — never promise a specific time yourself — then stop.";
  }

  throw new Error(`Unknown SMS tool: ${name}`);
}

/**
 * An inbound SMS from a contact. Returns true if Iris handled it (whether
 * or not she actually replied — an opt-out is still "handled"), false if
 * this contact isn't Iris's to answer at all, so the caller can fall
 * through to Ember.
 */
export async function irisHandleInboundSms(contactId: string, text: string, options: InboundSmsOptions = {}): Promise<boolean> {
  const receivedAt = options.receivedAt ?? new Date();
  const wait = options.wait ?? realWait;
  const pauseLikeAHuman = (reply: string) => wait(humanReplyDelayMs(receivedAt, reply));

  const row = await loadIrisLeadRow(contactId);
  if (!row) return false;
  // Already resolved (exhausted, qualified by voice or a human, opted out,
  // etc.) — not this contact's first real text exchange with Iris. Falls
  // through rather than reopening a concluded lead on an unrelated text.
  if (row.status !== "pending") return false;

  const clientId = row.client_id;
  const config = loadIrisConfig(clientId);
  const branding = loadClientBranding(clientId);
  if (!config || !branding) return false;

  const ghlConfig = await getGhlConfig(clientId).catch(() => null);
  if (!ghlConfig) return false;

  const timezone = (await getLocationTimezone(ghlConfig.locationId, ghlConfig.apiKey).catch(() => null)) || config.timezone || "America/St_Johns";

  // Same conservative opt-out classifier dial-pending.ts already uses
  // pre-dial — a clear "stop texting/calling me" ends things outright here
  // too, rather than the qualification loop trying to talk them out of it.
  const signal = await classifyInboundText(text, new Date(), timezone);
  if (signal.type === "opt_out") {
    await finishIrisLead(clientId, contactId, "lead opted out via text — cadence stopped");
    await addContactTags(contactId, ["do not call"], ghlConfig.locationId, ghlConfig.apiKey).catch((error) => {
      console.error(`[IRS-SMS] Failed to tag contact ${contactId} as "do not call":`, error instanceof Error ? error.message : error);
    });
    const reply = "No problem — we won't reach out again. Take care!";
    await pauseLikeAHuman(reply);
    await sendSMS(contactId, reply, ghlConfig.locationId, ghlConfig.apiKey).catch((error) => {
      console.error(`[IRS-SMS] Failed to send opt-out acknowledgment to ${contactId}:`, error instanceof Error ? error.message : error);
    });
    const key = historyKey(clientId, contactId);
    await appendHistory(AGENT_ID, key, "user", text).catch(() => {});
    await appendHistory(AGENT_ID, key, "assistant", reply).catch(() => {});
    return true;
  }

  const key = historyKey(clientId, contactId);
  const history = await loadHistory(AGENT_ID, key).catch((error) => {
    console.error(`[IRS-SMS] Failed to load conversation history for ${contactId}:`, error instanceof Error ? error.message : error);
    return [] as ChatMessage[];
  });

  const fromEmber = row.source === "ember";
  const openerText = fromEmber ? await lastEmberTouchText(clientId, contactId).catch(() => null) : null;
  const systemPrompt = buildSmsQualificationPrompt(config, row.lead, branding.brandName, branding.city, {
    origin: fromEmber ? "ember" : "form",
    openerText,
    callHandoff: config.smsCallHandoff,
  });
  const tools = config.smsCallHandoff ? [...SMS_TOOLS, SCHEDULE_TRANSFER_CALL_TOOL] : SMS_TOOLS;

  let working: ChatMessage[] = [...history, { role: "user", content: text }];
  let finalText = "";

  for (let turn = 0; turn < MAX_SMS_TOOL_TURNS; turn++) {
    const response = await chatWithTools(systemPrompt, working, tools, { maxTokens: 512, temperature: 0.6 });
    working = [...working, { role: "assistant", content: response.content }];

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    finalText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const call = tu as { id: string; name: string; input: any };
        let content: string;
        try {
          content = await executeSmsTool(clientId, contactId, config, ghlConfig, call.name, call.input, timezone);
        } catch (error) {
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return { type: "tool_result" as const, tool_use_id: call.id, content };
      })
    );
    working = [...working, { role: "user", content: toolResults }];
  }

  const reply = finalText || "Thanks — someone from our team will follow up with you shortly.";

  await pauseLikeAHuman(reply);
  await sendSMS(contactId, reply, ghlConfig.locationId, ghlConfig.apiKey).catch((error) => {
    console.error(`[IRS-SMS] Failed to send reply to ${contactId}:`, error instanceof Error ? error.message : error);
  });

  await appendHistory(AGENT_ID, key, "user", text).catch((error) => {
    console.error(`[IRS-SMS] Failed to persist inbound text for ${contactId}:`, error instanceof Error ? error.message : error);
  });
  await appendHistory(AGENT_ID, key, "assistant", reply).catch((error) => {
    console.error(`[IRS-SMS] Failed to persist reply for ${contactId}:`, error instanceof Error ? error.message : error);
  });

  return true;
}

/**
 * Read-only check for dial-pending.ts's pause-calling gate: is there an
 * ongoing text exchange with this lead at all? A non-empty history under
 * this contact's sms: key means irisHandleInboundSms has actually run for
 * them at least once — distinct from lastInboundText's raw GHL read, which
 * fires on ANY inbound text regardless of whether a real qualification
 * exchange ever started.
 */
export async function hasActiveSmsConversation(clientId: string, contactId: string): Promise<boolean> {
  const history = await loadHistory(AGENT_ID, historyKey(clientId, contactId), 1).catch(() => []);
  return history.length > 0;
}
