/**
 * Ember's send path — one nurture touch at a time, under a daily cap with
 * jittered spacing. Ported from agents/quarry/outreach.ts; the differences
 * are all about who is on the other end. Quarry texts strangers once or
 * twice; Ember texts a client's own past inquiries over months, so:
 *
 *   - every touch re-reads the live GHL card and contact first — a deal a
 *     human moved since the last scan, or a contact who set DND, never gets
 *     the text;
 *   - the CASL consent window is checked per send, not just at enrollment;
 *   - Ember never writes a reply itself. A clear "no" opts out; any other
 *     reply stops the cadence and goes to Iris, who qualifies them by text
 *     and calls for a live transfer (handoff.ts), with an alert to
 *     #backend-ops either way.
 */
import { classifyReply, ReplySentiment } from "../quarry/outreach";
import type { OutcomeStageMap } from "../forge/ads/attribution";
import { CourtesyTemplates, EmberConfig, renderTemplate, scriptKindFor } from "./config";
import { AlertFn, formatReactivationAlert, markExited, markReactivated } from "./alerts";
import { detectChange } from "./scan";
import { logSend, sendsToday, updateLead } from "./store";
import { GhlOpportunityLite, NurtureChannel, NurtureLead } from "./types";
import { NotInterestedCategory, StatusDecision } from "./status";
import { moveToNotInterested, MoveStageFn } from "./notinterested";
import {
  consentStart,
  EMPTY_CONTEXT,
  findTemporaryPause,
  HistoryDecision,
  HistoryMessage,
  LeadContext,
  ReviewContext,
} from "./history";

/** Appended to an AI-written personal opener; the scripts carry their own. */
export const STOP_LINE = "Reply STOP to opt out.";

const DAY_MS = 86_400_000;

/** The live GHL state a touch is checked against right before sending. */
export interface LiveContact {
  firstName: string | null;
  phone: string | null;
  email: string | null;
  /**
   * GHL's contact-level DND switch, plus per-channel settings
   * ({ SMS: { status: "active" | "inactive" | "permanent" }, Email: ... }).
   * Shape per HighLevel's contact API reference — the one live contact
   * checked on 2026-09-23 had neither field set at all, which is how GHL
   * returns a contact with no DND, so "absent" is read as "not blocked".
   */
  dnd?: boolean;
  dndSettings?: Record<string, { status?: string } | undefined>;
}

export interface LiveContext {
  contact: LiveContact;
  opportunity: GhlOpportunityLite;
}

export interface OutreachDeps {
  /** null when the opportunity no longer exists in GHL. */
  loadLive(lead: NurtureLead): Promise<LiveContext | null>;
  sendSMS(contactId: string, message: string): Promise<any>;
  sendEmail(contactId: string, subject: string, html: string, fromEmail: string): Promise<any>;
  alert: AlertFn;
  wait(ms: number): Promise<void>;
  /** The lead's real texts/emails in GHL, oldest first (history.ts). */
  readHistory(lead: NurtureLead): Promise<HistoryMessage[]>;
  /** Decides defer / script / personal opener from that history (history.ts). */
  reviewHistory(messages: HistoryMessage[], ctx: ReviewContext): Promise<HistoryDecision>;
  /** Where they stand in the CRM: stage, notes, Iris calls (context.ts). */
  readContext(lead: NurtureLead, opportunity: GhlOpportunityLite): Promise<LeadContext>;
  /** Clear-evidence Not Interested check (status.ts). */
  classifyStatus(messages: HistoryMessage[]): Promise<StatusDecision>;
  /** Moves a GHL card to a stage by name. */
  moveStage: MoveStageFn;
}

export type TouchPlan =
  /** body set = a personal opener replacing the script. */
  | { kind: "send"; body?: string; reason: string }
  /** Clear evidence they're no longer a prospect — move to Not Interested, never contact again (status.ts). */
  | { kind: "not_interested"; category: NotInterestedCategory; evidence: string; by: "rule" | "ai"; reason: string }
  /** "Not now" — restart the cycle from scratch on `until`. */
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "no_consent"; reason: string }
  | { kind: "retry"; reason: string };

