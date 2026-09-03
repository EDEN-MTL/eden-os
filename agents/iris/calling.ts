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
import {
  AGENT_UNAVAILABLE_LINE,
  buildVoicemailMessage,
  CALL_OPENING_GREETING,
  callOpeningContextLine,
} from "./scripts";

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
}

/**
 * Builds the transient assistant config Vapi actually calls with. Pure and
 * testable — no network, no DB. {{first_name}} / {{brand_name}} placeholders
 * in the shared script lines are substituted here since this is the one
 * place that actually knows who's being called.
 */
export function buildCallPayload(
  params: PlaceCallParams,
  vapiConfig: ReturnType<typeof getVapiEnvConfig>
): CreateCallPayload {
  const greeting = CALL_OPENING_GREETING.replace("{{first_name}}", params.firstName).replace(
    "{{brand_name}}",
    params.brandName
  );
  const contextLine = callOpeningContextLine(params.intent, params.city, params.leadSource);
  const firstMessage = contextLine ? `${greeting} ${contextLine}` : greeting;

  const tools: VapiTool[] = [];

  if (params.transferNumber) {
    const audience = params.intent === "seller" || params.intent === "downsize" ? "seller" : "buyer";
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
              firstMessage: `Hi, I have a ${audience} lead${
                params.firstName !== "there" ? ` (${params.firstName})` : ""
              } on the line, ready to talk. Are you available to take the call?`,
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
                      "Confirm a human operator is ready to take this call. Use transferSuccessful once " +
                      "they accept. Use transferCancel for voicemail, no answer, or a declined transfer. " +
                      "Keep this brief and focused only on confirming the handoff.",
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

  if (vapiConfig.serverUrl && params.contactId) {
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

  return {
    phoneNumberId: vapiConfig.phoneNumberId,
    customer: { number: params.phone },
    assistant: {
      firstMessage,
      model: {
        provider: vapiConfig.modelProvider,
        model: vapiConfig.modelName,
        messages: [{ role: "system", content: params.systemPrompt }],
      },
      voice: {
        provider: vapiConfig.voiceProvider,
        voiceId: vapiConfig.voiceId,
      },
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
      tools: tools.length > 0 ? tools : undefined,
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
