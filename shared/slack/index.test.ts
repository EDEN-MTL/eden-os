import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessageMock = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: postMessageMock };
  },
}));

import { initSlackClients, sendMessage } from "./index";

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
