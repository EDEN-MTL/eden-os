import Anthropic from "@anthropic-ai/sdk";
import { ChatMessage, ToolDef } from "../../../shared/claude";
import { APPOINTMENT_COLUMNS, ColumnKey, HomeServicesConfig, Language } from "./config";
import { LeadInfo, buildSummaryNote, columnForVisit, mergeInfo, missingRequired } from "./lead-info";
import { AlertKind, formatAlert, formatIsaNotes } from "./notify";
import { isTooLong, SHORTEN_SYSTEM, tidyReply } from "./reply-style";
import { firstNameOf, firstTouchText, followupText, FOLLOWUP_STEPS, isOptOut, optOutConfirmationText } from "./messages";
import { buildSystemPrompt, ThreadText } from "./prompt";
import { zonedHourToUtc } from "../cadence";
import { clampToSendWindow } from "./quiet-hours";
import { HsLead, HsStore } from "./store";

/**
 * The conversation core. Everything that touches the outside world comes in through HsDeps, so the
 * same code runs against real GHL/Slack/Claude in production, against recorded drafts in dry-run,
 * and against in-memory fakes in tests and the offline simulation.
 */
export interface HsDeps {
  config: HomeServicesConfig;
  store: HsStore;
  now(): Date;
  chat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<Anthropic.Message>;
  loadHistory(lead: HsLead): Promise<ChatMessage[]>;
  /** The lead's real text thread (oldest first), including what GHL's own automation already sent. */
  recentTexts(lead: HsLead): Promise<ThreadText[]>;
  appendHistory(lead: HsLead, role: "user" | "assistant", content: string): Promise<void>;
  ghl: {
    moveToColumn(lead: HsLead, stageId: string): Promise<void>;
    addTags(lead: HsLead, tags: string[]): Promise<void>;
    writeNote(lead: HsLead, body: string): Promise<void>;
    /** Fills the contact's "ISA Notes" custom field, which a GHL workflow texts to the owner. Must run BEFORE the move / tag that triggers it. */
    writeIsaNotes(lead: HsLead, text: string): Promise<void>;
    /** The stage the lead's card sits in right now, so Pedro moving it by hand is noticed. */
    currentStageId(lead: HsLead): Promise<string | null>;
  };
  alertOwner(text: string): Promise<void>;
  /** A teammate (Pedro) texting the lead means the conversation is his, not Iris's. */
  teammateIsTexting(lead: HsLead): Promise<boolean>;
}

const MAX_TOOL_TURNS = 6;
const REPLY_MIN_MS = 30_000;
const TYPING_MS_PER_CHAR = 50;
const TYPING_MAX_MS = 15_000;
const JITTER_MS = 10_000;

export const HS_TOOLS: ToolDef[] = [
  {
    name: "update_lead_info",
    description:
      "Records facts the lead has actually given you. Call this FIRST whenever the lead tells you anything (size, when they are free, address, name...). Only pass fields the lead really stated; never guess. Returns what is still missing before an appointment can be booked.",
    input_schema: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        street: { type: "string", description: "Street address, e.g. '1234 rue Beaubien'" },
        city: { type: "string", description: "Neighbourhood or city, e.g. 'Rosemont'" },
        postalCode: { type: "string" },
        service: { type: "string", description: "sanding/refinishing, installation, stairs, repair, other" },
        size: { type: "string", description: "Square footage, or number and type of rooms, in their words" },
        visitWindow: { type: "string", enum: ["morning", "afternoon", "evening", "anytime"], description: "When they are free for the in-person estimate. Morning/afternoon/anytime files as Loose Day, evening as Loose Night." },
        availabilityNotes: { type: "string", description: "Anything specific about when, as the lead said it: 'after 6pm', 'Saturdays only', 'Tuesday the 18th'" },
        timing: { type: "string", description: "When they want the work done, if they said" },
        phone: { type: "string" },
        language: { type: "string", enum: ["fr", "en"] },
        photosReceived: { type: "boolean" },
        woodType: { type: "string" },
        condition: { type: "string" },
        stairs: { type: "string" },
        occupied: { type: "string" },
        finish: { type: "string" },
        otherNotes: { type: "string" },
        openQuestions: { type: "string", description: "Anything the owner should clarify at the visit" },
      },
    },
  },
  {
    name: "move_to_column",
    description:
      "Files the lead as a loose appointment (Day for morning/afternoon, Night for evening), writes the notes and alerts the owner. It REFUSES until every required item is collected, so call it only when you believe the lead is ready. The column is chosen from the recorded availability.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "flag_needs_pedro",
    description:
      "Hands the lead to the owner right now (complaint, very large or commercial job, water damage or soft subfloor, asks for the owner, negotiates price, or a question you cannot answer). After calling it, tell the lead the owner will call.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "One short factual line for the owner, in the lead's own terms" } },
      required: ["reason"],
    },
  },
  {
    name: "route_lead",
    description: "Closes a lead that will not become an estimate: photo_quote (only wants a price by text), out_of_area, or not_interested (including spam).",
    input_schema: {
      type: "object",
      properties: { outcome: { type: "string", enum: ["photo_quote", "out_of_area", "not_interested"] } },
      required: ["outcome"],
    },
  },
  {
    name: "record_opt_out",
    description: "The lead asked, in any words, not to be contacted again. Stops all messages and tags the contact.",
    input_schema: { type: "object", properties: {} },
  },
];

