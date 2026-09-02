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
import { createCall, getVapiEnvConfig, CreateCallPayload, VapiCallResult } from "../../shared/vapi";
import { query } from "../../shared/db";
import { isCallingEnabled } from "./calling-settings";
import { CallIntent } from "./qualification";
import { buildVoicemailMessage, CALL_OPENING_GREETING, callOpeningContextLine } from "./scripts";

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
      serverUrl: vapiConfig.serverUrl,
      // Without this, Vapi has no way to tell the call apart from a live
      // pickup — Iris just talks into the machine as if a person answered,
      // which is exactly what happened testing against this number twice.
      voicemailDetection: { provider: "vapi" },
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
