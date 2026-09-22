import { afterEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../shared/claude", () => claude);

const ghl = vi.hoisted(() => ({ getConversations: vi.fn(), getConversationMessages: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);

import { classifyInboundText, lastInboundText } from "./text-signals";

afterEach(() => vi.clearAllMocks());

const NOW = new Date("2026-09-22T18:00:00.000Z");
const TIMEZONE = "America/St_Johns";

/**
 * Real example, Mark 2026-09-22: Catherine texting to ask for a 6pm
 * callback — Iris must mark that and not call before then. A second real
 * example from a live call, 2026-09-21: "I'm not looking to sell, I want
 * a CHIP program valuation" is a correction, NOT an opt-out or a time
 * request, and must classify as "none" — the whole reason this needs an
 * LLM pass rather than keyword matching.
 */
describe("classifyInboundText", () => {
  it("classifies a clear opt-out request", async () => {
    claude.ask.mockResolvedValue('{"type": "opt_out"}');
    const result = await classifyInboundText("Please stop calling me, I'm not interested", NOW, TIMEZONE);
    expect(result).toEqual({ type: "opt_out" });
  });

  it("classifies a specific callback time request and passes it through unchanged when already within the legal calling window", async () => {
    // 2026-09-22T20:30:00.000Z is 6:00 PM in America/St_Johns (UTC-2:30) —
    // within the 8am-9pm legal window, so clampToLegalCallingWindow should
    // return it untouched.
    const sixPmStJohns = "2026-09-22T20:30:00.000Z";
    claude.ask.mockResolvedValue(`{"type": "schedule_for", "when": "${sixPmStJohns}"}`);
    const result = await classifyInboundText("Call me at 6pm please", NOW, TIMEZONE);
    expect(result).toEqual({ type: "schedule_for", when: new Date(sixPmStJohns) });
  });

  it("defaults to 'none' for a correction that isn't an opt-out or a time request — the real Bob McGrath CHIP-program reply", async () => {
    claude.ask.mockResolvedValue('{"type": "none"}');
    const result = await classifyInboundText("I'm not looking to sell, I want a CHIP program valuation", NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  /**
   * Real bug found live 2026-09-22: Catherine's actual reply was just
   * "6 pm" — no verb, no "call me", answering our own preceding text
   * ("what would be a good time to speak?"). Passes the preceding
   * outbound message as context so this is readable as a clear
   * schedule_for rather than something ambiguous enough to fall back to
   * "none". This test only checks that the context string reaches
   * Claude's system prompt — the actual interpretation is Claude's job,
   * mocked here.
   */
  it("passes the preceding outbound message as context, for a bare reply like Catherine's real '6 pm'", async () => {
    claude.ask.mockResolvedValue('{"type": "schedule_for", "when": "2026-09-22T20:30:00.000Z"}');
    await classifyInboundText("6 pm", NOW, TIMEZONE, "What would be a good time to speak?");
    const [systemPrompt] = claude.ask.mock.calls[0];
    expect(systemPrompt).toContain("What would be a good time to speak?");
    expect(systemPrompt.toLowerCase()).toContain("reply to our own");
  });

  it("treats an empty or whitespace-only message as 'none' without calling Claude", async () => {
    expect(await classifyInboundText("", NOW, TIMEZONE)).toEqual({ type: "none" });
    expect(await classifyInboundText("   ", NOW, TIMEZONE)).toEqual({ type: "none" });
    expect(claude.ask).not.toHaveBeenCalled();
  });

  it("fails toward 'none' when Claude's response isn't valid JSON", async () => {
    claude.ask.mockResolvedValue("I think this lead wants a callback but I'm not sure of the time.");
    const result = await classifyInboundText("something ambiguous", NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("fails toward 'none' when the Claude call itself throws", async () => {
    claude.ask.mockRejectedValue(new Error("Anthropic API down"));
    const result = await classifyInboundText("call me at 6pm", NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("fails toward 'none' when the requested time is invalid, too soon, or too far out", async () => {
    claude.ask.mockResolvedValueOnce('{"type": "schedule_for", "when": "not-a-real-date"}');
    expect(await classifyInboundText("call me sometime", NOW, TIMEZONE)).toEqual({ type: "none" });

    // 5 minutes out — below the 10-minute minimum.
    claude.ask.mockResolvedValueOnce(`{"type": "schedule_for", "when": "${new Date(NOW.getTime() + 5 * 60_000).toISOString()}"}`);
    expect(await classifyInboundText("call me right now", NOW, TIMEZONE)).toEqual({ type: "none" });

    // 30 days out — beyond the 14-day maximum.
    claude.ask.mockResolvedValueOnce(`{"type": "schedule_for", "when": "${new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString()}"}`);
    expect(await classifyInboundText("call me next month", NOW, TIMEZONE)).toEqual({ type: "none" });
  });

  it("tolerates a markdown-fenced JSON response", async () => {
    claude.ask.mockResolvedValue('```json\n{"type": "opt_out"}\n```');
    const result = await classifyInboundText("stop texting me", NOW, TIMEZONE);
    expect(result).toEqual({ type: "opt_out" });
  });
});

/**
 * Real bug found live 2026-09-22: getConversations' SUMMARY only exposes
 * the single most recent message overall, whichever direction — NOT the
 * lead's most recent message. Confirmed on a real contact (Catherine
 * Nonsense): she replied "6 pm", but an automated follow-up text went out
 * 2 seconds later, making the conversation summary's lastMessageDirection
 * "outbound" again. lastInboundText now fetches the full thread instead.
 */
describe("lastInboundText", () => {
  const activityEntry = { messageType: "TYPE_ACTIVITY_OPPORTUNITY", direction: "outbound", body: "Opportunity updated" };

  it("finds the lead's real last inbound SMS even when a later outbound message makes the conversation summary look outbound-last (the real Catherine case)", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [{ id: "convo-1" }] });
    ghl.getConversationMessages.mockResolvedValue({
      messages: {
        messages: [
          activityEntry,
          { messageType: "TYPE_SMS", direction: "outbound", body: "Quick question, why are you looking to sell?" },
          { messageType: "TYPE_SMS", direction: "inbound", body: "6 pm" },
          { messageType: "TYPE_SMS", direction: "outbound", body: "What would be a good time to speak?" },
          { messageType: "TYPE_SMS", direction: "outbound", body: "Hey Catherine, saw you submitted the form..." },
          activityEntry,
        ],
      },
    });

    const result = await lastInboundText("contact-1", "loc-1", "key-1");
    expect(result).toEqual({ text: "6 pm", precedingOutbound: "What would be a good time to speak?" });
  });

  it("returns null when the lead has never sent an inbound SMS", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [{ id: "convo-1" }] });
    ghl.getConversationMessages.mockResolvedValue({
      messages: { messages: [{ messageType: "TYPE_SMS", direction: "outbound", body: "Hi, just following up!" }, activityEntry] },
    });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toBeNull();
  });

  it("returns null when there's no conversation at all", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [] });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toBeNull();
    expect(ghl.getConversationMessages).not.toHaveBeenCalled();
  });

  it("returns precedingOutbound: null when the inbound message is the very first one in the thread", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [{ id: "convo-1" }] });
    ghl.getConversationMessages.mockResolvedValue({
      messages: { messages: [{ messageType: "TYPE_SMS", direction: "inbound", body: "Hello?" }] },
    });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toEqual({ text: "Hello?", precedingOutbound: null });
  });

  it("returns null rather than throwing when the GHL fetch fails", async () => {
    ghl.getConversations.mockRejectedValue(new Error("GHL API down"));
    await expect(lastInboundText("contact-1", "loc-1", "key-1")).resolves.toBeNull();
  });
});
