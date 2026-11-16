/**
 * The stuck-lead check: every morning Iris goes through the cards that sit in the early stages she manages (Replied,
 * Buyer Leads, Day 1-3 AM/PM, Weekend AM/PM, ...), works out why each one has not moved, and fixes what she can.
 *
 * Mark, 2026-11-17, passing on Jacob's question ("why are some leads still in New Lead, Day 1 AM, Day 1 PM...?"):
 * Iris is the one responsible. A lead that is not moving, has no tag, no notes, or never got an initial text or call
 * is Iris's problem to analyse and resolve, and a lead stuck in a stage she manages gets another call or text based
 * on its conversation and history.
 *
 * What the audit of the 36 early-stage cards found (2026-11-17), and what this does about each:
 *   - A call that connected but never finished (hung up in 30 seconds, a bad line, silence) counted as "answered", so
 *     the queue row stayed 'placed', nothing re-opened and the card kept the stage of the first miss
 *     -> call again at a different time of day (twice more at most), then a text, then a decided ending.
 *   - Calls that were never answered ran out and the card stayed in the last stage
 *     -> one text from the history, then Not Ready once a few days have passed with no answer.
 *   - A lead who said "wrong number" (Ell Dee, 14 days in Day 1 AM) -> tagged, closed, moved to Not Interested.
 *   - A lead nobody ever contacted -> a first call (recent leads) or a person decides (old ones: CASL, Jacob's OK).
 *   - A lead who talked to Iris and went quiet -> a follow-up text written from the thread (the ASAP watch's writer
 *     and checks), at most `maxNudges` of them, then Not Ready (a qualified lead goes to a person instead).
 *   - A lead who texted last and was never answered, a lead tagged live transferred whose card never moved, a lead
 *     with no phone, an inquiry over 6 months old: these are a person's, listed in Slack, once a week.
 *
 * What it never does: contact or move anyone a teammate is working (a text or call from a person within the hands-off
 * window), anyone with a booking ahead, anyone tagged do not call, or a card that sits in a column a person works. A
 * lead handled today is left alone for `recheckDays`. The decision for each lead is a pure function
 * (diagnoseStuckLead, tested); the rest only reads and acts.
 *
 * Off per client unless iris.stuckLeads.enabled.
 */
import { query } from "../../shared/db";
import {
  addContactTags,
  createContactNote,
  getContact,
  getContactAppointments,
  getConversationMessages,
  getConversations,
  getCustomFieldDefs,
  getGhlConfig,
  listOpportunitiesForContact,
  listOpportunitiesInStage,
  listPipelines,
  updateOpportunityStage,
} from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { buildKeyToId, readField } from "../scout/intake";
import { refreshLead } from "../scout";
import { sendIrisText } from "../../webhooks/vapi-webhook";
import { AsapLeadContext, composeAsapText, openRowForReplies, TextGenerator } from "./asap-watch";
import { clampToLegalCallingWindow, formatLocal, isWithinLegalCallingWindow, zonedHourToUtc } from "./cadence";
import { CALL_LOG_CHANNEL } from "./channels";
import { queueColdLeadSweep } from "./dial-pending";
import { callAnswered } from "./followup-cohort";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { loadIrisConfig } from "./index";
import { eventsFromIrisCalls, eventsFromMessages, isTestContact, qualifiedSignals, ReviewEvent } from "./lead-review";
import { appendNoteToContact } from "./notes";
import { moveToNotInterested } from "./opt-out";
import { readAppointments } from "./no-show-state";
import { extractFirstName } from "./scripts";

export const STUCK_SOURCE = "stuck";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface StuckLeadsConfig {
  enabled: boolean;
  /** Regex sources, matched (case-insensitively) against a stage's trimmed name: the stages Iris manages. */
  stagePatterns: string[];
  /** Stage name (lowercase) -> the tag every card in it should carry ("buyer leads" -> "buyer lead"). */
  stageTags: Record<string, string>;
  maxCallsPerDay: number;
  maxTextsPerDay: number;
  maxMovesPerDay: number;
  /** Extra calls after a call that connected but never finished. */
  extraTriesForUnfinishedCalls: number;
  /** Days of quiet after Iris's last try before she follows up again. */
  quietDays: number;
  /** Days after the last try with no answer before the card goes to Not Ready. */
  giveUpAfterDays: number;
  /** Follow-up texts Iris writes one lead from this check, in all. */
  maxNudges: number;
  /** An inquiry older than this is a person's to decide (Mark, 2026-11-17: the old leftovers in Replied). */
  autoContactMaxDays: number;
  /** Days a lead handled by this check is left alone. */
  recheckDays: number;
  /** Days before a lead listed for a person is listed again. */
  personRepeatDays: number;
}

export const DEFAULT_STUCK_LEADS: Omit<StuckLeadsConfig, "enabled" | "stagePatterns" | "stageTags"> = {
  maxCallsPerDay: 4,
  maxTextsPerDay: 3,
  maxMovesPerDay: 10,
  extraTriesForUnfinishedCalls: 2,
  quietDays: 3,
  giveUpAfterDays: 5,
  maxNudges: 2,
  autoContactMaxDays: 60,
  recheckDays: 3,
  personRepeatDays: 7,
};