/**
 * Everything that decides what (if anything) this touch says, in order:
 *
 *   1. Clear evidence they're no longer a prospect — a stop request,
 *      another agent, bought, sold, no longer looking (status.ts, Mark's
 *      2026-10-01 rule) → moved to Not Interested, never contacted again.
 *      Checked first: moving a card isn't messaging, so it applies even to
 *      a lead past the consent window.
 *   2. CASL consent from the latest real inquiry (consentStart) → parked
 *      as no_consent if it's run out.
 *   3. A temporary "not right now" inside the cool-off → deferred to that
 *      message + reApproachAfterDays, then worked again from scratch.
 *   4. First touch of a cycle only: the model reads history + CRM context
 *      and picks defer / script / personal opener. Later touches use the
 *      approved scripts.
 *
 * Shared by sendTouch and the dry-run preview, so what a human approves in
 * the preview is exactly what the send path does.
 */
export async function planTouch(input: {
  lead: NurtureLead;
  contact: LiveContact;
  history: HistoryMessage[];
  context: LeadContext;
  config: EmberConfig;
  now: Date;
  review: (messages: HistoryMessage[], ctx: ReviewContext) => Promise<HistoryDecision>;
  classify: (messages: HistoryMessage[]) => Promise<StatusDecision>;
}): Promise<TouchPlan> {
  const { lead, contact, history, context, config, now } = input;

  const status = await input.classify(history);
  if (status.verdict === "not_interested") {
    return { kind: "not_interested", category: status.category, evidence: status.evidence, by: status.by, reason: `said "${status.evidence.slice(0, 80)}"` };
  }
  // A possible clear no the model couldn't confirm: neither move nor text.
  if (status.verdict === "unsure") return { kind: "retry", reason: status.reason };

  const from = consentStart(lead.inquiryAt, history);
  if (from && now.getTime() - new Date(from).getTime() >= config.consentWindowDays * DAY_MS) {
    return { kind: "no_consent", reason: `last inquiry ${from.slice(0, 10)} is past the ${config.consentWindowDays}-day consent window` };
  }

  const decline = findTemporaryPause(history);
  const coolOffMs = config.reApproachAfterDays * DAY_MS;
  if (decline?.at && now.getTime() - new Date(decline.at).getTime() < coolOffMs) {
    return {
      kind: "defer",
      until: new Date(new Date(decline.at).getTime() + coolOffMs),
      reason: `said "${decline.body.slice(0, 80)}" on ${decline.at.slice(0, 10)} — trying again after ${config.reApproachAfterDays} days`,
    };
  }

  if (lead.touchCount > 0) return { kind: "send", reason: "follow-up touch — approved script" };

  const decision = await input.review(history, {
    firstName: firstNameOf(lead, contact),
    brandName: config.outreach.senderName,
    intent: lead.intent,
    stopLine: STOP_LINE,
    now,
    lead: context,
    priorDecline: decline,
  });
  switch (decision.action) {
    case "retry":
      return { kind: "retry", reason: decision.reason };
    case "defer":
      return { kind: "defer", until: new Date(now.getTime() + coolOffMs), reason: decision.reason };
    case "personalized":
      return { kind: "send", body: decision.message, reason: decision.reason };
    default:
      return { kind: "send", reason: decision.reason };
  }
}

/**
 * Puts a lead back to the start of the cadence on `until` — touchCount 0,
 * so the next cycle opens with a fresh history + CRM review rather than
 * picking up the old cycle's third check-in.
 */
async function deferLead(lead: NurtureLead, until: Date, reason: string): Promise<void> {
  await updateLead(lead.id, {
    status: "nurturing",
    touchCount: 0,
    nextTouchAt: until.toISOString(),
    statusReason: `cooling off until ${until.toISOString().slice(0, 10)}: ${reason}`,
  });
}

export interface TouchContext {
  config: EmberConfig;
  clientName: string;
  outcomeStages?: OutcomeStageMap;
  stageNames: Record<string, string>;
  now?: Date;
}

export interface SendOutcome {
  leadId: number;
  sent: boolean;
  channel?: NurtureChannel;
  skippedReason?: string;
  error?: string;
}

function blocked(contact: LiveContact, channel: "SMS" | "Email"): boolean {
  if (contact.dnd === true) return true;
  const status = contact.dndSettings?.[channel]?.status;
  return status === "active" || status === "permanent";
}

/**
 * SMS whenever the contact has a phone and hasn't blocked it — these are
 * people who texted or called about a home, and a text is how the team
 * already talks to them. Email is the fallback, and only if configured.
 */
