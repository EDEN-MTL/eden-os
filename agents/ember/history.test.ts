import { describe, expect, it, vi } from "vitest";
vi.mock("../../shared/claude", () => ({ ask: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getConversations: vi.fn(), getConversationMessages: vi.fn() }));

import { getConversationMessages, getConversations } from "../../shared/ghl";
import {
  consentStart,
  EMPTY_CONTEXT,
  findHardOptOut,
  findSoftDecline,
  HistoryMessage,
  isHardOptOut,
  prefersText,
  readConversationHistory,
  reviewHistory,
  ReviewContext,
} from "./history";

const inb = (body: string, at = "2026-06-01T00:00:00Z"): HistoryMessage => ({ direction: "inbound", channel: "sms", body, at });
const outb = (body: string, at = "2026-05-31T00:00:00Z"): HistoryMessage => ({ direction: "outbound", channel: "sms", body, at });
const CTX: ReviewContext = {
  firstName: "Sarah", brandName: "Mark's Realty", intent: "buyer", stopLine: "Reply STOP to opt out.",
  now: new Date("2026-09-24"), lead: EMPTY_CONTEXT, priorDecline: null,
};

describe("hard opt-outs — permanent", () => {
  it.each(["STOP", "stop.", "Please stop texting me", "don't contact me again", "remove me from your list", "wrong number", "leave me alone", "unsubscribe"])(
    "catches %j",
    (body) => {
      expect(findHardOptOut([inb(body)])).toBe(body);
      expect(isHardOptOut(body)).toBe(true);
    }
  );
  it.each(["Not interested, thanks", "we already bought", "yes still looking", "can you stop by the house saturday?"])("does not treat %j as permanent", (body) => {
    expect(findHardOptOut([inb(body)])).toBeNull();
  });
  it("ignores our own outbound texts", () => {
    expect(findHardOptOut([outb("Reply STOP to opt out.")])).toBeNull();
  });
});

describe("soft declines — retried after the cool-off", () => {
  it.each(["Not interested, thanks", "We already bought a place", "we bought a house in june", "I'm working with another agent", "we have a realtor", "not right now", "no longer looking"])(
    "catches %j",
    (body) => expect(findSoftDecline([inb(body)])?.body).toBe(body)
  );
  it.each(["yes still looking", "we're not in a rush", "maybe in the spring"])("lets %j through", (body) => {
    expect(findSoftDecline([inb(body)])).toBeNull();
  });
  it("returns the most recent decline", () => {
    const d = findSoftDecline([inb("not interested", "2026-01-01T00:00:00Z"), inb("yes!", "2026-02-01T00:00:00Z"), inb("not right now", "2026-03-01T00:00:00Z")]);
    expect(d?.at).toBe("2026-03-01T00:00:00Z");
  });
});

describe("prefersText — no unasked calls", () => {
  it.each(["Please text me.", "I would appreciate to not be called so many times", "don't call me, text is better", "no more calls please", "I'm not available for a phone call"])(
    "catches %j",
    (body) => expect(prefersText([inb(body)])).toBe(body)
  );
  it.each(["call me at 5", "yes still looking", "can you call tomorrow?"])("lets %j through", (body) => {
    expect(prefersText([inb(body)])).toBeNull();
  });
});

describe("consentStart — CASL clock from the latest real inquiry", () => {
  it("is the original inquiry when they never wrote back", () => {
    expect(consentStart("2026-01-01T00:00:00Z", [outb("hi")])).toBe("2026-01-01T00:00:00Z");
  });
  it("moves forward when they wrote to us about a move", () => {
    expect(consentStart("2026-01-01T00:00:00Z", [inb("looking at 3 beds now", "2026-07-01T00:00:00Z")])).toBe("2026-07-01T00:00:00Z");
  });
  it("does NOT move forward for a decline or opt-out", () => {
    expect(consentStart("2026-01-01T00:00:00Z", [inb("not interested", "2026-07-01T00:00:00Z"), inb("stop", "2026-08-01T00:00:00Z")])).toBe("2026-01-01T00:00:00Z");
  });
});