/** CASL: an inquiry older than this is outside implied consent, so Jacob decides (Mark, 2026-10-22). */
const STALE_INQUIRY_DAYS = 180;
/** A lead nobody has ever contacted gets a first call only while the inquiry is this fresh. */
const FIRST_CONTACT_MAX_DAYS = 30;
/** A call that ended this long ago is not "still ringing". */
const CALL_RINGING_MS = 30 * 60_000;
/** Two calls to the same lead are at least this far apart. */
const MIN_HOURS_BETWEEN_CALLS = 20;
const TEXT_NOT_ANSWERED_AFTER_MS = 3 * HOUR;
/** A call Iris ended herself that lasted less than this was cut short (Corinne Wade: 94 seconds). */
const SHORT_CALL_SECONDS = 120;

export interface IrisCallFact {
  at: number;
  endedReason: string | null;
  seconds: number;
  /** How many times the lead spoke. */
  leadTurns: number;
  transcript: string;
}

export interface StuckFacts {
  contactId: string;
  name: string;
  stageName: string;
  daysInStage: number | null;
  createdAt: number | null;
  tags: string[];
  dnd: boolean;
  hasPhone: boolean;
  notes: string;
  events: ReviewEvent[];
  calls: IrisCallFact[];
  irisQueue: { status: string; callAfter: number | null; source: string | null } | null;
  hasUpcomingAppointment: boolean;
  /** A person texted or called them inside the hands-off window. */
  teammateInTouch: boolean;
  /** Follow-up texts this check has sent them. */
  nudges: number;
  lastNudgeAt: number | null;
  /** The last time this check acted on them (not counting a "needs a person" listing). */
  lastActionAt: number | null;
}

export type Diagnosis =
  | { action: "leave"; why: string }
  | { action: "person"; why: string }
  | { action: "close_wrong_number"; why: string }
  | { action: "call_again"; why: string }
  | { action: "text_follow_up"; why: string }
  | { action: "park_not_ready"; why: string };

export interface Diagnosed {
  diagnosis: Diagnosis;
  /** What is missing from the card, in words (the things Mark listed: not moving, no tag, no notes, no first text, no first call). */
  problems: string[];
  tagsToAdd: string[];
}