export function pickChannel(contact: LiveContact, config: EmberConfig): NurtureChannel | null {
  const { sms, email } = config.outreach;
  if (sms.enabled && contact.phone && !blocked(contact, "SMS")) return "sms";
  if (email.enabled && contact.email && !blocked(contact, "Email")) return "email";
  return null;
}

function templateAt<T>(templates: T[], index: number): T {
  return templates[Math.min(index, templates.length - 1)];
}

/** "Jordan Smith" → "Jordan"; nothing usable → "there" ("Hi there,"). */
/**
 * "JACOB" → "Jacob", "sarah" → "Sarah"; anything already mixed-case
 * ("McKenzie", "DeShawn") is left alone. Found 2026-10-01: the test
 * account's JACOB EDEN contact would have been texted "Hi JACOB," — a
 * shouted name reads as a mail merge, exactly what a nurture text must not.
 */
export function displayName(name: string): string {
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

function firstNameOf(lead: NurtureLead, contact: LiveContact): string {
  const fromContact = contact.firstName?.trim();
  if (fromContact) return displayName(fromContact);
  const fromName = lead.contactName?.trim().split(/\s+/)[0];
  return fromName ? displayName(fromName) : "there";
}

export function buildMessage(
  lead: NurtureLead,
  contact: LiveContact,
  channel: NurtureChannel,
  touchIndex: number,
  config: EmberConfig
): { subject?: string; body: string } {
  const vars = {
    firstName: firstNameOf(lead, contact),
    senderName: config.outreach.senderName,
    unsubscribeUrl: `${process.env.PUBLIC_BASE_URL ?? ""}/api/ember/unsubscribe/${lead.unsubscribeToken}`,
    physicalAddress: config.outreach.email.physicalAddress,
  };
  if (channel === "sms") {
    const scripts = config.outreach.sms.scripts[scriptKindFor(lead.intent)];
    return { body: renderTemplate(templateAt(scripts, touchIndex), vars) };
  }
  const t = templateAt(config.outreach.email.templates, touchIndex);
  return { subject: renderTemplate(t.subject, vars), body: renderTemplate(t.html, vars) };
}

/**
 * When the touch after `sentIndex` is due: the configured GAP from this
 * send, not an absolute offset from enrollment — see touchScheduleDays in
 * config.ts for why. null when that was the last touch.
 */
export function nextTouchAfterSend(sentAt: Date, sentIndex: number, schedule: number[]): Date | null {
  const next = sentIndex + 1;
  if (next >= schedule.length) return null;
  const gapDays = Math.max(0, schedule[next] - schedule[sentIndex]);
  return new Date(sentAt.getTime() + gapDays * DAY_MS);
}

/**
 * Whether `now` is inside the configured local send window. Evaluated in
 * the client's timezone via Intl, so DST is handled without a date library.
 */
export function inSendWindow(now: Date, config: EmberConfig): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, hour: "numeric", hourCycle: "h23" }).format(now)
  );
  return hour >= config.sendWindow.startHour && hour < config.sendWindow.endHour;
}

/**
 * Sends one nurture touch, or explains why not. Everything that could make
 * the touch wrong is checked here, immediately before sending — the row
 * may be up to an hour stale relative to GHL.
 */
