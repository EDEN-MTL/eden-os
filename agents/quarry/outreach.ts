/**
 * Module 7 — outreach.
 *
 * Two steps, on purpose:
 *   1. Send a PICTURE of the site and ask if they want the link.
 *   2. Send the link only after they say yes.
 *
 * A picture needs no click, so a stranger can judge the offer without
 * trusting the sender. And the link only ever reaches someone who just asked
 * for it, which is the person most likely to actually open it.
 *
 * Nothing in here sends without a human approving the lead first.
 */
import { renderTemplate, EmailConfig, QuarryConfig } from "./config";
import { logSend, sendsToday, updateLead } from "./store";
import { QuarryLead, SendStep } from "./types";

export type ReplySentiment = "positive" | "negative" | "unclear";

/**
 * Reads a reply as yes, no, or unclear.
 *
 * Negatives are checked FIRST and win outright. "not interested" contains
 * "interested"; "no thanks, ok" contains "ok". Checking positives first would
 * read both as a yes and text a link to someone who just declined — the worst
 * possible failure here, and the one most likely to draw a complaint.
 *
 * Matching is on whole words, so "non" is not "no" and "unsure" is not "sure".
 */
export function classifyReply(
  body: string,
  config: { positiveKeywords: string[]; negativeKeywords: string[] }
): ReplySentiment {
  const text = body.toLowerCase().trim();
  const hasWord = (phrase: string) => {
    const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(text);
  };

  if (config.negativeKeywords.some(hasWord)) return "negative";
  if (config.positiveKeywords.some(hasWord)) return "positive";
  return "unclear";
}

export interface SendGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Every reason a lead must not be texted, checked in one place.
 *
 * Each of these is a real way to embarrass yourself: texting a landline,
 * texting someone twice, sending a message whose link is missing, or sending
 * a lead nobody looked at.
 */
export function canSend(lead: QuarryLead, step: SendStep): SendGateResult {
  if (lead.approvalStatus !== "approved") {
    return { allowed: false, reason: `approval_status is "${lead.approvalStatus}"` };
  }
  if (lead.isMobile !== true) {
    return { allowed: false, reason: `not a confirmed mobile (${lead.phoneLineType ?? "unchecked"})` };
  }
  if (!lead.phone) return { allowed: false, reason: "no phone number" };
  if (!lead.ghlContactId) return { allowed: false, reason: "not synced to GHL yet" };

  if (step === "screenshot") {
    if (!lead.previewImageUrl) return { allowed: false, reason: "no screenshot to attach" };
    if (lead.sentAt) return { allowed: false, reason: "screenshot already sent" };
  }
  if (step === "link") {
    if (!lead.previewUrl) return { allowed: false, reason: "no preview URL to send" };
    if (!lead.sentAt) return { allowed: false, reason: "screenshot has not gone out yet" };
  }
  if (step === "nudge" && !lead.sentAt) {
    return { allowed: false, reason: "nothing to nudge about — no first message sent" };
  }
  return { allowed: true };
}

/**
 * The email-channel gate. Deliberately separate from canSend() — email has no
 * mobile requirement, no screenshot-must-precede-link ordering, and its own
 * opt-out flag, so folding it into the SMS gate would mean branching that
 * gate on channel throughout, for two checks that barely overlap.
 */
export function canSendEmail(lead: QuarryLead, step: "email_pitch" | "email_nudge" | "email_booking"): SendGateResult {
  if (lead.approvalStatus !== "approved") {
    return { allowed: false, reason: `approval_status is "${lead.approvalStatus}"` };
  }
  if (!lead.email) return { allowed: false, reason: "no published email on file" };
  if (!lead.ghlContactId) return { allowed: false, reason: "not synced to GHL yet" };
  if (lead.emailOptedOut) return { allowed: false, reason: "opted out of email" };

  if (step === "email_pitch" && lead.emailSentAt) {
    return { allowed: false, reason: "pitch already sent" };
  }
  if ((step === "email_nudge" || step === "email_booking") && !lead.emailSentAt) {
    return { allowed: false, reason: "no pitch sent yet" };
  }
  return { allowed: true };
}

/** The GHL calls outreach needs, injected so the send logic is testable. */
export interface OutreachDeps {
  sendMMS(contactId: string, message: string, attachments: string[]): Promise<any>;
  sendSMS(contactId: string, message: string): Promise<any>;
  moveStage(opportunityId: string, stageName: string): Promise<void>;
  /** Pause between sends. Injected so tests do not actually wait. */
  wait(ms: number): Promise<void>;
}

