/**
 * IRIS Conversation SOP content for 3% Realty East Coast — the actual
 * approved wording, not a placeholder. Kept as data (not buried in prose
 * inside index.ts) so it's testable and easy for the team to review/update
 * without touching logic.
 *
 * Source: "ISA / IRIS Conversation & Lead Handling SOP" (3% Realty East
 * Coast). This is separate from the VA/ISA Pipeline Management SOP, which
 * governs stages/scheduling (see cadence.ts) rather than what Iris says.
 */
import { CallIntent, IrisConfig } from "./qualification";
import { NormalisedLead } from "../scout/intake";
import { Financing } from "../scout/isa-notes";

export interface QuestionSet {
  sms: string[];
  call: string[];
}

/**
 * Call versions aren't given as a rigid separate script in the SOP — it
 * says to gather "the same core information" as texting but conversationally,
 * and gives only 1-2 example transitions per lead type. Those examples are
 * used verbatim below; the remaining core questions reuse the SMS wording,
 * since the SOP is explicit that the underlying information gathered is
 * identical between channels — only the delivery style differs.
 */
export const BUYER_QUESTIONS: QuestionSet = {
  sms: [
    "What budget range are you comfortable with?",
    "What's your ideal timeline to buy?",
    "Any specific areas or neighborhoods you're looking at?",
    "What type of home are you interested in?",
    "Are you already working with a real estate agent?",
    "Have you been pre-approved yet?",
  ],
  call: [
    "And roughly what budget are you looking to stay within?",
    "When are you hoping to make the move?",
    "Any specific areas or neighborhoods you're looking at?",
    "What type of home are you interested in?",
    "Are you already working with a real estate agent?",
    "Have you been pre-approved yet?",
  ],
};

export const SELLER_QUESTIONS: QuestionSet = {
  sms: [
    "Is the home already listed?",
    "What's the property address?",
    "What's your timeline to sell?",
    "Have you spoken to or are you currently working with another agent?",
    "Are you planning to buy another home after selling?",
  ],
  call: [
    "Is the home already listed?",
    "What's the property address?",
    "And what's your ideal timeline for selling?",
    "Have you spoken to or are you currently working with another agent?",
    "Are you planning to buy another home after selling?",
  ],
};

export const DOWNSIZER_QUESTIONS: QuestionSet = {
  sms: [
    "Are you looking to sell first, buy first, or do both?",
    "What has you thinking about downsizing?",
    "What's your budget for the new home?",
    "What's your timeline to make the move?",
    "Any preferred locations?",
  ],
  call: [
    "Are you looking to sell first, buy first, or do both?",
    "What has you thinking about downsizing?",
    "What's your budget for the new home?",
    "What's your timeline to make the move?",
    "Any preferred locations?",
  ],
};

/** Natural acknowledgments — vary these rather than repeating one phrase. */
export const NATURAL_TRANSITIONS = {
  sms: ["Got it!", "Makes sense.", "Sounds good.", "Cool, thanks for that.", "Yeah, I get why you'd ask that."],
  call: ["Got it.", "Makes sense.", "Sounds good.", "Absolutely.", "Awesome!"],
};

/**
 * Approved responses for recurring situations, taken verbatim from the SOP.
 * Where the SOP gives multiple phrasings, all are kept as variants so Iris
 * doesn't repeat the exact same line every time — the SOP explicitly warns
 * against overusing one phrase.
 */