describe("reviewHistory", () => {
  it("uses the standard script when there's nothing on record, without calling the model", async () => {
    const ask = vi.fn();
    expect(await reviewHistory([outb("Hi, thanks for reaching out!")], CTX, ask)).toEqual({ action: "script", reason: "no replies, calls or notes on record" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads the record when there are team notes or calls, even with no text replies", async () => {
    const ask = vi.fn(async () => '{"action":"script","reason":"nothing specific"}');
    await reviewHistory([], { ...CTX, lead: { ...EMPTY_CONTEXT, notes: [{ at: "2026-05-01", text: "Spoke with Sarah — wants a 3 bed, east end" }] } }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    const system = ask.mock.calls[0][0] as string;
    expect(system).toContain("Spoke with Sarah");
  });

  it("gives the model the pipeline stage, calls and the old decline to start from", async () => {
    const ask = vi.fn(async () => '{"action":"script","reason":"r"}');
    await reviewHistory([inb("not interested", "2026-01-10T00:00:00Z")], {
      ...CTX,
      lead: { ...EMPTY_CONTEXT, stageName: "Live Transferred", daysInStage: 200, irisCalls: [{ at: "2026-01-05", outcome: "customer-ended-call", excerpt: "looking in the spring" }] },
      priorDecline: inb("not interested", "2026-01-10T00:00:00Z"),
    }, ask);
    const system = ask.mock.calls[0][0] as string;
    expect(system).toContain("Pipeline stage: Live Transferred (untouched for 200 days)");
    expect(system).toContain("looking in the spring");
    expect(system).toContain('They last declined about 9 months ago, saying: "not interested"');
  });

  it("returns a personal opener and adds the STOP line", async () => {
    const ask = vi.fn(async () => '{"action":"personalized","reason":"east end 3 bed","message":"Hi Sarah, still hoping for that 3 bed in the east end this fall?"}');
    const d = await reviewHistory([inb("3 bed in the east end, fall")], CTX, ask);
    expect(d).toEqual({ action: "personalized", reason: "east end 3 bed", message: "Hi Sarah, still hoping for that 3 bed in the east end this fall? Reply STOP to opt out." });
  });

  it("does not double the STOP line, and doesn't mistake 'stop by' for one", async () => {
    const withLine = vi.fn(async () => '{"action":"personalized","reason":"r","message":"Hi Sarah, still looking? Reply STOP to opt out."}');
    expect((await reviewHistory([inb("hi")], CTX, withLine) as any).message).toBe("Hi Sarah, still looking? Reply STOP to opt out.");
    const stopBy = vi.fn(async () => '{"action":"personalized","reason":"r","message":"Hi Sarah, want to stop by an open house?"}');
    expect((await reviewHistory([inb("hi")], CTX, stopBy) as any).message).toMatch(/Reply STOP to opt out\.$/);
  });

  it("falls back to the approved script when the opener breaks guardrails (links, prices, too long)", async () => {
    for (const message of ["Check this out https://x.co", "Homes are going for $500k now!", "x".repeat(400)]) {
      const ask = vi.fn(async () => JSON.stringify({ action: "personalized", reason: "r", message }));
      expect((await reviewHistory([inb("hi")], CTX, ask)).action).toBe("script");
    }
  });

  it("maps the model's defer (and an old-style skip) to a pause, never a permanent stop", async () => {
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => '{"action":"defer","reason":"mid-sale with another agent"}'))).action).toBe("defer");
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => '{"action":"skip","reason":"x"}'))).action).toBe("defer");
  });

  it("retries — never sends — on a model failure or unreadable answer", async () => {
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => { throw new Error("no key"); }))).action).toBe("retry");
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => "sure, sounds good"))).action).toBe("retry");
  });
});

describe("readConversationHistory", () => {
  it("keeps texts, emails and team calls, strips HTML, oldest first", async () => {
    vi.mocked(getConversations).mockResolvedValue({ conversations: [{ id: "cv1" }] });
    vi.mocked(getConversationMessages).mockResolvedValue({
      messages: {
        messages: [
          { messageType: "TYPE_ACTIVITY_OPPORTUNITY", direction: "outbound", body: "Opportunity updated", dateAdded: "2026-09-04" },
          { messageType: "TYPE_CALL", direction: "outbound", body: "", dateAdded: "2026-09-03", meta: { call: { status: "completed", duration: 312 } } },
          { messageType: "TYPE_EMAIL", direction: "inbound", body: "<p>Still&nbsp;looking</p>", dateAdded: "2026-09-02" },
          { messageType: "TYPE_SMS", direction: "outbound", body: "Hi!", dateAdded: "2026-09-01" },
        ],
      },
    });
    expect(await readConversationHistory("c1", "loc", "key")).toEqual([
      { direction: "outbound", channel: "sms", body: "Hi!", at: "2026-09-01" },
      { direction: "inbound", channel: "email", body: "Still looking", at: "2026-09-02" },
      { direction: "outbound", channel: "call", body: "(phone call: completed, 312s)", at: "2026-09-03" },
    ]);
  });
});