export class EmailChannelNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Email channel is not configured: ${missing.join(", ")}. ` +
        `Set these in config/clients/<id>.json under quarry.outreach.email before sending. ` +
        `physicalAddress in particular is a CASL requirement, not a formality — ` +
        `refusing to send rather than ship a commercial email without one.`
    );
    this.name = "EmailChannelNotConfiguredError";
  }
}

/** Refuses to send anything if the channel-level setup is incomplete. */
export function assertEmailChannelConfigured(email: EmailConfig, bookingUrl: string): void {
  const missing: string[] = [];
  if (!email.fromDomain) missing.push("fromDomain");
  if (!email.fromAddress) missing.push("fromAddress");
  if (!email.physicalAddress) missing.push("physicalAddress");
  // The pitch no longer offers a link to a finished site — booking a call is
  // the ONLY call to action in the email now. Missing this isn't a broken
  // nice-to-have, it is an email with nothing for the reader to click.
  if (!bookingUrl) missing.push("generation.bookingUrl");
  if (missing.length) throw new EmailChannelNotConfiguredError(missing);
}

export function buildMessage(
  lead: QuarryLead,
  step: "screenshot" | "link" | "nudge",
  config: QuarryConfig
): string {
  return renderTemplate(config.outreach.templates[step], {
    senderName: config.outreach.senderName,
    businessName: lead.name,
    previewUrl: lead.previewUrl ?? "",
  });
}

export interface EmailMessage {
  subject: string;
  html: string;
}

/**
 * Turns the triage reasons already stored on the lead into ONE plain-English
 * sentence a business owner recognizes as their own problem, not a technical
 * finding. This is the single highest-leverage thing available in this
 * email: a cold pitch naming a real, checkable problem reportedly pulls
 * 15-20% replies against 1-3% for a generic one — and we already collect the
 * data, it just was not reaching the copy. See buildEmailMessage.
 *
 * Priority: no website at all is the strongest, most legible signal. "Does
 * not work on a phone" is the next most concrete thing a non-technical owner
 * can verify themselves in five seconds. A stale copyright/markup finding is
 * still concrete but slightly weaker. The vision pass's own reasoning is the
 * fallback — it is already natural language, generated for exactly this case
 * (a site that is technically fine but simply looks old).
 */
export function problemLine(lead: QuarryLead): string {
  if (!lead.website) {
    return "you don't currently have a website, so people searching for you online find nothing";
  }
  const reasons = lead.reasons.join(" ").toLowerCase();
  if (reasons.includes("viewport") || reasons.includes("https")) {
    return "your site doesn't work properly on a phone, which is where most people are looking";
  }
  if (reasons.includes("copyright") || reasons.includes("outdated markup")) {
    return "your site looks like it hasn't been touched in years";
  }
  if (lead.outdatedReasoning) {
    return `it looks a bit dated — ${lead.outdatedReasoning.toLowerCase().replace(/\.$/, "")}`;
  }
  return "your website could use a refresh";
}

/**
 * A short, specific credibility line from data Google already gave us — the
 * second half of the same "specificity wins" finding problemLine acts on.
 * Rating is used rather than neighbourhood: Google's formattedAddress is
 * street/city/province, with no neighbourhood name in it to parse out
 * reliably, whereas rating + review count is always attributable when
 * present and reads as "I actually looked at your business", not a mail-merge.
 *
 * Designed to collapse to nothing cleanly when there is no rating — the
 * template places this right after "Hi —" with no surrounding punctuation of
 * its own, so an empty string just leaves the greeting plain rather than a
 * gap or a stray comma.
 */
export function contextLine(lead: QuarryLead): string {
  if (lead.rating && lead.userRatingsTotal) {
    return ` I saw you're at ${lead.rating} stars on Google (${lead.userRatingsTotal} reviews) —`;
  }
  return "";
}