export const EDGE_CASE_RESPONSES = {
  /**
   * The service area lives in client config (market.city), never hardcoded
   * here — this system previously had "South Florida" hardcoded into every
   * agent prompt by mistake for a Newfoundland client. Not repeating that.
   */
  outOfServiceArea: (city: string): string[] => [
    `Thanks for sharing. Just so you know, our team currently helps clients in the ${city} area only. If you're ever looking here, we'd love to help.`,
    `Thanks for sharing. Just so you know, our team currently helps clients in the ${city} area only.`,
  ],
  outOfServiceAreaFollowUp: "Would you like us to keep your info in case we can refer someone in your area?",

  buyerHasAgent: [
    "Good to know! If you're all set, that's great. If anything changes, just let me know.",
    "Thanks for the heads-up. I'll step back unless something changes or you're looking for extra insight.",
  ],
  sellerHasAgentOrListed: [
    "Got it — if you're already listed, we totally respect that. If you're still exploring options, we can help with a conversation.",
    "Thanks for sharing. If you're currently listed, we don't want to overstep. If you're looking for a second opinion, we can chat.",
  ],
  notPreApproved: [
    "No worries — that's super common. Our agents can walk you through that part during your call.",
    "No worries — that's pretty common. One of our agents can walk you through that during the call.",
  ],
  leadNotReady: [
    "No worries! I can follow up another time or send more info — totally your call.",
    "No rush at all! I'm happy to check in another time if that works better.",
  ],

  /** Send at most two of these, then stop — see leadStoppedRespondingFinal. */
  leadStoppedResponding: [
    "Hey, just checking in — want me to keep going or would you prefer to pause here?",
    "Totally cool if now's not the best time. I can always follow up later.",
    "Still with me? No worries either way — I'll be here if you want to pick this back up.",
  ],
  leadStoppedRespondingFinal:
    "No worries — I'll hold off for now. Feel free to message me anytime if you'd like to continue!",

  offTopic: [
    "Let's bring it back real quick — are you looking to buy or sell right now?",
    "Gotcha! Let's circle back so I can get you the right info — are you buying, selling, or both?",
  ],
  /**
   * Takes brandName as a parameter, same reasoning as outOfServiceArea above
   * — this was hardcoded to "3% Realty East Coast" until Mark's 2026-09-04
   * multi-client push (a second client, Mark's Realty, is now running
   * through this same code), which would have had Iris naming the wrong
   * brokerage on any other client's calls.
   */
  isRealPerson: (brandName: string): string[] => [
    `I'm part of the ${brandName} team, here to help book things faster and make this easier for you.`,
    `I work behind the scenes for the ${brandName} team — like an assistant helping things run smoother.`,
    "You're chatting with IRIS. I'm here to gather your information and help get you connected with the right person.",
  ],
  rentalRequest: [
    "We mainly focus on home buying and selling, but I'll note your info in case something comes up.",
    "Right now we specialize in buying and selling. Renting isn't our focus, but happy to keep you in mind if things shift.",
  ],
  alreadyBooked: [
    "Awesome! You're all set. If anything changes, I can help you reschedule.",
    "Perfect, the booking's in! Let me know if you need to tweak the time or details.",
  ],

  /** Iris must never guess — hand off instead. */
  dontKnowAnswer: "That's something I'd rather have one of our agents go over with you directly.",
  realEstateAdviceRequest: "That's something one of our agents would be better suited to go over with you.",

  /** Call-only: audio trouble. {{first_name}} is substituted by the caller. */
  lineBreakingUp: [
    "Hey {{first_name}}, your line is breaking up a little. Can you say that again?",
    "Sorry, I can barely hear you. Can you repeat that?",
    "I didn't quite catch that. Could you say that one more time?",
  ],
  /** Call-only: dead air. {{first_name}} is substituted by the caller. */
  silenceCheckIn: ["Are you still there?", "Hey {{first_name}}, I just want to make sure I haven't lost you."],
};

/**
 * Live transfer is ALWAYS the first priority for a qualified lead (see
 * qualification.ts's decideOutcome) — presented confidently, never as a
 * question. Downsize/upgrading intents use whichever transfer line matches
 * the transaction that has to happen first, same mapping as
 * calendarForIntent in qualification.ts.
 */
export const LIVE_TRANSFER_LINES = {
  // Jacob's live feedback, 2026-09-04: name the concrete benefit (seeing
  // real listings), not just "connect you" — the seller/general lines are
  // unchanged since he only gave feedback on the buyer case.
  buyer: "Perfect. We'll connect you with one of our buyer agents to send over some available home options.",
  seller: "Sounds good. I'll connect you with one of our seller agents now.",
  general: "Perfect. I'll connect you with one of our agents now.",
};

export function liveTransferLineForIntent(intent: CallIntent): string {
  if (intent === "seller" || intent === "downsize") return LIVE_TRANSFER_LINES.seller;
  if (intent === "buyer" || intent === "upgrading") return LIVE_TRANSFER_LINES.buyer;
  return LIVE_TRANSFER_LINES.general;
}

