import { describe, expect, it, vi } from "vitest";
vi.mock("../../shared/claude", () => ({ chatWithTools: vi.fn() }));

import { buildEmberSmsPrompt, ConversationContext, ConversationDeps, emberConverse } from "./conversation";
import { config, lead } from "./test-fixtures";

const IRIS_CONFIG: any = {
  questions: ["Are you looking to buy or sell?", "What area?", "What type of home?", "What's your timeline?", "Are you pre-approved? Budget?"],
  hotScoreThreshold: 75,
  warmScoreThreshold: 40,
  timezone: "America/Toronto",
};

const NOW = new Date("2026-10-06T15:00:00Z"); // 11:00 Toronto

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    config: config(),
    irisConfig: IRIS_CONFIG,
    brandName: "Mark's Realty",
    city: "Toronto",
    timezone: "America/Toronto",
    firstName: "Jacob",
    opener: "Hi Jacob, it's Mark's Realty. Still thinking about a move? Reply STOP to opt out.",
    known: { timeline: "3-6 months" },
    now: NOW,
    ...over,
  };
}

const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" }) as any;
const tool = (name: string, input: any) => ({ content: [{ type: "tool_use", id: `t-${name}`, name, input }], stop_reason: "tool_use" }) as any;

function deps(...turns: any[]): ConversationDeps & { sent: string[] } {
  const sent: string[] = [];
  const chat = vi.fn();
  for (const t of turns) chat.mockResolvedValueOnce(t);
  return {
    sent,
    chat: chat as any,
    loadHistory: vi.fn(async () => []),
    appendHistory: vi.fn(async () => {}),
    sendSMS: vi.fn(async (_c: string, t: string) => { sent.push(t); }),
    pauseLikeAHuman: vi.fn(async () => {}),
    saveNotes: vi.fn(async () => true),
    queueIrisCall: vi.fn(async () => {}),
    updateLead: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
  };
}

describe("buildEmberSmsPrompt", () => {
  it("asks the client's own Iris questions, confirms buy/sell first, and answers 'bot?' honestly", () => {
    const p = buildEmberSmsPrompt(ctx());
    for (const q of IRIS_CONFIG.questions) expect(p).toContain(q);
    expect(p).toContain("confirm whether they're still thinking about buying or selling BEFORE anything else");
    expect(p).toContain("virtual assistant");
    expect(p).toContain("Still thinking about a move?"); // the opener they're replying to
    expect(p).toContain("timeline: 3-6 months");
  });
});

describe("emberConverse — Ember texts the old lead itself", () => {
  it("replies after the human-like pause and remembers the exchange", async () => {
    const d = deps(text("Great to hear from you, Jacob! Are you still thinking of buying?"));
    const reply = await emberConverse(lead(), "yes still looking", ctx(), d);
    expect(reply).toBe("Great to hear from you, Jacob! Are you still thinking of buying?");
    expect(d.pauseLikeAHuman).toHaveBeenCalledBefore(d.sendSMS as any);
    expect(d.sent).toEqual([reply]);
    expect(d.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "conversing" }));
    expect(d.appendHistory).toHaveBeenCalledWith("sms:eden-sub-account-one:c1", "user", "yes still looking");
    expect(d.appendHistory).toHaveBeenCalledWith("sms:eden-sub-account-one:c1", "assistant", reply);
  });

  it("a qualified lead who says 'now' gets Iris's live-transfer call queued — scored by code, not the model", async () => {
    const d = deps(
      tool("schedule_transfer_call", { intent: "buyer", area: "Downtown", propertyDetails: "3 bed", timeline: "within 1 month", budget: "500k", financing: "pre-approved", when: "now" }),
      text("Perfect — expect a quick call from our team in a couple of minutes!")
    );
    await emberConverse(lead({ status: "conversing" }), "now works", ctx(), d);
    expect(d.queueIrisCall).toHaveBeenCalledTimes(1);
    const when = (d.queueIrisCall as any).mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "handed_off" }));
    expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("live transfer"));
    expect(d.sent).toEqual(["Perfect - expect a quick call from our team in a couple of minutes!"]);
  });

  it("an unqualified lead never gets a call queued, whatever the model wanted", async () => {
    const d = deps(
      tool("schedule_transfer_call", { intent: "buyer", timeline: "maybe next year", financing: "not-approved", when: "now" }),
      text("No problem — someone from the team will follow up.")
    );
    await emberConverse(lead({ status: "conversing" }), "sure", ctx(), d);
    expect(d.queueIrisCall).not.toHaveBeenCalled();
    const toolResult = (d.chat as any).mock.calls[1][1].at(-1).content[0].content as string;
    expect(toolResult).toMatch(/^NOT scheduled/);
  });

  it("request_human_followup hands it to a person", async () => {
    const d = deps(tool("request_human_followup", { summary: "asked about a specific listing's price" }), text("Someone from the team will follow up shortly!"));
    await emberConverse(lead({ status: "conversing" }), "how much is 12 Elm St?", ctx(), d);
    expect(d.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied" }));
    expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("asked about a specific listing's price"));
  });

  it("pause_for_now respects the time they named", async () => {
    const d = deps(tool("pause_for_now", { reason: "after the holidays", resumeInDays: 60 }), text("Sounds good — I'll check back after the holidays!"));
    await emberConverse(lead({ status: "conversing" }), "reach out after the holidays", ctx(), d);
    expect(d.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({
      status: "nurturing", touchCount: 0, nextTouchAt: new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
    }));
  });

  it("an AI reply with a long dash or curly quotes is sent plain", async () => {
    const d = deps(text("Got it \u2014 what\u2019s your timeline?"));
    expect(await emberConverse(lead(), "yes", ctx(), d)).toBe("Got it - what's your timeline?");
    expect(d.sent).toEqual(["Got it - what's your timeline?"]);
  });

  it("sends nothing when the model produced no text", async () => {
    const d = deps({ content: [], stop_reason: "end_turn" });
    expect(await emberConverse(lead(), "hi", ctx(), d)).toBeNull();
    expect(d.sendSMS).not.toHaveBeenCalled();
  });
});
