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
import { EmberConfig, renderTemplate, scriptKindFor } from "./config";
import { AlertFn, formatReactivationAlert, markExited, markReactivated } from "./alerts";
import { detectChange } from "./scan";
import { logSend, sendsToday, updateLead } from "./store";
import { GhlOpportunityLite, NurtureChannel, NurtureLead } from "./types";
import {
  consentStart,
  EMPTY_CONTEXT,
  findHardOptOut,
  findSoftDecline,
  HistoryDecision,
  HistoryMessage,
  isHardOptOut,
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
}

export type TouchPlan =
  /** body set = a personal opener replacing the script. */
  | { kind: "send"; body?: string; reason: string }
  /** Permanent — CASL unsubscribe, or wrong number. */
  | { kind: "opt_out"; reason: string }
  /** "Not now" — restart the cycle from scratch on `until`. */
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "no_consent"; reason: string }
  | { kind: "retry"; reason: string };

/**
 * Everything that decides what (if anything) this touch says, in order:
 *
 *   1. A hard opt-out anywhere in history → never again. Code, not model.
 *   2. CASL consent from the latest real inquiry (consentStart) → parked
 *      as no_consent if it's run out.
 *   3. A soft decline inside the cool-off → deferred to decline +
 *      reApproachAfterDays (Mark, 2026-09-24: try again after 6 months).
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
}): Promise<TouchPlan> {
  const { lead, contact, history, context, config, now } = input;

  const hard = findHardOptOut(history);
  if (hard) return { kind: "opt_out", reason: `said "${hard.slice(0, 80)}"` };

  const from = consentStart(lead.inquiryAt, history);
  if (from && now.getTime() - new Date(from).getTime() >= config.consentWindowDays * DAY_MS) {
    return { kind: "no_consent", reason: `last inquiry ${from.slice(0, 10)} is past the ${config.consentWindowDays}-day consent window` };
  }

  const decline = findSoftDecline(history);
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
function firstNameOf(lead: NurtureLead, contact: LiveContact): string {
  const fromContact = contact.firstName?.trim();
  if (fromContact) return fromContact;
  const fromName = lead.contactName?.trim().split(/\s+/)[0];
  return fromName || "there";
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
  const plan = await planTouch({ lead, contact: live.contact, history, context, config, now, review: deps.reviewHistory });

  if (plan.kind === "retry") return skip(plan.reason);
  if (plan.kind === "opt_out") {
    await updateLead(lead.id, { status: "opted_out", statusReason: `history: ${plan.reason}`, nextTouchAt: null });
    return skip(`opted out: ${plan.reason}`);
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
  const message = plan.body && channel === "sms" ? { body: plan.body } : buildMessage(lead, live.contact, channel, touchIndex, config);
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
 * An inbound reply from a nurture lead. An unsubscribe ("stop", "remove
 * me") is permanent; a plain "no" / "not interested" pauses them for
 * reApproachAfterDays. Anything else — a yes, a
 * question, "who is this?" — ends the cadence and alerts, because someone
 * who answers a months-later text is the signal this agent exists to find.
 * Nothing is auto-sent back either way.
 */
export async function handleReply(
  lead: NurtureLead,
  body: string,
  ctx: {
    config: EmberConfig;
    clientName: string;
    alert: AlertFn;
    now?: Date;
    /**
     * Passes a non-"no" reply to Iris to qualify by text and call for a
     * live transfer (handoff.ts). "not_available" (no Iris config for this
     * client, contact unreadable) falls back to the human alert below.
     */
    handoff?: (lead: NurtureLead, text: string) => Promise<"handed_off" | "not_available">;
  }
): Promise<ReplySentiment> {
  const now = ctx.now ?? new Date();
  const sentiment = classifyReply(body, ctx.config.outreach);
  const snippet = body.trim().replace(/\s+/g, " ").slice(0, 140);

  // quarry's classifyReply lets any negative keyword win outright, which is
  // right for a cold pitch. Here the cadence stops on EVERY reply anyway, so
  // the only thing a classification decides is whether a human hears about
  // it — and "no rush, but yes still looking" silently filed as an opt-out
  // is a lost buyer. Mixed replies go to a human.
  // Negative phrases are stripped first (longest first) so "not interested"
  // doesn't count as containing the positive "interested".
  const alsoPositive =
    sentiment === "negative" &&
    classifyReply(stripPhrases(body, ctx.config.outreach.negativeKeywords), {
      positiveKeywords: ctx.config.outreach.positiveKeywords,
      negativeKeywords: [],
    }) === "positive";

  // Mark, 2026-09-24: only a real unsubscribe is forever. "No thanks" /
  // "not interested" / "we bought" pauses them for reApproachAfterDays and
  // the next cycle starts fresh from where they are in the CRM.
  if (isHardOptOut(body)) {
    await updateLead(lead.id, {
      status: "opted_out",
      statusReason: `replied "${snippet}"`,
      repliedAt: now.toISOString(),
      nextTouchAt: null,
    });
    return "negative";
  }
  const softDecline = findSoftDecline([{ direction: "inbound", channel: "sms", body, at: now.toISOString() }]) !== null;
  if ((sentiment === "negative" && !alsoPositive) || (softDecline && !alsoPositive && sentiment !== "positive")) {
    const until = new Date(now.getTime() + ctx.config.reApproachAfterDays * DAY_MS);
    await updateLead(lead.id, {
      status: "nurturing",
      touchCount: 0,
      nextTouchAt: until.toISOString(),
      repliedAt: now.toISOString(),
      statusReason: `cooling off until ${until.toISOString().slice(0, 10)}: replied "${snippet}"`,
    });
    return "negative";
  }

  if (ctx.handoff && (await ctx.handoff(lead, body)) === "handed_off") return sentiment;

  await updateLead(lead.id, {
    status: "replied",
    statusReason: `replied "${snippet}"`,
    repliedAt: now.toISOString(),
    nextTouchAt: null,
  });
  try {
    await ctx.alert(formatReactivationAlert(lead, `replied "${snippet}"`, ctx.clientName, now));
  } catch (error) {
    console.error(`[EMB] reply alert failed for lead ${lead.id}:`, error);
  }
  return sentiment;
}
