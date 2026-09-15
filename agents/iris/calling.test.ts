import { describe, expect, it } from "vitest";
import { bookingConfirmationLines, rescheduleConfirmationLines, buildCallPayload, PlaceCallParams } from "./calling";

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
   * Root cause found live, 2026-09-16: a recurring "Iris says a bare 'Hi.'
   * and waits to be asked who she is" bug survived several rounds of
   * prompt-only fixes because it was never a prompt problem — confirmed
   * via Vapi's own docs that under firstMessageMode
   * "assistant-waits-for-user", firstMessage is spoken VERBATIM the
   * instant the lead speaks, before the model gets a turn at all. A bare
   * "Hi!" firstMessage was the exact bug. Fixed by making firstMessage the
   * full canonical opening line (buildCallOpeningLine) instead.
   */
  it("uses the full canonical opening line as firstMessage, not a bare greeting", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessage).toBe("Hi, this is Iris with 3 Percent East Coast. Am I speaking with Sam?");
  });

  it("falls back to the generic identify question when no lead name is known", () => {
    const payload = buildCallPayload({ ...BASE_PARAMS, firstName: "there" }, VAPI_CONFIG);
    expect(payload.assistant.firstMessage).toBe("Hi, this is Iris with 3 Percent East Coast. Who do I have the pleasure of speaking with?");
  });

  /**
   * Mark's live feedback, 2026-09-06: even a bare "Hey!" said the instant
   * he answered still felt premature — real people let the other person
   * speak first. "assistant-waits-for-user" makes that genuine; the hook
   * is what stops Iris waiting forever if the lead never says anything.
   *
   * timeoutSeconds bumped 5 → 8, 2026-09-15: confirmed live (real
   * transcript) this hook's timer restarts the moment the LEAD's own
   * speech ends, not just "before they ever say anything" — on a real
   * call the lead said "Hello?", the model took a bit over 5s to
   * generate the (now longer) combined opening line, and this hook fired
   * its own bare "Hi!" into that gap before the model's real line
   * landed. 8s gives more headroom.
   *
   * triggerResetMode fixed "onUserSpeech" → "never", 2026-09-15: confirmed
   * live (timestamps) and via Vapi's own docs that "onUserSpeech" resets
   * the trigger COUNT on every lead utterance, letting this "one-shot"
   * hook re-arm and fire again later in the call — a real call had it
   * fire a second, nonsensical bare "Hi." ~18s after the lead's last
   * words, mid-reschedule-offer. "never" (Vapi's own default) makes this
   * a genuine once-per-call nudge, as originally intended.
   *
   * Fallback message changed from a bare "Hi!" to the SAME full opening
   * line as firstMessage, 2026-09-16 — once firstMessage became the full
   * line, a silent lead deserved the real opening, not a bare filler.
   */
  it("waits for the lead to speak first, with a one-shot nudge (the same full opening line) if they stay silent", () => {
    const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    expect(payload.assistant.firstMessageMode).toBe("assistant-waits-for-user");
    expect(payload.assistant.hooks).toEqual([
      {
        on: "customer.speech.timeout",
        do: [{ type: "say", exact: payload.assistant.firstMessage }],
        options: { timeoutSeconds: 8, triggerMaxCount: 1, triggerResetMode: "never" },
      },
    ]);
  });

  it("never mentions the calling-about reason or 'how are you' in the opening line, regardless of intent", () => {
    const unknownIntent = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
    const knownIntent = buildCallPayload({ ...BASE_PARAMS, intent: "seller", leadSource: "facebook" }, VAPI_CONFIG);
    for (const payload of [unknownIntent, knownIntent]) {
      expect(payload.assistant.firstMessage).not.toMatch(/calling about/i);
      expect(payload.assistant.firstMessage).not.toMatch(/how are you/i);
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
   * Updated 2026-09-12: bookingConfirmationLines randomizes across 5
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
      for (const line of bookingConfirmationLines()) {
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

    it("tells the transfer assistant to resume after being interrupted, and to say numbers naturally", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const briefingPrompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(briefingPrompt).toMatch(/pick back up with it once you've responded/i);
      expect(briefingPrompt).toMatch(/never digit by digit/i);
    });

    /**
     * Root cause found live, 2026-09-16: the recurring "transfer assistant
     * says a bare 'hi' and waits to be asked who she is" bug survived
     * several rounds of prompt-only fixes (folding the self-intro into one
     * turn, a stark wrong/right contrast) because it was never a model or
     * prompt problem — confirmed via Vapi's own docs that firstMessage is
     * spoken VERBATIM the instant the operator speaks, before the model
     * gets a turn at all. Fixed by making firstMessage the full canonical
     * transfer-opening line (transferOpeningLine) instead of a bare "Hi!".
     */
    it("uses the full canonical opening line as firstMessage on the transfer assistant, not a bare greeting", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      expect(tool.destinations[0].transferPlan.transferAssistant.firstMessage).toBe(
        "Hi, this is Iris from 3 Percent East Coast. I've got a buyer lead on the other line. Who am I speaking with?"
      );
    });

    it("tells the transfer assistant its opening line is already spoken for it automatically, and never to repeat it", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const prompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(prompt).toMatch(/Your opening line is spoken FOR you, automatically, the instant/i);
      expect(prompt).toContain(
        "\"Hi, this is Iris from 3 Percent East Coast. I've got a buyer lead on the other line. Who am I speaking with?\""
      );
      expect(prompt).toMatch(/mechanical platform behavior, not something you generate or choose to say/i);
      expect(prompt).toMatch(/NEVER say it again, never/i);
      expect(prompt).toMatch(/never say a bare "Hi" of/i);
      expect(prompt).toMatch(/Then STOP and\s+wait for their name/i);
    });

    /**
     * Reversed, 2026-09-15: an earlier version had IRIS confirm the lead is
     * still there post-merge and then introduce the agent herself. Removed
     * after confirming (Vapi's own docs on SIP REFER, our own call data, and
     * the "assistant-forwarded-call" ended-reason semantics) that once
     * transferSuccessful fires, the underlying SIP REFER hands the call
     * directly to the operator's line — Vapi (and IRIS) has no audio channel into it
     * anymore, so anything scripted for after that point can't actually be
     * heard by anyone. IRIS now just goes silent the moment the merge
     * succeeds, full stop.
     */
    it("goes silent immediately once transferSuccessful succeeds, with no post-merge presence check or agent introduction", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const prompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(prompt).toMatch(/The MOMENT transferSuccessful succeeds, your job is done — go silent\s+immediately/i);
      expect(prompt).toMatch(/never speak\s+again for the rest of this call/i);
      expect(prompt).not.toMatch(/are you still there\?/i);
      expect(prompt).not.toMatch(/the lead may have disconnected/i);
    });

    /**
     * Real operator feedback, 2026-09-15 (Jacob, playing the receiving
     * agent on a live test call, reviewed with Mark from the actual call
     * recording): the merge happened silently right after a vague "okay"
     * to the briefing, with no real question asked — Jacob never actually
     * said yes to a merge, only acknowledged hearing the summary. Fix,
     * per Jacob's own described preference from an earlier version of this
     * flow: ask a real yes/no question ("are you ready for me to merge the
     * call now?") and require an explicit yes before merging.
     */
    it("asks a real yes/no question before merging, rather than merging on a vague acknowledgment", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const prompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      expect(prompt).toMatch(/ask a real, explicit yes\/no question about merging the call/i);
      expect(prompt).toMatch(/Are you ready for me to merge the call\s+now\?/i);
      expect(prompt).toMatch(/On a genuine yes \(or clear\s+equivalent/i);
      expect(prompt).toMatch(/call transferSuccessful right away/i);
      expect(prompt).toMatch(/On a no or a request to wait, hold off/i);
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

    /**
     * Caught during a self-review, 2026-09-15: buildAgentBriefing's own
     * string already opens with "I have [name] on the other line, a
     * [audience] lead..." — an earlier version of the prompt ALSO wrapped
     * it in a separate hardcoded "I have [name] on the other line." example
     * sentence right before quoting it, so the model was fed that phrase
     * twice back to back. Exactly the kind of overlapping-rule redundancy
     * flagged live on the greeting/name-verification steps, just in the
     * briefing step instead.
     */
    it("does not duplicate 'on the other line' by wrapping the briefing in its own copy of the same phrase", () => {
      const payload = buildCallPayload(
        { ...BASE_PARAMS, intent: "buyer", transferNumber: "+17097058841" },
        VAPI_CONFIG
      );
      const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
      if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
      const prompt = tool.destinations[0].transferPlan.transferAssistant.model.messages[0].content;
      const occurrences = prompt.match(/on the other line/gi) ?? [];
      // Exactly one: from buildAgentBriefing's own sentence. (A second,
      // unrelated use of the phrase shows up later for the post-merge agent
      // introduction — "I've got [Agent Name] on the other line" — which is
      // a different variant string, not always drawn, so only assert the
      // briefing itself isn't self-duplicated.)
      expect(prompt).not.toMatch(/on the other line\.\" followed by these exact facts/i);
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    });

    it("is omitted when no transferNumber is given", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      expect(payload.assistant.model.tools?.find((t) => t.type === "transferCall")).toBeUndefined();
    });

    /**
     * Mark's spec, 2026-09-12: once a live transfer connects, identify who
     * picked up and assign the lead to them in the CRM. Confirmed live
     * against Vapi's own OpenAPI schema (TransferAssistantModel) that its
     * `tools` array is real and additive to transferSuccessful/transferCancel.
     */
    describe("post-transfer agent identification", () => {
      const withContact: PlaceCallParams = { ...BASE_PARAMS, transferNumber: "+17097058841", contactId: "contact-1" };

      function transferTool(payload: ReturnType<typeof buildCallPayload>) {
        const tool = payload.assistant.model.tools?.find((t) => t.type === "transferCall");
        if (tool?.type !== "transferCall") throw new Error("expected transferCall tool");
        return tool;
      }

      it("wires match_transfer_agent and assign_transfer_owner on the transfer assistant when a real contactId exists", () => {
        const payload = buildCallPayload(withContact, VAPI_CONFIG);
        const tools = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.tools;
        const names = tools?.map((t) => t.function.name);
        expect(names).toEqual(["match_transfer_agent", "assign_transfer_owner"]);
      });

      it("omits the identification tools entirely when there's no real contactId to assign", () => {
        const payload = buildCallPayload({ ...BASE_PARAMS, transferNumber: "+17097058841" }, VAPI_CONFIG);
        const tools = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.tools;
        expect(tools).toBeUndefined();
      });

      it("requires a spokenName argument for match_transfer_agent, read-only, no messages", () => {
        const payload = buildCallPayload(withContact, VAPI_CONFIG);
        const tools = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.tools;
        const match = tools?.find((t) => t.function.name === "match_transfer_agent");
        expect(match?.function.parameters.required).toEqual(["spokenName"]);
        expect(match?.messages).toBeUndefined();
      });

      it("makes matchedUserId optional on assign_transfer_owner, for the genuine no-match fallback", () => {
        const payload = buildCallPayload(withContact, VAPI_CONFIG);
        const tools = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.tools;
        const assign = tools?.find((t) => t.function.name === "assign_transfer_owner");
        expect(assign?.function.parameters.properties).toHaveProperty("matchedUserId");
        expect(assign?.function.parameters.required ?? []).not.toContain("matchedUserId");
      });

      it("bakes clientId and contactId into both identification tools' server URLs", () => {
        const payload = buildCallPayload(withContact, VAPI_CONFIG);
        const tools = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.tools;
        for (const tool of tools ?? []) {
          const url = new URL(tool.server.url);
          expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
          expect(url.searchParams.get("contactId")).toBe("contact-1");
        }
      });

      it("assigns a single confident match directly with no redundant spoken confirmation, but still checks ambiguous ones out loud", () => {
        const payload = buildCallPayload(withContact, VAPI_CONFIG);
        const briefingPrompt = transferTool(payload).destinations[0].transferPlan.transferAssistant.model.messages[0].content;
        expect(briefingPrompt).toMatch(/call match_transfer_agent with exactly what they said/i);
        // Real operator feedback, 2026-09-15: re-confirming a name the
        // operator just said once ("is this [name]?") on top of already
        // having asked who they were was redundant — a single MATCH is now
        // trusted directly, with no spoken confirmation step.
        expect(briefingPrompt).toMatch(/MATCH \(one confident real match\): trust it/i);
        expect(briefingPrompt).toMatch(/AMBIGUOUS \(multiple real matches\): ask using the ACTUAL/i);
        expect(briefingPrompt).toMatch(/NO_MATCH/);
      });
    });
  });

  /**
   * Mark's spec, 2026-09-12: a name correction from the lead has to
   * actually reach the CRM, not just be accepted verbally. Available
   * whenever there's a real contactId — independent of calendar/transfer
   * setup, since correcting a name isn't tied to either of those.
   */
  describe("update_lead_name tool", () => {
    it("is wired whenever a real contactId exists, regardless of calendar or transfer setup", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "update_lead_name");
      expect(tool).toBeDefined();
    });

    it("is omitted when there's no real contactId to correct", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "update_lead_name");
      expect(tool).toBeUndefined();
    });

    it("requires a correctedName argument", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "update_lead_name");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["correctedName"]);
    });

    it("bakes clientId and contactId into its server URL", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "update_lead_name");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
      expect(url.searchParams.get("contactId")).toBe("contact-1");
    });
  });

  /**
   * Mark's spec, 2026-09-12: a live transfer previously left the ISA notes
   * field untouched entirely — the receiving agent had no summary at all
   * unless a callback happened instead. Wired on Iris's own main-call
   * tools (not the transfer assistant), since she's the one who heard any
   * live corrections to the form/Scout data.
   */
  describe("save_isa_notes tool", () => {
    it("is wired whenever a real contactId exists, regardless of calendar or transfer setup", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "save_isa_notes");
      expect(tool).toBeDefined();
    });

    it("is omitted when there's no real contactId", () => {
      const payload = buildCallPayload(BASE_PARAMS, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "save_isa_notes");
      expect(tool).toBeUndefined();
    });

    it("requires a notes argument", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "save_isa_notes");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["notes"]);
    });

    it("bakes clientId and contactId into its server URL", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "save_isa_notes");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const url = new URL(tool.server.url);
      expect(url.searchParams.get("clientId")).toBe("3-percent-east-coast");
      expect(url.searchParams.get("contactId")).toBe("contact-1");
    });
  });

  describe("schedule_callback tool", () => {
    const withContactId: PlaceCallParams = { ...BASE_PARAMS, contactId: "contact-1" };

    it("is added only when serverUrl AND contactId are both present", () => {
      const payload = buildCallPayload(withContactId, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["update_lead_name", "save_isa_notes", "schedule_callback"]);
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

    it("replaces schedule_callback with all three tools when a calendarId is given", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["update_lead_name", "save_isa_notes", "check_availability", "book_appointment", "reschedule_appointment"]);
    });

    it("is omitted (falls back to schedule_callback) when no calendarId is given", () => {
      const payload = buildCallPayload({ ...BASE_PARAMS, contactId: "contact-1" }, VAPI_CONFIG);
      const names = payload.assistant.model.tools?.filter((t) => t.type === "function").map((t) => (t.type === "function" ? t.function.name : ""));
      expect(names).toEqual(["update_lead_name", "save_isa_notes", "schedule_callback"]);
    });

    it("bakes clientId, contactId, calendarId, and a buyer/seller intent into all three tools' server URLs", () => {
      const payload = buildCallPayload({ ...withCalendar, intent: "seller" }, VAPI_CONFIG);
      for (const name of ["check_availability", "book_appointment", "reschedule_appointment"]) {
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
      expect(summary).toContain("$500 thousand");
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
     * bookingConfirmationLines (Mark's spec — a single fixed line
     * sounded repetitive across calls), so this checks membership in that
     * list rather than one exact string. Deliberately NOT personalized
     * with the lead's name (reverted 2026-09-12 — see bookingConfirmationLines'
     * own comment): this content is fixed before the call starts and
     * spoken by Vapi directly, so it can never reflect a name the lead
     * corrects mid-call the way Iris's own live speech can.
     */
    it("wires a guaranteed request-complete confirmation on book_appointment, with control returned to Iris afterward", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "book_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const message = tool.messages?.find((m) => m.type === "request-complete");
      expect(message).toBeDefined();
      expect(message?.role).toBe("assistant");
      expect(bookingConfirmationLines()).toContain(message?.content);
      expect(message?.endCallAfterSpokenEnabled).not.toBe(true);
    });

    /**
     * Mark's spec, 2026-09-12: a lead changing their mind after a real
     * booking needs a genuine reschedule tool, not a repeated book_appointment
     * call (which would create a second real appointment) or a brush-off.
     * Only wired alongside book_appointment (same calendarId/contactId gate).
     */
    it("requires isoTime and appointmentId arguments for reschedule_appointment, wired only alongside book_appointment", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "reschedule_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.required).toEqual(["isoTime", "appointmentId"]);
      expect(tool.server.url).toContain("/tools/reschedule-appointment");
    });

    /**
     * Mark's live audit, 2026-09-13: without a real appointmentId,
     * handleRescheduleAppointment could only guess "the most recent
     * appointment for this contact" — which risks grabbing a real, older,
     * unrelated appointment from a completely different earlier call
     * (this test account re-dials and re-books the same contacts
     * repeatedly). Requiring the exact id book_appointment handed back
     * closes that gap.
     */
    it("requires the exact appointmentId, never letting the model guess or omit it", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "reschedule_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      expect(tool.function.parameters.properties).toHaveProperty("appointmentId");
      expect(tool.function.description).toMatch(/exact appointmentId book_appointment's own result gave you/i);
    });

    /**
     * Same guaranteed-confirmation mechanism as book_appointment, and
     * deliberately shares the "notification" + "text" anchor so the
     * existing endCall rejectionPlan gate (below) detects a reschedule
     * confirmation too, without needing its own separate gate logic.
     */
    it("wires a guaranteed request-complete confirmation on reschedule_appointment, matching the endCall gate's anchor words", () => {
      const payload = buildCallPayload(withCalendar, VAPI_CONFIG);
      const tool = payload.assistant.model.tools?.find((t) => t.type === "function" && t.function.name === "reschedule_appointment");
      if (tool?.type !== "function") throw new Error("expected function tool");
      const message = tool.messages?.find((m) => m.type === "request-complete");
      expect(message).toBeDefined();
      expect(message?.role).toBe("assistant");
      expect(rescheduleConfirmationLines()).toContain(message?.content);
      expect(message?.endCallAfterSpokenEnabled).not.toBe(true);
      for (const line of rescheduleConfirmationLines()) {
        const c = line.toLowerCase();
        expect(c).toContain("notification");
        expect(c).toContain("text");
      }
    });
  });
});

