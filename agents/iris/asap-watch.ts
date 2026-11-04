/**
 * The ASAP watch. Mark, 2026-11-05: when a lead's buying timeline is ASAP, Iris keeps an eye on them: she reviews
 * their whole conversation (calls and texts), works out what we already know and where we are in the follow-up, and
 * texts them a follow-up based on that history instead of a generic nudge.
 *
 * Runs a few times a day (shared/scheduler). For every active lead whose timeline reads ASAP:
 *   1. read the thread (GHL texts + Iris's own calls) and what the notes already say
 *   2. decide whether a text is due, and say why not when it isn't (decideAsapText, pure, tested)
 *   3. have the model write ONE short text from that history (composeAsapText), checked before it can go out
 *   4. send it through sendIrisText (the same guards as every other Iris text) and keep the lead's queue row open
 *      so that a reply is answered by Iris's text handling
 *
 * It never calls, never moves a card, and never texts a lead a teammate is working, one with a booking ahead, one
 * who has asked to stop, or one it has already texted today. Off unless iris.asapWatch.enabled.
 */
import { query } from "../../shared/db";
import { ask } from "../../shared/claude";
import { outboundTextProblem } from "../../shared/ghl/outbound-guard";
import {
  getContact,
  getContactAppointments,
  getConversationMessages,
  getConversations,
  getCustomFieldDefs,
  getGhlConfig,
  listOpportunitiesInStage,
  listPipelines,
} from "../../shared/ghl";
import { sendMessage } from "../../shared/slack";
import { buildKeyToId, readField } from "../scout/intake";
import { refreshLead } from "../scout";
import { isWithinLegalCallingWindow } from "./cadence";
import { CALL_LOG_CHANNEL } from "./channels";
import { checkHumanTouch, DEFAULT_HUMAN_HANDS_OFF_DAYS } from "./human-touch";
import { loadClientBranding, loadIrisConfig } from "./index";
import { eventsFromIrisCalls, eventsFromMessages, isTestContact, ReviewEvent } from "./lead-review";
import { appendNoteToContact } from "./notes";
import { readAppointments } from "./no-show-state";
import { holdForTextReply } from "./dial-pending";
import { extractFirstName } from "./scripts";
import { sendIrisText } from "../../webhooks/vapi-webhook";

export interface AsapWatchConfig {
  enabled: boolean;
  /** Stages never watched: finished, booked, with an agent, or owned by another Iris flow. */
  skipStages: string[];
  /** Hours between two of Iris's texts to the same lead (default 24). */
  minHoursBetweenTexts?: number;
  /** Texts this watch will send one lead in all (default 6). */
  maxTexts?: number;
  /** After this many days of watching with no conversation, hand the lead to a person (default 14). */
  maxDays?: number;
  /** Local hours texts may go out: from (inclusive) to (exclusive). Defaults 10 to 19. */
  sendFromHour?: number;
  sendToHour?: number;
}

export const ASAP_SOURCE = "asap";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Iris just called: let the call (and her own missed-call text) breathe before another text. */
const AFTER_CALL_QUIET_MS = 4 * HOUR;
/** A call lined up this soon goes first. */
const CALL_SOON_MS = 6 * HOUR;
const MAX_TEXT_LENGTH = 320;

/** "ASAP", "as soon as possible", "immediately", "right away". */
export function isAsapTimeline(timeline: string | null | undefined): boolean {
  return /\basap\b|as soon as possible|immediate(?:ly)?|right away|right now/i.test(String(timeline ?? ""));
}

