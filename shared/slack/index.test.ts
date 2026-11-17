import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessageMock = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: postMessageMock };
  },
}));

const memory = vi.hoisted(() => ({ appendHistory: vi.fn(async () => {}) }));
vi.mock("../conversation-memory", () => memory);

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

/**
 * Mark, 2026-11-18 (Daniel Eiriz): Iris posted a lead's name in a thread, Mark replied there, and she asked "could you
 * give me the lead's name?" because only some call sites remembered their own posts. sendMessage does it for all.
 */
describe("sendMessage remembers what was posted, for replies", () => {
  it("a top-level post is added to its thread's history under the real channel id and its own ts", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1234.5678", channel: "C0REAL" });

    await sendMessage("forge", { channel: "iris-call-logs", text: "📞 Daniel Eiriz was qualified" });

    expect(memory.appendHistory).toHaveBeenCalledWith("forge", "channel:C0REAL:1234.5678", "assistant", "📞 Daniel Eiriz was qualified");
  });

  it("a reply inside a thread goes into the ROOT's history, so the thread reads as one conversation", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1234.9999", channel: "C0REAL" });

    await sendMessage("forge", { channel: "C0REAL", text: "🔎 Reviewed", threadTs: "1234.5678" });

    expect(memory.appendHistory).toHaveBeenCalledWith("forge", "channel:C0REAL:1234.5678", "assistant", "🔎 Reviewed");
  });

  it("a DM goes into that person's DM history", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1.2", channel: "D0DM" });

    await sendMessage("forge", { channel: "U07H26WUGP5", text: "Call alert" });

    expect(memory.appendHistory).toHaveBeenCalledWith("forge", "dm:U07H26WUGP5", "assistant", "Call alert");
  });

  it("does nothing when Slack gives back no ts or channel, and never fails the post when remembering fails", async () => {
    postMessageMock.mockResolvedValueOnce({ ok: true });
    await sendMessage("forge", { channel: "C0REAL", text: "x" });
    expect(memory.appendHistory).not.toHaveBeenCalled();

    postMessageMock.mockResolvedValueOnce({ ok: true, ts: "1.2", channel: "C0REAL" });
    memory.appendHistory.mockRejectedValueOnce(new Error("DB down"));
    await expect(sendMessage("forge", { channel: "C0REAL", text: "y" })).resolves.toEqual({ ts: "1.2", channel: "C0REAL" });
  });
});
