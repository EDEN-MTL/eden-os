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

  /**
   * Mark's live feedback, 2026-09-05: even the shorter "am I speaking with
   * Sam?" opener still crammed identification into the very first thing
   * Iris said, before the lead had any chance to say "hello" first. The
   * opener is now a bare greeting only — name and brand are asked/mentioned
   * in later turns, driven by buildLeadQualificationPrompt's system prompt.
   */
  it("opens with a bare greeting, nothing else", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessage).not.toContain("Sam");
    expect(payload.assistant.firstMessage).not.toContain("3 Percent East Coast");
    expect(payload.assistant.firstMessage).not.toContain("{{");
    expect(payload.assistant.firstMessage.length).toBeLessThan(10);
  });

  /**
   * Mark's live feedback, 2026-09-06: even a bare "Hey!" said the instant
   * he answered still felt premature — real people let the other person
   * speak first. "assistant-waits-for-user" makes that genuine; the hook
   * is what stops Iris waiting forever if the lead never says anything.
   */
  it("waits for the lead to speak first, with a one-shot nudge if they stay silent", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessageMode).toBe("assistant-waits-for-user");
    expect(payload.assistant.hooks).toEqual([
      {
        on: "customer.speech.timeout",
        do: [{ type: "say", exact: "Hi!" }],
        options: { timeoutSeconds: 5, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
      },
    ]);
  });

  it("is a single short greeting — no calling-about reason or 'how are you' crammed in, regardless of intent", () => {
    const unknownIntent = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    const knownIntent = buildCallPayload({ ...BASE_PARAMS, intent: "seller", leadSource: "facebook" }, VAPI_CONFIG);
    for (const payload of [unknownIntent, knownIntent]) {
      expect(payload.assistant.firstMessage).not.toMatch(/calling about/i);
      expect(payload.assistant.firstMessage).not.toMatch(/how are you/i);
      expect(payload.assistant.firstMessage).not.toMatch(/\?/);
    }
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
    expect(payload.assistant.voicemailDetection).toEqual({
      provider: "vapi",
      backoffPlan: { startAtSeconds: 4, frequencySeconds: 4, maxRetries: 5 },
    });
    expect(payload.assistant.voicemailMessage).toContain("Iris");
    expect(payload.assistant.voicemailMessage).toContain(BASE_PARAMS.brandName);
  });

  it("wires only the always-available endCall tool when nothing else (transferNumber, contactId) is given", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.model.tools).toEqual([{ type: "endCall" }]);
  });

  it("always wires the endCall tool, regardless of what else is available", () => {
    const withTransfer = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
    expect(withTransfer.assistant.model.tools?.some((t) => t.type === "endCall")).toBe(true);
  });

  describe("transferCall tool", () => {
    it("is added when a transferNumber is given, using warm-transfer-experimental with a non-ending fallback", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      expect(tool).toBeDefined();
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      expect(tool.destinations[0].number).toBe("+17097058841");
      expect(tool.destinations[0].transferPlan.mode).toBe("warm-transfer-experimental");
      expect(tool.destinations[0].transferPlan.fallbackPlan.endCallEnabled).toBe(false);
    });

    /**
     * Mark's rule, 2026-09-06: never transfer without having told the lead
     * first and heard something back — confirmed live once already that
     * the prompt instruction alone isn't a guarantee (one real call had
     * Iris invoke the transfer immediately, no announcement or pause).
     * This is the structural backup: Vapi rejects the tool call itself
     * unless the lead's last message actually sounds like agreement.
     */
    it("rejects the transfer unless the lead's last message sounds like agreement", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      expect(tool.rejectionPlan?.conditions[0]).toMatchObject({
        type: "regex",
        target: { position: -1, role: "user" },
        negate: true,
      });
      const regex = new RegExp(tool.rejectionPlan!.conditions[0].regex);
      expect(regex.test("yeah sure")).toBe(true);
      expect(regex.test("sounds good")).toBe(true);
      expect(regex.test("what do you mean")).toBe(false);
      expect(regex.test("no, not right now")).toBe(false);
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
      const sellerTool = sellerPayload.assistant.model.tools?.find((t) => t.type === "transferCall");
      const buyerTool = buyerPayload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (sellerTool?.type !== "transferCall" || buyerTool?.type !== "transferCall") {
        throw new Error("expected transferCall tools");
      }
      const sellerBriefing = sellerTool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      const buyerBriefing = buyerTool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(sellerBriefing).toMatch(/seller lead/);
      expect(buyerBriefing).toMatch(/buyer lead/);
    });

    it("is omitted when no transferNumber is given", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      expect(payload.assistant.model.tools?.find((t) => t.type === "transferCall")).toBeUndefined();
    });
  });

  describe("schedule_callback tool", () => {
    const withContactId: PlaceCallParams = { ...BASE_PARAMS, contactId: "contact-1" };

    it("is added only when serverUrl AND contactId are both present", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["schedule_callback"]);
    });

    it("is omitted when serverUrl is unset, even with contactId given", () => {
      const payload = buildCallPayload(withContactId, { ...VAPI_CONFIG, serverUrl: undefined });
      expect(payload.assistant.model.tools?.some((t) => t.type === "function")).toBeFalsy();
    });

    it("is omitted when contactId is missing", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      expect(payload.assistant.model.tools?.some((t) => t.type === "function")).toBeFalsy();
    });

    it("bakes clientId and contactId into the tool's server URL as query params", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
      expect(url.searchParams.get("contactId")).toBe("contact-1");
    });

    it("attaches the webhook secret so Vapi actually sends X-Vapi-Secret back on this tool's callback", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.server.secret).toBe("test-webhook-secret");
    });

    it("requires a callbackTime argument from the model", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "schedule_callback");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["callbackTime"]);
    });
  });

  /**
   * Mark, 2026-09-06: replaces schedule_callback entirely for a call where
   * a real callbackCalendarId resolved — never both at once, so Iris has
   * exactly one clear way to handle scheduling per call.
   */
  describe("check_and_book_appointment tool", () => {
    const withCalendar: PlaceCallParams = { ...BASE_PARAMS, contactId: "contact-1", calendarId: "cal-123" };

    it("replaces schedule_callback when a calendarId is given", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["check_and_book_appointment"]);
    });

    it("is omitted (falls back to schedule_callback) when no calendarId is given", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["schedule_callback"]);
    });

    it("bakes clientId, contactId, calendarId, and a buyer/seller intent into the tool's server URL", () => {
      const payload = buildCallPayload({ ...withCalendar, intent: "seller" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "check_and_book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
      expect(url.searchParams.get("contactId")).toBe("contact-1");
      expect(url.searchParams.get("calendarId")).toBe("cal-123");
      expect(url.searchParams.get("intent")).toBe("seller");
    });

    it("requires a requestedTime argument from the model", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "check_and_book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["requestedTime"]);
    });
  });
});
