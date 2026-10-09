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
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "human", at: "2026-10-08T15:00:00.000Z", userId: "user-mark" });
  });

  it("does not count Iris's own texts (sent by API, no user id), the automation's, or the lead's", async () => {
    thread([sms({ source: "app" }), sms({ source: "workflow" }), sms({ direction: "inbound", userId: "user-mark" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("does not count Iris's own text on a contact with an assigned user — GHL stamps that user's id on app-sent texts too", async () => {
    thread([sms({ userId: "user-genna", meta: { marketplace: { appId: "6a8cab7374ed5c428c7013b6" } } })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("does not count a human text that never sent — nobody actually reached the lead", async () => {
    thread([sms({ userId: "user-mark", status: "failed" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("does not count a human text older than the window", async () => {
    thread([sms({ userId: "user-mark", dateAdded: "2026-10-01T15:00:00.000Z" })]);
    expect(await checkHumanTouch("c", "loc", "key", 7, NOW)).toEqual({ status: "none" });
  });

  it("ignores calls and other activity entries", async () => {
    thread([sms({ messageType: "TYPE_CALL", userId: "user-mark" }), sms({ messageType: "TYPE_ACTIVITY_OPPORTUNITY", userId: "user-mark" })]);
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
