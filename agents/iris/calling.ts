/**
 * Places Iris's outbound Vapi calls. This is the ONLY function in the
 * codebase allowed to actually dial — everything else (webhook handling,
 * scripts, config) is either read-only or downstream of a call this
 * function already placed.
 *
 * Two independent, unconditional gates, same idiom as the Meta compliance
 * gate (shared/meta/compliance.ts — "a HARD gate, not a rule... no bypass
 * flag, by design"):
 *   1. isCallingEnabled() must return true — reads the iris_calling_enabled
 *      row in ad_settings fresh on every call, defaults to false.
 *   2. All required VAPI_* env vars must be set (getVapiEnvConfig throws
 *      otherwise).
 * There is no parameter that skips either check.
 *
 * Called two ways: scripts/test-iris-call.ts (by hand, against a number the
 * operator controls) and agents/iris/dial-pending.ts (the real automatic
 * path — a lead.enriched event queues a delayed dial, a cron job resolves
 * it here once a fresh re-check confirms the lead still hasn't been
 * touched). Both go through the same two gates below either way.
 */
import { createCall, getVapiEnvConfig, CreateCallPayload, VapiCallResult, VapiTool, VapiFunctionTool } from "../../shared/vapi";
import { query } from "../../shared/db";
import { isCallingEnabled } from "./calling-settings";
import { CallIntent } from "./qualification";
import { AGENT_UNAVAILABLE_LINE, buildCallOpeningLine, expandBudgetShorthand, IDLE_NUDGE_VARIATIONS } from "./scripts";

export class CallingDisabledError extends Error {}

/**
 * Mark's spec, 2026-09-12 ("END CALL LOGIC — APPOINTMENT CONFIRMED"):
 * book_appointment's guaranteed request-complete confirmation, randomized
 * per call so Iris doesn't sound identical on every booking, and closing
 * with Mark's own suggested "reply to the text" line (reduces no-shows,
 * keeps the conversation open). Deliberately every variant contains BOTH
 * "notification" and "text" — the endCall rejectionPlan below detects any
 * of these by checking for that pair rather than hardcoding all five
 * phrases.
 *
 * Deliberately NOT personalized with the lead's name (reverted 2026-09-12
 * after a real call): this content is fixed at call-PLACEMENT time and
 * spoken by Vapi directly — the model never gets a chance to intercept or
 * correct it. A real call had the lead correct his name early on ("Mark",
 * not the form's "Manny") — Iris correctly used "Mark" for the rest of
 * the call in her own speech, but this guaranteed line, baked in before
 * the call even started, still said "Manny." A channel the model can't
 * fix must never risk saying a name that could go stale mid-call.
 */
export function bookingConfirmationLines(): string[] {
  return [
    "Perfect — your appointment is all set. You'll receive a notification with all the details shortly. If anything comes up before then, feel free to reply to the text.",
    "Alright, you're all booked in! You'll get a notification with the details in a bit. If anything comes up before then, feel free to reply to the text.",
    "Great — your appointment has been confirmed. You'll receive a notification shortly with all the details. If anything comes up before then, feel free to reply to the text.",
    "Awesome, you're all set! You'll get a quick notification with all the info. If anything comes up before then, feel free to reply to the text.",
    "Perfect, everything's booked. You'll receive a notification with the details shortly. If anything comes up before then, feel free to reply to the text.",
  ];
}

/**
 * Mark's spec, 2026-09-12: reschedule_appointment's own guaranteed
 * request-complete confirmation, parallel to bookingConfirmationLines.
 * Every variant also contains BOTH "notification" and "text" so the same
 * endCall rejectionPlan gate below detects a reschedule confirmation too,
 * with no separate gate logic needed for it. Not personalized, same
 * reasoning as bookingConfirmationLines above.
 */
export function rescheduleConfirmationLines(): string[] {
  return [
    "Great — I've updated your appointment to the new time. You'll get a notification with the details, and if anything comes up before then, feel free to reply to the text.",
    "Awesome, you're all set for the new time. You'll get a notification with the updated details. If anything comes up before then, feel free to reply to the text.",
    "Perfect, your appointment's been moved to the new time. You'll get a notification shortly. If anything comes up before then, feel free to reply to the text.",
  ];
}

export interface PlaceCallParams {
  clientId: string;
  brandName: string;
  city: string;
  phone: string;
  firstName: string;
  intent: CallIntent;
  leadSource: string | null;
  systemPrompt: string;
  contactId?: string;
  triggeredBy?: "manual" | "automatic";
  /**
   * Real ring-group number for this call's intent (qualification.ts's
   * transferNumberForIntent). Omit to skip wiring the transferCall tool
   * entirely — e.g. scripts/test-iris-call.ts's bare connectivity test has
   * no real lead or intent to transfer.
   */
  transferNumber?: string;
  /** Passed through to the warm-transfer agent briefing — see buildAgentBriefing below. */
  budget?: string | null;
  timeline?: string | null;
  /** Property TYPE ("Single Family Home"), not area — see NormalisedLead.propertyInterest's own doc comment. */
  propertyInterest?: string | null;
  bedrooms?: string | null;
  financing?: string | null;
  /**
   * Real calendar for this call's intent (qualification.ts's
   * callbackCalendarForIntent). Omit to skip wiring the real-time
   * availability tool — the call falls back to schedule_callback's simple
   * note+redial system instead, same soft-fail pattern as transferNumber.
   */
  calendarId?: string;
  /** Passed through to the appointment-notes summary — see buildLeadDetails below. */
  workingWithRealtor?: boolean | null;
}

/**
 * Shared "what do we actually know about this lead" fact list — used both
 * for the warm-transfer agent briefing (buildAgentBriefing) and for the
 * notes written onto a booked GHL appointment (see check_and_book_appointment's
 * wiring below). One source of fact-strings so the two never drift apart.
 */
