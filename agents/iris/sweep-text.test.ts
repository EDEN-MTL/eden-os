import { afterEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({ getConversations: vi.fn(), getConversationMessages: vi.fn() }));
vi.mock("../../shared/ghl", () => ghl);

import { buildSweepMissedCallText } from "../../webhooks/vapi-webhook";
import { isSweepMissedCallText, recentSweepText } from "./sweep-text";

const NOW = new Date("2026-11-16T14:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const thread = (...messages: any[]) => {
  ghl.getConversations.mockResolvedValue({ conversations: [{ id: "conv-1" }] });
  ghl.getConversationMessages.mockResolvedValue({ messages: { messages } });
};
const sweepText = (over: any = {}) => ({ direction: "outbound", messageType: "TYPE_SMS", status: "delivered", dateAdded: daysAgo(2), body: buildSweepMissedCallText("Magar Bhuma", "3 Percent East Coast", "buyer"), ...over });

afterEach(() => vi.clearAllMocks());

describe("isSweepMissedCallText", () => {
  it("matches what buildSweepMissedCallText sends, for a buyer and a seller", () => {
    expect(isSweepMissedCallText(buildSweepMissedCallText("Magar Bhuma", "3 Percent East Coast", "buyer"))).toBe(true);
    expect(isSweepMissedCallText(buildSweepMissedCallText("Ann Lee", "3 Percent East Coast", "seller"))).toBe(true);
  });

  it("does not match the intake text, the cadence's missed-call text, or a lead's own message", () => {
    expect(isSweepMissedCallText("Hey Magar! Saw you submitted a form for the list of new houses in St Johns.")).toBe(false);
    expect(isSweepMissedCallText("Hi Magar, it's Iris from 3 Percent East Coast. I just tried to call you but missed you. What time works best for me to try again?")).toBe(false);
    expect(isSweepMissedCallText(undefined)).toBe(false);
  });
});

describe("recentSweepText", () => {
  it("is none for Magar: his thread holds only the Nov 5 intake and cadence texts", async () => {
    thread({ direction: "outbound", status: "delivered", dateAdded: "2026-11-05T21:37:59.039Z", body: "Hi Magar, it's Iris from 3 Percent East Coast. Sorry our calls got cut off on my end!" });
    expect((await recentSweepText("m", "loc", "key", 7, NOW)).status).toBe("none");
  });

  it("is sent when a sweep text went out inside the window, and says when", async () => {
    thread(sweepText());
    expect(await recentSweepText("m", "loc", "key", 7, NOW)).toEqual({ status: "sent", at: daysAgo(2) });
  });

  it("is none once the last sweep text is older than the window", async () => {
    thread(sweepText({ dateAdded: daysAgo(9) }));
    expect((await recentSweepText("m", "loc", "key", 7, NOW)).status).toBe("none");
  });

  it("does not count a sweep text that failed to send, or one the lead wrote", async () => {
    thread(sweepText({ status: "failed" }), sweepText({ direction: "inbound" }));
    expect((await recentSweepText("m", "loc", "key", 7, NOW)).status).toBe("none");
  });

  it("is none when the lead has no conversation yet", async () => {
    ghl.getConversations.mockResolvedValue({ conversations: [] });
    expect((await recentSweepText("m", "loc", "key", 7, NOW)).status).toBe("none");
  });

  it("is unknown when the thread can't be read", async () => {
    ghl.getConversations.mockRejectedValue(new Error("GHL 500"));
    expect((await recentSweepText("m", "loc", "key", 7, NOW)).status).toBe("unknown");
  });
});