/** Ended reasons for "somebody picked up": Vapi reports a hang-up, a bad line or silence like this. */
const CONNECTED_REASONS = /^(?:customer-ended-call|assistant-ended-call|silence-timed-out)$/;
const WRONG_NUMBER = /wrong (?:number|person)|(?:not|isn'?t|is not) (?:\w+ )?(?:the )?(?:right )?(?:number|person)|nobody (?:here )?(?:by|with) that name|don'?t know (?:who|anyone)/i;

/** What the lead said on a call: the transcript's "User:" lines. */
export function leadSpeech(transcript: string): string {
  return transcript
    .split("\n")
    .filter((l) => /^\s*user:/i.test(l))
    .map((l) => l.replace(/^\s*user:\s*/i, ""))
    .join(" ");
}

export function saidWrongNumber(call: Pick<IrisCallFact, "transcript">): boolean {
  return WRONG_NUMBER.test(leadSpeech(call.transcript));
}

/** Picked up, but it never got anywhere: the lead hung up, the line was bad, or nobody spoke. */
export function isUnfinishedCall(call: IrisCallFact): boolean {
  if (!CONNECTED_REASONS.test(String(call.endedReason ?? "")) || saidWrongNumber(call)) return false;
  // The lead hanging up or going silent is a call that didn't finish at any length. When Iris ended it herself it only
  // counts if it was short: a two-minute conversation she wrapped up is a conversation, not a dropped call. (Seconds
  // are 0 when Vapi gave no end time; then the number of things the lead said stands in.)
  if (call.endedReason !== "assistant-ended-call") return true;
  return call.seconds > 0 ? call.seconds < SHORT_CALL_SECONDS : call.leadTurns <= 2;
}

const isIrisOrPerson = (e: ReviewEvent): boolean => e.direction === "out" && (e.actor === "human" || e.actor === "app" || e.actor === "iris_call");
const STOP = /^\s*(?:stop|unsubscribe|remove me|cancel|quit|end)\b/i;

export function isNothingTag(tags: string[]): boolean {
  return tags.every((t) => /^(?:replied|iris no answer)$/i.test(t));
}

export function listProblems(f: StuckFacts, stageTags: Record<string, string>): string[] {
  const out: string[] = [];
  if (f.daysInStage !== null && f.daysInStage >= 3) out.push(`${Math.round(f.daysInStage)} days in ${f.stageName.trim()}`);
  const want = stageTags[f.stageName.trim().toLowerCase()];
  if (isNothingTag(f.tags) || (want && !f.tags.some((t) => t.toLowerCase() === want.toLowerCase()))) out.push("no buyer/seller tag");
  if (!f.notes.trim()) out.push("no notes");
  if (!f.events.some((e) => isIrisOrPerson(e) && e.kind === "sms")) out.push("never got a text from Iris or a person");
  if (!f.calls.length && !f.events.some((e) => isIrisOrPerson(e) && e.kind === "call")) out.push("never called");
  return out;
}

/** Whether a call should be placed from the stage names' point of view: not at all when the lead asked for no calls. */
const canCall = (tags: string[]): boolean => !tags.some((t) => /^no calls$/i.test(t));

/**
 * What to do about one card. Pure: everything it needs is in `f`.
 * The order is the point: the cheap "leave it alone" reasons come first, so nothing is ever done to a lead somebody
 * else has, and each later rule only sees leads that really are stuck.
 */
export function diagnoseStuckLead(f: StuckFacts, cfg: Pick<StuckLeadsConfig, "stageTags" | "quietDays" | "giveUpAfterDays" | "maxNudges" | "recheckDays" | "extraTriesForUnfinishedCalls" | "autoContactMaxDays">, now: Date): Diagnosed {
  const t = now.getTime();
  const tags = f.tags.map((x) => x.toLowerCase());
  const problems = listProblems(f, cfg.stageTags);
  const wantTag = cfg.stageTags[f.stageName.trim().toLowerCase()];
  const tagsToAdd = wantTag && !tags.includes(wantTag.toLowerCase()) ? [wantTag] : [];
  const done = (diagnosis: Diagnosis, tagsToo = true): Diagnosed => ({ diagnosis, problems, tagsToAdd: tagsToo ? tagsToAdd : [] });

  if (f.dnd || tags.includes("do not call")) return done({ action: "leave", why: "do not call" }, false);
  if (!f.hasPhone) return done({ action: "person", why: "there is no phone number on the record" });
  if (f.hasUpcomingAppointment || tags.includes("appt booked")) return done({ action: "leave", why: "has an appointment booked" });
  if (tags.includes("live transferred")) return done({ action: "person", why: `tagged live transferred but the card is still in ${f.stageName.trim()}: move it` });
  if (f.teammateInTouch) return done({ action: "leave", why: "a teammate is in touch" });

  const sorted = [...f.calls].sort((a, b) => a.at - b.at);
  const lastCall = sorted.at(-1) ?? null;
  const lastSpoken = [...sorted].reverse().find((c) => c.leadTurns > 0) ?? null;
  if (lastSpoken && saidWrongNumber(lastSpoken)) return done({ action: "close_wrong_number", why: `they said it was the wrong number on the ${new Date(lastSpoken.at).toISOString().slice(5, 10)} call` }, false);

  const q = f.irisQueue;
  // Any dated pending row is a call lined up (a second one would overwrite its time); 'infinity' is a row waiting on a text.
  if (q?.status === "pending" && q.callAfter !== null) return done({ action: "leave", why: "a call is already lined up" });
  if (q?.status === "placed" && lastCall && t - lastCall.at < CALL_RINGING_MS) return done({ action: "leave", why: "a call is in progress" });

  const touches = f.events.filter(isIrisOrPerson);
  const lastTouchAt = touches.length ? Math.max(...touches.map((e) => e.at)) : null;
  const irisTexts = f.events.filter((e) => e.direction === "out" && e.kind === "sms" && e.actor === "app");
  const lastIrisTextAt = irisTexts.length ? Math.max(...irisTexts.map((e) => e.at)) : null;
  if (q?.status === "pending" && q.callAfter === null && lastIrisTextAt !== null && t - lastIrisTextAt < cfg.quietDays * DAY) return done({ action: "leave", why: "waiting on their reply to Iris's text" });
  if (f.lastActionAt !== null && t - f.lastActionAt < cfg.recheckDays * DAY) return done({ action: "leave", why: "handled in the last few days" });

  const last = f.events.at(-1);
  if (last && last.direction === "in" && last.kind === "sms" && !STOP.test(last.text) && t - last.at > TEXT_NOT_ANSWERED_AFTER_MS) return done({ action: "person", why: "they texted last and nobody has answered" });
  if (f.createdAt !== null && t - f.createdAt > STALE_INQUIRY_DAYS * DAY) return done({ action: "person", why: "the inquiry is over 6 months old: needs Jacob's OK before anyone contacts them" });

  if (f.createdAt !== null && t - f.createdAt > cfg.autoContactMaxDays * DAY) return done({ action: "person", why: `an inquiry from ${Math.round((t - f.createdAt) / DAY)} days ago: a person decides whether to reach out` });

  const qualified = qualifiedSignals(f.notes, f.tags) >= 3;
  const callable = canCall(f.tags);
  const everTried = touches.length > 0 || f.calls.length > 0;

  // Nobody ever contacted them.
  if (!everTried) {
    if (f.createdAt !== null && t - f.createdAt > FIRST_CONTACT_MAX_DAYS * DAY) return done({ action: "person", why: "an older lead nobody has ever contacted" });
    return done(callable ? { action: "call_again", why: "nobody has called or texted them yet" } : { action: "text_follow_up", why: "nobody has texted them yet (they asked for no calls)" });
  }

  const engaged = f.events.some((e) => e.direction === "in" && e.kind === "sms" && !STOP.test(e.text)) || f.calls.some((c) => c.leadTurns > 0);

  // A call that connected but never got anywhere: try again at another time of day, a couple of times.
  if (!qualified) {
    const unfinished = f.calls.filter(isUnfinishedCall);
    const lastIsUnfinished = lastSpoken !== null && isUnfinishedCall(lastSpoken);
    if (unfinished.length > 0 && lastIsUnfinished && unfinished.length < 1 + cfg.extraTriesForUnfinishedCalls) {
      const secs = lastSpoken.seconds ? `${Math.round(lastSpoken.seconds)}-second ` : "";
      const gapOk = lastCall !== null && t - lastCall.at >= MIN_HOURS_BETWEEN_CALLS * HOUR;
      if (gapOk) {
        return done(callable ? { action: "call_again", why: `they picked up a ${secs}call that never finished (${lastSpoken.endedReason?.replace(/-/g, " ")}): trying again at a different time` } : { action: "text_follow_up", why: "their last call never finished and they asked for no calls" });
      }
      return done({ action: "leave", why: "Iris called them a moment ago" });
    }
  }

  if (lastTouchAt !== null && t - lastTouchAt < cfg.quietDays * DAY) return done({ action: "leave", why: "tried within the last few days" });

  if (qualified) return done({ action: "person", why: "qualified in the notes and not moving: needs an agent to take the conversation" });

  if (!engaged) {
    // Never reached anyone. One text after the calls, then a decided ending.
    const lastCallAt = lastCall?.at ?? 0;
    const textedAfterCalls = irisTexts.some((e) => e.at >= lastCallAt - 5 * 60_000);
    if (textedAfterCalls) {
      if (lastTouchAt !== null && t - lastTouchAt >= cfg.giveUpAfterDays * DAY) return done({ action: "park_not_ready", why: `${f.calls.length} call${f.calls.length === 1 ? "" : "s"} and a text with no answer in ${Math.round((t - lastTouchAt) / DAY)} days` }, false);
      return done({ action: "leave", why: "waiting out the last try" });
    }
    return done({ action: "text_follow_up", why: "the calls went unanswered and no text followed" });
  }

  // They have talked to Iris (or texted), then went quiet.
  if (f.nudges >= cfg.maxNudges) {
    if (f.lastNudgeAt !== null && t - f.lastNudgeAt >= cfg.giveUpAfterDays * DAY) return done({ action: "park_not_ready", why: `${f.nudges} follow-up texts and no answer in ${Math.round((t - f.lastNudgeAt) / DAY)} days` }, false);
    return done({ action: "leave", why: "waiting out the last follow-up text" });
  }
  return done({ action: "text_follow_up", why: "they talked to Iris before and it has gone quiet: a follow-up from the history" });
}

/**
 * When a retry call goes out: the other half of the day from the last call (a lead who didn't finish at 10 AM may be
 * free at 2 PM), never in the next ten minutes, always inside calling hours. A lead nobody has called goes now.
 */
export function retryStartAt(now: Date, timeZone: string, lastCallAt: number | null): Date {
  const soonest = new Date(now.getTime() + 10 * 60_000);
  if (lastCallAt === null) return clampToLegalCallingWindow(soonest, timeZone);
  const localHour = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone })).getHours();
  const hour = localHour(new Date(lastCallAt)) >= 13 ? 10 : 14;
  const local = new Date(now.toLocaleString("en-US", { timeZone }));
  let at = zonedHourToUtc(local.getFullYear(), local.getMonth(), local.getDate(), hour, timeZone);
  if (at.getTime() < soonest.getTime()) at = zonedHourToUtc(local.getFullYear(), local.getMonth(), local.getDate() + 1, hour, timeZone);
  return clampToLegalCallingWindow(at, timeZone);
}

