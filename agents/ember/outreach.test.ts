import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  logSend: vi.fn(async () => {}),
  sendsToday: vi.fn(async () => 0),
  updateLead: vi.fn(async () => {}),
  transitionStatus: vi.fn(async () => true),
}));
vi.mock("./store", () => store);

import {
  handleReply,
  inSendWindow,
  LiveContext,
  nextTouchAfterSend,
  OutreachDeps,
  pickChannel,
  sendBatch,
  sendTouch,
  TouchContext,
} from "./outreach";
import { config, DAY, daysAgo, lead, NOW, opp, OUTCOME_STAGES, STAGES } from "./test-fixtures";

afterEach(() => vi.clearAllMocks());

function live(over: Partial<LiveContext["contact"]> = {}, oppOver: any = {}): LiveContext {
  return {
    contact: { firstName: "Jordan", phone: "+17095550100", email: "j@example.com", ...over },
    opportunity: opp(oppOver),
  };
}

function deps(over: Partial<OutreachDeps> = {}): OutreachDeps {
  return {
    loadLive: vi.fn(async () => live()),
    sendSMS: vi.fn(async () => ({ messageId: "m1" })),
    sendEmail: vi.fn(async () => ({ messageId: "e1" })),
    alert: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    readHistory: vi.fn(async () => []),
    reviewHistory: vi.fn(async () => ({ action: "script", reason: "no replies in their history" }) as any),
    ...over,
  };
}

const ctx = (over: Partial<TouchContext> = {}): TouchContext => ({
  config: config(),
  clientName: "Mark's Realty",
  outcomeStages: OUTCOME_STAGES,
  stageNames: STAGES,
  now: NOW,
  ...over,
});

describe("pickChannel", () => {
  it("prefers SMS when the contact has a phone", () => {
    expect(pickChannel(live().contact, config())).toBe("sms");
  });

  it("respects GHL DND, contact-wide or per channel", () => {
    expect(pickChannel(live({ dnd: true }).contact, config())).toBeNull();
    expect(pickChannel(live({ dndSettings: { SMS: { status: "active" } } }).contact, config())).toBeNull();
    expect(pickChannel(live({ dndSettings: { SMS: { status: "inactive" } } }).contact, config())).toBe("sms");
  });

  it("falls back to email only when email is enabled", () => {
    const c = config();
    c.outreach.email.enabled = true;
    expect(pickChannel(live({ phone: null }).contact, c)).toBe("email");
    expect(pickChannel(live({ phone: null }).contact, config())).toBeNull();
  });
});

describe("nextTouchAfterSend", () => {
  it("schedules the next touch by the configured gap from the actual send", () => {
    const sentAt = new Date("2026-10-01T15:00:00Z");
    expect(nextTouchAfterSend(sentAt, 0, [0, 14, 35])?.toISOString()).toBe(new Date(sentAt.getTime() + 14 * DAY).toISOString());
    expect(nextTouchAfterSend(sentAt, 1, [0, 14, 35])?.toISOString()).toBe(new Date(sentAt.getTime() + 21 * DAY).toISOString());
    expect(nextTouchAfterSend(sentAt, 2, [0, 14, 35])).toBeNull();
  });
});

describe("inSendWindow", () => {
  it("evaluates hours in the client's timezone", () => {
    expect(inSendWindow(new Date("2026-09-23T15:00:00Z"), config())).toBe(true); // 11:00 Toronto
    expect(inSendWindow(new Date("2026-09-23T07:00:00Z"), config())).toBe(false); // 03:00 Toronto
    expect(inSendWindow(new Date("2026-09-23T23:00:00Z"), config())).toBe(false); // 19:00 Toronto, end is exclusive
  });
});