export interface AsapLeadContext {
  contactId: string;
  name: string;
  firstName: string;
  stageName: string;
  tags: string[];
  dnd: boolean;
  hasPhone: boolean;
  createdAt: number | null;
  intent: string | null;
  budget: string | null;
  timeline: string | null;
  propertyInterest: string | null;
  bedrooms: string | null;
  financing: string | null;
  workingWithRealtor: boolean | null;
  notes: string;
  events: ReviewEvent[];
  /** Iris's call transcripts, oldest first (the calls themselves are also in `events`). */
  calls: { at: number; reached: boolean; transcript: string }[];
  irisQueue: { status: string; callAfter: number | null } | null;
  hasUpcomingAppointment: boolean;
  /** Texts this watch already sent this lead, oldest first. */
  watchTexts: { sentAt: number; text: string }[];
}

export type AsapDecision = { send: true } | { send: false; reason: string; needsPerson?: boolean };

/** Whether a text is due, and if not, why. Pure. */
export function decideAsapText(ctx: AsapLeadContext, cfg: AsapWatchConfig, now: Date, timeZone: string): AsapDecision {
  const t = now.getTime();
  const minGap = (cfg.minHoursBetweenTexts ?? 24) * HOUR;
  const maxTexts = cfg.maxTexts ?? 6;
  const maxDays = cfg.maxDays ?? 14;

  if (ctx.dnd || ctx.tags.some((x) => /do not call|opted out|unsubscribed|stop/i.test(x))) return { send: false, reason: "do not contact" };
  if (!ctx.hasPhone) return { send: false, reason: "no phone number" };
  if (ctx.hasUpcomingAppointment) return { send: false, reason: "already has an appointment booked" };

  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour < (cfg.sendFromHour ?? 10) || hour >= (cfg.sendToHour ?? 19) || !isWithinLegalCallingWindow(now, timeZone)) return { send: false, reason: "outside text hours" };

  const events = ctx.events;
  const last = events.at(-1);
  // They had the last word and nobody has answered: that is an answer to write, not a nudge. Iris's text handling
  // answers a live reply, and the lead review flags one that slipped through.
  if (last && last.direction === "in" && last.kind === "sms") return { send: false, reason: "they texted last and are waiting on an answer", needsPerson: true };

  const humanOut = events.filter((e) => e.direction === "out" && e.actor === "human");
  if (humanOut.length && t - humanOut[humanOut.length - 1].at < DEFAULT_HUMAN_HANDS_OFF_DAYS * DAY) return { send: false, reason: "a teammate has been in touch" };

  const irisOut = events.filter((e) => e.direction === "out" && (e.actor === "app" || e.actor === "iris_call"));
  const lastIrisText = [...irisOut].reverse().find((e) => e.kind === "sms");
  const lastIrisCall = [...irisOut].reverse().find((e) => e.kind === "call");
  if (lastIrisText && t - lastIrisText.at < minGap) return { send: false, reason: "Iris texted them within the last day" };
  if (lastIrisCall && t - lastIrisCall.at < AFTER_CALL_QUIET_MS) return { send: false, reason: "Iris just called them" };
  if (ctx.irisQueue?.status === "placed") return { send: false, reason: "a call is in progress" };
  if (ctx.irisQueue?.status === "pending" && ctx.irisQueue.callAfter !== null && ctx.irisQueue.callAfter < t + CALL_SOON_MS) return { send: false, reason: "a call is lined up shortly" };

  if (ctx.watchTexts.length >= maxTexts) return { send: false, reason: `already sent ${maxTexts} follow-up texts`, needsPerson: true };
  const first = ctx.watchTexts[0];
  if (first && t - first.sentAt > maxDays * DAY) return { send: false, reason: `${maxDays} days of follow-up without a conversation`, needsPerson: true };

  return { send: true };
}

const shortDay = (ms: number, timeZone: string): string => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);