export const STUCK_COMPOSER_SYSTEM = `You write ONE follow-up text message for Iris, a virtual assistant for a real estate brokerage, to send to a lead whose follow-up has stalled.

You are given everything that has happened with this lead: their messages, Iris's calls (with what was said when they answered), automated texts, and what is known and still missing. Write the single text that best moves them toward a short conversation with an agent.

Rules:
- Base it on the history. If they answered a call and told us things, refer to something real from it ("you mentioned you work days") and never ask again for something they already told us. If they never picked up, say so lightly and offer an easy way to connect (a better time, or just texting). If a call dropped or the line was bad, say you lost them and ask if now or another time is better.
- If they asked for a particular time or said when they are free, use it. If they said they cannot talk at some time of day, do not suggest that time.
- If they named a window ("weekday late afternoon", "after 4"), propose ONE specific time inside it as a question ("Would tomorrow around 4:30 work?"); never hand the choice back to them as an open "what's a good time".
- If they said they are just looking, will reach out themselves, or asked for space, keep it light and low-pressure (offer to send a few homes that fit, or ask one easy question) rather than pushing for a call.
- Ask for at most ONE thing: either a time that suits them for a quick call with an agent, OR one missing detail (prefer a specific budget number or a particular month, never a range). Never two questions.
- 1 or 2 short sentences, 220 characters or fewer, casual and warm, like a person texting. Start with "Hi {first name}," only if the thread does not already show Iris texting today.
- Say you are Iris from the brokerage only if no earlier text from Iris appears in the thread.
- Never invent facts, prices, listings, availability or an appointment. Never promise a call at a time that is not already lined up. Never mention being an AI unless asked.
- Plain text only: no emojis, no lists, no quotes, no "Reply STOP" line, no links.
- If there is truly nothing useful to say right now (for example they clearly said they are no longer interested or wrong number), reply with exactly: SKIP

Reply with the text message only.`;