describe("sendTouch", () => {
  it("sends the templated SMS and schedules the next touch", async () => {
    const d = deps();
    const outcome = await sendTouch(lead(), d, ctx());
    expect(outcome).toEqual({ leadId: 1, sent: true, channel: "sms" });
    expect(d.sendSMS).toHaveBeenCalledWith("c1", "Hi Jordan, it's Mark's Realty. Reply STOP to opt out.");
    expect(store.logSend).toHaveBeenCalledWith(expect.objectContaining({ touchIndex: 0, channel: "sms", ghlMessageId: "m1" }));
    expect(store.updateLead).toHaveBeenCalledWith(1, {
      touchCount: 1,
      lastTouchAt: NOW.toISOString(),
      nextTouchAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
    });
  });

  it("picks the buyer or seller script from the lead's intent", async () => {
    const d = deps();
    await sendTouch(lead({ intent: "buyer" }), d, ctx());
    await sendTouch(lead({ intent: "downsize" }), d, ctx());
    expect(d.sendSMS).toHaveBeenNthCalledWith(1, "c1", "Buyer one Jordan, it's Mark's Realty. Reply STOP to opt out.");
    expect(d.sendSMS).toHaveBeenNthCalledWith(2, "c1", "Seller one Jordan. Reply STOP to opt out.");
  });

  it("reuses the last template once the cadence outruns the list", async () => {
    const d = deps();
    await sendTouch(lead({ touchCount: 2 }), d, ctx());
    expect(d.sendSMS).toHaveBeenCalledWith("c1", "Touch two Jordan. Reply STOP to opt out.");
  });

  it("completes the lead when the last touch goes out", async () => {
    await sendTouch(lead({ touchCount: 2 }), deps(), ctx());
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ touchCount: 3, nextTouchAt: null, status: "completed" }));
  });

  it("does not send once the CASL consent window has passed", async () => {
    const d = deps();
    const outcome = await sendTouch(lead({ inquiryAt: daysAgo(181) }), d, ctx());
    expect(outcome.skippedReason).toBe("consent window ended");
    expect(d.loadLive).not.toHaveBeenCalled();
    expect(d.sendSMS).not.toHaveBeenCalled();
  });

  it("does not send when the card moved since the scan — reactivates and alerts instead", async () => {
    const d = deps({ loadLive: vi.fn(async () => live({}, { pipelineStageId: "s_confirmed" })) });
    const outcome = await sendTouch(lead(), d, ctx());
    expect(outcome.sent).toBe(false);
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledTimes(1);
  });

  it("exits without alerting when the deal was won", async () => {
    const d = deps({ loadLive: vi.fn(async () => live({}, { pipelineStageId: "s_closed" })) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.alert).not.toHaveBeenCalled();
    expect(store.transitionStatus).toHaveBeenCalledWith(1, expect.any(Array), expect.objectContaining({ status: "exited" }));
  });

  it("opts the lead out when GHL has DND set", async () => {
    const d = deps({ loadLive: vi.fn(async () => live({ dnd: true })) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "opted_out" }));
  });

  it("exits when the opportunity no longer exists", async () => {
    const d = deps({ loadLive: vi.fn(async () => null) });
    expect((await sendTouch(lead(), d, ctx())).skippedReason).toBe("opportunity gone");
  });

  it("skips a lead that is not nurturing or not yet due", async () => {
    const d = deps();
    expect((await sendTouch(lead({ status: "paused" }), d, ctx())).skippedReason).toBe("status is paused");
    expect((await sendTouch(lead({ nextTouchAt: new Date(NOW.getTime() + DAY).toISOString() }), d, ctx())).skippedReason).toBe("not due yet");
    expect(d.sendSMS).not.toHaveBeenCalled();
  });

  it("logs a failed send and leaves the lead due for a retry", async () => {
    const d = deps({ sendSMS: vi.fn(async () => { throw new Error("GHL API Error 500: boom"); }) });
    const outcome = await sendTouch(lead(), d, ctx());
    expect(outcome.error).toContain("boom");
    expect(store.logSend).toHaveBeenCalledWith(expect.objectContaining({ error: "GHL API Error 500: boom" }));
    expect(store.updateLead).not.toHaveBeenCalled();
  });
});

describe("sendTouch — conversation history (Mark, 2026-09-24)", () => {
  const inbound = (body: string) => ({ direction: "inbound" as const, channel: "sms" as const, body, at: daysAgo(90) });

  it("sends a personal opener on the first touch when the review writes one", async () => {
    const d = deps({
      readHistory: vi.fn(async () => [inbound("we want a 3 bed in the east end, probably fall")]),
      reviewHistory: vi.fn(async () => ({ action: "personalized", reason: "real convo", message: "Hi Jordan, still thinking about that 3 bed in the east end this fall? Reply STOP to opt out." }) as any),
    });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).toHaveBeenCalledWith("c1", "Hi Jordan, still thinking about that 3 bed in the east end this fall? Reply STOP to opt out.");
  });

  it("skips (and ends the cadence) when the review says a check-in would be unwelcome", async () => {
    const d = deps({ reviewHistory: vi.fn(async () => ({ action: "skip", reason: "already bought", optOut: false }) as any) });
    const out = await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(out.skippedReason).toContain("already bought");
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "exited", statusReason: "history: already bought" }));
  });

  it("never sends blind when the review can't run — the touch stays due", async () => {
    const d = deps({ reviewHistory: vi.fn(async () => ({ action: "retry", reason: "history review failed" }) as any) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(store.updateLead).not.toHaveBeenCalled();
  });

  it("never sends when history can't be read", async () => {
    const d = deps({ readHistory: vi.fn(async () => { throw new Error("GHL API Error 502"); }) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
  });

  it("an opt-out anywhere in the history ends it on ANY touch, without asking the model", async () => {
    const d = deps({ readHistory: vi.fn(async () => [inbound("please stop texting me")]) });
    await sendTouch(lead({ touchCount: 1 }), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.reviewHistory).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "opted_out" }));
  });

  it("later touches keep the approved scripts — only the first is reviewed", async () => {
    const d = deps();
    await sendTouch(lead({ touchCount: 1 }), d, ctx());
    expect(d.reviewHistory).not.toHaveBeenCalled();
    expect(d.sendSMS).toHaveBeenCalledWith("c1", "Touch two Jordan. Reply STOP to opt out.");
  });
});

