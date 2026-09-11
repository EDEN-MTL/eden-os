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
/**
 * Confirmed against Vapi's own OpenAPI schema (CreateTransferCallToolDTO),
 * 2026-09-06: a structural guard on the tool itself, evaluated BEFORE Vapi
 * lets the model's transferCall invocation through — the model can still
 * try to call the tool, but the call is rejected (not executed) unless the
 * condition(s) match. Mark's rule, same date: never transfer without
 * having told the lead first and heard something back — the prompt
 * already instructs this, but an instruction alone doesn't guarantee an
 * LLM never skips a step (confirmed live once already: one real call had
 * Iris invoke the transfer immediately with no announcement or pause).
 * This is the second, code-level line of defense.
 */
/**
 * `RegexCondition` matches one specific message by position (default -1,
 * the most recent) and optional role. `GroupCondition` combines nested
 * conditions with AND/OR — needed because the top-level `conditions` array
 * is always ANDed (confirmed against Vapi's own ToolRejectionPlan schema:
 * "For OR logic at the top level, use a single 'group' condition"). Mark's
 * live feedback, 2026-09-08: a single regex on the user's last message
 * wasn't enough — a real call had Iris invoke transferCall having never
 * said the transfer line at all, skipping straight from the last
 * qualifying question to the tool call. A regex alone can't express "AND
 * the assistant's own prior turn said the transfer line," which needs a
 * second condition targeting role: "assistant" combined via a group.
 */
export type VapiRejectionCondition =
  | { type: "regex"; regex: string; target?: { position?: number; role?: "user" | "assistant" }; negate?: boolean }
  | { type: "group"; operator: "AND" | "OR"; conditions: VapiRejectionCondition[] }
  | { type: "liquid"; liquid: string };

export interface VapiToolRejectionPlan {
  conditions: VapiRejectionCondition[];
}

export interface VapiTransferCallTool {
  type: "transferCall";
  rejectionPlan?: VapiToolRejectionPlan;
  destinations: {
    type: "number";
    number: string;
    description: string;
    transferPlan: {
      mode: "warm-transfer-experimental";
      transferAssistant: {
        firstMessage: string;
        firstMessageMode: "assistant-speaks-first" | "assistant-waits-for-user" | "assistant-speaks-first-with-model-generated-message";
        maxDurationSeconds: number;
        silenceTimeoutSeconds: number;
        model: {
          provider: string;
          model: string;
          messages: { role: "system"; content: string }[];
          // Confirmed live against Vapi's own OpenAPI schema (TransferAssistantModel),
          // 2026-09-12: transferSuccessful/transferCancel are ALWAYS added
          // automatically regardless of what's given here — this is purely
          // for ADDITIONAL custom function tools during the warm-transfer
          // whisper stage (e.g. agent identification — see calling.ts's
          // match_transfer_agent/assign_transfer_owner).
          tools?: VapiFunctionTool[];
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
/**
 * Confirmed against Vapi's own OpenAPI schema (CreateFunctionToolDTO /
 * ToolMessageComplete), 2026-09-11: a tool can carry its own `messages` —
 * Vapi speaks these automatically based on how the webhook responds,
 * independent of whatever the model does next. `role: "assistant"` means
 * `content` is spoken verbatim and, per the schema, "only this message
 * will be spoken and the model will not be requested to come up with a
 * response" — i.e. this is NOT a hint the model can rephrase or skip, it's
 * Vapi's own guaranteed TTS output. Built for book_appointment below after
 * three straight real calls had a genuine "Booked for" result followed by
 * endCall with nothing spoken at all — no amount of prompt wording held,
 * so this moves the one required confirmation out of the model's hands
 * entirely. `content` has no confirmed templating/variable-interpolation
 * syntax in this schema, so it can't echo back the exact day/time booked
 * — acceptable since Iris already speaks the specific time herself when
 * she proposes it, just before this tool is called to actually lock it
 * in. `endCallAfterSpokenEnabled: false` (the default) leaves control with
 * the model afterward, so it can still wait for the lead's real response
 * before invoking endCall itself — see buildLeadQualificationPrompt's
 * "Ending the call" section.
 */
export interface VapiToolMessage {
  type: "request-start" | "request-complete" | "request-failed" | "request-response-delayed";
  role?: "assistant" | "system";
  content?: string;
  endCallAfterSpokenEnabled?: boolean;
}

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
  messages?: VapiToolMessage[];
}

/**
 * Confirmed against Vapi's own OpenAPI schema (CreateEndCallToolDTO),
 * 2026-09-06: minimal shape is just `{ type: "endCall" }`, same as
 * transferCall/function above. Lets Iris actually hang up once she's said
 * her goodbye, instead of lingering or looping (confirmed live: without
 * this, a real test call had Iris say "I don't have the ability to hang up
 * the call myself").
 *
 * rejectionPlan added 2026-09-11, confirmed CreateEndCallToolDTO supports
 * it (same shape as transferCall's) via api.vapi.ai/api-json. This is a
 * structural backstop for the exact same category of bug the prompt's own
 * "MECHANICAL GATE" section already tried to fix three separate times: on
 * three different real calls, Iris got a "Booked for" result and invoked
 * endCall with no accompanying day/time confirmation at all, sometimes not
 * even a "Goodbye" — a prompt instruction alone kept not holding. See
 * agents/iris/calling.ts's buildCallPayload for the actual liquid
 * condition, which only rejects when a real booking happened THIS call and
 * nothing afterward ever confirmed it out loud — never blocks a legitimate
 * endCall after a successful transfer, an explicit lead goodbye, or an
 * unresponsive lead, since those paths never produce a "Booked for" result
 * to begin with.
 */
export interface VapiEndCallTool {
  type: "endCall";
  rejectionPlan?: VapiToolRejectionPlan;
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