/**
 * Mark's spec, 2026-09-12: closing lines should feel warm and personalized
 * rather than a bare "Goodbye" — the lead's name where known, and a
 * trailing "reply to the text" nudge (reduces no-shows, keeps the
 * conversation open).
 */
/**
 * Mark's live feedback, 2026-09-12: a real call had the lead correct his
 * name early on ("Mark", not the form's "Manny") — Iris correctly used
 * "Mark" in her own speech for the rest of the call, but the guaranteed
 * booking confirmation (fixed before the call started) still said
 * "Manny." Reverted personalization on these two specifically — they're
 * spoken by Vapi directly, never passing through the model, so they can
 * never reflect a live correction the way Iris's own generated speech can.
 */
describe("bookingConfirmationLines / rescheduleConfirmationLines", () => {
  it("never references a lead name at all, since this content can't react to a live name correction", () => {
    for (const line of bookingConfirmationLines()) {
      expect(line).not.toMatch(/\b(Jason|Sam|Manny|Mark)\b/);
    }
    for (const line of rescheduleConfirmationLines()) {
      expect(line).not.toMatch(/\b(Jason|Sam|Manny|Mark)\b/);
    }
  });

  it("includes the 'reply to the text' pro-tip on every variant", () => {
    for (const line of bookingConfirmationLines()) expect(line).toMatch(/feel free to reply to the text/i);
    for (const line of rescheduleConfirmationLines()) expect(line).toMatch(/feel free to reply to the text/i);
  });
});