// ─── The scan ───

export interface StuckEntry {
  contactId: string;
  name: string;
  stageName: string;
  diagnosed: Diagnosed;
  /** What was actually done (or, in a dry run, what would be). */
  did?: string;
  text?: string;
  /** Not acted on today because a daily limit was reached: it goes first tomorrow. */
  deferred?: boolean;
}

export interface StuckResult {
  skipped?: string;
  scanned: number;
  entries: StuckEntry[];
  timeZone: string;
  startAts: Record<string, Date>;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function stageIdByName(locationId: string, apiKey: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  for (const p of await listPipelines(locationId, apiKey)) for (const s of p.stages ?? []) if (String(s.name).trim().toLowerCase() === wanted) return s.id;
  return null;
}

/** Moves the lead's open card to Not Ready (iris.followUpCohort.notReadyStage). Returns whether a card moved. */
async function moveToNotReady(clientId: string, contactId: string, ghl: { locationId: string; apiKey: string }): Promise<boolean> {
  const stageName = loadIrisConfig(clientId)?.followUpCohort?.notReadyStage;
  if (!stageName) return false;
  const stageId = await stageIdByName(ghl.locationId, ghl.apiKey, stageName);
  if (!stageId) return false;
  const open = (await listOpportunitiesForContact(contactId, ghl.locationId, ghl.apiKey)).filter((o: any) => !o.status || o.status === "open");
  let moved = false;
  for (const opp of open) {
    if (opp.pipelineStageId === stageId) continue;
    await updateOpportunityStage(opp.id, stageId, ghl.locationId, ghl.apiKey);
    moved = true;
  }
  return moved;
}

const recordAction = (clientId: string, contactId: string, name: string, action: string, detail: string): Promise<unknown> =>
  query(`INSERT INTO iris_stuck_actions (client_id, contact_id, contact_name, action, detail) VALUES ($1, $2, $3, $4, $5)`, [clientId, contactId, name, action, detail.slice(0, 500)]);

export async function runStuckLeadCheck(
  clientId: string,
  options: { now?: Date; dryRun?: boolean; only?: string[]; composer?: (ctx: AsapLeadContext, now: Date, timeZone: string) => ReturnType<typeof composeAsapText>; generate?: TextGenerator } = {}
): Promise<StuckResult> {
  const now = options.now ?? new Date();
  const irisConfig = loadIrisConfig(clientId);
  const timeZone = irisConfig?.timezone || "America/St_Johns";
  const empty: StuckResult = { scanned: 0, entries: [], timeZone, startAts: {} };
  if (!irisConfig) return { ...empty, skipped: "no Iris config" };
  const cfg: StuckLeadsConfig = { ...DEFAULT_STUCK_LEADS, stagePatterns: [], stageTags: {}, ...(irisConfig.stuckLeads ?? {}), enabled: irisConfig.stuckLeads?.enabled === true };
  if (!cfg.enabled && !options.dryRun) return { ...empty, skipped: "the stuck-lead check is off" };
  if (cfg.stagePatterns.length === 0) return { ...empty, skipped: "no stages configured" };
  if (!options.dryRun && !isWithinLegalCallingWindow(now, timeZone)) return { ...empty, skipped: "outside calling hours" };
  const ghl = await getGhlConfig(clientId);
  if (!ghl) return { ...empty, skipped: "couldn't reach the CRM" };
  const patterns = cfg.stagePatterns.map((p) => new RegExp(p, "i"));
  const handsOff = irisConfig.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS;
  const keyToId = buildKeyToId(await getCustomFieldDefs(ghl.locationId, ghl.apiKey));

  const byContact = new Map<string, { opp: any; stageName: string }>();
  for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
    for (const s of p.stages ?? []) {
      const name = String(s.name).trim();
      if (!patterns.some((re) => re.test(name))) continue;
      for (const o of await listOpportunitiesInStage(ghl.locationId, p.id, s.id, ghl.apiKey)) {
        if (o?.status === "lost" || o?.status === "won") continue;
        const id = o.contactId ?? o.contact?.id;
        if (!id) continue;
        const prev = byContact.get(id);
        if (!prev || Date.parse(o.updatedAt ?? 0) > Date.parse(prev.opp.updatedAt ?? 0)) byContact.set(id, { opp: o, stageName: String(s.name) });
      }
    }
  }
  const ids = [...byContact.keys()].filter((id) => !options.only || options.only.includes(id));

