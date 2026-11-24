import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);
const textSignals = vi.hoisted(() => ({ classifyInboundText: vi.fn() }));
vi.mock("./text-signals", () => textSignals);
const optOut = vi.hoisted(() => ({ mightBeStop: vi.fn((t: string) => /stop|don'?t call|remove/i.test(t)), recordOptOut: vi.fn(async () => "moved their card to *Not Interested*") }));
vi.mock("./opt-out", () => optOut);
const stop = vi.hoisted(() => ({ closeQueueAndNurture: vi.fn(async () => ({ closedRows: 1, emberStopped: 0 })) }));
vi.mock("./stop-lead", () => stop);
const sms = vi.hoisted(() => ({ markLeadNoCalls: vi.fn(async () => {}) }));
vi.mock("./sms", () => sms);
vi.mock("./index", () => ({ loadIrisConfig: vi.fn(() => ({ timezone: "America/St_Johns" })) }));
vi.mock("./channels", () => ({ CALL_LOG_CHANNEL: "C-calls" }));
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const ghl = vi.hoisted(() => ({ getGhlConfig: vi.fn(async () => ({ locationId: "loc-1", apiKey: "key-1" })) }));
vi.mock("../../shared/ghl", () => ghl);

import { leadLines, maybeHonorVoiceStop } from "./voice-stop";

const call = (...lines: [string, string][]) => ({ messages: lines.map(([role, message]) => ({ role, message })) });

beforeEach(() => {
  db.query.mockResolvedValue([{ name: "Oluwadare Ogunbiyi" }]);
});
afterEach(() => vi.clearAllMocks());

describe("leadLines", () => {
  it("keeps only what the lead said", () => {
    expect(leadLines(call(["bot", "Hi, this is Iris."], ["user", "Hello?"], ["user", "  "], ["bot", "How are you?"], ["user", "Fine."]))).toEqual(["Hello?", "Fine."]);
  });
});

describe("maybeHonorVoiceStop — a stop said out loud on a call (audit, 2026-11-20)", () => {
  const stopCall = call(["bot", "Hi, this is Iris with 3 Percent East Coast."], ["user", "Yeah, please stop calling me."]);

  it("does nothing, and asks no model, when the lead said nothing stop-like", async () => {
    expect(await maybeHonorVoiceStop("3pc", "c1", null, call(["user", "Yes, that's me."], ["user", "About four hundred thousand."]))).toBeNull();
    expect(textSignals.classifyInboundText).not.toHaveBeenCalled();
  });

  it("closes the lead, tags them, and tells the team their exact words when the model is sure", async () => {
    textSignals.classifyInboundText.mockResolvedValue({ type: "opt_out", quote: "please stop calling me" });
    expect(await maybeHonorVoiceStop("3pc", "c1", null, stopCall)).toBe("opt_out");
    expect(stop.closeQueueAndNurture).toHaveBeenCalledWith("3pc", "c1", expect.stringContaining("asked on a call to stop"));
    expect(optOut.recordOptOut).toHaveBeenCalledWith("3pc", "c1", { locationId: "loc-1", apiKey: "key-1" }, "please stop calling me");
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining('*Oluwadare Ogunbiyi* asked to stop on the call') }));
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining('"please stop calling me"') }));
  });

  it("reads only the lead's lines, never Iris's", async () => {
    textSignals.classifyInboundText.mockResolvedValue({ type: "none" });
    await maybeHonorVoiceStop("3pc", "c1", null, call(["bot", "I can take you off the list if you say stop."], ["user", "Don't call me again."]));
    expect(textSignals.classifyInboundText.mock.calls[0][0]).toBe("Don't call me again.");
  });

  it("only tags 'no calls' when they only refuse the phone, and leaves them open to text", async () => {
    textSignals.classifyInboundText.mockResolvedValue({ type: "no_calls" });
    expect(await maybeHonorVoiceStop("3pc", "c1", null, call(["user", "Please don't call me, text me."]))).toBe("no_calls");
    expect(sms.markLeadNoCalls).toHaveBeenCalled();
    expect(optOut.recordOptOut).not.toHaveBeenCalled();
    expect(stop.closeQueueAndNurture).not.toHaveBeenCalled();
  });

  it("closes nothing on a maybe: it only tells the team", async () => {
    textSignals.classifyInboundText.mockResolvedValue({ type: "unsure_stop" });
    expect(await maybeHonorVoiceStop("3pc", "c1", null, call(["user", "Stop, let me think about that."]))).toBe("unsure_stop");
    expect(stop.closeQueueAndNurture).not.toHaveBeenCalled();
    expect(optOut.recordOptOut).not.toHaveBeenCalled();
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("might mean") }));
  });

  it("does nothing when GHL cannot be reached, rather than closing a lead it cannot tag", async () => {
    ghl.getGhlConfig.mockResolvedValueOnce(null as any);
    expect(await maybeHonorVoiceStop("3pc", "c1", null, stopCall)).toBeNull();
    expect(stop.closeQueueAndNurture).not.toHaveBeenCalled();
  });
});