export function guessLanguage(hint?: string | null): Language {
  const h = (hint ?? "").toLowerCase();
  if (/(^|[^a-z])(en|english|anglais)([^a-z]|$)/.test(h)) return "en";
  return "fr";
}

function langOf(lead: HsLead): Language {
  return lead.info.language ?? "fr";
}

async function localNow(deps: HsDeps): Promise<string> {
  return deps.now().toLocaleString("en-US", {
    timeZone: deps.config.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function replyDelayMs(receivedAt: Date, text: string, now: Date, random: () => number = Math.random): number {
  const typing = Math.min(text.length * TYPING_MS_PER_CHAR, TYPING_MAX_MS);
  const target = REPLY_MIN_MS + typing + Math.floor(random() * JITTER_MS);
  return Math.max(0, target - (now.getTime() - receivedAt.getTime()));
}

/** When a text may actually go out: after a human-sized pause, and never inside quiet hours. */
export function sendTime(deps: HsDeps, earliest: Date): Date {
  const { startHour, endHour } = deps.config.quietHours;
  return clampToSendWindow(earliest, deps.config.timezone, startHour, endHour);
}

async function queueText(deps: HsDeps, lead: HsLead, body: string, kind: "first_touch" | "reply" | "followup" | "optout_ack", earliest: Date): Promise<void> {
  await deps.store.enqueue({ clientId: lead.clientId, contactId: lead.contactId, body, kind, sendAfter: sendTime(deps, earliest) });
}

async function alert(deps: HsDeps, kind: AlertKind, info: LeadInfo, reason?: string): Promise<void> {
  await deps.alertOwner(formatAlert(kind, info, deps.config.notify.language, { reason }));
}

interface ToolOutcome {
  result: string;
  optedOut?: boolean;
}

async function runTool(deps: HsDeps, lead: HsLead, name: string, input: any): Promise<ToolOutcome> {
  const { config, store } = deps;
  const current = (await store.getLead(lead.clientId, lead.contactId)) ?? lead;

  if (name === "update_lead_info") {
    const info = mergeInfo(current.info, input ?? {});
    await store.updateLead(lead.clientId, lead.contactId, { info });
    const missing = missingRequired(info);
    return { result: missing.length ? `Saved. Still missing: ${missing.join("; ")}.` : "Saved. Everything required is collected; you can call move_to_column when the lead is ready." };
  }

  if (name === "move_to_column") {
    if (current.columnKey && APPOINTMENT_COLUMNS.has(current.columnKey)) {
      return { result: `The lead is already in an appointment column; only ${config.ownerName} moves a lead out of one. Do not move it. If something changed, tell the lead ${config.ownerName} will follow up and call flag_needs_pedro.` };
    }
    const missing = missingRequired(current.info);
    if (missing.length) return { result: `NOT moved. Still missing: ${missing.join("; ")}. Ask for one or two of these, then try again.` };
    const column = columnForVisit(current.info);
    if (!column) return { result: "NOT moved: no availability recorded." };
    const date = deps.now().toLocaleDateString("en-CA", { timeZone: config.timezone });
    // The owner's GHL workflow fires on the move and reads this field, so it is written first. If it cannot be
    // saved the card stays put: a card in a Loose column with no notification would sit unseen.
    try {
      await deps.ghl.writeIsaNotes(current, formatIsaNotes(column as AlertKind, current.info, config.notify.language));
    } catch (error) {
      console.error("[IRS-HS] could not write ISA Notes:", error instanceof Error ? error.message : error);
      return { result: `NOT moved: the notes could not be saved on our side. Tell the lead ${config.ownerName} will contact them to confirm a time, and call flag_needs_pedro.` };
    }
    await deps.ghl.moveToColumn(current, config.columns[column]);
    await deps.ghl.writeNote(current, buildSummaryNote(current.info, column, date));
    await store.updateLead(lead.clientId, lead.contactId, { columnKey: column, nextFollowupAt: null });
    await alert(deps, column as AlertKind, current.info);
    return { result: `Filed as a loose appointment. Tell the lead ${config.ownerName} will contact them to confirm the exact time, around when they said they are free. Never promise a specific time yourself.` };
  }

  if (name === "flag_needs_pedro") {
    const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "needs a call";
    await deps.ghl.writeIsaNotes(current, formatIsaNotes("needsPedro", current.info, config.notify.language, { reason })).catch((error) => {
      console.error("[IRS-HS] could not write ISA Notes:", error instanceof Error ? error.message : error);
    });
    await deps.ghl.addTags(current, [config.tags.needsPedro]);
    await deps.ghl.writeNote(current, `IRIS HANDOFF — ${deps.now().toLocaleDateString("en-CA", { timeZone: config.timezone })}\nReason: ${reason}\n\n${buildSummaryNote(current.info, current.columnKey ?? "none", deps.now().toLocaleDateString("en-CA", { timeZone: config.timezone }))}`);
    await store.updateLead(lead.clientId, lead.contactId, { status: "needs_pedro", nextFollowupAt: null, resolutionReason: reason });
    await alert(deps, "needsPedro", current.info, reason);
    return { result: `Handed to ${config.ownerName}. Tell the lead ${config.ownerName} will call them, with no promised time, then stop.` };
  }

  if (name === "route_lead") {
    const tagFor = { photo_quote: config.tags.photoQuote, out_of_area: config.tags.outOfArea, not_interested: config.tags.notInterested } as const;
    const outcome = input?.outcome as keyof typeof tagFor;
    if (!(outcome in tagFor)) return { result: "Unknown outcome; use photo_quote, out_of_area or not_interested." };
    // A closed lead that texts back ("thanks") is reopened with its reason kept, so the same tag is not applied again.
    if (current.resolutionReason !== outcome) await deps.ghl.addTags(current, [tagFor[outcome]]);
    await store.updateLead(lead.clientId, lead.contactId, { status: "closed", nextFollowupAt: null, resolutionReason: outcome });
    return { result: "Closed. Send one short, warm closing message and stop." };
  }

  if (name === "record_opt_out") {
    await applyOptOut(deps, current);
    return { result: "Opted out. Send nothing further.", optedOut: true };
  }

  return { result: `Unknown tool: ${name}` };
}

async function applyOptOut(deps: HsDeps, lead: HsLead): Promise<void> {
  await deps.ghl.addTags(lead, [deps.config.tags.dnd]);
  await deps.store.updateLead(lead.clientId, lead.contactId, { status: "opted_out", nextFollowupAt: null, resolutionReason: "opted out by text" });
  await deps.store.cancelPending(lead.clientId, lead.contactId, ["first_touch", "reply", "followup"]);
}

/**
 * One inbound text from a lead. Returns true when the flow owns this lead (even if it chose to stay
 * quiet), false when the lead is not one of ours.
 */
export async function handleInbound(deps: HsDeps, leadIn: HsLead, text: string, receivedAt: Date = deps.now()): Promise<boolean> {
  const { store } = deps;
  const lead = (await store.getLead(leadIn.clientId, leadIn.contactId)) ?? leadIn;
  await store.updateLead(lead.clientId, lead.contactId, { lastInboundSeenAt: receivedAt });

  if (lead.status === "opted_out") return true;
  // Any pending follow-up is moot the moment the lead answers (brief, section 8).
  await store.cancelPending(lead.clientId, lead.contactId, ["followup"]);
  await store.updateLead(lead.clientId, lead.contactId, { nextFollowupAt: null });

  // After a handoff the lead is the owner's; Iris stays quiet but the lead's reply must not vanish.
  if (lead.status === "needs_pedro") {
    await deps.alertOwner(`💬 ${lead.info.fullName ?? "A lead"} replied after the hand-off: "${text.slice(0, 200)}"`);
    return true;
  }
  const reopenedFrom = lead.status === "closed" || lead.status === "idle" ? lead.status : null;
  if (reopenedFrom) {
    // A closed or idle lead texting back is a new conversation; reopen it.
    await store.updateLead(lead.clientId, lead.contactId, { status: "active" });
  }

  if (await deps.teammateIsTexting(lead)) return true;

  if (isOptOut(text)) {
    await applyOptOut(deps, lead);
    await queueText(deps, lead, optOutConfirmationText(langOf(lead)), "optout_ack", new Date(deps.now().getTime() + replyDelayMs(receivedAt, optOutConfirmationText(langOf(lead)), deps.now())));
    await deps.appendHistory(lead, "user", text);
    return true;
  }

  const fresh = (await store.getLead(lead.clientId, lead.contactId)) ?? lead;
  const history = await deps.loadHistory(fresh);
  // The text being answered is passed to the model as the new user turn; leave it out of the thread so it isn't shown twice.
  const thread = await deps.recentTexts(fresh).catch(() => [] as ThreadText[]);
  while (thread.length && thread[thread.length - 1].from === "lead" && thread[thread.length - 1].text.trim() === text.trim()) thread.pop();
  const system = buildSystemPrompt({ config: deps.config, info: fresh.info, column: fresh.columnKey, nowLocal: await localNow(deps), language: langOf(fresh), thread });

  let working: ChatMessage[] = [...history, { role: "user", content: text }];
  let finalText = "";
  let optedOut = false;
  let toolCalls = 0;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await deps.chat(system, working, HS_TOOLS);
    working = [...working, { role: "assistant", content: response.content }];
    finalText = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    toolCalls += toolUses.length;
    const results = [];
    for (const tu of toolUses) {
      const call = tu as { id: string; name: string; input: any };
      let outcome: ToolOutcome;
      try {
        outcome = await runTool(deps, fresh, call.name, call.input);
      } catch (error) {
        outcome = { result: `Error: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (outcome.optedOut) optedOut = true;
      results.push({ type: "tool_result" as const, tool_use_id: call.id, content: outcome.result });
    }
    working = [...working, { role: "user", content: results }];
    // Nothing the model could add matters once the lead has opted out; the confirmation is a fixed text.
    if (optedOut) break;
  }

  await deps.appendHistory(fresh, "user", text);
  if (optedOut) {
    const ack = optOutConfirmationText(langOf(fresh));
    await queueText(deps, fresh, ack, "optout_ack", new Date(deps.now().getTime() + replyDelayMs(receivedAt, ack, deps.now())));
    return true;
  }
  // No fallback text: a reply the model failed to produce is better left for a person than replaced with a canned line.
  if (!finalText) {
    await deps.alertOwner(`⚠️ Iris produced no reply for ${fresh.info.fullName ?? fresh.contactId}'s text: "${text.slice(0, 200)}". Needs a person.`);
    return true;
  }
  // A closed lead who only said "thanks" gets a courtesy reply but stays closed; only new facts or a new outcome keep it open.
  if (reopenedFrom === "closed" && toolCalls === 0) await store.updateLead(lead.clientId, lead.contactId, { status: "closed" });
  finalText = tidyReply(finalText, text);
  if (isTooLong(finalText)) {
    // One retry to say it shorter. If that fails or is still long, the tidied original goes out: a long text beats no text.
    const shorter = await deps
      .chat(SHORTEN_SYSTEM, [{ role: "user", content: finalText }], [])
      .then((r) => r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ").trim())
      .catch(() => "");
    if (shorter) finalText = tidyReply(shorter, text);
  }
  await deps.appendHistory(fresh, "assistant", finalText);
  await queueText(deps, fresh, finalText, "reply", new Date(deps.now().getTime() + replyDelayMs(receivedAt, finalText, deps.now())));
  return true;
}

/**
 * Starts a conversation record for a new lead. `lastInboundSeenAt` is the moment from which the
 * lead's replies count (the card's creation), so a reply that lands before the first poll is not lost.
 * Iris only texts first when `outreach.firstTouch` is on; otherwise she waits for the lead's reply
 * to whatever the client's own automation sent. Idempotent: a lead already enrolled is left alone.
 */
export async function enrollLead(deps: HsDeps, lead: Pick<HsLead, "clientId" | "contactId" | "opportunityId" | "columnKey" | "info" | "lastInboundSeenAt">): Promise<boolean> {
  const now = deps.now();
  const inserted = await deps.store.insertLead({
    clientId: lead.clientId,
    contactId: lead.contactId,
    opportunityId: lead.opportunityId,
    columnKey: lead.columnKey,
    info: lead.info,
    status: "active",
    followupStep: 0,
    nextFollowupAt: null,
    lastInboundSeenAt: lead.lastInboundSeenAt,
    lastOutboundAt: null,
    resolutionReason: null,
  });
  if (!inserted) return false;
  if (!deps.config.outreach.firstTouch) return true;

  const language = lead.info.language ?? "fr";
  const body = firstTouchText(language, firstNameOf(lead.info.fullName));
  // A reply within about a minute, not instantly.
  const firstSend = sendTime(deps, new Date(now.getTime() + 20_000 + Math.floor(Math.random() * 25_000)));
  await deps.store.enqueue({ clientId: lead.clientId, contactId: lead.contactId, body, kind: "first_touch", sendAfter: firstSend });
  if (deps.config.outreach.followups) {
    // Counted from when the first text really leaves (it may wait for the morning), not from when the lead arrived.
    await deps.store.updateLead(lead.clientId, lead.contactId, { nextFollowupAt: sendTime(deps, new Date(firstSend.getTime() + 3 * 3_600_000)) });
  }
  return true;
}

/** The next local morning, half an hour after the send window opens so it is not the very first text of the day. */
function morningAfter(deps: HsDeps, from: Date): Date {
  const tomorrow = new Date(new Date(from.toLocaleString("en-US", { timeZone: deps.config.timezone })).getTime() + 24 * 3_600_000);
  const opens = zonedHourToUtc(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), deps.config.quietHours.startHour, deps.config.timezone);
  return new Date(opens.getTime() + 30 * 60_000);
}

/** Sends the next scripted follow-up for a lead whose clock ran out with no reply. */
export async function runFollowup(deps: HsDeps, lead: HsLead): Promise<void> {
  const step = lead.followupStep + 1;
  const now = deps.now();
  const language = langOf(lead);
  const body = followupText(step, language, firstNameOf(lead.info.fullName));
  if (!body || step > FOLLOWUP_STEPS) return;

  await queueText(deps, lead, body, "followup", now);

  // Day columns follow the cadence: steps 1-2 are still Day 1, step 3 is Day 2, step 4 is Day 3.
  const column: ColumnKey = step >= 4 ? "day3" : step === 3 ? "day2" : "day1";
  if (column !== lead.columnKey) await deps.ghl.moveToColumn(lead, deps.config.columns[column]);

  if (step >= FOLLOWUP_STEPS) {
    // After Day 3 the brief leaves long-term nurture undecided: tag and stop, send nothing more.
    await deps.ghl.addTags(lead, [deps.config.tags.longTermNurture]);
    await deps.store.updateLead(lead.clientId, lead.contactId, { followupStep: step, columnKey: column, nextFollowupAt: null, status: "idle", resolutionReason: "cadence finished, no reply" });
    return;
  }
  const next = step === 1 ? morningAfter(deps, now) : new Date(now.getTime() + 24 * 3_600_000);
  await deps.store.updateLead(lead.clientId, lead.contactId, { followupStep: step, columnKey: column, nextFollowupAt: sendTime(deps, next) });
}