  const callRows = await query<{ contact_id: string; created_at: Date; ended_at: Date | null; ended_reason: string | null; transcript: string | null }>(
    `SELECT contact_id, created_at, ended_at, ended_reason, transcript FROM iris_call_log WHERE client_id = $1 AND created_at > now() - interval '120 days' ORDER BY created_at`,
    [clientId]
  );
  const callsBy = new Map<string, typeof callRows>();
  for (const c of callRows) callsBy.set(c.contact_id, [...(callsBy.get(c.contact_id) ?? []), c]);
  const queue = await query<{ contact_id: string; status: string; call_after: unknown; source: string | null }>(`SELECT contact_id, status, call_after, source FROM iris_pending_calls WHERE client_id = $1`, [clientId]);
  const queueBy = new Map(queue.map((r) => [r.contact_id, r]));
  const actionRows = await query<{ contact_id: string; action: string; created_at: Date }>(
    `SELECT contact_id, action, created_at FROM iris_stuck_actions WHERE client_id = $1 AND created_at > now() - interval '60 days' ORDER BY created_at`,
    [clientId]
  ).catch((error) => {
    // Created at boot from schema.sql; until then (a dry run just ahead of a deploy) nothing has been done.
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  });
  const actionsBy = new Map<string, typeof actionRows>();
  for (const a of actionRows) actionsBy.set(a.contact_id, [...(actionsBy.get(a.contact_id) ?? []), a]);

  const results = await pool(ids, 4, async (contactId): Promise<(StuckEntry & { facts: StuckFacts }) | null> => {
    try {
      const { opp, stageName } = byContact.get(contactId)!;
      const raw = await getContact(contactId, ghl.locationId, ghl.apiKey);
      const contact = raw?.contact ?? raw;
      if (!contact) return null;
      if (irisConfig.leadReview?.excludeContactIds?.includes(contactId) || isTestContact(contact, irisConfig.leadReview?.excludeEmailDomains)) return null;
      const convo = await getConversations(contactId, ghl.locationId, ghl.apiKey);
      const convId = convo?.conversations?.[0]?.id;
      const messages: any[] = convId ? (await getConversationMessages(convId, ghl.locationId, ghl.apiKey, 80))?.messages?.messages ?? [] : [];
      const irisCalls = callsBy.get(contactId) ?? [];
      const events = [...eventsFromMessages(messages), ...eventsFromIrisCalls(irisCalls)].sort((a, b) => a.at - b.at);
      const appointments = await getContactAppointments(contactId, ghl.locationId, ghl.apiKey).catch(() => []);
      const q = queueBy.get(contactId);
      const rawAfter = q?.call_after as unknown;
      const callAfter = rawAfter instanceof Date ? rawAfter.getTime() : typeof rawAfter === "string" ? (/inf/i.test(rawAfter) ? null : Date.parse(rawAfter)) : typeof rawAfter === "number" && Number.isFinite(rawAfter) ? rawAfter : null;
      const mine = actionsBy.get(contactId) ?? [];
      const nudges = mine.filter((a) => a.action === "text_follow_up");
      const acted = mine.filter((a) => a.action !== "person");
      const lastStageChange = Date.parse(opp.lastStageChangeAt ?? "");
      const facts: StuckFacts = {
        contactId,
        name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.name || String(opp.contact?.name ?? contactId),
        stageName,
        daysInStage: Number.isFinite(lastStageChange) ? (now.getTime() - lastStageChange) / DAY : null,
        createdAt: contact.dateAdded ? Date.parse(contact.dateAdded) : null,
        tags: (contact.tags ?? []).map((x: string) => String(x)),
        dnd: contact.dnd === true,
        hasPhone: Boolean(contact.phone),
        notes: String(readField(contact.customFields, irisConfig.callbackNotesFieldKey, keyToId) ?? ""),
        events,
        calls: irisCalls.map((c) => ({
          at: new Date(c.created_at).getTime(),
          endedReason: c.ended_reason,
          seconds: c.ended_at ? Math.max(0, (new Date(c.ended_at).getTime() - new Date(c.created_at).getTime()) / 1000) : 0,
          // A voicemail greeting has "User:" lines too: only a call that reached a person counts as them speaking.
          leadTurns: callAnswered(c) ? (String(c.transcript ?? "").match(/^\s*user:\s*\S/gim) ?? []).length : 0,
          transcript: String(c.transcript ?? ""),
        })),
        irisQueue: q ? { status: q.status, callAfter: callAfter !== null && Number.isFinite(callAfter) ? callAfter : null, source: q.source } : null,
        hasUpcomingAppointment: Boolean(readAppointments(appointments, now, timeZone).upcoming),
        teammateInTouch: events.some((e) => e.direction === "out" && e.actor === "human" && now.getTime() - e.at < handsOff * DAY),
        nudges: nudges.length,
        lastNudgeAt: nudges.length ? new Date(nudges[nudges.length - 1].created_at).getTime() : null,
        lastActionAt: acted.length ? new Date(acted[acted.length - 1].created_at).getTime() : null,
      };
      const diagnosed = diagnoseStuckLead(facts, cfg, now);
      // A "needs a person" listing is repeated once a week, not daily.
      const lastListed = mine.filter((a) => a.action === "person").at(-1);
      if (diagnosed.diagnosis.action === "person" && lastListed && now.getTime() - new Date(lastListed.created_at).getTime() < cfg.personRepeatDays * DAY) {
        return { contactId, name: facts.name, stageName, diagnosed: { ...diagnosed, diagnosis: { action: "leave", why: "listed for a person this week" } }, facts };
      }
      return { contactId, name: facts.name, stageName, diagnosed, facts };
    } catch (error) {
      console.error(`[STUCK] ${contactId}:`, error instanceof Error ? error.message : error);
      return null;
    }
  });
  const scanned = results.filter((r): r is NonNullable<typeof r> => r !== null);