function buildLeadDetails(params: PlaceCallParams, audience: "buyer" | "seller"): string[] {
  const details: string[] = [];
  // Mark, 2026-09-06: propertyInterest is PROPERTY TYPE ("Single Family
  // Home"), not area — this used to read "in Single Family Home", which
  // sounds like a place name. "looking for a X" is correct regardless of
  // client, since no client checked so far has a real area field at all.
  if (params.propertyInterest) details.push(`looking for a ${params.propertyInterest}`);
  if (params.bedrooms) details.push(`${params.bedrooms} bedrooms`);
  if (params.budget) details.push(`around a ${expandBudgetShorthand(params.budget)} budget`);
  if (params.timeline) details.push(`hoping to move within ${params.timeline}`);
  if (audience === "buyer" && params.financing) details.push(`financing: ${params.financing}`);
  if (params.workingWithRealtor !== null && params.workingWithRealtor !== undefined) {
    details.push(params.workingWithRealtor ? "already working with a realtor" : "not working with a realtor");
  }
  return details;
}

/**
 * What Iris tells the human agent once they pick up the warm transfer —
 * Mark, 2026-09-05: previously just "I have a {audience} lead (name) on the
 * line", which left the agent to re-discover everything Scout and this
 * same call already established. Keeps it to what's actually known and
 * actually useful — never a full CRM dump — so the agent can pick up the
 * conversation in one breath instead of re-qualifying from scratch.
 */
function buildAgentBriefing(params: PlaceCallParams, audience: "buyer" | "seller"): string {
  const who = params.firstName !== "there" ? params.firstName : "a lead";
  const details = buildLeadDetails(params, audience);
  const detailText = details.length > 0 ? `, ${details.join(", ")}` : "";
  return `I have ${who} on the other line, a ${audience} lead${detailText}.`;
}

/**
 * The lead-facts half of a booked appointment's notes — see
 * check_and_book_appointment's wiring below for where the conversational
 * half (Iris's own free-text summary) gets appended to this. Mark's
 * request, 2026-09-08: a booked appointment only ever carried a generic
 * "Booked automatically by Iris during a live call" note — no lead details
 * at all, meaning whoever picks up the appointment has to re-open the
 * contact and re-derive everything Iris already established.
 */
function buildAppointmentLeadSummary(params: PlaceCallParams, audience: "buyer" | "seller"): string {
  const who = params.firstName !== "there" ? params.firstName : "the lead";
  const details = buildLeadDetails(params, audience);
  const detailText = details.length > 0 ? ` — ${details.join(", ")}.` : ".";
  return `${who}, a ${audience} lead${detailText}`;
}

/**
 * Builds the transient assistant config Vapi actually calls with. Pure and
 * testable — no network, no DB.
 */
