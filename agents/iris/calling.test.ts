import { describe, expect, it } from "vitest";
import { buildCallPayload, PlaceCallParams } from "./calling";

/**
 * Only buildCallPayload is tested here — it's the pure part. placeCall()
 * itself touches the DB and the network, same as agents/forge/ads/settings.ts
 * and shared/ghl, neither of which have unit tests in this repo either.
 */
const VAPI_CONFIG = {
  apiKey: "test-key",
  phoneNumberId: "phone-123",
  modelProvider: "openai",
  modelName: "gpt-4.1-nano",
  voiceProvider: "vapi",
  voiceId: "Neha",
  serverUrl: "https://example.com/webhooks/vapi",
};

const BASE_PARAMS: PlaceCallParams = {
  clientId: "3-percent-east-coast",
  brandName: "3 Percent East Coast",
  city: "St. John's",
  phone: "+15555551234",
  firstName: "Sam",
  intent: "unknown",
  leadSource: null,
  systemPrompt: "test system prompt",
};

describe("buildCallPayload", () => {
  it("passes the phone number and phoneNumberId through untouched", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.customer.number).toBe("+15555551234");
    expect(payload.phoneNumberId).toBe("phone-123");
  });

  it("substitutes first name and brand name into the greeting", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessage).toContain("Sam");
    expect(payload.assistant.firstMessage).toContain("3 Percent East Coast");
    expect(payload.assistant.firstMessage).not.toContain("{{");
  });

  it("omits the context clause for unknown intent rather than inventing one", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessage).not.toMatch(/calling about/i);
  });

  it("adds a context clause referencing city and lead source when intent is known", () => {
    const payload = buildCallPayload(
      { ...BASE_PARAMS, intent: "seller", leadSource: "facebook" },
      VAPI_CONFIG
    );
    expect(payload.assistant.firstMessage).toMatch(/calling about/i);
    expect(payload.assistant.firstMessage).toContain("St. John's");
    expect(payload.assistant.firstMessage).toContain("facebook");
  });

  it("carries the system prompt through as the model's only system message", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.model.messages).toEqual([{ role: "system", content: "test system prompt" }]);
  });

  it("uses the model and voice config it's given rather than a hardcoded provider", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.model.provider).toBe("openai");
    expect(payload.assistant.model.model).toBe("gpt-4.1-nano");
    expect(payload.assistant.voice.provider).toBe("vapi");
    expect(payload.assistant.voice.voiceId).toBe("Neha");
    expect(payload.assistant.serverUrl).toBe("https://example.com/webhooks/vapi");
  });
});
