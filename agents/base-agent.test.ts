import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/claude", () => ({
  chatWithTools: vi.fn(),
  // A trivial but faithful stand-in for the real block-builder — just
  // enough shape (type + a data field derived from the input) for tests to
  // assert the right attachment reached chatWithTools() without needing the
  // real Anthropic SDK types.
  attachmentToBlock: vi.fn((attachment: { data: Buffer; mediaType: string }) => ({
    type: attachment.mediaType === "application/pdf" ? "document" : "image",
    mediaType: attachment.mediaType,
    data: attachment.data.toString("base64"),
  })),
  isAttachmentMediaType: (mediaType: string) =>
    ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"].includes(mediaType),
  MAX_ATTACHMENT_BYTES: 8 * 1024 * 1024,
}));
vi.mock("../shared/slack", () => ({
  sendMessage: vi.fn(),
  getUserRealName: vi.fn(async () => null),
  downloadFile: vi.fn(),
}));

// A tiny fake of the real Postgres-backed store — same shape (load the
// persisted turns, append new ones), so these tests exercise the actual
// contract BaseAgent depends on without touching a real database.
const fakeStore = new Map<string, { role: "user" | "assistant"; content: string }[]>();
vi.mock("../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async (agentId: string, historyKey: string) => fakeStore.get(`${agentId}:${historyKey}`) || []),
  appendHistory: vi.fn(async (agentId: string, historyKey: string, role: "user" | "assistant", content: string) => {
    const key = `${agentId}:${historyKey}`;
    const existing = fakeStore.get(key) || [];
    fakeStore.set(key, [...existing, { role, content }]);
  }),
}));

// Same idea as fakeStore, but agent-scoped only — notes aren't keyed by
// thread, that's the entire point of them.
const fakeNotesStore = new Map<string, string[]>();
vi.mock("../shared/agent-notes", () => ({
  loadNotes: vi.fn(async (agentId: string) => fakeNotesStore.get(agentId) || []),
  saveNote: vi.fn(async (agentId: string, note: string) => {
    const existing = fakeNotesStore.get(agentId) || [];
    fakeNotesStore.set(agentId, [...existing, note]);
  }),
}));

import { chatWithTools } from "../shared/claude";
import { appendHistory, loadHistory } from "../shared/conversation-memory";
import { saveNote } from "../shared/agent-notes";
import { downloadFile, sendMessage } from "../shared/slack";
import { BaseAgent } from "./base-agent";

class PlainAgent extends BaseAgent {
  constructor() {
    super("eden", "Plain", "PLN");
  }
  getSystemPrompt(): string {
    return "plain";
  }
}

class ToolAgent extends BaseAgent {
  public calls: { name: string; input: any }[] = [];
  constructor() {
    super("forge", "Tool", "TL");
  }
  getSystemPrompt(): string {
    return "tools";
  }
  protected getTools() {
    return [{ name: "get_thing", description: "gets a thing", input_schema: { type: "object" as const, properties: {} } }];
  }
  protected async executeTool(name: string, input: any): Promise<string> {
    this.calls.push({ name, input });
    return `result for ${name}`;
  }
}

function textBlock(text: string) {
  return { type: "text" as const, text, citations: null };
}
function toolUseBlock(id: string, name: string, input: any) {
  return { type: "tool_use" as const, id, name, input };
}
function endTurn(text: string) {
  return { content: [textBlock(text)], stop_reason: "end_turn" } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeStore.clear();
  fakeNotesStore.clear();
});