export function buildCallPayload(
  params: PlaceCallParams,
  vapiConfig: ReturnType<typeof getVapiEnvConfig>
): CreateCallPayload {
  // The full opening turn — greeting, self-intro, and the identify
  // question, as ONE line. Root cause found live, 2026-09-16: under
  // firstMessageMode "assistant-waits-for-user", Vapi speaks firstMessage
  // VERBATIM the instant the other party speaks, before the model gets a
  // turn — a bare "Hi!" here was the exact bare "Hi." every real call kept
  // showing, mechanically, regardless of what the system prompt said.
  // Everything else (how are you, the reason for the call) still happens
  // as its own later turn, driven by the system prompt.
  const firstMessage = buildCallOpeningLine(params.firstName, params.brandName);

  const tools: VapiTool[] = [];

  // Mark's spec, 2026-09-12: a backup for the lead's own name being wrong
  // on file (misheard, a form typo, a nickname) — separate from the
  // pre-call gate (agents/iris/index.ts, dial-pending.ts) that already
  // refuses to dial at all when no name exists. Available whenever there's
  // a real contactId to correct, independent of calendar/transfer setup.
  if (vapiConfig.serverUrl && params.contactId) {
    const nameQs = new URLSearchParams({ clientId: params.clientId, contactId: params.contactId }).toString();
    tools.push({
      type: "function",
      function: {
        name: "update_lead_name",
        description:
          "Corrects the lead's name on file in the CRM — only call this when the lead confirms they ARE " +
          "the right person but says the name itself is wrong (a mispronunciation, a form typo, a nickname " +
          "they go by instead). Never call this when someone denies being the lead entirely — that's a " +
          "different case (see the rule on that below).",
        parameters: {
          type: "object",
          properties: {
            correctedName: {
              type: "string",
              description: "Exactly the corrected name the lead gave you — never a guess or a name you invented.",
            },
          },
          required: ["correctedName"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/update-lead-name?${nameQs}`, secret: vapiConfig.webhookSecret },
    });

    // Mark's spec, 2026-09-12: a live transfer previously left the ISA
    // notes field untouched — the receiving agent had no summary at all
    // unless a callback happened instead. Iris (not the transfer
    // assistant) calls this once qualification is done, since she's the
    // one who heard any live corrections to the form/Scout data.
    tools.push({
      type: "function",
      function: {
        name: "save_isa_notes",
        description:
          "Saves a structured qualification summary to the CRM's ISA notes field, visible to whoever " +
          "picks up this lead (transfer or callback). Call this ONCE, right before presenting the live " +
          "transfer or the scheduling fallback — after every fact has been verified/gathered, so the " +
          "summary reflects the FINAL, corrected information, not the original form data if the lead " +
          "corrected anything during this call.",
        parameters: {
          type: "object",
          properties: {
            notes: {
              type: "string",
              description:
                "A concise, structured note using ONLY information actually collected on this call — " +
                "never invented or guessed, and never a field that wasn't actually provided (leave it out " +
                "entirely rather than guessing). Format as line-per-fact, e.g. for a buyer: " +
                "\"Lead: [name]\\nIntent: Buyer\\nTimeline: [x]\\nTarget Area: [x]\\nBudget: [x]\\n" +
                "Property Type: [x]\\nPre-Approval: [x]\\nAdditional Context: [anything fresh from this " +
                "call, e.g. a corrected value].\" For a seller, use Property/Timeline/Property Type/" +
                "Reason-Context/Replacement Home in place of the buyer-specific fields.",
            },
          },
          required: ["notes"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/save-isa-notes?${nameQs}`, secret: vapiConfig.webhookSecret },
    });
  }

  if (params.transferNumber) {
    const audience = params.intent === "seller" || params.intent === "downsize" ? "seller" : "buyer";
    const briefing = buildAgentBriefing(params, audience);
    // The full transfer-assistant opening turn, same root-cause fix as the
    // main call's firstMessage (2026-09-16): under firstMessageMode
    // "assistant-waits-for-user", Vapi speaks firstMessage verbatim the
    // instant the operator speaks, before the model gets a turn — a bare
    // "Hi!" here was the exact bare "Hi." every real transfer kept
    // showing, mechanically, regardless of what the system prompt said.
    const transferOpeningLine =
      `Hi, this is Iris from ${params.brandName}. I've got a ${audience} lead on the other line. ` +
      "Who am I speaking with?";

    // Mark's spec, 2026-09-12: once a live transfer connects, identify
    // which real team member picked up and assign the lead to them in the
    // CRM — rather than leaving every transferred lead's owner unset.
    // Wired only when there's a real contactId to assign (same gate as the
    // booking tools) — match_transfer_agent/assign_transfer_owner have
    // nothing to act on otherwise (e.g. scripts/test-iris-call.ts's bare
    // connectivity test has no real contact). Confirmed live, 2026-09-12,
    // against Vapi's own OpenAPI schema (TransferAssistantModel): the
    // transferAssistant's own `tools` array is real and additive —
    // transferSuccessful/transferCancel stay available regardless.
    const transferToolsQs = new URLSearchParams({ clientId: params.clientId, contactId: params.contactId || "" }).toString();
    const identificationTools: VapiFunctionTool[] =
      vapiConfig.serverUrl && params.contactId
        ? [
            {
              type: "function",
              function: {
                name: "match_transfer_agent",
                description:
                  "Matches a spoken name against the REAL team roster for this location — never books, " +
                  "assigns, or changes anything itself. Call this the moment the operator gives their name, " +
                  "before greeting them or giving the briefing. Returns MATCH (one confident real match), " +
                  "AMBIGUOUS (more than one real match — ask which), or NO_MATCH (no real match at all).",
                parameters: {
                  type: "object",
                  properties: {
                    spokenName: {
                      type: "string",
                      description: "Exactly what the operator said when asked their name — never your own guess or a name you invented.",
                    },
                  },
                  required: ["spokenName"],
                },
              },
              server: { url: `${vapiConfig.serverUrl}/tools/match-transfer-agent?${transferToolsQs}`, secret: vapiConfig.webhookSecret },
            },
            {
              type: "function",
              function: {
                name: "assign_transfer_owner",
                description:
                  "Actually assigns this lead to a real team member in the CRM — the ONLY tool that does " +
                  "this. Only ever call this with a matchedUserId you already got back from " +
                  "match_transfer_agent's own MATCH or AMBIGUOUS result, copied character for character — " +
                  "never one you typed or guessed yourself. Omit matchedUserId entirely only after a genuine " +
                  "NO_MATCH that didn't resolve even after one retry — this tags the lead for manual " +
                  "follow-up instead of guessing.",
                parameters: {
                  type: "object",
                  properties: {
                    matchedUserId: {
                      type: "string",
                      description: "The exact id from match_transfer_agent's MATCH/AMBIGUOUS result — omit only when giving up after NO_MATCH.",
                    },
                  },
                },
              },
              server: { url: `${vapiConfig.serverUrl}/tools/assign-transfer-owner?${transferToolsQs}`, secret: vapiConfig.webhookSecret },
            },
          ]
        : [];

    // Confirmed-once-is-enough, 2026-09-15: an earlier version also had the
    // model read a MATCH result back for spoken confirmation ("Got it, is
    // this [name]?") — redundant on top of already asking who they were, per
    // real operator feedback (Jacob, live test). A confident MATCH is now
    // trusted directly; only AMBIGUOUS genuinely needs a spoken check.
    const agentIdentificationClause =
      identificationTools.length > 0
        ? ` Before greeting them by name, match their name to a real team member so the lead gets ` +
          `assigned correctly. The moment they give you their name, call match_transfer_agent with ` +
          `exactly what they said — never guess who it might be yourself.\n` +
          `- MATCH (one confident real match): trust it — call assign_transfer_owner with that exact id ` +
          `right away, with no spoken confirmation step, and move straight to greeting them by name and ` +
          `giving the briefing below.\n` +
          `- AMBIGUOUS (multiple real matches): ask using the ACTUAL candidate names it gave you, e.g. ` +
          `"I have a couple of Andrews — is this Andrew Fleming or Andrew Smith?" Once they pick one, call ` +
          `assign_transfer_owner with that person's id.\n` +
          `- NO_MATCH: ask them to repeat their name once ("Sorry, can you repeat your name?"), then call ` +
          `match_transfer_agent again with what they say. If it's STILL NO_MATCH after that one retry, ` +
          `stop trying — call assign_transfer_owner with no matchedUserId at all, and move on with the ` +
          `call exactly as normal. Never guess a name or invent a match just to avoid this outcome.`
        : "";

    tools.push({
      type: "transferCall",
      // Structural backup for the prompt's own "say the line, wait, only
      // transfer on agreement" instruction — see VapiToolRejectionPlan's
      // doc comment. Requires BOTH: the lead's most recent message actually
      // sounds like agreement, AND Iris's own immediately-preceding turn
      // actually said the transfer line — not assuming either on its own.
      //
      // Mark's live feedback, 2026-09-08: even with the agreement-only
      // check below already live, a real call had Iris invoke transferCall
      // having never said the transfer line at all — she went straight
      // from the last qualifying question to the tool call, skipping the
      // announcement and the pause entirely. A regex on the user's last
      // message can't catch that; this adds a second condition targeting
      // role: "assistant" for the transfer line itself, combined via a
      // group (top-level conditions are ANDed in Vapi's schema, which isn't
      // what's needed here — see VapiRejectionCondition's own doc comment).
      rejectionPlan: {
        conditions: [
          {
            type: "group",
            operator: "OR",
            conditions: [
              {
                // No inline (?i) here despite Vapi's own docs showing it in
                // their examples — that syntax isn't valid in Node's RegExp
                // at all, and their schema explicitly says rejectionPlan
                // regexes run through RegExp.test. Explicit case variants
                // instead, confirmed to actually compile via a live regex
                // engine rather than trusting the vendor's own (apparently
                // broken) example.
                // Expanded 2026-09-16, confirmed live: a real call had the
                // lead reply "No problem." to the transfer announcement,
                // then later explicitly ask "Can you do live transfer
                // again?" — neither matched this regex, so THREE separate
                // legitimate transfer attempts got rejected by this
                // structural gate, and Iris fell back to offering a
                // callback instead of ever actually dialing. Added "no
                // problem"/"that's fine"/"sure thing" as natural
                // acknowledgment phrasings, and the bare word "transfer"
                // to catch an explicit request like the one above.
                type: "regex",
                regex:
                  "\\b([Yy]es|[Yy]eah|[Yy]ep|[Yy]up|[Ss]ure|[Oo]k|[Oo]kay|[Ff]ine|[Aa]lright|[Dd]efinitely|[Aa]bsolutely|[Pp]lease|[Tt]ransfer)\\b|[Ss]ounds good|[Gg]o ahead|[Tt]hat works|[Nn]o problem|[Tt]hat's fine|[Tt]hat's ok(?:ay)?|[Ss]ure thing",
                target: { position: -1, role: "user" },
                negate: true,
              },
              {
                // "connect you with"/"connect with you" covers every
                // LIVE_TRANSFER_LINES variant (buyer/seller/general — see
                // scripts.ts) AND AGENT_UNAVAILABLE_LINE's own "love to
                // connect with you" phrasing, so a retry attempt right
                // after a fallback line still passes this check. Widened
                // 2026-09-16 from "connect you with" only, confirmed live
                // that a retry attempt landed right after a message using
                // the "with you" word order instead.
                type: "regex",
                regex: "[Cc]onnect (?:you with|with you)",
                target: { position: -2, role: "assistant" },
                negate: true,
              },
            ],
          },
        ],
      },
      destinations: [
        {
          type: "number",
          number: params.transferNumber,
          description: `Transfer to the ${audience} team once the lead is qualified and ready to talk to a real agent.`,
          transferPlan: {
            mode: "warm-transfer-experimental",
            transferAssistant: {
              // Does NOT speak first — same pattern as the main call's own
              // opening (firstMessageMode "assistant-waits-for-user").
              // Waiting lets the operator say their own "Hello?" first, the
              // way a real transferred call actually feels. firstMessage is
              // now the FULL canonical opening line (2026-09-16 — see
              // transferOpeningLine's own comment above for why): Vapi
              // speaks it verbatim the instant the operator speaks, so this
              // guarantees the correct opening regardless of the model.
              firstMessage: transferOpeningLine,
              firstMessageMode: "assistant-waits-for-user",
              maxDurationSeconds: 120,
              silenceTimeoutSeconds: 30,
              model: {
                provider: vapiConfig.modelProvider,
                model: vapiConfig.modelName,
                // The live-transfer flow, 2026-09-15/16 (consolidated from
                // several rounds of live-call fixes — see git history on
                // this file for the blow-by-blow): the opening line is now
                // said automatically via firstMessage (transferOpeningLine
                // above), match the operator's name silently, brief them
                // once, get an EXPLICIT yes before merging (a vague "okay"
                // isn't enough — confirmed live that operators don't parse
                // that as consent to merge), then the moment the merge
                // succeeds, go silent — a post-merge lead-presence check
                // was tried and removed after confirming (Vapi's own docs
                // on SIP REFER) that Iris has no audio channel into the
                // call anymore once the merge completes.
                messages: [
                  {
                    role: "system",
                    content:
                      "Your opening line is spoken FOR you, automatically, the instant the operator says " +
                      `anything at all once their line connects (even just "hello?"): "${transferOpeningLine}" ` +
                      "This is a mechanical platform behavior, not something you generate or choose to say. " +
                      "Root cause found live, 2026-09-16, after this exact line kept getting split into a " +
                      "bare \"Hi.\" that waited to be asked who you were, despite several rounds of prompt " +
                      "fixes: that bare \"Hi.\" was never something the model said — it came from the call " +
                      "platform's own literal first-message field, spoken instantly, before the model ever " +
                      "got a turn. Fixed by making that field say this exact full line instead. If the " +
                      "operator never says anything at all, the same line gets said automatically after a " +
                      "short wait instead.\n" +
                      "Because of this: you did NOT actually generate that opening line yourself — it " +
                      "already happened by the time you get your first real turn. NEVER say it again, never " +
                      "repeat it, never paraphrase a second version of it, and never say a bare \"Hi\" of " +
                      "your own on top of it. Your first actual turn is reacting to whatever the operator " +
                      "says in response to already having heard it — most often their name. Then STOP and " +
                      "wait for their name if they haven't given it yet.\n" +
                      `${agentIdentificationClause}` +
                      "\nOnce you have a name — confirmed through the matching above if it applies, or just " +
                      "given directly otherwise — greet them by it (\"Perfect, [their name].\"), then " +
                      "briefly explain who's on the other line and why, using ONLY these exact facts, " +
                      `adjusted only for natural phrasing (never invented or guessed, never said twice): "${briefing}" No filler before or around it ` +
                      "— never \"[lead] is waiting on the other line,\" \"please hold while I connect " +
                      "you,\" or anything narrating the mechanics of what you're doing. Keep it to one or " +
                      "two sentences. If they ask a real question you can answer from the briefing, answer " +
                      "it first.\n" +
                      "Then ask a real, explicit yes/no question about merging the call — never merge on a " +
                      "vague acknowledgment to the briefing alone. Pick ONE, vary each time: \"Are you " +
                      "ready for me to merge the call now?\" / \"Ready for me to bring them on?\" / \"Should " +
                      "I go ahead and connect you now?\" / \"Ready to merge you in?\" Then STOP and wait for " +
                      "their answer. On a genuine yes (or clear equivalent — \"yep\", \"go ahead\", " +
                      "\"sure\", \"ready\"), call transferSuccessful right away — no further line needed, " +
                      "the question already said what's about to happen. On a no or a request to wait, " +
                      "hold off and ask again once they say they're ready. If they ask a real question " +
                      "instead of answering, answer it, then re-ask the merge question. Use transferCancel " +
                      "instead for voicemail, no answer, or a declined transfer.\n" +
                      "The MOMENT transferSuccessful succeeds, your job is done — go silent immediately, " +
                      "no \"okay?\", no \"have a great day\", no second sentence, nothing. Never speak " +
                      "again for the rest of this call unless something goes structurally wrong (never " +
                      "re-qualify, never re-transfer, never start booking, never interrupt the operator or " +
                      "the lead) — let them continue the conversation entirely on their own.\n" +
                      "If the operator starts talking while you're mid-sentence at any point in this whole " +
                      "flow, stop, listen to what they actually said, and respond to that first — but don't " +
                      "just drop the rest of what you still needed to say because you got cut off; pick back " +
                      "up with it once you've responded, except once transferSuccessful has succeeded, " +
                      "where silence is the correct final state, not something to recover from. Whenever " +
                      "you say a number out loud — the " +
                      "lead's budget, a phone number, anything numeric in the briefing — say it the way a " +
                      "person actually would (\"around four hundred to five hundred thousand\"), never digit " +
                      "by digit (\"4-0-0 to 5-0-0 k\") or like you're reading a spreadsheet cell.",
                  },
                ],
                tools: identificationTools.length > 0 ? identificationTools : undefined,
              },
            },
            // endCallEnabled: false is what returns control to Iris (rather
            // than ending the call) if nobody in the ring group picks up —
            // see shared/vapi's VapiTransferCallTool doc comment for why
            // this specific mode/field combination, not a simpler one.
            fallbackPlan: { message: AGENT_UNAVAILABLE_LINE, endCallEnabled: false },
          },
        },
      ],
    });
  }

  if (vapiConfig.serverUrl && params.contactId && params.calendarId) {
    // Real-time calendar path — only wired when a real callbackCalendarId
    // resolved for this client/intent (qualification.ts's
    // callbackCalendarForIntent). Replaces schedule_callback entirely for
    // this call rather than offering both — one clear tool for "how do I
    // handle scheduling," not two overlapping ones. Mark, 2026-09-06: built
    // once a real test calendar existed to verify against live (never
    // invent availability — see AGENT_UNAVAILABLE_FOLLOW_UP's history).
    //
    // Split into two tools 2026-09-11 (previously one combined
    // check_and_book_appointment): three straight real calls had a genuine
    // "Booked for" result followed immediately by endCall with nothing
    // spoken at all — no prompt wording held. Vapi tools support a
    // `messages: [{type: "request-complete"}]` config that speaks a
    // guaranteed confirmation the instant a tool call succeeds,
    // independent of the model — but Vapi has no way to attach that only
    // to the "actually booked" branch of a single tool's response; a
    // combined tool's "success" (the webhook responded) and "a real
    // booking happened" aren't the same fact. Splitting into a read-only
    // check and a book-only tool makes them the same fact for
    // book_appointment specifically, so it's the only one that carries
    // this guarantee. See VapiToolMessage's own doc comment in shared/vapi.
    const audience = params.intent === "seller" || params.intent === "downsize" ? "seller" : "buyer";
    const qs = new URLSearchParams({
      clientId: params.clientId,
      contactId: params.contactId,
      calendarId: params.calendarId,
      intent: audience,
      // Baked in at call-placement time from what Scout/this call already
      // know — never left to the model to retype, same reasoning as
      // buildAgentBriefing's briefing string. See handleBookAppointment.
      leadSummary: buildAppointmentLeadSummary(params, audience),
    }).toString();

    const bookingLines = bookingConfirmationLines();
    const rescheduleLines = rescheduleConfirmationLines();

    tools.push({
      type: "function",
      function: {
        name: "check_availability",
        description:
          "Checks a specific time against the REAL calendar — never books anything, never invents " +
          "availability. Call this for ANY specific day/time you're about to propose or confirm, whether " +
          "the lead named it or you suggested it (e.g. 'about 3 hours from now'). If it comes back " +
          "available or with real alternatives, and the lead agrees to one, call book_appointment with " +
          "that exact isoTime to actually lock it in — this tool alone never creates a booking.",
        parameters: {
          type: "object",
          properties: {
            requestedTime: {
              type: "string",
              description:
                "The exact moment to check, as an ISO 8601 timestamp, computed relative to the current " +
                "date and time given to you at the top of this prompt — never a bare time like '2pm' with " +
                "no date.",
            },
          },
          required: ["requestedTime"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/check-availability?${qs}`, secret: vapiConfig.webhookSecret },
    });

    tools.push({
      type: "function",
      function: {
        name: "book_appointment",
        description:
          "Actually creates a real appointment on the calendar — the ONLY tool that does. Only ever call " +
          "this with an exact isoTime value you already got back from check_availability (either as the " +
          "confirmed exact match, or as one of the real alternatives the lead agreed to) — never a time " +
          "you haven't checked first.",
        parameters: {
          type: "object",
          properties: {
            isoTime: {
              type: "string",
              description:
                "The exact isoTime value from check_availability's response, copied character for " +
                "character — never recomputed from the spoken phrase.",
            },
            conversationNotes: {
              type: "string",
              description:
                "OPTIONAL — a short (one sentence) note on anything from THIS call worth flagging to " +
                "whoever picks up the appointment: a correction the lead gave (e.g. 'budget actually " +
                "changed to 500k'), something specific they mentioned, or a concern they raised. Never " +
                "restate facts already known before the call — only what came up freshly during it. Omit " +
                "entirely if there's nothing beyond the standard facts.",
            },
          },
          required: ["isoTime"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/book-appointment?${qs}`, secret: vapiConfig.webhookSecret },
      // Guaranteed, model-independent confirmation — see this file's own
      // comment above and VapiToolMessage's doc comment in shared/vapi.
      // Can't echo the exact day/time (no confirmed templating in this
      // schema), which is fine — Iris already said the specific time
      // herself when proposing it, just before this tool locks it in.
      // endCallAfterSpokenEnabled defaults to false, so control returns to
      // Iris afterward to actually wait for the lead's response before she
      // invokes endCall herself — see buildLeadQualificationPrompt's
      // "Ending the call" section.
      messages: [
        {
          type: "request-complete",
          role: "assistant",
          // Randomized per call, Mark's spec 2026-09-12 ("END CALL LOGIC —
          // APPOINTMENT CONFIRMED"): a single fixed line sounded repetitive
          // call after call. All five variants deliberately share both
          // "notification" and "text" so the endCall rejectionPlan's liquid
          // check below can detect any of them without hardcoding five
          // separate phrases.
          content: bookingLines[Math.floor(Math.random() * bookingLines.length)],
        },
      ],
    });

    // Mark's spec, 2026-09-12: a lead changing their mind after a real
    // booking needs a genuine reschedule, not a duplicate appointment or a
    // "teammate will follow up" brush-off. Only wired alongside
    // book_appointment (same server/contactId/calendarId gate above) since
    // there's nothing to reschedule without a real booking tool in the
    // first place. See handleRescheduleAppointment in webhooks/vapi-tools.ts
    // — it UPDATES the same appointment record book_appointment created,
    // confirmed live 2026-09-12, rather than creating a second one.
    tools.push({
      type: "function",
      function: {
        name: "reschedule_appointment",
        description:
          "Changes an EXISTING real appointment (already booked earlier this call via book_appointment) " +
          "to a new time — the only tool that does this, and safe to call more than once if the lead " +
          "changes their mind again. Only ever call this with an exact isoTime you already got back from " +
          "check_availability, AND the exact appointmentId book_appointment's own result gave you this " +
          "call. Never call this before book_appointment has actually succeeded once this call — call " +
          "book_appointment for that instead.",
        parameters: {
          type: "object",
          properties: {
            isoTime: {
              type: "string",
              description:
                "The exact isoTime value from check_availability's response, copied character for " +
                "character — never recomputed from the spoken phrase.",
            },
            appointmentId: {
              type: "string",
              description:
                "The exact appointmentId from book_appointment's own success result this call, copied " +
                "character for character — never invented or reused across different calls. This is what " +
                "makes sure the right appointment gets changed rather than a guess.",
            },
          },
          required: ["isoTime", "appointmentId"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/reschedule-appointment?${qs}`, secret: vapiConfig.webhookSecret },
      // Same guaranteed, model-independent confirmation mechanism as
      // book_appointment above — see that tool's own comment. Every
      // variant here also contains "notification" and "text", so the
      // existing endCall rejectionPlan gate below covers a reschedule
      // confirmation too, with no changes needed to that gate itself.
      messages: [
        {
          type: "request-complete",
          role: "assistant",
          content: rescheduleLines[Math.floor(Math.random() * rescheduleLines.length)],
        },
      ],
    });
  } else if (vapiConfig.serverUrl && params.contactId) {
    const qs = new URLSearchParams({
      clientId: params.clientId,
      contactId: params.contactId,
    }).toString();

    tools.push({
      type: "function",
      function: {
        name: "schedule_callback",
        description:
          "Records that this lead asked to be called back at a specific time. Only call this once you " +
          "and the lead have agreed on a concrete day and time — never a vague one. Leaves a note on the " +
          "lead's record and schedules a real follow-up call for that exact moment; it does not book a " +
          "calendar appointment.",
        parameters: {
          type: "object",
          properties: {
            callbackTime: {
              type: "string",
              description:
                "The exact moment the lead agreed to, as an ISO 8601 timestamp, computed relative to the " +
                "current date and time given to you at the top of this prompt — never a bare time like " +
                "'2pm' with no date, and never earlier than a few minutes from now.",
            },
          },
          required: ["callbackTime"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/schedule-callback?${qs}`, secret: vapiConfig.webhookSecret },
    });
  }

  // Always available, unconditionally — every call needs a way to actually
  // end once Iris is genuinely done, regardless of intent/transfer/callback
  // state. See buildLeadQualificationPrompt's "Ending the call" section for
  // when she's told to use it.
  //
  // rejectionPlan added 2026-09-11 as a structural backstop for a bug the
  // prompt's own "MECHANICAL GATE" section already tried to fix three
  // separate times on three different real calls: Iris gets a "Booked for"
  // tool result and invokes endCall right after with no accompanying
  // day/time confirmation at all — sometimes not even a "Goodbye". A
  // prompt instruction alone kept not holding, same lesson as
  // transferCall's own rejectionPlan above.
  //
  // CONFIRMED LIVE, 2026-09-11, this exact version did NOT fire: a real
  // "Booked for Friday 2:00 PM" result came back, Iris invoked endCall
  // ~1.3s later with zero words spoken in between, and the tool succeeded
  // — the rejectionPlan never blocked it. Leading hypothesis: Vapi's docs
  // describe the liquid `messages` variable as carrying role "user",
  // "assistant", "system" — tool-call results may not be included in that
  // array at all, in which case checking for the literal tool-result text
  // "Booked for" could never match anything, since that string only ever
  // existed inside a tool result, never in something Iris herself said.
  //
  // Redesigned same day around the book_appointment/check_availability
  // split above: rather than looking for tool-result text that may not be
  // visible here, this now looks for Vapi's OWN guaranteed spoken
  // confirmation — genuinely assistant-role content, not a tool result, so
  // far more likely to actually be in scope for a liquid condition.
  // Combined with Mark's instruction that Iris must never hang up on her
  // own until she's actually heard back from the lead afterward (or the
  // lead's gone quiet, ending with the exact "I'll hold off for now" line
  // from the two-check-in rule): rejects unless EITHER a user message
  // follows that confirmation, or the "hold off for now" line was reached.
  // Never blocks a legitimate endCall after a successful transfer, an
  // explicit lead goodbye, or an unresponsive lead who's been through the
  // two-check-in sequence, since none of those paths ever produce this
  // confirmation to begin with (transfer/goodbye) or they satisfy the
  // escape valve.
  //
  // Updated 2026-09-12 for bookingConfirmationLines' 5 randomized
  // variants: checks for "notification" AND "text" together (every variant
  // contains both — see that constant's own comment) rather than the single
  // literal "you're all booked" phrase, which only one of the five variants
  // still contains. Confirmed live 2026-09-11 with the single-phrase
  // version of this gate — the mechanism itself (liquid seeing genuinely
  // spoken assistant content) is proven; this only widens the match.
  tools.push({
    type: "endCall",
    rejectionPlan: {
      conditions: [
        {
          type: "liquid",
          liquid:
            "{%- assign bookedFound = false -%}" +
            "{%- assign heardBack = false -%}" +
            "{%- for msg in messages -%}" +
            "{%- if msg.role == 'assistant' -%}" +
            "{%- assign c = msg.content | downcase -%}" +
            "{%- if c contains 'notification' and c contains 'text' -%}" +
            "{%- assign bookedFound = true -%}" +
            "{%- endif -%}" +
            "{%- if bookedFound and c contains 'hold off for now' -%}" +
            "{%- assign heardBack = true -%}" +
            "{%- endif -%}" +
            "{%- endif -%}" +
            "{%- if bookedFound and msg.role == 'user' -%}" +
            "{%- assign heardBack = true -%}" +
            "{%- endif -%}" +
            "{%- endfor -%}" +
            "{%- if bookedFound and heardBack == false -%}true{%- else -%}false{%- endif -%}",
        },
      ],
    },
  });

  return {
    phoneNumberId: vapiConfig.phoneNumberId,
    customer: { number: params.phone },
    assistant: {
      firstMessage,
      firstMessageMode: "assistant-waits-for-user",
      // Mark's live feedback, 2026-09-06: if the lead stays silent, Iris
      // shouldn't wait forever — firstMessage alone never fires under
      // "assistant-waits-for-user" if the lead never speaks at all, so
      // this hook is the actual fallback for that case.
      //
      // timeoutSeconds bumped 5 -> 8 -> 15 (2026-09-15, 2026-09-19):
      // confirmed live, twice, via real transcripts and Vapi's own docs,
      // that this timer is NOT scoped to "the lead never said anything at
      // the start of the call" — it fires on the first qualifying gap of
      // customer silence ANYWHERE in the call. Widening the number alone
      // has diminishing returns (a real person can easily pause 15-20s+
      // mid-thought answering an open-ended question), so as of
      // 2026-09-21 the actual fix is WHAT gets said (IDLE_NUDGE_VARIATIONS,
      // scripts.ts), not just when — see that constant's own doc comment.
      //
      // triggerResetMode fixed "onUserSpeech" → "never", 2026-09-15:
      // confirmed live (real transcript, timestamps) and via Vapi's own
      // docs that "onUserSpeech" actually RESETS the trigger count every
      // time the lead speaks — "never" is Vapi's own documented default
      // and is what makes triggerMaxCount an honest total-per-call cap.
      //
      // triggerMaxCount raised 1 -> 3, 2026-09-22, Mark's explicit spec:
      // try checking in at least 3 times before giving up, not just once.
      // Since timeoutSeconds' clock "starts when the assistant finishes
      // speaking" (Vapi's own docs), each firing re-arms the SAME 15s wait
      // after itself, so this naturally produces 3 check-ins roughly 15s
      // apart if the lead stays silent throughout, no extra hook needed
      // for the repetition itself. `exact` is the raw variations array,
      // not a single pre-picked string — Vapi randomly picks one PER
      // firing on its own side, so a lead who gets all 3 nudges doesn't
      // hear the identical line 3 times in a row.
      hooks: [
        {
          on: "customer.speech.timeout",
          do: [{ type: "say", exact: IDLE_NUDGE_VARIATIONS }],
          options: { timeoutSeconds: 15, triggerMaxCount: 3, triggerResetMode: "never" },
        },
        // Mark's spec, 2026-09-22: if the lead still hasn't responded even
        // after all 3 check-ins above, Iris should give up and end the
        // call rather than sit in dead air (or worse, drift back into
        // qualification as if someone answered). A SEPARATE hook entry,
        // not a 4th action tacked onto the nudge hook — Vapi's
        // customer.speech.timeout only fires the `do` actions of the ONE
        // hook whose own condition is met, so this needs its own trigger
        // to end the call specifically once the nudges are exhausted,
        // not as a side effect of any one of them.
        //
        // Every time the nudge hook fires, it resets THIS hook's clock too
        // (both are keyed off the same "time since the assistant last
        // spoke"), so as long as this hook's timeoutSeconds (30) is always
        // greater than the nudge hook's per-trigger timeoutSeconds (15),
        // the nudge hook will always win the race and re-arm this one —
        // right up until its own triggerMaxCount (3) is used up, at which
        // point it stops re-arming and this hook's own 30s window (after
        // whichever nudge was last spoken) is what finally ends the call.
        // That ordering guarantee holds regardless of the exact per-hook
        // reset semantics, which is why 30 only needs to stay > 15, not
        // some precisely-tuned number.
        {
          on: "customer.speech.timeout",
          do: [{ type: "tool", tool: { type: "endCall" } }],
          options: { timeoutSeconds: 30, triggerMaxCount: 1, triggerResetMode: "never" },
        },
      ],
      model: {
        provider: vapiConfig.modelProvider,
        model: vapiConfig.modelName,
        messages: [{ role: "system", content: params.systemPrompt }],
        tools: tools.length > 0 ? tools : undefined,
      },
      voice: {
        provider: vapiConfig.voiceProvider,
        voiceId: vapiConfig.voiceId,
      },
      // Confirmed against Vapi's own OpenAPI schema (api.vapi.ai/api-json),
      // 2026-09-05 — both fields live directly on `assistant`, not nested
      // under `model` like `tools` (see shared/vapi's VapiAssistantConfig
      // doc comment for that distinction). Mark's human-like-behavior brief,
      // same date: waitSeconds raised from Vapi's 0.4s default so Iris gives
      // the lead a beat to finish a thought instead of jumping in the moment
      // audio goes quiet. stopSpeakingPlan is left mostly at Vapi's own
      // defaults (undocumented here but sensible out of the box — a bare
      // "yeah"/"okay" never interrupts, "wait"/"stop"/"actually" always do)
      // — only voiceSeconds is nudged up slightly to cut down on false
      // interrupts from background noise on a real phone line.
      startSpeakingPlan: { waitSeconds: 0.7 },
      stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1 },
      server: vapiConfig.serverUrl ? { url: vapiConfig.serverUrl, secret: vapiConfig.webhookSecret } : undefined,
      // Without this, Vapi has no way to tell the call apart from a live
      // pickup — Iris just talks into the machine as if a person answered,
      // which is exactly what happened testing against this number twice.
      //
      // backoffPlan widens the default detection window (~2s/2.5s). First
      // widened to 4s/4s — confirmed live 2026-09-03: with the default
      // timing, Vapi repeatedly flagged a real live pickup as voicemail
      // mid-greeting (cut Iris off after "I'm calling about the home
      // you—" and played the voicemail message instead), 4 times in a row
      // against the same number.
      //
      // 4s/4s alone was NOT enough: confirmed live again 2026-09-18 against
      // a real seller lead — she picked up and said "Hello?", and 2 seconds
      // later Vapi still played the voicemail message ("Sorry I missed
      // you...") over her, and she hung up confused 17s in. Per Vapi's own
      // voicemail-detection docs, this is a known, explicitly documented
      // failure mode ("Assistant leaves voicemail message when human picks
      // up"), and pushing startAtSeconds/frequencySeconds further (their
      // own guidance) is the first thing to try before reaching for a
      // provider swap. "vapi" itself is Vapi's own recommended default
      // provider (a Gemini+beep+real-time hybrid) — the alternatives
      // (google: more accurate but slower; openai: more accurate but
      // costs more; twilio: explicitly "prone to false positives," legacy)
      // are real options if this recurs again at 5s/5s, but a provider
      // change has cost/latency tradeoffs worth a deliberate call, not a
      // silent swap.
      // Mark's call, 2026-09-23: stop leaving a voicemail message at all —
      // detection itself stays ON (still needed to correctly tell a real
      // pickup apart from a machine, per the comment above), but per
      // Vapi's own docs, voicemailMessage "if unspecified, it will hang
      // up." Omitting it entirely is the actual "no voicemail" behavior,
      // not disabling voicemailDetection (which would regress to Iris
      // talking into the machine as if a person answered — the original
      // bug this whole config exists to prevent).
      voicemailDetection: { provider: "vapi", backoffPlan: { startAtSeconds: 5, frequencySeconds: 5, maxRetries: 5 } },
    },
  };
}

/**
 * Places a real call and logs it. Throws CallingDisabledError before
 * touching the network if either gate isn't satisfied — see the module
 * comment above.
 */
export async function placeCall(params: PlaceCallParams): Promise<VapiCallResult> {
  const enabled = await isCallingEnabled(params.clientId);
  if (!enabled) {
    throw new CallingDisabledError(
      `Iris calling is disabled for client "${params.clientId}" (ad_settings.iris_calling_enabled ` +
        `is not "true"). Run scripts/enable-iris-calling.ts to turn it on deliberately — it does not ` +
        `turn on by itself.`
    );
  }

  const vapiConfig = getVapiEnvConfig();
  const payload = buildCallPayload(params, vapiConfig);
  const result = await createCall(payload, vapiConfig.apiKey);

  await query(
    `INSERT INTO iris_call_log (client_id, vapi_call_id, contact_id, phone, status, triggered_by)
     VALUES ($1, $2, $3, $4, 'initiated', $5)`,
    [params.clientId, result.id, params.contactId ?? null, params.phone, params.triggeredBy ?? "manual"]
  );

  return result;
}