export function buildEmailMessage(
  lead: QuarryLead,
  step: "email_pitch" | "email_nudge" | "email_booking",
  config: QuarryConfig
): EmailMessage {
  const vars = {
    senderName: config.outreach.senderName,
    businessName: lead.name,
    problem: problemLine(lead),
    context: contextLine(lead),
    previewUrl: lead.previewUrl ?? "",
    bookingUrl: config.generation.bookingUrl,
    unsubscribeUrl: `${process.env.PUBLIC_BASE_URL ?? ""}/api/quarry/unsubscribe/${lead.emailUnsubscribeToken}`,
    physicalAddress: config.outreach.email.physicalAddress,
    senderEmail: config.outreach.email.fromAddress,
  };
  const templateKey =
    step === "email_pitch" ? "pitch" : step === "email_nudge" ? "nudge" : "booking";
  return {
    subject: renderTemplate(config.outreach.email.templates.subject, vars),
    html: renderTemplate(config.outreach.email.templates[templateKey], vars),
  };
}

export interface SendOutcome {
  leadId: number;
  sent: boolean;
  skippedReason?: string;
  error?: string;
}

/**
 * Sends one message and records it.
 *
 * The send is logged even when it fails, because a failed send still tells
 * you something about deliverability — and a silent failure is the thing that
 * makes a carrier problem look like a bad offer.
 */
export async function sendOne(
  lead: QuarryLead,
  step: "screenshot" | "link" | "nudge",
  config: QuarryConfig,
  deps: OutreachDeps
): Promise<SendOutcome> {
  const gate = canSend(lead, step);
  if (!gate.allowed) {
    return { leadId: lead.id, sent: false, skippedReason: gate.reason };
  }

  const message = buildMessage(lead, step, config);
  const contactId = lead.ghlContactId!;

  try {
    const result =
      step === "screenshot"
        ? await deps.sendMMS(contactId, message, [lead.previewImageUrl!])
        : await deps.sendSMS(contactId, message);

    await logSend({
      leadId: lead.id,
      step,
      messageContent: message,
      attachmentUrl: step === "screenshot" ? lead.previewImageUrl : null,
      ghlMessageId: result?.messageId ?? result?.id ?? null,
      clientId: lead.clientId,
    });

    if (step === "screenshot") {
      await updateLead(lead.id, { sentAt: new Date().toISOString(), pipelineStage: "Screenshot Sent" });
      if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Screenshot Sent");
    } else if (step === "link") {
      await updateLead(lead.id, { pipelineStage: "Site Sent" });
      if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Site Sent");
    }

    return { leadId: lead.id, sent: true };
  } catch (error) {
    const message_ = error instanceof Error ? error.message : String(error);
    await logSend({
      leadId: lead.id,
      step,
      messageContent: message,
      attachmentUrl: step === "screenshot" ? lead.previewImageUrl : null,
      error: message_,
      clientId: lead.clientId,
    });
    return { leadId: lead.id, sent: false, error: message_ };
  }
}

/** The GHL call the email path needs. Kept separate from OutreachDeps —
 *  sendMMS/sendSMS and sendEmail belong to genuinely different sends, and a
 *  combined interface would let an email call site accidentally invoke an
 *  SMS method that silently no-ops for a lead with no phone. */