describe("BaseAgent.generateReply — no tools of its own (every existing agent besides Forge)", () => {
  it("tells the model it has durable memory of this thread, plus a save_note capability", async () => {
    // Live symptom this guards against: Forge, asked "can you remember
    // things?", answered from its own generic training (an LLM has no
    // memory) and denied a capability the system actually has. Nothing in
    // any agent's own getSystemPrompt() says otherwise, so the correction
    // has to be appended here, uniformly, rather than per agent.
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("sure do"));

    const agent = new PlainAgent();
    await agent.generateReply("key-memory-aware", "can you remember things?");

    const systemPromptSent = vi.mocked(chatWithTools).mock.calls[0][0];
    expect(systemPromptSent).toContain("plain"); // the agent's own prompt is still present
    expect(systemPromptSent.toLowerCase()).toMatch(/saved durably|reloaded on every message/);
    expect(systemPromptSent.toLowerCase()).toContain("save_note");
  });

  it("loads history from the durable store, calls the model, and persists both turns in order", async () => {
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("hello back"));

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key1", "hi");

    expect(reply).toBe("hello back");
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledWith("eden", "key1");

    // appendHistory must be called user-then-assistant, not in parallel —
    // both share one auto-increment id that defines conversation order.
    const appendCalls = vi.mocked(appendHistory).mock.calls;
    expect(appendCalls).toEqual([
      ["eden", "key1", "user", "hi"],
      ["eden", "key1", "assistant", "hello back"],
    ]);

    // Second turn proves history genuinely round-trips through the store —
    // as plain strings, regardless of the content-block shape a tool-loop
    // turn works with internally.
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("second reply"));
    await agent.generateReply("key1", "again");
    const secondMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    expect(secondMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
      { role: "user", content: "again" },
    ]);
  });

  it("degrades to no memory this turn if the store is unreachable, rather than failing the reply", async () => {
    vi.mocked(loadHistory).mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("still answered"));

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key-db-down", "hi");

    expect(reply).toBe("still answered");
    const messagesSent = vi.mocked(chatWithTools).mock.calls[0][1];
    expect(messagesSent).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends an attachment as a content block for this turn, but persists only a text marker", async () => {
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("nice chart"));

    const agent = new PlainAgent();
    const attachment = { data: Buffer.from("fake-image-bytes"), mediaType: "image/png" as const, filename: "spend.png" };
    const reply = await agent.generateReply("key-attach", "what does this show?", undefined, attachment);

    expect(reply).toBe("nice chart");
    const messagesSent = vi.mocked(chatWithTools).mock.calls[0][1];
    expect(messagesSent).toEqual([
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", data: Buffer.from("fake-image-bytes").toString("base64") },
          { type: "text", text: "what does this show?" },
        ],
      },
    ]);

    // The durable store gets a marker, never the file bytes — an attachment
    // is scratch input for this turn, not something worth replaying (and
    // paying tokens for) on every future turn.
    expect(vi.mocked(appendHistory).mock.calls).toEqual([
      ["eden", "key-attach", "user", "what does this show?\n[attached: spend.png]"],
      ["eden", "key-attach", "assistant", "nice chart"],
    ]);

    // A later turn in the same thread only ever sees that plain-text marker.
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("follow-up reply"));
    await agent.generateReply("key-attach", "and now?");
    const secondMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    expect(secondMessages[0]).toEqual({ role: "user", content: "what does this show?\n[attached: spend.png]" });
  });
});

describe("BaseAgent.generateReply — tool-capable agent", () => {
  it("returns text directly when the model doesn't call a tool", async () => {
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("no tool needed"));

    const agent = new ToolAgent();
    const reply = await agent.generateReply("key2", "just chat");

    expect(reply).toBe("no tool needed");
    expect(agent.calls).toHaveLength(0);
  });

  it("executes a requested tool and feeds the result back for a final answer", async () => {
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "get_thing", { id: "abc" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("here's your answer"));

    const agent = new ToolAgent();
    const reply = await agent.generateReply("key3", "get me the thing");

    expect(reply).toBe("here's your answer");
    expect(agent.calls).toEqual([{ name: "get_thing", input: { id: "abc" } }]);

    // The second chatWithTools call must carry the tool_result keyed to the
    // exact tool_use id, or Anthropic's API rejects the request outright.
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResultMessage).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "result for get_thing" }],
    });

    // And only the clean final text — not the tool_use/tool_result scratch
    // work — gets persisted to the durable store.
    expect(vi.mocked(appendHistory).mock.calls).toEqual([
      ["forge", "key3", "user", "get me the thing"],
      ["forge", "key3", "assistant", "here's your answer"],
    ]);
  });

  it("turns a thrown tool error into a tool_result the model can react to, not a crash", async () => {
    class FailingAgent extends ToolAgent {
      protected async executeTool(): Promise<string> {
        throw new Error("Meta API is down");
      }
    }

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_2", "get_thing", {})],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("looks like something's wrong on their end"));

    const agent = new FailingAgent();
    const reply = await agent.generateReply("key4", "get me the thing");

    expect(reply).toBe("looks like something's wrong on their end");
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1] as any;
    expect(toolResultMessage.content[0].content).toContain("Meta API is down");
  });

  it("never persists raw content-block history — only clean text turns — across multiple turns", async () => {
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_3", "get_thing", {})],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("final"));

    const agent = new ToolAgent();
    await agent.generateReply("key5", "go");

    // A follow-up turn's outgoing history must be plain strings, proving
    // the tool_use/tool_result scratch work from turn 1 was never stored.
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("second turn reply"));
    await agent.generateReply("key5", "follow up");

    const thirdCallMessages = vi.mocked(chatWithTools).mock.calls[2][1];
    for (const m of thirdCallMessages) {
      expect(typeof m.content).toBe("string");
    }
  });
});

