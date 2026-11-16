import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBotUserIdMock, irisHandle, forgeHandle } = vi.hoisted(() => ({
  getBotUserIdMock: vi.fn(),
  irisHandle: vi.fn(),
  forgeHandle: vi.fn(),
}));

vi.mock("../shared/slack", () => ({ getSigningSecret: vi.fn(), getBotUserId: getBotUserIdMock }));
vi.mock("../agents/eden-brain", () => ({ edenBrain: {} }));
vi.mock("../agents/scout", () => ({ scoutAgent: {} }));
vi.mock("../agents/iris", () => ({ irisAgent: { handleMessage: irisHandle } }));
vi.mock("../agents/atlas", () => ({ atlasAgent: {} }));
vi.mock("../agents/ember", () => ({ emberAgent: {} }));
vi.mock("../agents/muse", () => ({ museAgent: {} }));
vi.mock("../agents/forge", () => ({ forgeAgent: { handleMessage: forgeHandle } }));
vi.mock("../agents/lens", () => ({ lensAgent: {} }));
vi.mock("../agents/nova", () => ({ novaAgent: {} }));

import {
  createAgentHandler,
  extractFileFromEvent,
  isSlackRetryDelivery,
  mentionsUser,
  stripMention,
  verifySlackSignature,
} from "./slack-events";

const SECRET = "test-signing-secret";

function fakeRequest(overrides: { timestamp?: string; signature?: string; rawBody?: Buffer }) {
  return {
    headers: {
      "x-slack-request-timestamp": overrides.timestamp,
      "x-slack-signature": overrides.signature,
    },
    rawBody: overrides.rawBody,
    body: {},
  } as any;
}

function realSignature(timestamp: string, rawBody: Buffer, secret = SECRET) {
  const sigBaseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  return "v0=" + crypto.createHmac("sha256", secret).update(sigBaseString).digest("hex");
}

describe("verifySlackSignature", () => {
  it("returns true for a correctly computed signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = realSignature(timestamp, rawBody);

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature, rawBody }))).toBe(true);
  });

  it("returns false, rather than throwing, when the signature header is a different length than expected", () => {
    // Real bug this guards against: crypto.timingSafeEqual throws a
    // RangeError on a byte-length mismatch instead of returning false.
    // x-slack-signature is fully attacker-controlled and needs no secret
    // to send an arbitrary short value — inside an async Express handler
    // that throw became an unhandled promise rejection, which crashes the
    // whole process on this Node version (no global handler catches it).
    // A pre-auth denial-of-service against every agent's webhook route.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));

    expect(() =>
      verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: "short", rawBody }))
    ).not.toThrow();
    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: "short", rawBody }))).toBe(false);
  });

  it("returns false for a same-length but incorrect signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const wrongSignature = realSignature(timestamp, rawBody, "a-completely-different-secret");

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp, signature: wrongSignature, rawBody }))).toBe(false);
  });

  it("returns false when the timestamp or signature header is missing", () => {
    expect(verifySlackSignature(SECRET, fakeRequest({ signature: "v0=abc" }))).toBe(false);
    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp: String(Math.floor(Date.now() / 1000)) }))).toBe(
      false
    );
  });

  it("returns false for a timestamp older than 5 minutes (replay protection)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = realSignature(staleTimestamp, rawBody);

    expect(verifySlackSignature(SECRET, fakeRequest({ timestamp: staleTimestamp, signature, rawBody }))).toBe(false);
  });
});

describe("isSlackRetryDelivery", () => {
  // Regression guard: confirmed live 2026-09-06, one Slack message produced
  // two identical acknowledgments and two full Quarry discovery runs — the
  // handler had no way to tell a retried delivery from a fresh one.
  it("is true when Slack sends a retry-num header", () => {
    expect(isSlackRetryDelivery({ headers: { "x-slack-retry-num": "1" } } as any)).toBe(true);
  });

  it("is false for a fresh delivery with no retry header", () => {
    expect(isSlackRetryDelivery({ headers: {} } as any)).toBe(false);
  });
});

describe("extractFileFromEvent", () => {
  it("returns undefined when the event has no files", () => {
    expect(extractFileFromEvent({ text: "hi" })).toBeUndefined();
  });

  it("returns undefined for an empty files array", () => {
    expect(extractFileFromEvent({ files: [] })).toBeUndefined();
  });

  it("prefers url_private_download over url_private when both are present", () => {
    const file = extractFileFromEvent({
      files: [{ url_private_download: "https://files.slack.com/download", url_private: "https://files.slack.com/view", mimetype: "image/png", name: "ad.png" }],
    });

    expect(file).toEqual({ url: "https://files.slack.com/download", mimetype: "image/png", name: "ad.png" });
  });

  it("falls back to url_private when url_private_download is absent", () => {
    const file = extractFileFromEvent({
      files: [{ url_private: "https://files.slack.com/view", mimetype: "image/jpeg", name: "ad.jpg" }],
    });

    expect(file?.url).toBe("https://files.slack.com/view");
  });

  it("only ever uses the first file — same one-attachment-per-turn contract as the dashboard", () => {
    const file = extractFileFromEvent({
      files: [
        { url_private: "https://files.slack.com/first", mimetype: "image/png", name: "first.png" },
        { url_private: "https://files.slack.com/second", mimetype: "image/png", name: "second.png" },
      ],
    });

    expect(file?.name).toBe("first.png");
  });
});

