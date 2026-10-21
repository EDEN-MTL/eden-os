import { afterEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({ getConversations: vi.fn(), getConversationMessages: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);

import { checkHumanTouch } from "./human-touch";

afterEach(() => vi.clearAllMocks());

const NOW = new Date("2026-10-10T15:00:00.000Z");
const sms = (over: Record<string, unknown>) => ({ messageType: "TYPE_SMS", direction: "outbound", status: "delivered", dateAdded: "2026-10-08T15:00:00.000Z", body: "hi", ...over });

function thread(messages: unknown[]) {
  ghl.getConversations.mockResolvedValue({ conversations: [{ id: "conv-1" }] });
  ghl.getConversationMessages.mockResolvedValue({ messages: { messages } });
}

describe("checkHumanTouch", () => {
  it("recognises a text a person typed — it carries their user id", async () => {
    thread([sms({ userId: "user-mark" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "human", at: "2026-10-08T15:00:00.000Z", userId: "user-mark", kind: "text" });
  });

  it("does not count Iris's own texts (sent by API, no user id), the automation's, or the lead's", async () => {
    thread([sms({ source: "app" }), sms({ source: "workflow" }), sms({ direction: "inbound", userId: "user-mark" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("does not count Iris's own text on a contact with an assigned user — GHL stamps that user's id on app-sent texts too", async () => {
    thread([sms({ userId: "user-genna", meta: { marketplace: { appId: "6a8cab7374ed5c428c7013b6" } } })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  /**
   * Angela Marie, 2026-10-13: her contact had an assigned agent, so GHL stamped that agent's
   * user id on the intake automation's text ("you'll receive a call from our AI assistant,
   * IRIS") — and the check read it as the agent having texted her.
   */
  it("does not count an automation text even when GHL stamped the assigned agent's user id on it", async () => {
    thread([sms({ source: "workflow", userId: "user-charlene" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("still counts a person's own text that sits next to automation texts", async () => {
    thread([sms({ source: "workflow", userId: "user-charlene", dateAdded: "2026-10-09T15:00:00.000Z" }), sms({ source: "app", userId: "user-charlene", dateAdded: "2026-10-08T15:00:00.000Z" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "human", at: "2026-10-08T15:00:00.000Z", userId: "user-charlene", kind: "text" });
  });

  it("does not count a human text that never sent — nobody actually reached the lead", async () => {
    thread([sms({ userId: "user-mark", status: "failed" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("does not count a human text older than the window", async () => {
    thread([sms({ userId: "user-mark", dateAdded: "2026-10-01T15:00:00.000Z" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("ignores activity entries, and a call with no user (nothing a teammate did)", async () => {
    thread([sms({ messageType: "TYPE_CALL" }), sms({ messageType: "TYPE_ACTIVITY_OPPORTUNITY", userId: "user-mark" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  /** Sabrina Marie, 2026-10-20: Jacob phoned her (2 seconds, no answer), then texted. A call is talking to the lead. */
  it("counts a teammate's call from GHL, answered or not", async () => {
    thread([sms({ messageType: "TYPE_CALL", userId: "user-jacob", dateAdded: "2026-10-09T18:49:00.000Z", direction: "outbound", meta: { call: { duration: 2 } } })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "human", at: "2026-10-09T18:49:00.000Z", userId: "user-jacob", kind: "call" });
  });

  it("reports whichever came last, the text or the call", async () => {
    thread([
      sms({ userId: "user-jacob", dateAdded: "2026-10-08T10:00:00.000Z" }),
      sms({ messageType: "TYPE_CALL", userId: "user-jacob", dateAdded: "2026-10-09T10:00:00.000Z" }),
    ]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toMatchObject({ kind: "call", at: "2026-10-09T10:00:00.000Z" });
  });

  it("can be told to look at texts only (the follow-up on leads a teammate called and did not reach)", async () => {
    thread([sms({ messageType: "TYPE_CALL", userId: "user-jacob" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW, { includeCalls: false })).toEqual({ status: "none" });
  });

  it("does not count a call older than the window", async () => {
    thread([sms({ messageType: "TYPE_CALL", userId: "user-jacob", dateAdded: "2026-09-01T10:00:00.000Z" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("is 'none' for a lead with no conversation at all", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [] });
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("is 'unknown' — not 'none' — when the thread can't be read, so callers fail closed", async () => {
    ghl.getConversations.mockRejectedValue(new Error("boom"));
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "unknown" });
  });
});
