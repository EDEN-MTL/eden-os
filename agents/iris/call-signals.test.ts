import { afterEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../shared/claude", () => claude);

import { classifyMissedCallback } from "./call-signals";

afterEach(() => vi.clearAllMocks());

const NOW = new Date("2026-10-01T19:21:00.000Z");
const TIMEZONE = "America/St_Johns";

/**
 * Real case, Mark 2026-10-01: Saife Sarwar's actual call transcript — she
 * said she's busy and asked to be called later, with no specific time, and
 * the call ended mid-way through Iris's reply before anything got
 * scheduled.
 */
const SAIFE_TRANSCRIPT = `AI: Hi. Are you still with me?
User: Yes. Hello?
AI: Hi. This is Iris with 3 percent East Coast. Am I speaking with Safe?
User: Yes.
AI: Great. How are you doing today?
User: Ma'am, right now is busy. Can I call you later?
AI: No problem at`;

describe("classifyMissedCallback", () => {
  it("classifies a vague 'call me later' with no time given as call_later", async () => {
    claude.ask.mockResolvedValue('{"type": "call_later"}');
    const result = await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE);
    expect(result).toEqual({ type: "call_later" });
  });

  it("classifies a specific named time with no confirmation as schedule_for", async () => {
    const sixPmStJohns = "2026-10-01T20:30:00.000Z"; // 6pm America/St_Johns, within 8am-9pm
    claude.ask.mockResolvedValue(`{"type": "schedule_for", "when": "${sixPmStJohns}"}`);
    const transcript = `AI: This is Iris, is now a good time?\nUser: Can you call me back at 6pm instead?\nAI: Sure, I can do that, let me just`;
    const result = await classifyMissedCallback(transcript, NOW, TIMEZONE);
    expect(result).toEqual({ type: "schedule_for", when: new Date(sixPmStJohns) });
  });

  it("classifies 'none' when the transcript already shows a confirmed scheduled callback — nothing was actually missed", async () => {
    claude.ask.mockResolvedValue('{"type": "none"}');
    const transcript = `User: Can you call me back at 6?\nAI: Callback scheduled for 6:00 PM. Talk soon!`;
    const result = await classifyMissedCallback(transcript, NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("classifies 'none' for a normal completed/booked call with no callback request at all", async () => {
    claude.ask.mockResolvedValue('{"type": "none"}');
    const transcript = `AI: Perfect, your appointment is all set. Talk soon!\nUser: Great, thanks!`;
    const result = await classifyMissedCallback(transcript, NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("treats an empty transcript as 'none' without calling Claude", async () => {
    expect(await classifyMissedCallback("", NOW, TIMEZONE)).toEqual({ type: "none" });
    expect(await classifyMissedCallback("   ", NOW, TIMEZONE)).toEqual({ type: "none" });
    expect(claude.ask).not.toHaveBeenCalled();
  });

  it("fails toward 'none' when Claude's response isn't valid JSON", async () => {
    claude.ask.mockResolvedValue("I think she wants a callback but I'm not sure.");
    const result = await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("fails toward 'none' when the Claude call itself throws", async () => {
    claude.ask.mockRejectedValue(new Error("Anthropic API down"));
    const result = await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE);
    expect(result).toEqual({ type: "none" });
  });

  it("fails toward 'none' when the requested time is invalid, too soon, or too far out", async () => {
    claude.ask.mockResolvedValueOnce('{"type": "schedule_for", "when": "not-a-real-date"}');
    expect(await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE)).toEqual({ type: "none" });

    claude.ask.mockResolvedValueOnce(`{"type": "schedule_for", "when": "${new Date(NOW.getTime() + 5 * 60_000).toISOString()}"}`);
    expect(await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE)).toEqual({ type: "none" });

    claude.ask.mockResolvedValueOnce(`{"type": "schedule_for", "when": "${new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString()}"}`);
    expect(await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE)).toEqual({ type: "none" });
  });

  it("tolerates a markdown-fenced JSON response", async () => {
    claude.ask.mockResolvedValue('```json\n{"type": "call_later"}\n```');
    const result = await classifyMissedCallback(SAIFE_TRANSCRIPT, NOW, TIMEZONE);
    expect(result).toEqual({ type: "call_later" });
  });
});
