import { describe, expect, it } from "vitest";
import { BOOKING_CONFIRMATION_LINES, buildCallPayload, PlaceCallParams } from "./calling";

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
    expect(payload.assistant.model.tools).toHaveLength(1);
    expect(payload.assistant.model.tools?.[0].type).toBe("endCall");
  });

  /**
   * Mark's live feedback, 2026-09-11: this exact "Booked for" +
   * unconfirmed-endCall bug happened a third time despite two rounds of
   * prompt-only fixes, and a first structural gate (keyed off the tool's
   * own "Booked for" result text) was CONFIRMED LIVE not to fire — the
   * leading theory being that tool-result text isn't visible to a liquid
   * condition at all, only genuine user/assistant turns are. Redesigned
   * around the book_appointment/check_availability split (see calling.ts):
   * book_appointment now carries its own Vapi-guaranteed spoken
   * confirmation, and THIS gate looks for that genuinely-spoken content
   * instead of tool-result text. No Liquid interpreter is available in
   * this test environment, so these assertions check the template's
   * structure and key substrings rather than executing it — the real
   * semantics can only be confirmed live.
   *
   * Updated 2026-09-12: BOOKING_CONFIRMATION_LINES randomizes across 5
   * variants, so the gate can no longer key on the single literal "you're
   * all booked" phrase (only one variant still contains it) — it now
   * checks for "notification" AND "text" together, which every variant
   * contains (see that constant's own comment in calling.ts).
   */
  describe("endCall tool", () => {
    it("has a rejectionPlan requiring hearing back from the lead after Vapi's own booking confirmation", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "endCall");
      if (tool?.type !== "endCall") throw new Error("expected endCall tool");
      const condition = tool.rejectionPlan?.conditions[0];
      if (condition?.type !== "liquid") throw new Error("expected a liquid condition");
      expect(condition.liquid).toContain("notification");
      expect(condition.liquid).toContain("text");
      // The "heard back" half: either a user reply, or the exact final
      // gone-quiet line, after the booking confirmation was spoken.
      expect(condition.liquid).toContain("heardBack");
      expect(condition.liquid).toContain("hold off for now");
      expect(condition.liquid).toContain("msg.role == 'user'");
      // Every one of the randomized confirmation variants must actually
      // satisfy this gate's detection condition — otherwise a call that
      // happens to draw that variant would silently never unblock endCall.
      for (const line of BOOKING_CONFIRMATION_LINES) {
        const c = line.toLowerCase();
        expect(c).toContain("notification");
        expect(c).toContain("text");
      }
    });
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
     * Mark's live feedback, 2026-09-11: the transferAssistant previously
     * used "assistant-speaks-first", so it said "Hi!" the instant the
     * operator's line connected, before they'd said anything at all — a
     * real operator experienced this as being talked at the moment they
     * picked up. Should behave like the main call's own opening instead:
     * wait for them to speak first.
     */
    it("waits for the operator to speak first, same as the main call's own opening", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      expect(tool.destinations[0].transferPlan.transferAssistant.firstMessageMode).toBe("assistant-waits-for-user");
    });

    it("tells the transfer assistant to resume its briefing after being interrupted, and to say numbers naturally", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const briefingPrompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(briefingPrompt).toMatch(/pick back up with whatever you still hadn't gotten to yet/i);
      expect(briefingPrompt).toMatch(/never digit by digit/i);
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
      const group = tool.rejectionPlan?.conditions[0];
      if (group?.type !== "group") throw new Error("expected a group condition");
      const agreementCondition = group.conditions.find((c) => c.type === "regex" && c.target?.role === "user");
      if (agreementCondition?.type !== "regex") throw new Error("expected a regex condition targeting the user");
      expect(agreementCondition).toMatchObject({ target: { position: -1, role: "user" }, negate: true });
      const regex = new RegExp(agreementCondition.regex);
      expect(regex.test("yeah sure")).toBe(true);
      expect(regex.test("sounds good")).toBe(true);
      expect(regex.test("what do you mean")).toBe(false);
      expect(regex.test("no, not right now")).toBe(false);
    });

    /**
     * Mark's live feedback, 2026-09-08: even with the agreement-only check
     * above already live, a real call had Iris invoke transferCall having
     * never said the transfer line at all — straight from the last
     * qualifying question to the tool call, skipping the announcement and
     * the pause entirely. A regex on the user's last message alone can't
     * catch that.
     */
    it("also rejects the transfer unless Iris's own prior turn actually said the transfer line", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const group = tool.rejectionPlan?.conditions[0];
      if (group?.type !== "group") throw new Error("expected a group condition");
      expect(group.operator).toBe("OR");
      const lineCondition = group.conditions.find((c) => c.type === "regex" && c.target?.role === "assistant");
      if (lineCondition?.type !== "regex") throw new Error("expected a regex condition targeting the assistant");
      expect(lineCondition).toMatchObject({ target: { position: -2, role: "assistant" }, negate: true });
      const regex = new RegExp(lineCondition.regex);
      // Every LIVE_TRANSFER_LINES variant (buyer/seller/general) shares this substring.
      expect(regex.test("Perfect. We'll connect you with one of our buyer agents to send over some available home options.")).toBe(true);
      expect(regex.test("Sounds good. I'll connect you with one of our seller agents now.")).toBe(true);
      expect(regex.test("Perfect. I'll connect you with one of our agents now.")).toBe(true);
      expect(regex.test("How many bedrooms and bathrooms do you need?")).toBe(false);
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
   *
   * Split into check_availability + book_appointment 2026-09-11 (was one
   * combined check_and_book_appointment tool) so book_appointment alone
   * could safely carry Vapi's own guaranteed spoken confirmation — see
   * this describe block's own tests below and VapiToolMessage's doc
   * comment in shared/vapi.
   */
  describe("check_availability / book_appointment tools", () => {
    const withCalendar: PlaceCallParams = { ...BASE_PARAMS, contactId: "contact-1", calendarId: "cal-123" };

    it("replaces schedule_callback with both tools when a calendarId is given", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["check_availability", "book_appointment"]);
    });

    it("is omitted (falls back to schedule_callback) when no calendarId is given", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["schedule_callback"]);
    });

    it("bakes clientId, contactId, calendarId, and a buyer/seller intent into both tools' server URLs", () => {
      const payload = buildCallPayload({ ...withCalendar, intent: "seller" }, VAPI_CONFIG);
      for (const name of ["check_availability", "book_appointment"]) {
        const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === name);
        if (tool?.type !== "function") throw new Error(`expected ${name} function tool`);
        const url = new URL(tool.server.url);
        expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
        expect(url.searchParams.get("contactId")).toBe("contact-1");
        expect(url.searchParams.get("calendarId")).toBe("cal-123");
        expect(url.searchParams.get("intent")).toBe("seller");
      }
    });

    it("requires a requestedTime argument for check_availability, and never books anything itself", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "check_availability");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["requestedTime"]);
      expect(tool.messages).toBeUndefined();
    });

    it("requires an isoTime argument for book_appointment", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["isoTime"]);
    });

    /**
     * Mark's request, 2026-09-08: a booked appointment only ever carried a
     * generic "Booked automatically..." note — no lead details at all.
     * leadSummary is baked in at call-placement time from what's already
     * known, never left to the model to retype (see
     * webhooks/vapi-tools.ts's handleBookAppointment for how this gets
     * appended to the appointment's notes).
     */
    it("bakes a lead-facts summary into book_appointment's server URL", () => {
      const payload = buildCallPayload(
        { ...withCalendar, intent: "buyer", firstName: "Jason", propertyInterest: "condo", bedrooms: "2", budget: "$500k", timeline: "3 months", workingWithRealtor: false },
        VAPI_CONFIG
      );
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      const summary = url.searchParams.get("leadSummary");
      expect(summary).toContain("Jason");
      expect(summary).toContain("condo");
      expect(summary).toContain("2 bedrooms");
      expect(summary).toContain("$500k");
      expect(summary).toContain("3 months");
      expect(summary).toContain("not working with a realtor");
    });

    it("offers an optional conversationNotes argument on book_appointment for anything fresh from the call, not required", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.properties).toHaveProperty("conversationNotes");
      expect(tool.function.parameters.required).not.toContain("conversationNotes");
    });

    /**
     * The whole point of the split — see VapiToolMessage's doc comment in
     * shared/vapi and this file's own comment above book_appointment's
     * wiring. Only book_appointment ever creates a real booking, so only
     * it carries Vapi's guaranteed request-complete confirmation.
     *
     * Updated 2026-09-12: content is randomized across
     * BOOKING_CONFIRMATION_LINES (Mark's spec — a single fixed line
     * sounded repetitive across calls), so this checks membership in that
     * list rather than one exact string.
     */
    it("wires a guaranteed request-complete confirmation on book_appointment, with control returned to Iris afterward", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const message = tool.messages?.find((m) => m.type === "request-complete");
      expect(message).toBeDefined();
      expect(message?.role).toBe("assistant");
      expect(BOOKING_CONFIRMATION_LINES).toContain(message?.content);
      expect(message?.endCallAfterSpokenEnabled).not.toBe(true);
    });
  });
});
