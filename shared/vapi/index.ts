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
  /**
   * Confirmed against Vapi's own OpenAPI schema, 2026-09-06: default is
   * "assistant-speaks-first" (what this had been using — Iris says
   * firstMessage the instant the call connects). Mark's live feedback,
   * same date: even a bare "Hey!" said the moment he picked up still felt
   * premature — a real phone answer is the OTHER person saying something
   * first. "assistant-waits-for-user" makes Iris genuinely wait for the
   * lead to speak; see `hooks` below for what happens if they don't.
   */
  firstMessageMode?: "assistant-speaks-first" | "assistant-waits-for-user" | "assistant-speaks-first-with-model-generated-message";
  /**
   * Confirmed against Vapi's own OpenAPI schema (CallHookCustomerSpeechTimeout
   * / SayHookAction), 2026-09-06: the one built-in mechanism for "say
   * something if the customer hasn't spoken within N seconds" — needed
   * because firstMessageMode: "assistant-waits-for-user" alone would leave
   * Iris silently waiting forever if the lead never says anything first.
   * Per Vapi's docs, the timeout clock starts once the assistant's turn
   * begins and resets on user speech — combined with waits-for-user mode,
   * that start-of-turn is effectively "the call connected."
   */
  hooks?: {
    on: string;
    do: { type: "say"; exact: string | string[] }[];
    options?: { timeoutSeconds: number; triggerMaxCount?: number; triggerResetMode?: "onUserSpeech" | "never" };
  }[];
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
    /**
     * Confirmed against Vapi's own OpenAPI schema (api.vapi.ai/api-json),
     * 2026-09-04, after a real call failed with "assistant.property tools
     * should not exist": CreateAssistantDTO (what assistant.* validates
     * against, for both POST /assistant and the inline assistant in
     * POST /call) has NO `tools` property at all — it only exists on the
     * per-provider model schema (OpenAIModel.tools here), alongside both
     * `transferCall` and `function` tool types. This was live-broken from
     * the moment schedule_callback (a function tool) was first exercised by
     * a real automatic call; the earlier transferCall-only test apparently
     * didn't trip the same validation, but per this schema `assistant.tools`
     * was never actually valid either way.
     */
    tools?: VapiTool[];
  };
  voice: {
    provider: string;
    voiceId: string;
  };
  /**
   * Confirmed against Vapi's own OpenAPI schema (api.vapi.ai/api-json),
   * 2026-09-05: both live directly on CreateAssistantDTO, siblings of
   * `model`/`voice`/`tools` — NOT nested under `model` the way `tools` is
   * (see that field's own comment above for that distinction; the two
   * fields don't follow the same nesting rule as each other, confirmed
   * against the schema rather than assumed).
   */
  startSpeakingPlan?: { waitSeconds?: number };
  /** See startSpeakingPlan above — same schema location, opposite purpose (when to stop, not start, talking). */
  stopSpeakingPlan?: {
    numWords?: number;
    voiceSeconds?: number;
    backoffSeconds?: number;
    acknowledgementPhrases?: string[];
    interruptionPhrases?: string[];
  };
  /**
   * Vapi's actual field for this is `server` (an object), NOT the flat
   * `serverUrl` string this code sent for a while — that string still
   * routes the webhook to the right URL, but Vapi has nowhere to put a
   * secret on it, so every end-of-call-report delivery came back with no
   * X-Vapi-Secret header and got rejected by webhooks/vapi-webhook.ts's own
   * check the moment VAPI_WEBHOOK_SECRET was actually set. Confirmed live:
   * a real test call showed the webhook retried ~20 times, every one logged
   * "Invalid or missing X-Vapi-Secret header". `secret` here is the
   * documented (if now legacy, per Vapi's server-authentication docs)
   * inline-secret pattern — simpler than provisioning a Vapi dashboard
   * credential for this.
   */
  server?: { url: string; secret?: string };
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

/**
 * Live-transfers the call to a real phone number. "warm-transfer-experimental"
 * is the one documented mode with a transferAssistant — a small separate
 * model that briefs whoever picks up before connecting them (the actual
 * "warm" part) — and, combined with fallbackPlan.endCallEnabled: false,
 * reliably returns control to Iris if nobody answers (plain
 * "warm-transfer-say-summary" does not resume the assistant on a failed
 * transfer per Vapi's own docs and community reports). See
 * agents/iris/calling.ts's buildCallPayload.
 */
export interface VapiTransferCallTool {
  type: "transferCall";
  destinations: {
    type: "number";
    number: string;
    description: string;
    transferPlan: {
      mode: "warm-transfer-experimental";
      transferAssistant: {
        firstMessage: string;
        firstMessageMode: "assistant-speaks-first";
        maxDurationSeconds: number;
        silenceTimeoutSeconds: number;
        model: {
          provider: string;
          model: string;
          messages: { role: "system"; content: string }[];
        };
      };
      fallbackPlan: { message: string; endCallEnabled: false };
    };
  }[];
}

/**
 * A custom function tool — Vapi calls back to our own server (POST to
 * server.url) when the assistant invokes it, and expects
 * {results: [{toolCallId, result}]} back. Used for schedule_callback; see
 * webhooks/vapi-tools.ts for the server side.
 */
export interface VapiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
  server: { url: string; secret?: string };
}

/**
 * Confirmed against Vapi's own OpenAPI schema (CreateEndCallToolDTO),
 * 2026-09-06: minimal shape is just `{ type: "endCall" }`, same as
 * transferCall/function above — no separate messages/rejectionPlan needed.
 * Lets Iris actually hang up once she's said her goodbye, instead of
 * lingering or looping (confirmed live: without this, a real test call had
 * Iris say "I don't have the ability to hang up the call myself").
 */
export interface VapiEndCallTool {
  type: "endCall";
}

export type VapiTool = VapiTransferCallTool | VapiFunctionTool | VapiEndCallTool;

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
  webhookSecret: string | undefined;
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
    // Optional by design, same as webhooks/vapi-webhook.ts's own check
    // (`if (secret && ...)`) — lets local/early testing run without one.
    // When it IS set, both sides must agree: this is what makes Vapi
    // actually attach it as X-Vapi-Secret (see VapiAssistantConfig.server).
    webhookSecret: process.env.VAPI_WEBHOOK_SECRET || undefined,
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