/**
 * Fallback when the live transfer can't be completed — booking, not the
 * first choice. Also the literal message Vapi's own transferPlan.fallbackPlan
 * speaks automatically if nobody picks up (see calling.ts) — not just
 * documentation for the model. Mark's live feedback, 2026-09-06, testing a
 * real call: warmer than the original ("Looks like they're tied up right
 * now") — doesn't bake in a specific time here, since whether a real time
 * can be offered next depends on whether a real calendar is available (see
 * buildLeadQualificationPrompt's schedulingFallback).
 */
export const AGENT_UNAVAILABLE_LINE = "They're busy with another client right now, but they'd love to connect with you.";

/**
 * Open question rather than pre-checked slots — there's no calendar behind
 * this anymore (see qualification.ts's callbackNotesFieldKey doc comment):
 * whatever day/time the lead names here is what gets scheduled directly via
 * schedule_callback, not checked against real availability first.
 */
export const AGENT_UNAVAILABLE_FOLLOW_UP = "What day and time works best for us to call you back?";

/**
 * ── Draft additions below, pending Jacob's SOP sign-off ─────────────────
 * Reverse-engineered from 5 real ISA call recordings (transcribed
 * 2026-09-01), not from the written SOP — it doesn't cover an opener, the
 * agent-unavailable slot offer above, or a closing recap yet. Being in this
 * file does not mean approved for this block specifically; treat as
 * proposed wording until confirmed.
 */

/**
 * Opens with a bare, natural greeting — nothing else. Mark's live feedback,
 * 2026-09-05: even the shorter one-liner ("Hi, this is Iris with X — am I
 * speaking with Y?") still crammed identification and a question into the
 * very first thing Iris says, before the lead has had any chance to say
 * "hello" the way a real person answering (or being called) would. This is
 * now just the opener — genuinely wait for whatever the lead does with it
 * before saying anything else. Who she's speaking with is its own turn,
 * see callIdentifyLine below and the opening sequence in
 * buildLeadQualificationPrompt.
 */
export function callOpeningGreeting(): string {
  return "Hey!";
}

/**
 * The identify-the-lead question — asked as its own turn after "Hey!",
 * whichever way that greeting landed (the lead said something back, or
 * stayed quiet). "there" is the sentinel dial-pending.ts/test scripts use
 * for "no real name on file" (see NormalisedLead.name) — asked for rather
 * than parroting a placeholder back at the lead.
 */
export function callIdentifyLine(firstName: string): string {
  return firstName && firstName !== "there"
    ? `Hey, am I speaking with ${firstName}?`
    : "Hey, who do I have the pleasure of speaking with?";
}

/**
 * Ties the call to why the lead is actually being contacted instead of a
 * cold, context-free opener. Returns null when intent is "unknown" or there
 * is nothing true to reference yet — never invent a reason for the call.
 *
 * Mark's live feedback, 2026-09-06: the previous version named the lead
 * source verbatim ("I saw you reached out through 1. Home Buyer Form a
 * little while ago") — reading GHL's internal form label out loud sounds
 * exactly like what it is, a database field, not a sentence. leadSource is
 * still accepted (kept for callers/signature compat) but no longer spoken —
 * "the form you submitted online" covers the same ground naturally. This
 * line now also does the job the separate intent-only verifying line used
 * to do (see buildLeadQualificationPrompt) — it already ends as a question,
 * so asking "still the plan?" again right after would just repeat it.
 */
export function callOpeningContextLine(
  intent: CallIntent,
  city: string,
  _leadSource: string | null
): string | null {
  const subject =
    intent === "seller"
      ? `selling your home in ${city}`
      : intent === "buyer"
        ? "buying a home"
        : intent === "downsize"
          ? "downsizing your home"
          : intent === "upgrading"
            ? "upgrading your home"
            : null;
  if (!subject) return null;
  return `I was calling about the form you submitted online about ${subject} — still the plan?`;
}