describe("sendBatch", () => {
  it("stops at the daily cap, counting what already went out today", async () => {
    store.sendsToday.mockResolvedValueOnce(19);
    const d = deps();
    const result = await sendBatch([lead({ id: 1 }), lead({ id: 2 })], d, ctx());
    expect(result.sent).toBe(1);
    expect(result.capReached).toBe(true);
  });

  it("waits a jittered gap between actual sends only", async () => {
    const d = deps();
    await sendBatch([lead({ id: 1 }), lead({ id: 2, status: "paused" }), lead({ id: 3 })], d, ctx(), { random: () => 0.5 });
    // one wait after lead 1 (sent), none after lead 2 (skipped), none after the last
    expect(d.wait).toHaveBeenCalledTimes(1);
    expect(d.wait).toHaveBeenCalledWith(90_000 + 60_000);
  });

  it("stops when the send window closes mid-batch", async () => {
    const times = [new Date("2026-09-23T22:59:00Z"), new Date("2026-09-23T23:01:00Z")];
    const d = deps();
    const result = await sendBatch([lead({ id: 1 }), lead({ id: 2 })], d, ctx(), { clock: () => times.shift()! });
    expect(result.sent).toBe(1);
    expect(d.sendSMS).toHaveBeenCalledTimes(1);
  });
});

describe("handleReply", () => {
  const replyCtx = (alert = vi.fn(async () => {})) => ({ config: config(), clientName: "Mark's Realty", alert, now: NOW });

  it("a clear no opts out quietly", async () => {
    const r = replyCtx();
    expect(await handleReply(lead(), "No thanks, not interested", r)).toBe("negative");
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "opted_out" }));
    expect(r.alert).not.toHaveBeenCalled();
  });

  it("a yes stops the cadence and alerts", async () => {
    const r = replyCtx();
    expect(await handleReply(lead(), "Yes! still looking actually", r)).toBe("positive");
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied", nextTouchAt: null }));
    expect(r.alert).toHaveBeenCalledWith(expect.stringContaining('replied "Yes! still looking actually"'));
  });

  it("hands a non-'no' reply to Iris instead of alerting a human directly", async () => {
    const r = { ...replyCtx(), handoff: vi.fn(async () => "handed_off" as const) };
    await handleReply(lead(), "yes still looking", r);
    expect(r.handoff).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "yes still looking");
    expect(store.updateLead).not.toHaveBeenCalled();
    expect(r.alert).not.toHaveBeenCalled();
  });

  it("falls back to the human alert when Iris isn't available for this client", async () => {
    const r = { ...replyCtx(), handoff: vi.fn(async () => "not_available" as const) };
    await handleReply(lead(), "yes still looking", r);
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied" }));
    expect(r.alert).toHaveBeenCalledTimes(1);
  });

  it("never hands a clear 'no' to Iris", async () => {
    const r = { ...replyCtx(), handoff: vi.fn(async () => "handed_off" as const) };
    await handleReply(lead(), "no thanks, not interested", r);
    expect(r.handoff).not.toHaveBeenCalled();
  });

  it("an unclear reply also goes to a human", async () => {
    const r = replyCtx();
    expect(await handleReply(lead(), "who is this?", r)).toBe("unclear");
    expect(r.alert).toHaveBeenCalledTimes(1);
  });

  it("a mixed reply is not silently filed as an opt-out", async () => {
    const r = replyCtx();
    await handleReply(lead(), "no rush but yes still looking", r);
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "replied" }));
    expect(r.alert).toHaveBeenCalledTimes(1);
  });
});
