import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelloRescue, openerFromPrompt, RESCUE_DELAY_MS } from "./hello-rescue";
import { buildLeadQualificationPrompt } from "./scripts";

const OPENER = "Hi, this is Iris with 3 Percent East Coast. Am I speaking with Soyemi?";
const PROMPT = `## FIRST TURN — READ THIS FIRST\nWhen a real person first speaks to you, your ENTIRE reply is exactly this, copied word for word, every word, nothing added, nothing dropped:\n\n${OPENER}\n\nThat is ALL of the first turn.`;
const CONTROL = "https://phone-call-websocket.example/abc/control";

const call = (over: Record<string, unknown> = {}) => ({ id: "abc", monitor: { controlUrl: CONTROL }, assistant: { model: { messages: [{ role: "system", content: PROMPT }] } }, ...over });
const speech = (role: string, status: string, c = call()) => ({ type: "speech-update", role, status, call: c });
const transcript = (role: string, c = call()) => ({ type: "transcript", role, transcriptType: "final", transcript: "hello", call: c });

describe("openerFromPrompt", () => {
  it("reads the real opener out of the real prompt", () => {
    const lead: any = { name: "Soyemi Damilola", intent: "buyer", budget: null, timeline: null, leadSource: null, propertyInterest: null, bedrooms: null, financing: null, workingWithRealtor: null };
    const config: any = { questions: ["a", "b", "c", "d", "e"], timezone: "America/St_Johns" };
    const prompt = buildLeadQualificationPrompt(config, lead, "3 Percent East Coast", "St. John's", true, true, true);
    expect(openerFromPrompt(prompt)).toBe("Hi, this is Iris with 3 Percent East Coast. Am I speaking with Soyemi?");
  });
  it("is null for a call with no first-turn block (inbound), so those are never rescued", () => {
    const lead: any = { name: "Soyemi", intent: "buyer" };
    const config: any = { questions: ["a", "b", "c", "d", "e"], timezone: "America/St_Johns" };
    expect(openerFromPrompt(buildLeadQualificationPrompt(config, lead, "3 Percent East Coast", "St. John's", true, true, true, "inbound"))).toBeNull();
    expect(openerFromPrompt(null)).toBeNull();
  });
});

describe("hello rescue", () => {
  const say = vi.fn(async (_u: string, _c: string) => {});
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  const make = (extra: Record<string, unknown> = {}) => createHelloRescue({ say, ...extra });

  it("says the opener once when the lead was heard but nothing was transcribed", async () => {
    const r = make();
    r.observe(speech("user", "started"));
    r.observe(speech("user", "stopped"));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(CONTROL, OPENER);
    // a second silence later does not repeat it
    r.observe(speech("user", "stopped"));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a transcript arrives (a screener, a voicemail greeting or a normal hello)", async () => {
    const r = make();
    r.observe(speech("user", "stopped"));
    r.observe(transcript("user"));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).not.toHaveBeenCalled();
  });

  it("stays quiet once Iris has spoken", async () => {
    const r = make();
    r.observe(speech("assistant", "started"));
    r.observe(speech("user", "stopped"));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).not.toHaveBeenCalled();
  });

  it("does nothing on a silent line: no speech was heard", async () => {
    const r = make();
    r.observe({ type: "status-update", status: "in-progress", call: call() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(say).not.toHaveBeenCalled();
  });

  it("never rescues a call without an opener (inbound or a transfer leg)", async () => {
    const fetchCall = vi.fn(async () => ({ monitor: { controlUrl: CONTROL }, assistant: { model: { messages: [{ role: "system", content: "no first turn block" }] } } }));
    const r = make({ fetchCall });
    const bare = call({ assistant: { model: { messages: [{ role: "system", content: "no first turn block" }] } } });
    r.observe(speech("user", "stopped", bare));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).not.toHaveBeenCalled();
  });

  it("looks the call up when the live message carried neither the control address nor the prompt", async () => {
    const fetchCall = vi.fn(async () => ({ monitor: { controlUrl: CONTROL }, assistant: { model: { messages: [{ role: "system", content: PROMPT }] } } }));
    const r = make({ fetchCall });
    r.observe(speech("user", "stopped", { id: "abc" } as any));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(fetchCall).toHaveBeenCalledWith("abc");
    expect(say).toHaveBeenCalledWith(CONTROL, OPENER);
  });

  it("forgets a call when it ends, and says nothing if it ended during the wait", async () => {
    const r = make();
    r.observe(speech("user", "stopped"));
    r.observe({ type: "end-of-call-report", call: call() });
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(say).not.toHaveBeenCalled();
    expect(r.size()).toBe(0);
  });

  it("a failed say is logged, not thrown", async () => {
    const failing = vi.fn(async () => {
      throw new Error("control 500");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createHelloRescue({ say: failing });
    r.observe(speech("user", "stopped"));
    await vi.advanceTimersByTimeAsync(RESCUE_DELAY_MS + 50);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