export interface EmailDeps {
  sendEmail(contactId: string, subject: string, html: string, fromEmail: string): Promise<any>;
  moveStage(opportunityId: string, stageName: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

export async function sendEmailOne(
  lead: QuarryLead,
  step: "email_pitch" | "email_nudge" | "email_booking",
  config: QuarryConfig,
  deps: EmailDeps
): Promise<SendOutcome> {
  const gate = canSendEmail(lead, step);
  if (!gate.allowed) {
    return { leadId: lead.id, sent: false, skippedReason: gate.reason };
  }

  const { subject, html } = buildEmailMessage(lead, step, config);
  const logStep: SendStep = step;

  try {
    const result = await deps.sendEmail(
      lead.ghlContactId!,
      subject,
      html,
      config.outreach.email.fromAddress
    );

    await logSend({
      leadId: lead.id,
      step: logStep,
      messageContent: `${subject}\n\n${html}`,
      ghlMessageId: result?.messageId ?? result?.id ?? null,
      clientId: lead.clientId,
    });

    if (step === "email_pitch") {
      await updateLead(lead.id, { emailSentAt: new Date().toISOString() });
      // Moves to "Screenshot Sent" — the first non-New-Lead stage in the
      // fixed pipeline. As of 2026-08-27 the pitch offers a free redesign and
      // a call, not a finished site (Jacob builds it himself in the gap
      // before the call — see the booking-notice requirement on
      // generation.bookingUrl), so no stage name in the current pipeline
      // literally describes this moment. This is the closest fit; GHL has no
      // create/rename-stage API (gotcha 4 in CLAUDE.md) so the actual fix is
      // a one-click relabel to something like "Pitched" next time you're in
      // the GHL UI — that only changes the label, not the stage id, so
      // nothing here needs to change when you do.
      if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Screenshot Sent");
    } else if (step === "email_nudge") {
      await updateLead(lead.id, { emailNudgeCount: lead.emailNudgeCount + 1 });
    }
    // "email_booking" needs no lead-state update — it is the auto-reply fired
    // from handleEmailReply, which has already set repliedAt/pipelineStage
    // before this ever runs.

    return { leadId: lead.id, sent: true };
  } catch (error) {
    const message_ = error instanceof Error ? error.message : String(error);
    await logSend({
      leadId: lead.id,
      step: logStep,
      messageContent: `${subject}\n\n${html}`,
      error: message_,
      clientId: lead.clientId,
    });
    return { leadId: lead.id, sent: false, error: message_ };
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
 * Sends an approved batch, spaced out.
 *
 * Two protections, both about carrier health rather than any rule:
 *   - a hard daily ceiling per number, counted from what actually went out
 *   - a randomised gap between messages
 *
 * The gap is randomised because a message every 180 seconds on the dot is a
 * machine, and that is precisely what carrier spam filtering looks for.
 */
export interface RateLimit {
  dailyCap: number;
  minSendSpacingSeconds: number;
  jitterSeconds: number;
}

export interface BatchOptions {
  clientId?: string;
  random?: () => number;
  log?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Sends a batch under a daily cap, spaced out with a randomised gap.
 *
 * Channel-agnostic on purpose: SMS and email both need "check the cap, send
 * one, log the outcome, wait a jittered gap, repeat" and differ only in what
 * "send one" means. `sendFn` carries that difference; this function owns the
 * cap/jitter bookkeeping exactly once instead of twice.
 *
 * The gap is randomised because a message every N seconds on the dot is a
 * machine, and that pattern is precisely what spam/carrier filtering looks
 * for — true for SMS carriers and just as true for inbox providers.
 */
export async function sendBatch(
  leads: QuarryLead[],
  sendFn: (lead: QuarryLead) => Promise<SendOutcome>,
  limit: RateLimit,
  options: BatchOptions = {}
): Promise<BatchResult> {
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.log(`[QRY] ${line}`));
  const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const result: BatchResult = { attempted: 0, sent: 0, skipped: [], failed: [], capReached: false };

  const alreadySent = await sendsToday(options.clientId ?? "eden");
  let remaining = limit.dailyCap - alreadySent;
  if (remaining <= 0) {
    log(`daily cap reached (${alreadySent}/${limit.dailyCap}) — nothing sent`);
    result.capReached = true;
    return result;
  }
  log(`${alreadySent} sent today, ${remaining} left under the cap of ${limit.dailyCap}`);

  for (const [index, lead] of leads.entries()) {
    if (remaining <= 0) {
      result.capReached = true;
      log(`daily cap reached — ${leads.length - index} leads held for tomorrow`);
      break;
    }

    result.attempted++;
    const outcome = await sendFn(lead);

    if (outcome.sent) {
      result.sent++;
      remaining--;
      log(`  → ${lead.name}`);
    } else if (outcome.error) {
      result.failed.push(outcome);
      log(`  ✗ ${lead.name}: ${outcome.error}`);
    } else {
      // A skipped lead does not consume the daily allowance — nothing left.
      result.skipped.push(outcome);
      log(`  – ${lead.name}: ${outcome.skippedReason}`);
    }

    const isLast = index === leads.length - 1;
    if (!isLast && remaining > 0) {
      const jitter = Math.floor(random() * limit.jitterSeconds * 1000);
      await wait(limit.minSendSpacingSeconds * 1000 + jitter);
    }
  }
  return result;
}

/** Convenience wrapper for the SMS path, matching the pre-refactor call shape. */
export async function sendSmsBatch(
  leads: QuarryLead[],
  step: "screenshot" | "link" | "nudge",
  config: QuarryConfig,
  deps: OutreachDeps,
  options: BatchOptions = {}
): Promise<BatchResult> {
  return sendBatch(
    leads,
    (lead) => sendOne(lead, step, config, deps),
    {
      dailyCap: config.outreach.dailySendCap,
      minSendSpacingSeconds: config.outreach.minSendSpacingSeconds,
      jitterSeconds: config.outreach.jitterSeconds,
    },
    // deps.wait must win over sendBatch's real-setTimeout default — it is
    // how tests replace the spacing delay with something that resolves
    // instantly. Losing this wired every wrapper through a live 180s wait.
    { wait: deps.wait, ...options }
  );
}

/**
 * Sends an approved batch of email pitches/nudges. Refuses outright if the
 * channel is not fully configured — see assertEmailChannelConfigured.
 */
export async function sendEmailBatch(
  leads: QuarryLead[],
  step: "email_pitch" | "email_nudge",
  config: QuarryConfig,
  deps: EmailDeps,
  options: BatchOptions = {}
): Promise<BatchResult> {
  assertEmailChannelConfigured(config.outreach.email, config.generation.bookingUrl);
  return sendBatch(
    leads,
    (lead) => sendEmailOne(lead, step, config, deps),
    {
      dailyCap: config.outreach.email.dailySendCap,
      minSendSpacingSeconds: config.outreach.email.minSendSpacingSeconds,
      jitterSeconds: config.outreach.email.jitterSeconds,
    },
    { wait: deps.wait, ...options }
  );
}

/**
 * Handles an inbound reply.
 *
 * A yes sends the link. A no sends nothing at all and marks the lead — the
 * one thing that must never happen is a link arriving after someone declines.
 * Anything unclear is left for a human, because guessing wrong here is worse
 * than answering slowly.
 */
export async function handleReply(
  lead: QuarryLead,
  body: string,
  config: QuarryConfig,
  deps: OutreachDeps
): Promise<{ sentiment: ReplySentiment; outcome?: SendOutcome }> {
  const sentiment = classifyReply(body, config.outreach);
  await updateLead(lead.id, { repliedAt: new Date().toISOString() });

  if (sentiment === "negative") {
    await updateLead(lead.id, { pipelineStage: "Lost/Nurture" });
    if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Lost/Nurture");
    return { sentiment };
  }

  if (sentiment === "positive") {
    await updateLead(lead.id, { pipelineStage: "Replied Interest" });
    if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Replied Interest");
    const outcome = await sendOne(lead, "link", config, deps);
    return { sentiment, outcome };
  }

  // Unclear: move it where a human will see it, but send nothing.
  await updateLead(lead.id, { pipelineStage: "Replied Interest" });
  if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Replied Interest");
  return { sentiment };
}

/**
 * Handles a reply to an EMAIL pitch. A negative reply here sets
 * emailOptedOut — CASL treats "no"/"stop"/"unsubscribe" as withdrawn consent,
 * not just a lukewarm response, so this is stricter than the SMS reply
 * handler on purpose. It does not touch isMobile/SMS eligibility — declining
 * email is not a statement about text messages.
 */
export async function handleEmailReply(
  lead: QuarryLead,
  body: string,
  config: QuarryConfig,
  deps: EmailDeps
): Promise<{ sentiment: ReplySentiment; outcome?: SendOutcome }> {
  const sentiment = classifyReply(body, config.outreach);
  await updateLead(lead.id, { emailRepliedAt: new Date().toISOString() });

  if (sentiment === "negative") {
    await updateLead(lead.id, { emailOptedOut: true, pipelineStage: "Lost/Nurture" });
    if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Lost/Nurture");
    return { sentiment };
  }

  await updateLead(lead.id, { pipelineStage: "Replied Interest" });
  if (lead.ghlOpportunityId) await deps.moveStage(lead.ghlOpportunityId, "Replied Interest");

  if (sentiment === "positive") {
    // The gap this closes: on the old cold-SMS blast, 342 people replied
    // positively and almost none of them ever got a next step back — that
    // silence, not the reply rate, is where the campaign actually died. A
    // "yes" here must not just sit in the CRM waiting for a human to notice.
    // Re-uses sendEmailOne (not sendEmailBatch) because this is a one-off
    // reply-triggered send, not a scheduled batch under the daily cap.
    const outcome = await sendEmailOne(lead, "email_booking", config, deps);
    return { sentiment, outcome };
  }

  // Unclear replies (a question, not a yes/no) still get NOTHING auto-sent —
  // guessing wrong here (e.g. auto-sending the booking link to "how much
  // does this cost?") is worse than leaving it for a human to actually read
  // and answer.
  return { sentiment };
}
