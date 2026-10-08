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
    readContext: vi.fn(async () => ({ stageName: null, daysInStage: null, tags: [], knownAnswers: [], notes: [], irisCalls: [] })),
    classifyStatus: vi.fn(async () => ({ verdict: "keep_nurturing", reason: "nothing that reads as a clear no" }) as any),
    moveStage: vi.fn(async () => {}),
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

  it("parks the lead as no_consent once the CASL window from their latest inquiry has passed", async () => {
    const d = deps();
    const outcome = await sendTouch(lead({ inquiryAt: daysAgo(181) }), d, ctx());
    expect(outcome.skippedReason).toContain("consent window");
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "no_consent" }));
  });

  it("counts a recent message from the lead as a fresh inquiry for consent", async () => {
    const d = deps({ readHistory: vi.fn(async () => [{ direction: "inbound" as const, channel: "sms" as const, body: "we might move in the spring", at: daysAgo(30) }]) });
    await sendTouch(lead({ inquiryAt: daysAgo(400) }), d, ctx());
    expect(d.sendSMS).toHaveBeenCalledTimes(1);
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

  it("pauses (never ends) the lead when the review says now's a bad time", async () => {
    const d = deps({ reviewHistory: vi.fn(async () => ({ action: "defer", reason: "mid-sale with another agent" }) as any) });
    const out = await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(out.skippedReason).toContain("mid-sale");
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({
      status: "nurturing", touchCount: 0, nextTouchAt: new Date(NOW.getTime() + 180 * DAY).toISOString(),
    }));
  });

  it("holds a temporary 'not right now' for 6 months from when they said it, then tries again with it as context", async () => {
    const said = (days: number, body: string) => ({ direction: "inbound" as const, channel: "sms" as const, body, at: daysAgo(days) });
    const recent = deps({ readHistory: vi.fn(async () => [said(60, "not interested right now")]) });
    await sendTouch(lead(), recent, ctx());
    expect(recent.sendSMS).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ nextTouchAt: new Date(NOW.getTime() + 120 * DAY).toISOString() }));

    const old = deps({ readHistory: vi.fn(async () => [said(200, "not right now"), said(20, "hmm what is out there these days?")]) });
    await sendTouch(lead(), old, ctx());
    expect(old.sendSMS).toHaveBeenCalledTimes(1);
    expect((old.reviewHistory as any).mock.calls[0][1].priorDecline.body).toBe("not right now");
  });

  it("reads the CRM context only for a cycle's first touch", async () => {
    const d = deps();
    await sendTouch(lead(), d, ctx());
    await sendTouch(lead({ touchCount: 1 }), d, ctx());
    expect(d.readContext).toHaveBeenCalledTimes(1);
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

  it("moves a lead to Not Interested on clear evidence in their history — on ANY touch — and never texts them", async () => {
    const d = deps({
      classifyStatus: vi.fn(async () => ({ verdict: "not_interested", category: "other_agent", evidence: "we're working with another agent now", by: "rule" }) as any),
    });
    const out = await sendTouch(lead({ touchCount: 1 }), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.reviewHistory).not.toHaveBeenCalled();
    expect(out.skippedReason).toContain("not interested");
    expect(store.transitionStatus).toHaveBeenCalledWith(1, expect.any(Array), expect.objectContaining({ status: "not_interested" }));
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Not Qualified/Not Interested");
    expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("we're working with another agent now"));
  });

  it("a stop request is recorded as an opt-out as well as moved", async () => {
    const d = deps({ classifyStatus: vi.fn(async () => ({ verdict: "not_interested", category: "asked_to_stop", evidence: "stop", by: "rule" }) as any) });
    await sendTouch(lead(), d, ctx());
    expect(store.transitionStatus).toHaveBeenCalledWith(1, expect.any(Array), expect.objectContaining({ status: "opted_out" }));
    expect(d.moveStage).toHaveBeenCalled();
  });

  it("when a possible clear no can't be confirmed, neither moves nor texts — waits", async () => {
    const d = deps({ classifyStatus: vi.fn(async () => ({ verdict: "unsure", reason: "status check failed" }) as any) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.moveStage).not.toHaveBeenCalled();
    expect(store.updateLead).not.toHaveBeenCalled();
  });

  it("still texts when the check finds no clear no", async () => {
    const d = deps();
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).toHaveBeenCalledTimes(1);
    expect(d.moveStage).not.toHaveBeenCalled();
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

describe("handleReply — Ember answers old leads itself (Mark, 2026-10-06)", () => {
  const keep = async () => ({ verdict: "keep_nurturing", reason: "x" }) as any;
  const replyCtx = (over: any = {}) => ({
    config: config(), clientName: "Mark's Realty", alert: vi.fn(async () => {}), now: NOW, firstName: "Jordan",
    classifyStatus: vi.fn(keep), moveStage: vi.fn(async () => {}),
    sendCourtesy: vi.fn(async () => {}), converse: vi.fn(async () => "Great! Still looking to buy?"),
    ...over,
  });

  it("an interested reply goes into Ember's own conversation, with one alert", async () => {
    const r = replyCtx();
    await handleReply(lead(), "yes still looking", r);
    expect(r.converse).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "yes still looking");
    expect(r.alert).toHaveBeenCalledWith(expect.stringContaining("Ember is texting with them"));
    expect(r.sendCourtesy).not.toHaveBeenCalled();
  });

  it("mid-conversation replies go straight to the conversation — no repeat alert, no pause rule", async () => {
    const r = replyCtx();
    await handleReply(lead({ status: "conversing" }), "not ready to talk right now, text me tomorrow", r);
    expect(r.converse).toHaveBeenCalled();
    expect(r.alert).not.toHaveBeenCalled();
    expect(store.updateLead).not.toHaveBeenCalledWith(1, expect.objectContaining({ touchCount: 0 }));
  });

  it("a clear no is moved to Not Interested AND gets one polite reply", async () => {
    const r = replyCtx({ classifyStatus: vi.fn(async () => ({ verdict: "not_interested", category: "already_bought", evidence: "we already bought last month", by: "ai" }) as any) });
    await handleReply(lead(), "we already bought last month", r);
    expect(r.moveStage).toHaveBeenCalledWith("o1", "Not Qualified/Not Interested");
    expect(r.sendCourtesy).toHaveBeenCalledWith("Congrats on the new place, Jordan! Wishing you all the best - take care.");
    expect(r.converse).not.toHaveBeenCalled();
  });

  it("a STOP is moved and recorded as an opt-out, but never answered", async () => {
    const r = replyCtx({ classifyStatus: vi.fn(async () => ({ verdict: "not_interested", category: "asked_to_stop", evidence: "STOP", by: "rule" }) as any) });
    await handleReply(lead(), "STOP", r);
    expect(r.moveStage).toHaveBeenCalled();
    expect(r.sendCourtesy).not.toHaveBeenCalled();
  });

  it("'not ready yet' pauses them and gets one polite reply — never moved", async () => {
    const r = replyCtx();
    await handleReply(lead(), "I'm not ready yet", r);
    expect(r.moveStage).not.toHaveBeenCalled();
    expect(r.converse).not.toHaveBeenCalled();
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ status: "nurturing", touchCount: 0 }));
    expect(r.sendCourtesy).toHaveBeenCalledWith(expect.stringContaining("I'll check back in a few months"));
  });

  it("a possible no that can't be confirmed goes to a human — not moved, not answered", async () => {
    const r = replyCtx({ classifyStatus: vi.fn(async () => ({ verdict: "unsure", reason: "x" }) as any) });
    await handleReply(lead(), "we sort of found something", r);
    expect(r.moveStage).not.toHaveBeenCalled();
    expect(r.converse).not.toHaveBeenCalled();
    expect(r.sendCourtesy).not.toHaveBeenCalled();
    expect(r.alert).toHaveBeenCalledWith(expect.stringContaining("please read it"));
  });

  it("a mixed 'no rush but yes' reply is not filed as a no", async () => {
    const r = replyCtx();
    await handleReply(lead(), "no rush but yes still looking", r);
    expect(r.converse).toHaveBeenCalled();
    expect(r.sendCourtesy).not.toHaveBeenCalled();
  });

  it("courtesy templates can be overridden per client", async () => {
    const c = config();
    c.outreach.courtesy = { notReady: "All good {{firstName}}, talk soon!" };
    const r = replyCtx({ config: c });
    await handleReply(lead(), "not right now", r);
    expect(r.sendCourtesy).toHaveBeenCalledWith("All good Jordan, talk soon!");
  });
});