  // Act, oldest-stuck first, inside the daily limits.
  const order = [...scanned].sort((a, b) => (b.facts.daysInStage ?? 0) - (a.facts.daysInStage ?? 0));
  let calls = 0;
  let texts = 0;
  let moves = 0;
  const startAts: Record<string, Date> = {};
  const compose = options.composer ?? ((ctx: AsapLeadContext, n: Date, tz: string) => composeAsapText(ctx, n, tz, options.generate, { system: STUCK_COMPOSER_SYSTEM, asap: false }));
  const entries: StuckEntry[] = [];

  for (const r of order) {
    const { facts, diagnosed } = r;
    const d = diagnosed.diagnosis;
    const entry: StuckEntry = { contactId: r.contactId, name: r.name, stageName: r.stageName, diagnosed };
    entries.push(entry);
    if (d.action === "leave") continue;
    if (d.action === "person") {
      if (!options.dryRun) await recordAction(clientId, r.contactId, r.name, "person", d.why).catch(() => {});
      continue;
    }
    // Everything below changes something, so a teammate working the lead (read live) outranks it.
    const touch = await checkHumanTouch(r.contactId, ghl.locationId, ghl.apiKey, handsOff, now);
    if (touch.status !== "none") {
      entry.diagnosed = { ...diagnosed, diagnosis: { action: "leave", why: touch.status === "human" ? "a teammate has been in touch" : "couldn't verify no teammate is in touch" } };
      continue;
    }
    try {
      if (d.action === "close_wrong_number") {
        if (moves >= cfg.maxMovesPerDay) { entry.deferred = true; continue; }
        moves++;
        entry.did = "tagged wrong number + do not call, moved to Not Interested";
        if (options.dryRun) continue;
        await addContactTags(r.contactId, ["wrong number", "do not call"], ghl.locationId, ghl.apiKey).catch(() => {});
        const move = await moveToNotInterested(clientId, r.contactId, ghl).catch(() => null);
        if (!move || !move.moved) entry.did = "tagged wrong number + do not call (the card could not be moved: someone should move it)";
        await createContactNote(r.contactId, `Iris: ${d.why} — tagged "wrong number" and "do not call" and closed the card so nobody keeps calling.`, ghl.locationId, ghl.apiKey).catch(() => {});
        await query(`UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = 'wrong number', resolved_at = now() WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`, [clientId, r.contactId]).catch(() => {});
        await recordAction(clientId, r.contactId, r.name, "close_wrong_number", d.why);
      } else if (d.action === "park_not_ready") {
        if (moves >= cfg.maxMovesPerDay) { entry.deferred = true; continue; }
        moves++;
        entry.did = "moved to Not Ready";
        if (options.dryRun) continue;
        const moved = await moveToNotReady(clientId, r.contactId, ghl);
        if (!moved) { entry.did = "tried to move to Not Ready: the stage or card wasn't found, so someone should check"; await recordAction(clientId, r.contactId, r.name, "person", "could not move to Not Ready"); continue; }
        await createContactNote(r.contactId, `Iris: moved to Not Ready — ${d.why}. A person can pull them back any time.`, ghl.locationId, ghl.apiKey).catch(() => {});
        await query(`UPDATE iris_pending_calls SET status = 'skipped', resolution_reason = 'stuck-lead check: no answer, moved to Not Ready', resolved_at = now() WHERE client_id = $1 AND contact_id = $2 AND status = 'pending'`, [clientId, r.contactId]).catch(() => {});
        await recordAction(clientId, r.contactId, r.name, "park_not_ready", d.why);
      } else if (d.action === "call_again") {
        if (calls >= cfg.maxCallsPerDay) { entry.deferred = true; continue; }
        const lastCallAt = facts.calls.length ? Math.max(...facts.calls.map((c) => c.at)) : null;
        const startAt = retryStartAt(now, timeZone, lastCallAt);
        startAts[r.contactId] = startAt;
        calls++;
        entry.did = `call lined up for ${formatLocal(startAt.toISOString(), timeZone)}`;
        if (options.dryRun) continue;
        const placed = await queueColdLeadSweep(clientId, [r.contactId], startAt);
        if (placed.length === 0) {
          entry.diagnosed = { ...diagnosed, diagnosis: { action: "person", why: "I couldn't line up a call: no readable name or phone on the record" } };
          entry.did = undefined;
          await recordAction(clientId, r.contactId, r.name, "person", "no readable name or phone");
          continue;
        }
        await recordAction(clientId, r.contactId, r.name, "call_again", d.why);
      } else if (d.action === "text_follow_up") {
        if (texts >= cfg.maxTextsPerDay) { entry.deferred = true; continue; }
        if (!isWithinLegalCallingWindow(now, timeZone) && !options.dryRun) { entry.deferred = true; continue; }
        const lead = await refreshLead(r.contactId, clientId);
        if (!lead) { entry.diagnosed = { ...diagnosed, diagnosis: { action: "person", why: "I couldn't read their record to write a text" } }; continue; }
        const ctx: AsapLeadContext = {
          contactId: r.contactId,
          name: facts.name,
          firstName: extractFirstName(lead.name),
          stageName: facts.stageName,
          tags: facts.tags,
          dnd: facts.dnd,
          hasPhone: facts.hasPhone,
          createdAt: facts.createdAt,
          intent: lead.intent ?? null,
          budget: lead.budget,
          timeline: lead.timeline,
          propertyInterest: lead.propertyInterest,
          bedrooms: lead.bedrooms,
          financing: lead.financing,
          workingWithRealtor: lead.workingWithRealtor,
          notes: facts.notes,
          events: facts.events,
          calls: facts.calls.map((c) => ({ at: c.at, reached: c.leadTurns > 0, transcript: c.transcript })),
          irisQueue: facts.irisQueue ? { status: facts.irisQueue.status, callAfter: facts.irisQueue.callAfter } : null,
          hasUpcomingAppointment: facts.hasUpcomingAppointment,
          watchTexts: [],
        };
        const composed = await compose(ctx, now, timeZone);
        if (composed.text === null) {
          entry.diagnosed = { ...diagnosed, diagnosis: { action: "person", why: `I didn't text them (${composed.reason}): a person should look` } };
          if (!options.dryRun) await recordAction(clientId, r.contactId, r.name, "person", composed.reason);
          continue;
        }
        entry.text = composed.text;
        texts++;
        entry.did = `texted: “${composed.text}”`;
        if (options.dryRun) continue;
        const outcome = await sendIrisText(clientId, r.contactId, r.name, composed.text);
        if (outcome !== "delivered" && outcome !== "sent") {
          entry.diagnosed = { ...diagnosed, diagnosis: { action: "person", why: `the follow-up text did not go out (${outcome})` } };
          entry.did = undefined;
          continue;
        }
        await recordAction(clientId, r.contactId, r.name, "text_follow_up", composed.text);
        await openRowForReplies(clientId, r.contactId, lead, { source: STUCK_SOURCE, reason: "stuck-lead check: texted, waiting for a reply" });
        await appendNoteToContact(clientId, r.contactId, `Iris (stuck-lead check): texted "${composed.text}" because ${d.why}.`).catch(() => {});
      }
    } catch (error) {
      console.error(`[STUCK] ${r.name}:`, error instanceof Error ? error.message : error);
      entry.did = undefined;
      entry.deferred = true;
    }
  }