/**
 * Closes the loop with a recap — who, when, why — instead of ending right
 * after the last answer. agentName comes from routing (RoutingRule.agentName
 * in client config) once a lead is actually assigned; Iris must never invent
 * a name, so pass null until routing has genuinely picked someone.
 */
export function callbackRecapLine(chosenSlot: string, agentName: string | null, intent: CallIntent): string {
  const who = agentName ? `from ${agentName}` : "from one of our team";
  const goal =
    intent === "seller" || intent === "downsize"
      ? "help you sell this house"
      : intent === "buyer" || intent === "upgrading"
        ? "help you find the right home"
        : "help you out";
  return `So you're all set — you'll get a call ${chosenSlot} ${who}, and hopefully we can ${goal}.`;
}

/**
 * Natural phrasing for each Financing value — spoken back to the lead as
 * part of a verifying question, never the raw enum ("in-progress" read
 * aloud sounds like a bug report, not a sentence).
 */
const FINANCING_PHRASES: Record<Exclude<Financing, null>, string> = {
  cash: "paying in cash",
  "pre-approved": "already pre-approved",
  "in-progress": "still working on getting pre-approved",
  "not-approved": "not pre-approved yet",
};

/**
 * Turns what Scout/the lead form already established into a VERIFYING
 * question instead of Iris re-discovering it cold — Mark, 2026-09-05: the
 * buyer/seller tag and form answers already say what the lead wants, so
 * Iris's job on the call is to confirm it, not ask "are you looking to buy
 * or sell?" from scratch. Combines intent + area into one natural line when
 * both are known (matches the approved SOP example verbatim); falls back
 * to intent alone, or a plain area check when intent isn't known yet, so a
 * known fact is never silently dropped just because the other one is
 * missing.
 */
function verifyIntentAndAreaLine(intent: CallIntent, area: string | null): string | null {
  if (intent === "buyer" || intent === "upgrading") {
    return area ? `You were looking to buy a home in ${area}, right?` : "You reached out about buying a home — still the plan?";
  }
  if (intent === "seller" || intent === "downsize") {
    return area
      ? `I can see you're looking at selling your place in ${area} — is that right?`
      : "I can see you're looking at selling your home — is that right?";
  }
  return null;
}

function verifyAreaOnlyLine(area: string): string {
  return `You mentioned you're interested in ${area} — is that right?`;
}

function verifyTimelineLine(intent: CallIntent, timeline: string): string {
  const verb = intent === "seller" || intent === "downsize" ? "sell" : "make a move";
  return `You mentioned you're looking to ${verb} within ${timeline} — does that still sound right?`;
}

function verifyFinancingLine(financing: Exclude<Financing, null>): string {
  return `I also see you mentioned you're ${FINANCING_PHRASES[financing]} — still accurate?`;
}

/**
 * The real, full system prompt for an actual lead-qualification call —
 * assembled from this file's approved wording rather than written fresh, so
 * what Iris says on a real call matches what's actually been reviewed.
 *
 * This is the piece that was missing: agents/iris/calling.ts could place a
 * call, but every call placed so far (scripts/test-iris-call.ts) used a
 * bare connectivity-test prompt, not this. Iris's Slack persona
 * (agents/iris/index.ts) is deliberately separate — a colleague-report tone
 * for teammates is a different job from a live qualification call, and this
 * function is scoped to the latter only.
 *
 * Never re-asks what the lead already told Scout at intake — states each
 * known answer so Iris confirms rather than re-collects it, then only lists
 * what's still actually missing as things to ask.
 */