describe("displayName — no shouted names in texts", () => {
  it.each([["JACOB", "Jacob"], ["sarah", "Sarah"], ["MARY-JANE", "Mary-Jane"], ["O'BRIEN", "O'Brien"], ["McKenzie", "McKenzie"], ["DeShawn", "DeShawn"]])(
    "%s → %s",
    async (input, out) => {
      const { displayName } = await import("./outreach");
      expect(displayName(input)).toBe(out);
    }
  );
});

describe("smsSafe — keep texts in the plain (GSM-7) character set so they bill as 1 segment", () => {
  const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
  it("swaps long dashes, curly quotes, ellipses and odd spaces for plain ones", async () => {
    const { smsSafe } = await import("./outreach");
    expect(smsSafe("Hi Jacob \u2014 it\u2019s \u201Cgreat\u201D\u2026 see\u00A0you")).toBe(`Hi Jacob - it's "great"... see you`);
  });
  it("drops emoji, folds accents GSM-7 lacks, and swaps two-slot characters (Mark, 2026-10-09)", async () => {
    const { smsSafe } = await import("./outreach");
    expect(smsSafe("Great news \u{1F389}\u{1F3E1} Fran\u00E7ois! [3 bed] ~ok")).toBe("Great news Francois! (3 bed) -ok");
    expect(smsSafe("Caf\u00E9  ready \u{1F44D}")).toBe("Caf\u00E9 ready");
  });
  it("keeps an over-long AI reply to one text, keeping the question at the end", async () => {
    const { fitOneSegment, smsLength } = await import("./outreach");
    const long = "That's great to hear, and thanks so much for getting back to me after all this time. " +
      "We'd love to help you find the right place this spring. What area are you hoping to buy in?";
    const fitted = fitOneSegment(long);
    expect(smsLength(fitted)).toBeLessThanOrEqual(160);
    expect(fitted.endsWith("What area are you hoping to buy in?")).toBe(true);
    expect(fitOneSegment("Short and sweet. Still looking?")).toBe("Short and sweet. Still looking?");
  });
  it("every approved script and courtesy reply fits one text, even for a long name", async () => {
    const { smsLength, courtesyFor } = await import("./outreach");
    const { readFileSync } = await import("fs");
    const sender = "3% Realty East Coast";
    const name = "Christopher";
    for (const id of ["eden-sub-account-one"]) {
      const scripts = JSON.parse(readFileSync(`config/clients/${id}.json`, "utf-8")).ember.outreach.sms.scripts;
      for (const t of Object.values(scripts).flat() as string[]) {
        const text = t.replace("{{firstName}}", name).replace("{{senderName}}", sender);
        expect(smsLength(text), text).toBeLessThanOrEqual(160);
      }
    }
    for (const kind of ["not_ready", "already_bought", "already_sold", "other_agent", "no_longer_looking"] as const) {
      expect(smsLength(courtesyFor(kind, name, config())!)).toBeLessThanOrEqual(160);
    }
  });
  it("every default courtesy reply is plain", async () => {
    const { DEFAULT_COURTESY, courtesyFor } = await import("./outreach");
    for (const kind of ["not_ready", "already_bought", "already_sold", "other_agent", "no_longer_looking"] as const) {
      expect(courtesyFor(kind, "Jacob", config())).toMatch(GSM);
    }
    for (const t of Object.values(DEFAULT_COURTESY)) expect(t.replace("{{firstName}}", "J")).toMatch(GSM);
  });
  it("a scripted or AI-written touch goes out plain", async () => {
    const d = deps({ reviewHistory: vi.fn(async () => ({ action: "personalized", reason: "r", message: "Hi Jordan \u2014 still keen on the east end? Reply STOP to opt out." }) as any) });
    await sendTouch(lead(), d, ctx());
    expect(d.sendSMS).toHaveBeenCalledWith("c1", "Hi Jordan - still keen on the east end? Reply STOP to opt out.");
  });
});
