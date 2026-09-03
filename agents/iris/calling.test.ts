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
  webhookSecret: "test-webhook-secret",
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
    expect(payload.assistant.server).toEqual({ url: "https://example.com/webhooks/vapi", secret: "test-webhook-secret" });
  });

  it("enables voicemail detection and sets a real message, not just talking into the machine", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.voicemailDetection).toEqual({ provider: "vapi" });
    expect(payload.assistant.voicemailMessage).toContain("Iris");
    expect(payload.assistant.voicemailMessage).toContain(BASE_PARAMS.brandName);
  });

  it("wires no tools at all when nothing (transferNumber, contactId) is given", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.tools).toBeUndefined();
  });

  describe("transferCall tool", () => {
    it("is added when a transferNumber is given, using warm-transfer-experimental with a non-ending fallback", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.tools?.find((t) => t.type === "transferCall");
      expect(tool).toBeDefined();
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      expect(tool.destinations[0].number).toBe("+17097058841");
      expect(tool.destinations[0].transferPlan.mode).toBe("warm-transfer-experimental");
      expect(tool.destinations[0].transferPlan.fallbackPlan.endCallEnabled).toBe(false);
    });

    it("briefs the receiving agent as 'seller' for seller/downsize intent and 'buyer' for buyer/upgrading", () => {
      const sellerPayload = buildCallPayload(
        { ...BASE_PARAMS, intent: "seller", transferNumber: "+17097059439" },
        VAPI_CONFIG
      );
      const buyerPayload = buildCallPayload(
        { ...BASE_PARAMS, intent: "buyer", transferNumber: "+17097058841" },
        VAPI_CONFIG
      );
      const sellerTool = sellerPayload.assistant.tools?.find((t) => t.type === "transferCall");
      const buyerTool = buyerPayload.assistant.tools?.find((t) => t.type === "transferCall");
      if (sellerTool?.type !== "transferCall" || buyerTool?.type !== "transferCall") {
        throw new Error("expected transferCall tools");
      }
      expect(sellerTool.destinations[0].transferPlan.transferAssistant.firstMessage).toMatch(/seller lead/);
      expect(buyerTool.destinations[0].transferPlan.transferAssistant.firstMessage).toMatch(/buyer lead/);
    });

    it("is omitted when no transferNumber is given", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      expect(payload.assistant.tools?.find((t) => t.type === "transferCall")).toBeUndefined();
    });
  });

  describe("schedule_callback tool", () => {
    const withContactId: PlaceCallParams = { ...BASE_PARAMS, contactId: "contact-1" };

    it("is added only when serverUrl AND contactId are both present", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const names = payload.assistant.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["schedule_callback"]);
    });

    it("is omitted when serverUrl is unset, even with contactId given", () => {
      const payload = buildCallPayload(withContactId, { ...VAPI_CONFIG, serverUrl: undefined });
      expect(payload.assistant.tools?.some((t) => t.type === "function")).toBeFalsy();
    });

    it("is omitted when contactId is missing", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      expect(payload.assistant.tools?.some((t) => t.type === "function")).toBeFalsy();
    });

    it("bakes clientId and contactId into the tool's server URL as query params", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
      expect(url.searchParams.get("contactId")).toBe("contact-1");
    });

    it("attaches the webhook secret so Vapi actually sends X-Vapi-Secret back on this tool's callback", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.server.secret).toBe("test-webhook-secret");
    });

    it("requires a callbackTime argument from the model", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["callbackTime"]);
    });
  });
});