  // The missing tag, on every card that is not being closed. (A dry run changes nothing.)
  if (!options.dryRun) {
    for (const r of scanned) {
      if (r.diagnosed.tagsToAdd.length > 0 && r.diagnosed.diagnosis.action !== "leave") {
        await addContactTags(r.contactId, r.diagnosed.tagsToAdd, ghl.locationId, ghl.apiKey).catch(() => {});
      }
    }
  }
  return { scanned: scanned.length, entries, timeZone, startAts };
}

/** The Slack post: what was fixed, what waits for tomorrow, what needs a person. Null when there is nothing to say. */
export function formatStuckPost(r: StuckResult): string | null {
  if (r.skipped) return null;
  const did = r.entries.filter((e) => e.did && !e.deferred);
  const deferred = r.entries.filter((e) => e.deferred);
  const person = r.entries.filter((e) => e.diagnosed.diagnosis.action === "person");
  if (did.length === 0 && deferred.length === 0 && person.length === 0) return null;
  const left = r.entries.filter((e) => e.diagnosed.diagnosis.action === "leave").length;
  const lines = [`🧭 *Stuck-lead check:* I went through ${r.scanned} cards in the early stages; ${did.length} fixed, ${person.length} need a person, ${left} fine for now.`];
  const why = (e: StuckEntry) => e.diagnosed.diagnosis.why;
  const stage = (e: StuckEntry) => e.stageName.trim();
  if (did.length) {
    lines.push("", "*What I did:*");
    for (const e of did) lines.push(`• *${e.name}* (${stage(e)}): ${why(e)} → ${e.did}`);
  }
  if (deferred.length) lines.push("", `Over today's limit, first in line tomorrow: ${deferred.map((e) => `*${e.name}*`).join(", ")}.`);
  if (person.length) {
    lines.push("", "*Needs a person:*");
    for (const e of person) lines.push(`• *${e.name}* (${stage(e)}): ${why(e)}${e.diagnosed.problems.length ? ` _(${e.diagnosed.problems.join("; ")})_` : ""}`);
  }
  return lines.join("\n");
}

/** Scheduler entry point. One client failing never stops the next. */
export async function runStuckLeadCheckAll(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await import("fs")).readdirSync((await import("path")).join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    if (!loadIrisConfig(clientId)?.stuckLeads?.enabled) continue;
    try {
      const result = await runStuckLeadCheck(clientId);
      console.log(`[STUCK] ${clientId}: ${result.skipped ?? `${result.scanned} scanned, ${result.entries.filter((e) => e.did && !e.deferred).length} fixed`}.`);
      const post = formatStuckPost(result);
      if (post) await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text: post }).catch((error) => console.error("[STUCK] Slack post failed:", error instanceof Error ? error.message : error));
    } catch (error) {
      console.error(`[STUCK] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