export async function sendTouch(lead: NurtureLead, deps: OutreachDeps, ctx: TouchContext): Promise<SendOutcome> {
  const { config } = ctx;
  const now = ctx.now ?? new Date();
  const schedule = config.outreach.touchScheduleDays;
  const skip = (reason: string): SendOutcome => ({ leadId: lead.id, sent: false, skippedReason: reason });

  if (lead.status !== "nurturing") return skip(`status is ${lead.status}`);
  if (lead.touchCount >= schedule.length) {
    await updateLead(lead.id, { status: "completed", statusReason: "cadence finished", nextTouchAt: null });
    return skip("cadence already finished");
  }
  if (lead.nextTouchAt && new Date(lead.nextTouchAt).getTime() > now.getTime()) return skip("not due yet");

  const live = await deps.loadLive(lead);
  if (!live) {
    await markExited(lead, "opportunity no longer exists in GHL");
    return skip("opportunity gone");
  }

  const change = detectChange(lead, live.opportunity, ctx);
  if (change.kind === "exited") {
    await markExited(lead, change.reason);
    return skip(change.reason);
  }
  if (change.kind === "reactivated") {
    await markReactivated(lead, change.reason, { clientName: ctx.clientName, alert: deps.alert, now });
    return skip(change.reason);
  }

  const channel = pickChannel(live.contact, config);
  if (!channel) {
    const anyDnd = blocked(live.contact, "SMS") || blocked(live.contact, "Email");
    await updateLead(lead.id, {
      status: anyDnd ? "opted_out" : "exited",
      statusReason: anyDnd ? "DND set in GHL" : "no reachable channel",
      nextTouchAt: null,
    });
    return skip(anyDnd ? "DND in GHL" : "no reachable channel");
  }

  const touchIndex = lead.touchCount;

  // Mark, 2026-09-24: read what they've actually said, and where they
  // stand in the CRM, before texting — see planTouch for the rules.
  let history: HistoryMessage[];
  try {
    history = await deps.readHistory(lead);
  } catch (error) {
    // Unknown history is not "no history" — wait for the next run.
    return skip(`could not read conversation history: ${error instanceof Error ? error.message : String(error)}`);
  }
  const context = touchIndex === 0 ? await deps.readContext(lead, live.opportunity).catch(() => EMPTY_CONTEXT) : EMPTY_CONTEXT;
  const plan = await planTouch({ lead, contact: live.contact, history, context, config, now, review: deps.reviewHistory, classify: deps.classifyStatus });

  if (plan.kind === "retry") return skip(plan.reason);
  if (plan.kind === "not_interested") {
    await moveToNotInterested(lead, plan, { config, clientName: ctx.clientName, alert: deps.alert, moveStage: deps.moveStage, now });
    return skip(`not interested: ${plan.reason}`);
  }
  if (plan.kind === "no_consent") {
    await updateLead(lead.id, { status: "no_consent", statusReason: plan.reason, nextTouchAt: null });
    return skip(plan.reason);
  }
  if (plan.kind === "defer") {
    await deferLead(lead, plan.until, plan.reason);
    return skip(`deferred: ${plan.reason}`);
  }

  // Personal openers are SMS-only; email keeps its CASL-checked template.
  const built = plan.body && channel === "sms" ? { body: plan.body } : buildMessage(lead, live.contact, channel, touchIndex, config);
  const message = channel === "sms" ? { ...built, body: smsSafe(built.body) } : built;
  const logged = message.subject ? `${message.subject}\n\n${message.body}` : message.body;

  try {
    const result =
      channel === "sms"
        ? await deps.sendSMS(lead.ghlContactId, message.body)
        : await deps.sendEmail(lead.ghlContactId, message.subject!, message.body, config.outreach.email.fromAddress);

    await logSend({
      clientId: lead.clientId,
      leadId: lead.id,
      touchIndex,
      channel,
      messageContent: logged,
      ghlMessageId: result?.messageId ?? result?.id ?? null,
    });
    const next = nextTouchAfterSend(now, touchIndex, schedule);
    await updateLead(lead.id, {
      touchCount: touchIndex + 1,
      lastTouchAt: now.toISOString(),
      nextTouchAt: next?.toISOString() ?? null,
      // Completed as soon as the last touch goes out. A reply to that last
      // text is still handled — listOpenLeadsByContactId includes completed.
      ...(next ? {} : { status: "completed", statusReason: "cadence finished" }),
    });
    return { leadId: lead.id, sent: true, channel };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Logged even on failure — a silent failure is what makes a carrier
    // problem look like a dead lead list. The row is left due, so the next
    // run retries it.
    await logSend({ clientId: lead.clientId, leadId: lead.id, touchIndex, channel, messageContent: logged, error: msg });
    return { leadId: lead.id, sent: false, channel, error: msg };
  }
}

export interface BatchResult {
  attempted: number;
  sent: number;
  skipped: SendOutcome[];
  failed: SendOutcome[];
  capReached: boolean;
}

/**
 * Sends due touches under the daily cap with a randomised gap between
 * them — a message every N seconds on the dot is the pattern carrier spam
 * filtering looks for. Same bookkeeping as quarry/outreach.ts's sendBatch.
 */
