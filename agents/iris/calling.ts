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
  propertyInterest?: string | null;
  financing?: string | null;
  /**
   * Real calendar for this call's intent (qualification.ts's
   * callbackCalendarForIntent). Omit to skip wiring the real-time
   * availability tool — the call falls back to schedule_callback's simple
   * note+redial system instead, same soft-fail pattern as transferNumber.
   */
  calendarId?: string;
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
  const details: string[] = [];
  if (params.propertyInterest) details.push(`in ${params.propertyInterest}`);
  if (params.budget) details.push(`around a ${params.budget} budget`);
  if (params.timeline) details.push(`hoping to move within ${params.timeline}`);
  if (audience === "buyer" && params.financing) details.push(`financing: ${params.financing}`);

  const detailText = details.length > 0 ? `, ${details.join(", ")}` : "";
  return `I have ${who} on the other line, a ${audience} lead${detailText}.`;
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
      destinations: [
        {
          type: "number",
          number: params.transferNumber,
          description: `Transfer to the ${audience} team once the lead is qualified and ready to talk to a real agent.`,
          transferPlan: {
            mode: "warm-transfer-experimental",
            transferAssistant: {
              // Short bare greeting, same reasoning as callOpeningGreeting
              // for the main call — Mark, 2026-09-05: don't launch into the
              // briefing before the operator has even said anything back.
              firstMessage: "Hey!",
              firstMessageMode: "assistant-speaks-first",
              maxDurationSeconds: 120,
              silenceTimeoutSeconds: 30,
              model: {
                provider: vapiConfig.modelProvider,
                model: vapiConfig.modelName,
                messages: [
                  {
                    role: "system",
                    content:
                      `You just said "Hey!" to whoever picked up — wait for them to respond, then ask ` +
                      `"This is Iris with ${params.brandName}. Who am I speaking with?" and wait for their ` +
                      "name. Greet them by name once given (e.g. \"Hey Jason\"), then immediately give this " +
                      `exact briefing, adjusting only for natural phrasing: "${briefing}" — then confirm ` +
                      "they're ready to take the call. Once they confirm, immediately call " +
                      "transferSuccessful. Use transferCancel for voicemail, no answer, or a declined " +
                      "transfer. After transferSuccessful, your job is done — never end the call yourself; " +
                      "let the operator and the lead continue the conversation on their own. Keep " +
                      "everything you say brief — the whole briefing should take a few seconds, not a full " +
                      "CRM readout.",
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
    const qs = new URLSearchParams({
      clientId: params.clientId,
      contactId: params.contactId,
      calendarId: params.calendarId,
      intent: params.intent === "seller" || params.intent === "downsize" ? "seller" : "buyer",
    }).toString();

    tools.push({
      type: "function",
      function: {
        name: "check_and_book_appointment",
        description:
          "Checks a specific time against the REAL calendar and books it immediately if it's open. If " +
          "that exact time isn't available, returns the nearest REAL open times instead — never invents " +
          "availability. Call this for ANY specific day/time you're about to propose or confirm, whether " +
          "the lead named it or you suggested it (e.g. 'about 3 hours from now') — never assume a time is " +
          "open just because it sounds reasonable. If it comes back with alternatives, offer them to the " +
          "lead and call this tool again once they pick one, to actually book it.",
        parameters: {
          type: "object",
          properties: {
            requestedTime: {
              type: "string",
              description:
                "The exact moment to check/book, as an ISO 8601 timestamp, computed relative to the " +
                "current date and time given to you at the top of this prompt — never a bare time like " +
                "'2pm' with no date.",
            },
          },
          required: ["requestedTime"],
        },
      },
      server: { url: `${vapiConfig.serverUrl}/tools/check-and-book-appointment?${qs}`, secret: vapiConfig.webhookSecret },
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
  tools.push({ type: "endCall" });

  return {
    phoneNumberId: vapiConfig.phoneNumberId,
    customer: { number: params.phone },
    assistant: {
      firstMessage,
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