/** The conversation so far, oldest first, in plain words, for the model (and for a person reading the dry run). */
export function buildAsapThread(ctx: AsapLeadContext, timeZone: string): string {
  const lines: string[] = [];
  let callIndex = 0;
  for (const e of ctx.events) {
    const when = shortDay(e.at, timeZone);
    if (e.kind === "call" && e.actor === "iris_call") {
      const call = ctx.calls.find((c) => Math.abs(c.at - e.at) < 60_000) ?? ctx.calls[callIndex];
      callIndex++;
      if (e.reached && call?.transcript) lines.push(`[${when}] Iris CALL, they answered:\n${call.transcript.trim().slice(0, 1800)}`);
      else lines.push(`[${when}] Iris CALL, no answer${call?.transcript && /voice ?mail|leave a message/i.test(call.transcript) ? " (went to voicemail)" : ""}`);
      continue;
    }
    if (!e.text && e.kind !== "call") continue;
    const who = e.direction === "in" ? "LEAD" : e.actor === "human" ? "TEAMMATE" : e.actor === "automation" ? "AUTOMATED TEXT" : "IRIS";
    if (e.kind === "call") lines.push(`[${when}] ${who} phone call${e.reached ? ", they were reached" : ", not reached"}`);
    else lines.push(`[${when}] ${who} ${e.kind}: ${e.text.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  return lines.join("\n") || "(no messages or calls yet)";
}

/** Where we are in the follow-up, in a few facts the model can lean on. */
export function whereWeAre(ctx: AsapLeadContext, now: Date, timeZone: string): string[] {
  const t = now.getTime();
  const calls = ctx.events.filter((e) => e.actor === "iris_call");
  const answered = calls.filter((e) => e.reached);
  const out: string[] = [`Stage: ${ctx.stageName}`];
  if (ctx.createdAt) out.push(`Came in ${Math.max(0, Math.round((t - ctx.createdAt) / DAY))} days ago`);
  out.push(`Iris has called ${calls.length} time${calls.length === 1 ? "" : "s"}; they picked up ${answered.length}`);
  const texts = ctx.events.filter((e) => e.direction === "out" && e.kind === "sms" && e.actor === "app").length;
  out.push(`Iris has texted ${texts} time${texts === 1 ? "" : "s"}; the lead has texted ${ctx.events.filter((e) => e.direction === "in" && e.kind === "sms").length} time(s)`);
  if (ctx.irisQueue?.status === "pending" && ctx.irisQueue.callAfter !== null) out.push(`A call is lined up for ${shortDay(ctx.irisQueue.callAfter, timeZone)}`);
  return out;
}

/** What we already know, and what is still missing, from the form and the notes. */
export function knownAndMissing(ctx: AsapLeadContext): { known: string[]; missing: string[] } {
  const known: string[] = [];
  const missing: string[] = [];
  const add = (label: string, value: string | null | undefined, need: string) => (value ? known.push(`${label}: ${value}`) : missing.push(need));
  add("Timeline", ctx.timeline, "timeline");
  if (ctx.intent !== "seller") {
    add("Budget", ctx.budget, "budget");
    add("Pre-approval", ctx.financing, "pre-approval");
  }
  add("Property type", ctx.propertyInterest, "property type");
  add("Bedrooms", ctx.bedrooms, "bedrooms");
  if (ctx.workingWithRealtor !== null) known.push(`Working with a realtor: ${ctx.workingWithRealtor ? "yes" : "no"}`);
  else missing.push("whether they already have a realtor");
  // Area is never a form field here: it lives only in the conversation and the notes.
  if (!/\barea\b|neighbou?rhood|mount pearl|paradise|cbs|torbay|st\.? john|goulds|kilbride|conception bay/i.test(`${ctx.notes} ${ctx.events.map((e) => e.text).join(" ")}`)) missing.push("area");
  return { known, missing };
}

export const COMPOSER_SYSTEM = `You write ONE follow-up text message for Iris, a virtual assistant for a real estate brokerage, to send to a lead who says they want to buy ASAP.

You are given everything that has happened with this lead: their messages, Iris's calls (with what was said when they answered), automated texts, and what is known and still missing. Write the single text that best moves them toward a short conversation with an agent.

Rules:
- Base it on the history. If they answered a call and told us things, refer to something real from it ("you mentioned you work days") and never ask again for something they already told us. If they never picked up, say so lightly and offer an easy way to connect (a better time, or just texting).
- If they asked for a particular time or said when they are free, use it. If they said they cannot talk at some time of day, do not suggest that time.
- If they named a window ("weekday late afternoon", "after 4"), propose ONE specific time inside it as a question ("Would tomorrow around 4:30 work?"); never hand the choice back to them as an open "what's a good time".
- If they said they are just looking, will reach out themselves, or asked for space, keep it light and low-pressure (offer to send a few homes that fit, or ask one easy question) rather than pushing for a call.
- Ask for at most ONE thing: either a time that suits them for a quick call with an agent, OR one missing detail (prefer a specific budget number or a particular month, never a range). Never two questions.
- 1 or 2 short sentences, 220 characters or fewer, casual and warm, like a person texting. Start with "Hi {first name}," only if the thread does not already show Iris texting today.
- Say you are Iris from the brokerage only if no earlier text from Iris appears in the thread.
- Never invent facts, prices, listings, availability or an appointment. Never promise a call at a time that is not already lined up. Never mention being an AI unless asked.
- Plain text only: no emojis, no lists, no quotes, no "Reply STOP" line, no links.
- If there is truly nothing useful to say right now (for example they clearly said they are no longer interested), reply with exactly: SKIP

Reply with the text message only.`;

/** What the model is shown for one lead. */
export function composerInput(ctx: AsapLeadContext, now: Date, timeZone: string): string {
  const { known, missing } = knownAndMissing(ctx);
  return `Lead: ${ctx.name} (first name: ${ctx.firstName})
Wants to: ${ctx.intent === "seller" ? "sell" : "buy"}, timeline ASAP
Where we are in the follow-up:
${whereWeAre(ctx, now, timeZone).map((l) => `- ${l}`).join("\n")}

Already known:
${known.map((k) => `- ${k}`).join("\n") || "- nothing beyond the form"}
Still missing: ${missing.join(", ") || "nothing important"}
${ctx.notes ? `\nNotes on the record:\n${ctx.notes.slice(0, 900)}\n` : ""}
The conversation so far (oldest first; times are the client's local time; it is now ${shortDay(now.getTime(), timeZone)}):
${buildAsapThread(ctx, timeZone)}`;
}

/** The checks every composed text must pass before it can go out. Returns the problem, or null. */
export function asapTextProblem(text: string, ctx: Pick<AsapLeadContext, "contactId" | "firstName">): string | null {
  const bad = outboundTextProblem(text, ctx.contactId);
  if (bad) return bad;
  const t = text.trim();
  if (t.length > MAX_TEXT_LENGTH) return `too long (${t.length} characters)`;
  if ((t.match(/\?/g) ?? []).length > 1) return "asks more than one question";
  if (/\bstop\b.*\bopt|reply stop|unsubscribe/i.test(t)) return "contains an opt-out line";
  if (/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(t)) return "contains an emoji";
  if (/\n/.test(t)) return "is not a single message";
  if (/https?:\/\/|www\./i.test(t)) return "contains a link";
  if (/\b(?:as an ai|i am an ai|language model)\b/i.test(t)) return "talks about being an AI";
  return null;
}

/** Cleans the model's reply into a sendable text, or null for SKIP / unusable. */
export function cleanComposedText(raw: string): string | null {
  const t = raw.trim().replace(/^["“]|["”]$/g, "").trim();
  if (!t || /^skip\b/i.test(t)) return null;
  return t;
}

export type TextGenerator = (system: string, input: string) => Promise<string>;
const askModel: TextGenerator = (system, input) => ask(system, input, { maxTokens: 220, temperature: 0.5 });

/** Writes the text, checks it, and gives the model one more go when a check fails (it told them what was wrong). */
export async function composeAsapText(ctx: AsapLeadContext, now: Date, timeZone: string, generate: TextGenerator = askModel): Promise<{ text: string } | { text: null; reason: string }> {
  const input = composerInput(ctx, now, timeZone);
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await generate(COMPOSER_SYSTEM, attempt === 0 ? input : `${input}\n\nYour previous attempt was rejected because it ${problem}. Write a different text that fixes that.`);
    } catch (error) {
      return { text: null, reason: `the model could not be reached: ${error instanceof Error ? error.message : error}` };
    }
    const text = cleanComposedText(raw);
    if (!text) return { text: null, reason: "the model chose not to text them" };
    const bad = asapTextProblem(text, ctx);
    if (!bad) return { text };
    problem = bad;
  }
  return { text: null, reason: `the written text was rejected: ${problem}` };
}

// ─── The scan ───

export interface AsapWatchEntry {
  contactId: string;
  name: string;
  stageName: string;
  decision: AsapDecision;
  text?: string;
  outcome?: "delivered" | "sent" | "failed" | "skipped" | "dry-run";
  composeReason?: string;
}

export interface AsapWatchResult {
  watched: number;
  entries: AsapWatchEntry[];
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Makes sure a reply to the text we just sent is answered by Iris: her text handling only answers leads whose queue row is pending. */
export async function openRowForReplies(clientId: string, contactId: string, lead: unknown): Promise<void> {
  const rows = await query<{ id: number; status: string }>(`SELECT id, status FROM iris_pending_calls WHERE client_id = $1 AND contact_id = $2`, [clientId, contactId]);
  if (rows[0]) {
    if (rows[0].status !== "pending") await holdForTextReply(rows[0].id);
    return;
  }
  await query(
    `INSERT INTO iris_pending_calls (client_id, contact_id, lead, call_after, status, is_explicit_callback, source, sms_scheduled, resolution_reason)
     VALUES ($1, $2, $3, 'infinity', 'pending', true, $4, false, 'ASAP watch: texted, waiting for a reply')
     ON CONFLICT (client_id, contact_id) DO NOTHING`,
    [clientId, contactId, JSON.stringify(lead), ASAP_SOURCE]
  );
}

export async function runAsapWatch(clientId: string, options: { now?: Date; dryRun?: boolean; only?: string[]; compose?: boolean; composer?: (ctx: AsapLeadContext, now: Date, timeZone: string) => ReturnType<typeof composeAsapText> } = {}): Promise<AsapWatchResult> {
  const now = options.now ?? new Date();
  const irisConfig = loadIrisConfig(clientId);
  const cfg = irisConfig?.asapWatch;
  const branding = loadClientBranding(clientId);
  const ghl = await getGhlConfig(clientId);
  if (!irisConfig || !cfg || !branding || !ghl) return { watched: 0, entries: [] };
  const timeZone = irisConfig.timezone || "America/St_Johns";
  const skip = new Set(cfg.skipStages.map((s) => s.toLowerCase()));
  const keyToId = buildKeyToId(await getCustomFieldDefs(ghl.locationId, ghl.apiKey));

  const cards = new Map<string, string>();
  for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
    for (const s of p.stages ?? []) {
      if (skip.has(String(s.name).toLowerCase())) continue;
      for (const o of await listOpportunitiesInStage(ghl.locationId, p.id, s.id, ghl.apiKey)) {
        if (o?.status === "lost" || o?.status === "won") continue;
        const id = o.contactId ?? o.contact?.id;
        if (id && !cards.has(id)) cards.set(id, String(s.name));
      }
    }
  }

  const calls = await query<{ contact_id: string; created_at: Date; ended_reason: string | null; transcript: string | null }>(
    `SELECT contact_id, created_at, ended_reason, transcript FROM iris_call_log WHERE client_id = $1 AND created_at > now() - interval '90 days' ORDER BY created_at`,
    [clientId]
  );
  const callsBy = new Map<string, typeof calls>();
  for (const c of calls) callsBy.set(c.contact_id, [...(callsBy.get(c.contact_id) ?? []), c]);
  const queue = await query<{ contact_id: string; status: string; call_after: unknown }>(`SELECT contact_id, status, call_after FROM iris_pending_calls WHERE client_id = $1`, [clientId]);
  const queueBy = new Map(queue.map((q) => [q.contact_id, q]));
  // The table is created at boot from schema.sql; until then (a dry run just ahead of a deploy) nothing has been sent.
  const sentRows = await query<{ contact_id: string; sent_at: Date; text: string }>(`SELECT contact_id, sent_at, text FROM asap_watch_texts WHERE client_id = $1 ORDER BY sent_at`, [clientId]).catch((error) => {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  });
  const sentBy = new Map<string, { sentAt: number; text: string }[]>();
  for (const r of sentRows) sentBy.set(r.contact_id, [...(sentBy.get(r.contact_id) ?? []), { sentAt: new Date(r.sent_at).getTime(), text: r.text }]);
  const snoozed = new Set(
    (await query<{ contact_id: string }>(`SELECT contact_id FROM lead_review_snoozes WHERE client_id = $1 AND until > now()`, [clientId])).map((r) => r.contact_id)
  );

  const ids = [...cards.keys()].filter((id) => !options.only || options.only.includes(id));
  const results = await pool(ids, 4, async (contactId): Promise<AsapWatchEntry | null> => {
    try {
      const lead = await refreshLead(contactId, clientId);
      if (!lead || !isAsapTimeline(lead.timeline)) return null;
      const rawContact = await getContact(contactId, ghl.locationId, ghl.apiKey);
      const contact = rawContact?.contact ?? rawContact;
      if (!contact) return null;
      if (snoozed.has(contactId) || isTestContact(contact, irisConfig.leadReview?.excludeEmailDomains) || irisConfig.leadReview?.excludeContactIds?.includes(contactId)) return null;

      const convo = await getConversations(contactId, ghl.locationId, ghl.apiKey);
      const convId = convo?.conversations?.[0]?.id;
      const messages: any[] = convId ? (await getConversationMessages(convId, ghl.locationId, ghl.apiKey, 80))?.messages?.messages ?? [] : [];
      const irisCalls = callsBy.get(contactId) ?? [];
      const events = [...eventsFromMessages(messages), ...eventsFromIrisCalls(irisCalls)].sort((a, b) => a.at - b.at);
      const q = queueBy.get(contactId);
      const rawAfter = q?.call_after as unknown;
      const callAfter = rawAfter instanceof Date ? rawAfter.getTime() : typeof rawAfter === "string" ? (/inf/i.test(rawAfter) ? null : Date.parse(rawAfter)) : typeof rawAfter === "number" && Number.isFinite(rawAfter) ? rawAfter : null;
      const appointments = await getContactAppointments(contactId, ghl.locationId, ghl.apiKey).catch(() => []);
      const name = lead.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contactId;

      const ctx: AsapLeadContext = {
        contactId,
        name,
        firstName: extractFirstName(lead.name),
        stageName: cards.get(contactId) ?? "",
        tags: (contact.tags ?? []).map((t: string) => String(t)),
        dnd: contact.dnd === true,
        hasPhone: Boolean(contact.phone),
        createdAt: contact.dateAdded ? Date.parse(contact.dateAdded) : null,
        intent: lead.intent ?? null,
        budget: lead.budget,
        timeline: lead.timeline,
        propertyInterest: lead.propertyInterest,
        bedrooms: lead.bedrooms,
        financing: lead.financing,
        workingWithRealtor: lead.workingWithRealtor,
        notes: String(readField(contact.customFields, irisConfig.callbackNotesFieldKey, keyToId) ?? ""),
        events,
        calls: irisCalls.map((c) => ({ at: new Date(c.created_at).getTime(), reached: events.some((e) => e.actor === "iris_call" && Math.abs(e.at - new Date(c.created_at).getTime()) < 1000 && e.reached), transcript: c.transcript ?? "" })),
        irisQueue: q ? { status: q.status, callAfter: callAfter !== null && Number.isFinite(callAfter) ? callAfter : null } : null,
        hasUpcomingAppointment: Boolean(readAppointments(appointments, now, timeZone).upcoming),
        watchTexts: sentBy.get(contactId) ?? [],
      };

      const decision = decideAsapText(ctx, cfg, now, timeZone);
      const entry: AsapWatchEntry = { contactId, name, stageName: ctx.stageName, decision };
      if (!decision.send) return entry;

      // A teammate working the lead right now outranks every rule above; re-read the live thread.
      const touch = await checkHumanTouch(contactId, ghl.locationId, ghl.apiKey, irisConfig.humanHandsOffDays ?? DEFAULT_HUMAN_HANDS_OFF_DAYS, now);
      if (touch.status !== "none") return { ...entry, decision: { send: false, reason: touch.status === "human" ? "a teammate has been in touch" : "couldn't verify no teammate is texting them" } };

      if (options.compose === false) return entry;
      const composed = await (options.composer ?? composeAsapText)(ctx, now, timeZone);
      if (composed.text === null) return { ...entry, decision: { send: false, reason: composed.reason }, composeReason: composed.reason };
      entry.text = composed.text;
      if (options.dryRun) return { ...entry, outcome: "dry-run" };

      const outcome = await sendIrisText(clientId, contactId, name, composed.text);
      entry.outcome = outcome;
      if (outcome === "delivered" || outcome === "sent") {
        await query(`INSERT INTO asap_watch_texts (client_id, contact_id, text, outcome) VALUES ($1, $2, $3, $4)`, [clientId, contactId, composed.text, outcome]);
        await openRowForReplies(clientId, contactId, lead);
        await appendNoteToContact(clientId, contactId, `Iris (ASAP follow-up): texted "${composed.text}" based on the call and text history.`).catch(() => {});
      }
      return entry;
    } catch (error) {
      console.error(`[ASAP] ${contactId}:`, error instanceof Error ? error.message : error);
      return null;
    }
  });

  return { watched: results.filter((r) => r !== null).length, entries: results.filter((r): r is AsapWatchEntry => r !== null) };
}

/** What gets posted after a real run: who was texted, and who now needs a person. */
export function formatAsapWatchPost(result: AsapWatchResult): string | null {
  const sent = result.entries.filter((e) => e.outcome === "delivered" || e.outcome === "sent");
  const person = result.entries.filter((e) => !e.decision.send && e.decision.needsPerson);
  if (sent.length === 0 && person.length === 0) return null;
  const lines = [`⚡ *ASAP watch:* ${result.watched} ASAP lead${result.watched === 1 ? "" : "s"} watched.`];
  if (sent.length) {
    lines.push(`Texted ${sent.length}:`);
    for (const e of sent) lines.push(`• *${e.name}* (${e.stageName}): “${e.text}”`);
  }
  if (person.length) {
    lines.push(`Needs a person:`);
    for (const e of person) lines.push(`• *${e.name}* (${e.stageName}): ${(e.decision as { reason: string }).reason}`);
  }
  return lines.join("\n");
}

/** Scheduler entry point. One client failing never stops the next. */
export async function runAsapWatchAll(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await import("fs")).readdirSync((await import("path")).join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    if (!loadIrisConfig(clientId)?.asapWatch?.enabled) continue;
    try {
      const result = await runAsapWatch(clientId);
      const post = formatAsapWatchPost(result);
      console.log(`[ASAP] ${clientId}: ${result.watched} watched, ${result.entries.filter((e) => e.outcome === "delivered" || e.outcome === "sent").length} texted.`);
      if (post) await sendMessage("iris", { channel: CALL_LOG_CHANNEL, text: post }).catch((error) => console.error("[ASAP] Slack post failed:", error instanceof Error ? error.message : error));
    } catch (error) {
      console.error(`[ASAP] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