describe("BaseAgent.generateReply — save_note (every agent, tool-capable or not)", () => {
  it("lets even a toolless agent save a note via the tool every agent gets for free", async () => {
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_note", "save_note", { note: "Prefers metric units" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce(endTurn("Got it, noted."));

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key-note", "remember I prefer metric units going forward");

    expect(reply).toBe("Got it, noted.");
    expect(saveNote).toHaveBeenCalledWith("eden", "Prefers metric units");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1];
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1] as any;
    expect(toolResultMessage.content[0].tool_use_id).toBe("call_note");
    expect(toolResultMessage.content[0].content).toMatch(/noted/i);
  });

  it("surfaces previously saved notes in the system prompt of a totally different, later conversation", async () => {
    // This is the entire point of a note vs. conversation history: it has
    // to show up in a thread that never saw it get saved.
    fakeNotesStore.set("eden", ["Prefers metric units"]);
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("Sure — 5km, got it."));

    const agent = new PlainAgent();
    await agent.generateReply("a-totally-different-thread", "how far is that");

    const systemPromptSent = vi.mocked(chatWithTools).mock.calls[0][0];
    expect(systemPromptSent).toContain("Prefers metric units");
  });

  it("degrades to no notes this turn if the store is unreachable, rather than failing the reply", async () => {
    const { loadNotes } = await import("../shared/agent-notes");
    vi.mocked(loadNotes).mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    vi.mocked(chatWithTools).mockResolvedValueOnce(endTurn("still answered"));

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key-notes-down", "hi");

    expect(reply).toBe("still answered");
  });
});

describe("BaseAgent.handleMessage — Slack attachment resolution", () => {
  function slackMessage(overrides: Partial<any> = {}) {
    return {
      agentId: "eden",
      userId: "U123",
      channelId: "C123",
      text: "hello",
      isDM: true,
      timestamp: "1234.5678",
      ...overrides,
    };
  }

  it("passes no attachment when the message has no file", async () => {
    const agent = new PlainAgent();
    const spy = vi.spyOn(agent, "generateReply").mockResolvedValueOnce("ok");

    await agent.handleMessage(slackMessage());

    expect(spy).toHaveBeenCalledWith(expect.any(String), "hello", { senderName: null }, undefined);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("downloads an attached file using the agent's own bot token and passes it through as an Attachment", async () => {
    vi.mocked(downloadFile).mockResolvedValueOnce(Buffer.from("fake-png-bytes"));
    const agent = new PlainAgent();
    const spy = vi.spyOn(agent, "generateReply").mockResolvedValueOnce("ok");

    await agent.handleMessage(slackMessage({ file: { url: "https://files.slack.com/x", mimetype: "image/png", name: "ad.png" } }));

    expect(downloadFile).toHaveBeenCalledWith("eden", "https://files.slack.com/x");
    expect(spy).toHaveBeenCalledWith(expect.any(String), "hello", { senderName: null }, {
      data: Buffer.from("fake-png-bytes"),
      mediaType: "image/png",
      filename: "ad.png",
    });
  });

  it("skips an unsupported file type without even attempting a download", async () => {
    const agent = new PlainAgent();
    const spy = vi.spyOn(agent, "generateReply").mockResolvedValueOnce("ok");

    await agent.handleMessage(slackMessage({ file: { url: "https://files.slack.com/x", mimetype: "video/mp4", name: "clip.mp4" } }));

    expect(downloadFile).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.any(String), "hello", { senderName: null }, undefined);
  });

  it("degrades to no attachment, without failing the reply, when the download throws", async () => {
    // Real-world trigger: a transient Slack API error, an expired file url,
    // or a scope issue — none of these should turn "couldn't fetch the
    // image" into a dead conversation.
    vi.mocked(downloadFile).mockRejectedValueOnce(new Error("network error"));
    const agent = new PlainAgent();
    const spy = vi.spyOn(agent, "generateReply").mockResolvedValueOnce("still answered");

    await agent.handleMessage(slackMessage({ file: { url: "https://files.slack.com/x", mimetype: "image/png", name: "ad.png" } }));

    expect(spy).toHaveBeenCalledWith(expect.any(String), "hello", { senderName: null }, undefined);
    expect(sendMessage).toHaveBeenCalled();
  });
});
