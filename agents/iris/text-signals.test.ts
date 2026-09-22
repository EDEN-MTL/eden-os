import { afterEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../shared/claude", () => claude);

const ghl = vi.hoisted(() => ({ getConversations: vi.fn() }));
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

describe("lastInboundText", () => {
  it("returns the last message body when the most recent conversation was inbound", async () => {
    ghl.getConversations.mockResolvedValue({
      conversations: [{ lastMessageDirection: "inbound", lastMessageBody: "Call me at 6pm please" }],
    });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toBe("Call me at 6pm please");
    expect(ghl.getConversations).toHaveBeenCalledWith("contact-1", "loc-1", "key-1");
  });

  it("returns null when the most recent message was outbound (nothing new from the lead)", async () => {
    ghl.getConversations.mockResolvedValue({
      conversations: [{ lastMessageDirection: "outbound", lastMessageBody: "Hi, just following up!" }],
    });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toBeNull();
  });

  it("returns null when there are no conversations at all", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [] });
    expect(await lastInboundText("contact-1", "loc-1", "key-1")).toBeNull();
  });

  it("returns null rather than throwing when the GHL fetch fails", async () => {
    ghl.getConversations.mockRejectedValue(new Error("GHL API down"));
    await expect(lastInboundText("contact-1", "loc-1", "key-1")).resolves.toBeNull();
  });
});