export function buildLeadQualificationPrompt(
  config: IrisConfig,
  lead: NormalisedLead,
  brandName: string,
  city: string,
  bookingToolsAvailable: boolean,
  transferAvailable: boolean,
  calendarAvailable: boolean
): string {
  const firstName = lead.name?.split(" ")[0] || "there";
  const identifyLine = callIdentifyLine(firstName);
  // Moved out of the firstMessage (see callOpeningGreeting) into the
  // opening-sequence instructions below, so the reason for the call is its
  // own turn rather than crammed into the first thing Iris says.
  const contextLine = callOpeningContextLine(lead.intent, city, lead.leadSource);

  // Verifying lines are actual sentences to speak, confirming what Scout/the
  // form already established — never a generic "confirm it" instruction.
  // stillNeeded stays the open-question fallback (config.questions) for
  // whatever genuinely isn't known yet. Branches independently on intent vs.
  // area so a known fact is never silently dropped just because the other
  // one is missing — see verifyIntentAndAreaLine's own comment.
  const verifying: string[] = [];
  const stillNeeded: string[] = [];

  if (lead.intent !== "unknown" && lead.propertyInterest) {
    verifying.push(verifyIntentAndAreaLine(lead.intent, lead.propertyInterest)!);
  } else if (lead.intent !== "unknown" && !lead.propertyInterest) {
    // Bare intent (no area yet) is already confirmed by the opening's own
    // contextLine below ("I was calling about the form you submitted online
    // about buying a home — still the plan?") — asking a second, separate
    // "still the plan?" here would just repeat the same question twice.
    stillNeeded.push(config.questions[1]);
  } else if (lead.intent === "unknown" && lead.propertyInterest) {
    verifying.push(verifyAreaOnlyLine(lead.propertyInterest));
    stillNeeded.push(config.questions[0]);
  } else {
    stillNeeded.push(config.questions[0]);
    stillNeeded.push(config.questions[1]);
  }

  // Property type + bedroom/bathroom count — Jacob's live feedback,
  // 2026-09-04. There's no GHL field capturing this today (nothing in
  // NormalisedLead tracks it), so it's always still-needed, never known.
  stillNeeded.push(config.questions[2]);

  if (lead.timeline) verifying.push(verifyTimelineLine(lead.intent, lead.timeline));
  else stillNeeded.push(config.questions[3]);

  if (lead.intent !== "seller") {
    if (lead.financing) verifying.push(verifyFinancingLine(lead.financing));
    else stillNeeded.push(config.questions[4]);
  }

  const verifyingBlock = verifying.length
    ? `## Verify what's already known — speak these as natural check-ins, ONE AT A TIME, pausing and waiting for their answer before the next one. Never re-discover any of this cold:
${verifying.map((l) => `- "${l}"`).join("\n")}

If their answer confirms it, acknowledge briefly (vary the phrase — see the acknowledgment rule below) and move on. If it conflicts with what's shown here — they say something's changed, or it was never quite right — treat THEIR latest answer as the real one, acknowledge the update naturally (e.g. "Got it, so that's changed a bit"), and never argue or repeat the stale value back at them.`
    : `## What you already know about this lead\nNothing yet — this is a cold first contact.`;

  const stillNeededBlock = stillNeeded.length
    ? `\n\n## Still need to gather — ask ONE at a time, always pausing and waiting for their answer before the next one\n${stillNeeded.map((q) => `- ${q}`).join("\n")}`
    : "";

  // bookingToolsAvailable reflects whether this environment actually has a
  // scheduling tool wired at all (VAPI_SERVER_URL set — it calls back to our
  // own server, which only exists once deployed). calendarAvailable further
  // distinguishes WHICH tool: check_and_book_appointment (a real calendar
  // was provisioned for this client/intent — calling.ts wires this instead
  // of schedule_callback when calendarId resolves) vs. the simpler
  // note+redial schedule_callback. Telling Iris to use a tool that isn't in
  // her tools list for this call would have her hallucinate having scheduled
  // something real, so this always matches what's actually possible.
  //
  // Mark, 2026-09-06: built once a real client calendar existed to verify
  // against — implements sections 11/12/16 of his human-like-behavior brief
  // (check real availability, never invent a slot, offer the nearest real
  // alternative) without inventing anything: the tool itself is the only
  // thing that ever asserts a time is open.
  const schedulingFallback = calendarAvailable
    ? `If they gave a specific day and time, work out the exact moment relative
to the current date and time above. If they didn't name one, suggest
roughly 3 hours from now as your first guess. Either way, call
check_and_book_appointment with that moment as an ISO 8601 timestamp —
never assume it's open, the tool tells you. If it books, confirm the exact
time back to them in plain language. If it comes back with alternatives
instead, offer 2-3 of them naturally and call the tool again with whichever
one they pick. If nothing is open at all today, offer the next real opening
within 24 hours the same way. Never say a time is available or booked unless
the tool actually confirmed it.

Example: "I don't have that exact time, but I've got an opening at 4:15pm —
would that work?" — always naming a real time the tool gave you, never one
you made up.`
    : bookingToolsAvailable
      ? `Then ask: "${AGENT_UNAVAILABLE_FOLLOW_UP}" Once they give a specific day and
time, work out the exact moment relative to the current date and time above,
then call schedule_callback with that as an ISO 8601 timestamp. Confirm the
callback back to them in plain language before ending the call — never claim
it's scheduled unless the tool actually confirmed it.`
      : `You do NOT have a working callback-scheduling tool on this call — do not
claim to have scheduled anything or invent a time. Instead say a teammate
will follow up directly to get them scheduled.`;

  // transferAvailable reflects whether transferNumber was actually resolved
  // for this lead's intent (calling.ts only wires the transferCall tool
  // when one was given). Confirmed live, 2026-09-04: without this check,
  // Iris was unconditionally told to "always invoke the transferCall tool"
  // even on a call where no such tool existed at all — she said the
  // transfer line and then had nothing to actually invoke.
  //
  // Mark, 2026-09-05: presenting the line was never conditioned on actually
  // hearing the lead say yes — invoke the tool right after saying it, so a
  // lead who says "I can't talk right now" got transferred anyway. Now the
  // line is followed by a real pause: only invoke transferCall once the
  // lead has said something that sounds like agreement, and if they signal
  // they're busy/unavailable instead, skip the transfer entirely and go
  // straight to the scheduling fallback below.
  const transferSection = transferAvailable
    ? `Live transfer is the first priority once you're done verifying — present
it confidently, don't ask permission, say the line, then STOP and wait:
"${liveTransferLineForIntent(lead.intent)}"

Listen to what they say next:
- Agreement ("okay", "sure", "yeah") → NOW invoke the transferCall tool available to you. Don't invoke it before they've responded.
- Unavailable right now ("I'm at work", "can you call me later", "I can't talk") → do NOT invoke transferCall at all. Acknowledge naturally and move straight to the scheduling fallback below instead.

If the transferCall tool comes back without anyone picking up: "${AGENT_UNAVAILABLE_LINE}"
${schedulingFallback}`
    : `You do NOT have a live-transfer tool on this call — never tell the lead
you're connecting them to an agent or say the line normally used for that,
since there is no way to actually do it here. Once you're ready to wrap up,
transition in your own words toward getting them scheduled with an agent
directly (something like "${AGENT_UNAVAILABLE_LINE}").
${schedulingFallback}`;

  const now = new Date();
  const nowLocal = now.toLocaleString("en-US", {
    timeZone: config.timezone || "America/St_Johns",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return `You are IRIS, an AI ISA (Inside Sales Assistant) for ${brandName}. You are on a
LIVE PHONE CALL with a real lead right now — not a Slack conversation, not a
test. You are NOT a real estate agent.

Right now it is ${nowLocal}. Use this as the reference point any time you
need to work out an exact date/time from something relative the lead says
("tomorrow afternoon", "Friday morning") — never guess or invent a time that
doesn't map back to this.

${verifyingBlock}${stillNeededBlock}

## How you open the call
Your first line was just "Hey!" — you don't yet know whether they said
anything back or stayed quiet, so react to whichever actually happened:
1. If they said something back (even just "hi" or "hello"): acknowledge it
   naturally, then ask "${identifyLine}" — then STOP and wait for their answer.
2. If there was silence: continue on your own with that same question —
   "${identifyLine}" — then STOP and wait for their answer.
3. Once you know who you're speaking with, introduce yourself by name:
   "This is Iris with ${brandName}." Say this even if nobody asked — don't
   wait to be prompted for it, and don't skip it if the lead already asked
   who you are earlier in the call.
4. Then ask how they're doing today, and genuinely wait for their answer.
5. Acknowledge it naturally and briefly (e.g. "${NATURAL_TRANSITIONS.call[4]}" or
   another line from natural conversation — vary it, don't reuse the same
   one every call) — don't launch straight into business.
6. Only then bring up why you're calling${contextLine ? `: "${contextLine}"` : ", using what's already known about them above"}.
7. Move into verifying what's known, then gathering what's still needed
   (both below) — one at a time, always pausing and genuinely waiting for
   their answer before asking the next one. Never stack more than one question
   into a single turn, and never answer your own question. If an item below
   reads as two questions in one line (e.g. "What type of home, and how many
   bedrooms?"), split it into two separate turns yourself — ask the first
   part, wait, then ask the second.

## Your job
Verify what's known above, gather what's still needed, decide fit, then get
a qualified lead connected to the right agent — as a natural back-and-forth
conversation, not a questionnaire being read aloud.

${transferSection}

## How you sound
- Speak, then pause and actually listen — don't fill every silence. A short
  pause is normal and better than rushing to the next line.
- If the lead starts talking while you're mid-sentence, stop talking,
  listen to what they actually said, and respond to that — never talk over
  them or finish your own sentence first.
- Vary your acknowledgments — "${NATURAL_TRANSITIONS.call[0]}", "${NATURAL_TRANSITIONS.call[1]}",
  "${NATURAL_TRANSITIONS.call[2]}", "${NATURAL_TRANSITIONS.call[3]}", "${NATURAL_TRANSITIONS.call[4]}" — never repeat
  the exact same one twice in a row.
- The conversation always takes priority over this script. If the lead says
  something that doesn't match what you expected next, respond to what they
  actually said before deciding what to ask next — don't plow ahead with
  the next scripted question regardless.
- When you mention a day/time (a scheduled callback, an appointment, or
  your own reasoning like "since it's currently..."), say it simply — day
  of week and time only, e.g. "Saturday at 5 PM". Never read out the exact
  date, month, year, or a timezone offset (like "GMT minus 2:30") — that
  reads like a database timestamp, not a sentence. Only give the exact
  date if the lead actually asks for it.

## Ending the call
You have an endCall tool — use it once you've said your goodbye out loud and
there is genuinely nothing left to do: the callback is confirmed and you've
wrapped up, or the lead has said they're done and you've said bye back. Never
call it mid-conversation, and never call it instead of a live transfer or
before a callback is actually confirmed — only after your final goodbye line.
Don't just say goodbye and keep talking; if you've said it, end the call.

## Rules you must never break
- Never give legal, investment, mortgage, or financial advice:
  "${EDGE_CASE_RESPONSES.realEstateAdviceRequest}"
- Never claim to be human or a licensed agent, e.g.:
  "${EDGE_CASE_RESPONSES.isRealPerson(brandName)[0]}"
- Never guess an answer you don't have:
  "${EDGE_CASE_RESPONSES.dontKnowAnswer}"
- Respect an existing agent relationship — don't push:
  buyer: "${EDGE_CASE_RESPONSES.buyerHasAgent[0]}"
  seller: "${EDGE_CASE_RESPONSES.sellerHasAgentOrListed[0]}"
- The service area is ${city} only — if asked about elsewhere:
  "${EDGE_CASE_RESPONSES.outOfServiceArea(city)[0]}"
- If the lead goes quiet, follow up at most twice, then stop:
  "${EDGE_CASE_RESPONSES.leadStoppedResponding[0]}" then
  "${EDGE_CASE_RESPONSES.leadStoppedRespondingFinal}"
- If the lead is upset, stay calm, don't argue, offer to connect them with an agent.
- Ask one clear question at a time — never stack several into one message.

Never invent a location, calendar id, or field key that isn't in this
client's config. Be warm, concise, and match the lead's energy.`;
}

/**
 * Left on the lead's voicemail when Vapi's voicemail detection fires —
 * see agents/iris/calling.ts's voicemailDetection config. Short and
 * self-contained on purpose: unlike a live call, there's no back-and-forth
 * to react to, so this can't reference anything the lead hasn't said yet.
 * Points them to a text follow-up rather than promising a specific callback
 * time, since nothing has actually scheduled one at this point.
 */
export function buildVoicemailMessage(brandName: string): string {
  return `Hi, this is Iris calling from ${brandName}. Sorry I missed you — I'll follow up by text shortly, or feel free to call this number back anytime. Thanks, and have a great day!`;
}
