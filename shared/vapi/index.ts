/**
 * Vapi voice API client — thin HTTP transport only, same split as
 * shared/ghl: this module knows how to talk to Vapi, nothing about whether
 * a call SHOULD be placed. That decision (the iris_calling_enabled gate)
 * lives in agents/iris/calling.ts, one layer up — same shape as shared/ghl
 * (transport) vs agents/scout/intake.ts (business logic).
 */

const VAPI_BASE_URL = "https://api.vapi.ai";

export interface VapiAssistantConfig {
  firstMessage: string;
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
  };
  voice: {
    provider: string;
    voiceId: string;
  };
  serverUrl?: string;
  /**
   * Vapi's own detection ("vapi" provider) — per their docs, combines audio
   * analysis and transcription to catch voicemail within the first few
   * seconds, and hands off cleanly if a real person picks up mid-greeting.
   * Paired with voicemailMessage below: without it, Iris just talks into
   * the machine as if a person answered live (exactly what's happened
   * twice already testing against a brand-new number).
   */
  voicemailDetection?: {
    provider: "vapi";
    backoffPlan?: { startAtSeconds?: number; frequencySeconds?: number; maxRetries?: number };
    beepMaxAwaitSeconds?: number;
  };
  /** What Iris actually leaves on voicemail once detected — see scripts.ts's buildVoicemailMessage. */
  voicemailMessage?: string;
}

export interface CreateCallPayload {
  phoneNumberId: string;
  assistant: VapiAssistantConfig;
  customer: {
    number: string;
  };
}

export interface VapiCallResult {
  id: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Reads the model/voice/server config from env rather than a hardcoded
 * default — see .env.example's comment on VAPI_MODEL_PROVIDER etc. Throws
 * loudly if anything required is missing, rather than sending Vapi a
 * request that will fail in some less obvious way.
 */
export function getVapiEnvConfig(): {
  apiKey: string;
  phoneNumberId: string;
  modelProvider: string;
  modelName: string;
  voiceProvider: string;
  voiceId: string;
  serverUrl: string | undefined;
} {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const modelProvider = process.env.VAPI_MODEL_PROVIDER;
  const modelName = process.env.VAPI_MODEL_NAME;
  const voiceProvider = process.env.VAPI_VOICE_PROVIDER;
  const voiceId = process.env.VAPI_VOICE_ID;

  const missing = [
    ["VAPI_API_KEY", apiKey],
    ["VAPI_PHONE_NUMBER_ID", phoneNumberId],
    ["VAPI_MODEL_PROVIDER", modelProvider],
    ["VAPI_MODEL_NAME", modelName],
    ["VAPI_VOICE_PROVIDER", voiceProvider],
    ["VAPI_VOICE_ID", voiceId],
  ].filter(([, v]) => !v);

  if (missing.length > 0) {
    throw new Error(`[VAPI] Missing required env vars: ${missing.map(([k]) => k).join(", ")}`);
  }

  return {
    apiKey: apiKey!,
    phoneNumberId: phoneNumberId!,
    modelProvider: modelProvider!,
    modelName: modelName!,
    voiceProvider: voiceProvider!,
    voiceId: voiceId!,
    // dotenv turns "VAPI_SERVER_URL=" (present, empty) into "", not
    // undefined — Vapi's API rejects an empty-string serverUrl outright
    // ("must be a valid URL"), so normalize the unset case here rather
    // than passing "" through to the payload.
    serverUrl: process.env.VAPI_SERVER_URL || undefined,
  };
}

/** Places an outbound call. No gating here by design — see agents/iris/calling.ts. */
export async function createCall(payload: CreateCallPayload, apiKey: string): Promise<VapiCallResult> {
  const response = await fetch(`${VAPI_BASE_URL}/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vapi API Error ${response.status}: ${errorText}`);
  }

  return (await response.json()) as VapiCallResult;
}
