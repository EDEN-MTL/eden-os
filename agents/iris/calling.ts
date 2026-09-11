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
import { createCall, getVapiEnvConfig, CreateCallPayload, VapiCallResult, VapiTool } from "../../shared/vapi";
import { query } from "../../shared/db";
import { isCallingEnabled } from "./calling-settings";
import { CallIntent } from "./qualification";
import { AGENT_UNAVAILABLE_LINE, buildVoicemailMessage, callOpeningGreeting } from "./scripts";

export class CallingDisabledError extends Error {}

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
  if (params.budget) details.push(`around a ${params.budget} budget`);
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
  // Just the opening turn — identify Iris and ask who she's speaking with,
  // then stop and wait. Everything else (how are you, the reason for the
  // call) happens as its own turn, driven by the system prompt below, not
  // crammed into this one line. See scripts.ts's callOpeningGreeting.
  const firstMessage = callOpeningGreeting();

  const tools: VapiTool[] = [];

  if (params.transferNumber) {
    const audience = params.intent === "seller" || params.intent === "downsize" ? "seller" : "buyer";
    const briefing = buildAgentBriefing(params, audience);
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
                type: "regex",
                regex: "\\b([Yy]es|[Yy]eah|[Yy]ep|[Yy]up|[Ss]ure|[Oo]k|[Oo]kay|[Ff]ine|[Aa]lright|[Dd]efinitely|[Aa]bsolutely|[Pp]lease)\\b|[Ss]ounds good|[Gg]o ahead|[Tt]hat works",
                target: { position: -1, role: "user" },
                negate: true,
              },
              {
                // "connect you with" is the one substring every
                // LIVE_TRANSFER_LINES variant (buyer/seller/general) shares
                // — see scripts.ts's LIVE_TRANSFER_LINES.
                type: "regex",
                regex: "[Cc]onnect you with",
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
              // Bare greeting only, and it does NOT speak first — same
              // pattern as the main call's own opening (callOpeningGreeting
              // / firstMessageMode "assistant-waits-for-user"). Mark's live
              // feedback, 2026-09-11: this was previously set to
              // "assistant-speaks-first", which had Iris say "Hi!" the
              // instant the operator's line connected, before they'd said
              // anything at all — a real operator experienced this as
              // being talked at the moment they picked up. Waiting lets the
              // operator say their own "Hello?" first, the way a real
              // transferred call actually feels; if they stay silent, Vapi
              // itself says a bare "Hi!" on Iris's behalf after a moment,
              // same fallback the main call already relies on.
              firstMessage: "Hi!",
              firstMessageMode: "assistant-waits-for-user",
              maxDurationSeconds: 120,
              silenceTimeoutSeconds: 30,
              model: {
                provider: vapiConfig.modelProvider,
                model: vapiConfig.modelName,
                messages: [
                  {
                    role: "system",
                    content:
                      "You do NOT speak first — wait for the operator to say something (a real " +
                      "\"Hello?\" or anything else) once their line connects, the way a person naturally " +
                      "does when they pick up. If they stay silent for a few seconds, the system says a " +
                      "bare \"Hi!\" on your behalf automatically — that isn't something you choose to say, " +
                      "it just happens. Either way, once it's your turn, react to whatever they actually " +
                      `said, then ask "This is Iris with ${params.brandName}. Who am I speaking with?" and ` +
                      "wait for their name. Greet them by name once given (e.g. \"Hi Jason\"), then " +
                      `immediately give this exact briefing, adjusting only for natural phrasing: "${briefing}" ` +
                      "— then confirm they're ready to take the call. Once they confirm, say ONE bridging " +
                      "line out loud before doing anything else — something like \"Perfect, connecting you " +
                      `now — ${params.firstName !== "there" ? params.firstName : "the lead"} is on the ` +
                      "line, go ahead\" (use the operator's own name if they gave one, e.g. " +
                      "\"Perfect Jason, connecting you now\"). Mark's live feedback, 2026-09-10, after " +
                      "watching a real transfer succeed: neither side got any spoken cue that the merge " +
                      "had actually happened — the operator didn't know the lead was live on the line yet, " +
                      "and the lead had no idea who they'd just been connected to. This bridging line exists " +
                      "so neither person has to guess. ONLY once you've said it, immediately call " +
                      "transferSuccessful. Use transferCancel for voicemail, no answer, or a declined " +
                      "transfer. After transferSuccessful, your job is done — never end the call yourself; " +
                      "let the operator and the lead continue the conversation on their own. Keep " +
                      "everything you say brief — the whole briefing should take a few seconds, not a full " +
                      "CRM readout. If the operator starts talking while you're mid-sentence, stop, listen " +
                      "to what they actually said, and respond to that first — but don't just drop the rest " +
                      "of your briefing because you got cut off. Once you've responded to whatever they " +
                      "said, pick back up with whatever you still hadn't gotten to yet (their name, the " +
                      "briefing, confirming they're ready, or the bridging line) — the operator still needs " +
                      "that information even if the delivery got interrupted partway through. Whenever you " +
                      "say a number out loud — the lead's budget, a phone number, anything numeric in the " +
                      "briefing — say it the way a person actually would (\"around four hundred to five " +
                      "hundred thousand\"), never digit by digit (\"4-0-0 to 5-0-0 k\") or like you're " +
                      "reading a spreadsheet cell.",
                  },
                ],
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
          content: "Perfect, you're all booked! Thanks so much for your time today — if anything comes up, just text us at this number.",
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
  // confirmation ("you're all booked") — genuinely assistant-role content,
  // not a tool result, so far more likely to actually be in scope for a
  // liquid condition. Combined with Mark's instruction that Iris must
  // never hang up on her own until she's actually heard back from the
  // lead afterward (or the lead's gone quiet, ending with the exact "I'll
  // hold off for now" line from the two-check-in rule): rejects unless
  // EITHER a user message follows that confirmation, or the "hold off for
  // now" line was reached. Never blocks a legitimate endCall after a
  // successful transfer, an explicit lead goodbye, or an unresponsive
  // lead who's been through the two-check-in sequence, since none of
  // those paths ever produce the "you're all booked" confirmation to
  // begin with (transfer/goodbye) or they satisfy the escape valve.
  // Still unverified against a real live call — watch the next test.
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
            "{%- if c contains \"you're all booked\" -%}" +
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
      // shouldn't wait forever — but she also shouldn't speak the moment
      // the call connects, which is what firstMessage alone would do
      // under the default "assistant-speaks-first" mode. This nudge fires
      // once (triggerMaxCount: 1), never repeats mid-call
      // (triggerResetMode: "onUserSpeech" — the clock only matters for
      // this initial silence, not every later pause), and just says a
      // bare "Hi!" rather than firstMessage's full greeting, matching the
      // same "wait, don't lead with everything at once" rhythm as the
      // opening sequence in buildLeadQualificationPrompt.
      hooks: [
        {
          on: "customer.speech.timeout",
          do: [{ type: "say", exact: "Hi!" }],
          options: { timeoutSeconds: 5, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
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
      // backoffPlan widens the default detection window (~2s/2.5s) to
      // 4s/4s — confirmed live 2026-09-03: with the default timing, Vapi
      // repeatedly flagged a real live pickup as voicemail mid-greeting
      // (cut Iris off after "I'm calling about the home you—" and played
      // the voicemail message instead), 4 times in a row against the same
      // number. Per Vapi's own voicemail-detection docs, this exact
      // false-positive pattern is known, and widening startAtSeconds/
      // frequencySeconds to 3-4s is their documented fix.
      voicemailDetection: { provider: "vapi", backoffPlan: { startAtSeconds: 4, frequencySeconds: 4, maxRetries: 5 } },
      voicemailMessage: buildVoicemailMessage(params.brandName),
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