export async function sendBatch(
  leads: NurtureLead[],
  deps: OutreachDeps,
  ctx: TouchContext,
  options: {
    random?: () => number;
    log?: (line: string) => void;
    /** Real time for each send. A batch can run over an hour, so neither the
     *  send window nor lastTouchAt can use the time the batch started. */
    clock?: () => Date;
  } = {}
): Promise<BatchResult> {
  const { config } = ctx;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.log(`[EMB] ${line}`));
  const result: BatchResult = { attempted: 0, sent: 0, skipped: [], failed: [], capReached: false };
  const clientId = leads[0]?.clientId;
  if (!clientId) return result;

  const alreadySent = await sendsToday(clientId);
  let remaining = config.outreach.dailySendCap - alreadySent;
  if (remaining <= 0) {
    log(`daily cap reached (${alreadySent}/${config.outreach.dailySendCap}) — nothing sent`);
    result.capReached = true;
    return result;
  }

  for (const [index, lead] of leads.entries()) {
    if (remaining <= 0) {
      result.capReached = true;
      log(`daily cap reached — ${leads.length - index} touches held for tomorrow`);
      break;
    }
    const now = options.clock ? options.clock() : ctx.now ?? new Date();
    if (!inSendWindow(now, config)) {
      log(`send window closed — ${leads.length - index} touches held for the next window`);
      break;
    }
    result.attempted++;
    const outcome = await sendTouch(lead, deps, { ...ctx, now });
    const who = lead.contactName ?? `lead ${lead.id}`;
    if (outcome.sent) {
      result.sent++;
      remaining--;
      log(`  → ${who} (${outcome.channel}, touch ${lead.touchCount + 1})`);
    } else if (outcome.error) {
      result.failed.push(outcome);
      log(`  ✗ ${who}: ${outcome.error}`);
    } else {
      result.skipped.push(outcome);
      log(`  – ${who}: ${outcome.skippedReason}`);
    }

    // Only wait after an actual send — a skip made no noise worth spacing.
    const isLast = index === leads.length - 1;
    if (outcome.sent && !isLast && remaining > 0) {
      const jitter = Math.floor(random() * config.outreach.jitterSeconds * 1000);
      await deps.wait(config.outreach.minSendSpacingSeconds * 1000 + jitter);
    }
  }
  return result;
}

