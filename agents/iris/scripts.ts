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
  call: ["Got it.", "Makes sense.", "Sounds good.", "Absolutely."],
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
  isRealPerson: [
    "I'm part of the 3% Realty East Coast team, here to help book things faster and make this easier for you.",
    "I work behind the scenes for the 3% Realty East Coast team — like an assistant helping things run smoother.",
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
  buyer: "Perfect. Based on what you've shared, I'll connect you with one of our buyer agents now.",
  seller: "Sounds good. I'll connect you with one of our seller agents now.",
  general: "Perfect. I'll connect you with one of our agents now.",
};

export function liveTransferLineForIntent(intent: CallIntent): string {
  if (intent === "seller" || intent === "downsize") return LIVE_TRANSFER_LINES.seller;
  if (intent === "buyer" || intent === "upgrading") return LIVE_TRANSFER_LINES.buyer;
  return LIVE_TRANSFER_LINES.general;
}

/** Fallback when the live transfer can't be completed — booking, not the first choice. */
export const AGENT_UNAVAILABLE_LINE = "Looks like they're tied up right now. Let's get you booked for a quick phone call instead.";

/**
 * Offers two concrete slots rather than an open "what time works for you?" —
 * an open question on a call tends to get a vague answer and burns another
 * round trip. {{slot_a}} / {{slot_b}} are two times already confirmed against
 * the callback calendar, substituted by the (not yet built) call execution
 * step — never offer a time that hasn't actually been checked as free.
 */
export const AGENT_UNAVAILABLE_FOLLOW_UP = "Would {{slot_a}} or {{slot_b}} work better for you?";

/**
 * ── Draft additions below, pending Jacob's SOP sign-off ─────────────────
 * Reverse-engineered from 5 real ISA call recordings (transcribed
 * 2026-09-01), not from the written SOP — it doesn't cover an opener, the
 * agent-unavailable slot offer above, or a closing recap yet. Being in this
 * file does not mean approved for this block specifically; treat as
 * proposed wording until confirmed.
 */

/** Opens with who's calling, not just what it's about — matches every real call reviewed. */
export const CALL_OPENING_GREETING = "Hi {{first_name}}, this is Iris with {{brand_name}}. How are you doing today?";

/**
 * Ties the call to why the lead is actually being contacted instead of a
 * cold, context-free opener. Returns null when intent is "unknown" or there
 * is nothing true to reference yet — never invent a reason for the call.
 * leadSource is passed through as-is (e.g. NormalisedLead.leadSource); most
 * leads carry no ad attribution yet (see Scout's system prompt), so this is
 * commonly null and the source clause is simply omitted.
 */
export function callOpeningContextLine(
  intent: CallIntent,
  city: string,
  leadSource: string | null
): string | null {
  const subject =
    intent === "seller"
      ? `the house you're looking at selling in ${city}`
      : intent === "buyer"
        ? "the home you're looking to buy"
        : intent === "downsize"
          ? "downsizing your home"
          : intent === "upgrading"
            ? "upgrading your home"
            : null;
  if (!subject) return null;
  return leadSource
    ? `I'm calling about ${subject} — I saw you reached out through ${leadSource} a little while ago.`
    : `I'm calling about ${subject}.`;
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
  bookingToolsAvailable: boolean
): string {
  const known: string[] = [];
  const stillNeeded: string[] = [];

  const track = (label: string, value: string | null, ask: string) => {
    if (value) known.push(`- ${label}: ${value} — already known, do NOT ask again`);
    else stillNeeded.push(ask);
  };

  track("Intent", lead.intent !== "unknown" ? lead.intent : null, config.questions[0]);
  track("Area/property interest", lead.propertyInterest, config.questions[1]);
  track("Timeline", lead.timeline, config.questions[2]);
  if (lead.intent !== "seller") track("Financing", lead.financing, config.questions[3]);

  const knownBlock = known.length
    ? `## What you already know about this lead — confirm it, never re-ask it\n${known.join("\n")}`
    : `## What you already know about this lead\nNothing yet — this is a cold first contact.`;

  const stillNeededBlock = stillNeeded.length
    ? `\n\n## Still need to gather\n${stillNeeded.map((q) => `- ${q}`).join("\n")}`
    : "";

  // bookingToolsAvailable reflects whether this environment actually has the
  // check_availability/book_appointment tools wired (VAPI_SERVER_URL set —
  // they call back to our own server, which only exists once deployed).
  // Telling Iris to use tools that aren't in her tools list for this call
  // would have her hallucinate having booked something real. Match what's
  // actually possible rather than describing the ideal end state always.
  const transferFallback = bookingToolsAvailable
    ? `If the transferCall tool comes back without anyone picking up: "${AGENT_UNAVAILABLE_LINE}"
Then call the check_availability tool to get real open times — never invent
times yourself. Offer the lead the two it returns rather than an open
question: "${AGENT_UNAVAILABLE_FOLLOW_UP}" Once they pick one, call
book_appointment with that exact time to actually confirm it, then recap
what you just booked before ending the call.`
    : `If a transfer genuinely can't happen right now: "${AGENT_UNAVAILABLE_LINE}"
You do NOT have a working booking tool on this call — do not claim to have
booked anything or invent a time. Instead say a teammate will follow up
directly to get them scheduled.`;

  return `You are IRIS, an AI ISA (Inside Sales Assistant) for ${brandName}. You are on a
LIVE PHONE CALL with a real lead right now — not a Slack conversation, not a
test. You are NOT a real estate agent.

${knownBlock}${stillNeededBlock}

## Your job
Confirm what's known above, gather what's still needed, decide fit, then get
a qualified lead connected to the right agent. Live transfer is ALWAYS the
first priority — present it confidently, don't ask permission, and actually
invoke the transferCall tool available to you (not just say the line):
"${liveTransferLineForIntent(lead.intent)}"

${transferFallback}

## Rules you must never break
- Never give legal, investment, mortgage, or financial advice:
  "${EDGE_CASE_RESPONSES.realEstateAdviceRequest}"
- Never claim to be human or a licensed agent, e.g.:
  "${EDGE_CASE_RESPONSES.isRealPerson[0]}"
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
