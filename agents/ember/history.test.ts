import { describe, expect, it, vi } from "vitest";
vi.mock("../../shared/claude", () => ({ ask: vi.fn() }));
vi.mock("../../shared/ghl", () => ({ getConversations: vi.fn(), getConversationMessages: vi.fn() }));

import { getConversationMessages, getConversations } from "../../shared/ghl";
import { findOptOut, HistoryMessage, readConversationHistory, reviewHistory } from "./history";

const inb = (body: string): HistoryMessage => ({ direction: "inbound", channel: "sms", body, at: "2026-06-01T00:00:00Z" });
const outb = (body: string): HistoryMessage => ({ direction: "outbound", channel: "sms", body, at: "2026-05-31T00:00:00Z" });
const CTX = { firstName: "Sarah", brandName: "Mark's Realty", intent: "buyer", stopLine: "Reply STOP to opt out.", now: new Date("2026-09-24") };

describe("findOptOut", () => {
  it.each(["STOP", "stop.", "Please stop texting me", "don't contact me again", "remove me from your list", "wrong number", "Not interested, thanks", "leave me alone"])(
    "catches %j",
    (body) => expect(findOptOut([inb(body)])).toBe(body)
  );
  it.each(["yes still looking", "can you stop by the house saturday?", "we're not in a rush"])("lets %j through", (body) => {
    expect(findOptOut([inb(body)])).toBeNull();
  });
  it("ignores our own outbound texts", () => {
    expect(findOptOut([outb("Reply STOP to opt out.")])).toBeNull();
  });
});

describe("reviewHistory", () => {
  it("skips an opt-out without calling the model", async () => {
    const ask = vi.fn();
    expect(await reviewHistory([inb("stop")], CTX, ask)).toEqual(expect.objectContaining({ action: "skip", optOut: true }));
    expect(ask).not.toHaveBeenCalled();
  });

  it("uses the standard script when they never replied, without calling the model", async () => {
    const ask = vi.fn();
    expect(await reviewHistory([outb("Hi, thanks for reaching out!")], CTX, ask)).toEqual({ action: "script", reason: "no replies in their history" });
    expect(ask).not.toHaveBeenCalled();
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

  it("honours the model's skip", async () => {
    const ask = vi.fn(async () => '{"action":"skip","reason":"bought through a friend"}');
    expect(await reviewHistory([inb("we bought through a friend last month")], CTX, ask)).toEqual({ action: "skip", reason: "bought through a friend", optOut: false });
  });

  it("retries — never sends — on a model failure or unreadable answer", async () => {
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => { throw new Error("no key"); }))).action).toBe("retry");
    expect((await reviewHistory([inb("hi")], CTX, vi.fn(async () => "sure, sounds good"))).action).toBe("retry");
  });
});

describe("readConversationHistory", () => {
  it("keeps only texts/emails, strips HTML, and returns oldest first", async () => {
    vi.mocked(getConversations).mockResolvedValue({ conversations: [{ id: "cv1" }] });
    vi.mocked(getConversationMessages).mockResolvedValue({
      messages: {
        messages: [
          { messageType: "TYPE_ACTIVITY_OPPORTUNITY", direction: "outbound", body: "Opportunity updated", dateAdded: "2026-09-03" },
          { messageType: "TYPE_EMAIL", direction: "inbound", body: "<p>Still&nbsp;looking</p>", dateAdded: "2026-09-02" },
          { messageType: "TYPE_SMS", direction: "outbound", body: "Hi!", dateAdded: "2026-09-01" },
        ],
      },
    });
    const h = await readConversationHistory("c1", "loc", "key");
    expect(h).toEqual([
      { direction: "outbound", channel: "sms", body: "Hi!", at: "2026-09-01" },
      { direction: "inbound", channel: "email", body: "Still looking", at: "2026-09-02" },
    ]);
    expect(getConversationMessages).toHaveBeenCalledWith("cv1", "loc", "key", 50);
  });
});