function stripPhrases(text: string, phrases: string[]): string {
  let out = text.toLowerCase();
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|\\W)${escaped}(?=\\W|$)`, "g"), "$1 ");
  }
  return out;
}

/**
 * Keeps a text in the plain GSM-7 character set. Mark, 2026-10-06: one
 * long dash or curly quote switches the WHOLE message to Unicode (UCS-2),
 * which cuts a segment from 160 characters to 70 — a one-line reply bills
 * as 2-3 texts instead of 1. Swaps the usual culprits for plain
 * equivalents; anything else is left as written.
 */
export function smsSafe(text: string): string {
  return text
    .replace(/[\u2014\u2013\u2012\u2010\u2011\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ");
}

export const DEFAULT_COURTESY: CourtesyTemplates = {
  notReady: "No problem at all, {{firstName}} - I'll check back in a few months. If anything changes before then, just text me here!",
  alreadyBought: "Congrats on the new place, {{firstName}}! Wishing you all the best - take care.",
  alreadySold: "Congrats on the sale, {{firstName}}! All the best with what's next.",
  otherAgent: "Good to know, {{firstName}} - glad you're in good hands. Wishing you all the best!",
  notInterested: "No problem, {{firstName}} - thanks for letting me know. Take care!",
};

/** The one polite reply for a decline — null for a stop request (never answered). */
export function courtesyFor(kind: NotInterestedCategory | "not_ready", firstName: string, config: EmberConfig): string | null {
  if (kind === "asked_to_stop") return null;
  const t = { ...DEFAULT_COURTESY, ...(config.outreach.courtesy ?? {}) };
  const template =
    kind === "not_ready" ? t.notReady
    : kind === "already_bought" ? t.alreadyBought
    : kind === "already_sold" ? t.alreadySold
    : kind === "other_agent" ? t.otherAgent
    : t.notInterested;
  return smsSafe(renderTemplate(template, { firstName }));
}

/**
 * An inbound reply from a nurture lead. Mark, 2026-10-06: Ember answers
 * them itself.
 *   1. Clear evidence they're no longer a prospect (status.ts) → moved to
 *      Not Interested, plus one polite reply — except after a stop request.
 *   2. Couldn't tell whether it's a clear no → a human reads it; no reply.
 *   3. First reply is "not ready yet" / a bare "no thanks" → paused
 *      reApproachAfterDays, plus one polite reply. (Mid-conversation, the
 *      model handles "not now" itself with pause_for_now.)
 *   4. Anything else → Ember's own conversation (conversation.ts), which
 *      qualifies them and hands only the CALL to Iris.
 */
export async function handleReply(
  lead: NurtureLead,
  body: string,
  ctx: {
    config: EmberConfig;
    clientName: string;
    alert: AlertFn;
    now?: Date;
    firstName: string;
    classifyStatus: (messages: HistoryMessage[]) => Promise<StatusDecision>;
    moveStage: MoveStageFn;
    /** Sends one courtesy text after the human-like pause. */
    sendCourtesy: (text: string) => Promise<void>;
    /** Ember's conversation turn (conversation.ts emberConverse). */
    converse?: (lead: NurtureLead, text: string) => Promise<string | null>;
  }
): Promise<ReplySentiment> {
  const now = ctx.now ?? new Date();
  const sentiment = classifyReply(body, ctx.config.outreach);
  const snippet = body.trim().replace(/\s+/g, " ").slice(0, 140);
  const reply: HistoryMessage = { direction: "inbound", channel: "sms", body, at: now.toISOString() };

  const status = await ctx.classifyStatus([reply]);
  if (status.verdict === "not_interested") {
    await updateLead(lead.id, { repliedAt: now.toISOString() });
    const moved = await moveToNotInterested(lead, status, { config: ctx.config, clientName: ctx.clientName, alert: ctx.alert, moveStage: ctx.moveStage, now });
    const courtesy = courtesyFor(status.category, ctx.firstName, ctx.config);
    if (moved && courtesy) await ctx.sendCourtesy(courtesy).catch((e) => console.error(`[EMB] courtesy reply failed for lead ${lead.id}:`, e));
    return "negative";
  }
  if (status.verdict === "unsure") {
    await updateLead(lead.id, { status: "replied", statusReason: `replied "${snippet}" — needs a human look`, repliedAt: now.toISOString(), nextTouchAt: null });
    try {
      await ctx.alert(formatReactivationAlert(lead, `replied "${snippet}" — couldn't tell automatically whether that's a "no", please read it`, ctx.clientName, now));
    } catch (error) {
      console.error(`[EMB] reply alert failed for lead ${lead.id}:`, error);
    }
    return sentiment;
  }

  const midConversation = lead.status === "conversing" || lead.status === "handed_off";
  // quarry's classifyReply lets any negative keyword win outright; "no
  // rush, but yes still looking" must not be filed as a no.
  const alsoPositive =
    sentiment === "negative" &&
    classifyReply(stripPhrases(body, ctx.config.outreach.negativeKeywords), {
      positiveKeywords: ctx.config.outreach.positiveKeywords,
      negativeKeywords: [],
    }) === "positive";
  const temporary = findTemporaryPause([reply]) !== null;
  if (!midConversation && ((sentiment === "negative" && !alsoPositive) || (temporary && !alsoPositive && sentiment !== "positive"))) {
    const until = new Date(now.getTime() + ctx.config.reApproachAfterDays * DAY_MS);
    await updateLead(lead.id, {
      status: "nurturing",
      touchCount: 0,
      nextTouchAt: until.toISOString(),
      repliedAt: now.toISOString(),
      statusReason: `cooling off until ${until.toISOString().slice(0, 10)}: replied "${snippet}"`,
    });
    const courtesy = courtesyFor("not_ready", ctx.firstName, ctx.config);
    if (courtesy) await ctx.sendCourtesy(courtesy).catch((e) => console.error(`[EMB] courtesy reply failed for lead ${lead.id}:`, e));
    return "negative";
  }

  if (!midConversation) {
    await updateLead(lead.id, { repliedAt: now.toISOString() });
    try {
      await ctx.alert(formatReactivationAlert(lead, `replied "${snippet}" — Ember is texting with them to qualify for a live transfer`, ctx.clientName, now, "ember"));
    } catch (error) {
      console.error(`[EMB] reply alert failed for lead ${lead.id}:`, error);
    }
  }
  if (ctx.converse) {
    await ctx.converse(lead, body);
    return sentiment;
  }

  // No conversation available (no Iris questions configured for this
  // client): a human takes it.
  await updateLead(lead.id, { status: "replied", statusReason: `replied "${snippet}"`, repliedAt: now.toISOString(), nextTouchAt: null });
  return sentiment;
}
