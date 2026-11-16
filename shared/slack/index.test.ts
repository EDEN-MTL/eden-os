import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessageMock = vi.fn();
const authTestMock = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: postMessageMock };
    auth = { test: authTestMock };
  },
}));

import { getBotUserId, initSlackClients, sendMessage } from "./index";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FORGE_BOT_TOKEN = "xoxb-test-token";
  initSlackClients();
});

describe("sendMessage", () => {
  it("returns the posted message's ts so callers can reference it later", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1234.5678" });

    const result = await sendMessage("forge", { channel: "C_OPS", text: "hello" });

    expect(result).toEqual({ ts: "1234.5678" });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C_OPS", text: "hello" })
    );
  });
});

describe("getBotUserId", () => {
  // The id is cached per agent for the life of the process, so each case uses
  // its own agent rather than depending on test order.
  it("returns the bot's own Slack user id, and only asks Slack once", async () => {
    authTestMock.mockResolvedValue({ ok: true, user_id: "UFORGEBOT" });

    expect(await getBotUserId("forge")).toBe("UFORGEBOT");
    expect(await getBotUserId("forge")).toBe("UFORGEBOT");
    expect(authTestMock).toHaveBeenCalledTimes(1);
  });

  it("returns null instead of throwing when Slack can't be reached, and asks again next time", async () => {
    process.env.LENS_BOT_TOKEN = "xoxb-lens-token";
    initSlackClients();
    authTestMock.mockRejectedValueOnce(new Error("slack is down"));

    expect(await getBotUserId("lens")).toBeNull();

    // A failed lookup must not be remembered as "no id" forever.
    authTestMock.mockResolvedValueOnce({ ok: true, user_id: "ULENSBOT" });
    expect(await getBotUserId("lens")).toBe("ULENSBOT");
  });

  it("returns null when Slack answers without a user id", async () => {
    process.env.NOVA_BOT_TOKEN = "xoxb-nova-token";
    initSlackClients();
    authTestMock.mockResolvedValueOnce({ ok: true });

    expect(await getBotUserId("nova")).toBeNull();
  });
});