describe("mentionsUser / stripMention", () => {
  it("recognises a Slack user mention, plain or with the legacy |name suffix", () => {
    expect(mentionsUser("<@UIRIS> call John", "UIRIS")).toBe(true);
    expect(mentionsUser("hey <@UIRIS|iris> call John", "UIRIS")).toBe(true);
  });

  it("does not treat a different user, a plain word, or a longer id as a mention", () => {
    expect(mentionsUser("<@UMARK> call John", "UIRIS")).toBe(false);
    expect(mentionsUser("iris call John", "UIRIS")).toBe(false);
    expect(mentionsUser("<@UIRIS2> call John", "UIRIS")).toBe(false);
    expect(mentionsUser("UIRIS", "UIRIS")).toBe(false);
  });

  it("removes only her own tag and the punctuation Slack leaves behind it", () => {
    expect(stripMention("<@UIRIS> yes", "UIRIS")).toBe("yes");
    expect(stripMention("<@UIRIS>, call Koren Pye", "UIRIS")).toBe("call Koren Pye");
    expect(stripMention("call Koren Pye <@UIRIS>", "UIRIS")).toBe("call Koren Pye");
    expect(stripMention("<@UIRIS> ask <@UMARK> to look", "UIRIS")).toBe("ask <@UMARK> to look");
  });
});

/**
 * Mark, 2026-11-17: Iris answered every message anyone typed in the call-log
 * channel — team chatter about a call included. In a channel she now answers
 * only when tagged. DMs are unchanged, and so is every other agent.
 */
describe("createAgentHandler: Iris in channels only answers when tagged", () => {
  const BOT = "UIRIS";

  beforeEach(() => {
    vi.clearAllMocks();
    getBotUserIdMock.mockResolvedValue(BOT);
  });

  async function deliver(agentId: "iris" | "forge", event: Record<string, unknown>) {
    const req = { body: { type: "event_callback", event: { type: "message", user: "UMARK", ts: "1.1", ...event } }, headers: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() } as any;
    await createAgentHandler(agentId)(req, res);
  }

  it("ignores an untagged message in a channel", async () => {
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "that last call went well" });
    expect(irisHandle).not.toHaveBeenCalled();
  });

  it("ignores an untagged message in a private channel, a group DM, and a thread under her own post", async () => {
    await deliver("iris", { channel: "G_LOGS", channel_type: "group", text: "nice" });
    await deliver("iris", { channel: "G_MPDM", channel_type: "mpim", text: "nice" });
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "agreed", thread_ts: "9.9" });
    expect(irisHandle).not.toHaveBeenCalled();
  });

  it("answers when she is tagged, and hands her the text without her own tag", async () => {
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UIRIS> how many calls today?" });
    expect(irisHandle).toHaveBeenCalledTimes(1);
    expect(irisHandle.mock.calls[0][0]).toMatchObject({ text: "how many calls today?", isDM: false, channelId: "C_LOGS" });
  });

  // Her "reply yes to confirm" check matches the WHOLE message (isYes in
  // slack-commands.ts); a raw "<@UIRIS> yes" would no longer match and a pending
  // call to a real lead would quietly never be confirmed.
  it("strips her tag so a tagged yes or no still reads as a bare yes or no", async () => {
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UIRIS> yes" });
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UIRIS> no" });
    expect(irisHandle.mock.calls.map((c) => c[0].text)).toEqual(["yes", "no"]);
  });

  it("still answers a message that is only her tag, instead of handing the model an empty message", async () => {
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UIRIS>" });
    expect(irisHandle).toHaveBeenCalledTimes(1);
    expect(irisHandle.mock.calls[0][0].text).not.toBe("");
  });

  it("ignores a message that tags someone else", async () => {
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UJACOB> did you see this?" });
    expect(irisHandle).not.toHaveBeenCalled();
  });

  it("still answers every DM, tagged or not", async () => {
    await deliver("iris", { channel: "D_MARK", channel_type: "im", text: "how many calls today?" });
    expect(irisHandle).toHaveBeenCalledTimes(1);
    expect(irisHandle.mock.calls[0][0]).toMatchObject({ text: "how many calls today?", isDM: true });
  });

  it("stays quiet rather than answering everything when her own Slack id can't be looked up", async () => {
    getBotUserIdMock.mockResolvedValue(null);
    await deliver("iris", { channel: "C_LOGS", channel_type: "channel", text: "<@UIRIS> hello" });
    expect(irisHandle).not.toHaveBeenCalled();
  });

  it("leaves every other agent alone: an untagged channel message still reaches Forge", async () => {
    await deliver("forge", { channel: "C_ADS", channel_type: "channel", text: "how are the ads doing?" });
    expect(forgeHandle).toHaveBeenCalledTimes(1);
    expect(forgeHandle.mock.calls[0][0].text).toBe("how are the ads doing?");
    expect(getBotUserIdMock).not.toHaveBeenCalled();
  });
});
