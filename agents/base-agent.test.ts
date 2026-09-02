import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/claude", () => ({
  chat: vi.fn(),
  chatWithTools: vi.fn(),
  // A trivial but faithful stand-in for the real block-builder — just
  // enough shape (type + a data field derived from the input) for tests to
  // assert the right attachment reached chat() without needing the real
  // Anthropic SDK types.
  attachmentToBlock: vi.fn((attachment: { data: Buffer; mediaType: string }) => ({
    type: attachment.mediaType === "application/pdf" ? "document" : "image",
    mediaType: attachment.mediaType,
    data: attachment.data.toString("base64"),
  })),
}));
vi.mock("../shared/slack", () => ({
  sendMessage: vi.fn(),
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

import { chat, chatWithTools } from "../shared/claude";
import { appendHistory, loadHistory } from "../shared/conversation-memory";
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

beforeEach(() => {
  vi.clearAllMocks();
  fakeStore.clear();
});

describe("BaseAgent.generateReply — no tools (every existing agent)", () => {
  it("loads history from the durable store, calls plain chat(), and persists both turns in order", async () => {
    vi.mocked(chat).mockResolvedValueOnce("hello back");

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key1", "hi");

    expect(reply).toBe("hello back");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(loadHistory).toHaveBeenCalledWith("eden", "key1");

    // appendHistory must be called user-then-assistant, not in parallel —
    // both share one auto-increment id that defines conversation order.
    const appendCalls = vi.mocked(appendHistory).mock.calls;
    expect(appendCalls).toEqual([
      ["eden", "key1", "user", "hi"],
      ["eden", "key1", "assistant", "hello back"],
    ]);

    // Second turn proves history genuinely round-trips through the store.
    vi.mocked(chat).mockResolvedValueOnce("second reply");
    await agent.generateReply("key1", "again");
    const secondChatMessages = vi.mocked(chat).mock.calls[1][1];
    expect(secondChatMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
      { role: "user", content: "again" },
    ]);
  });

  it("degrades to no memory this turn if the store is unreachable, rather than failing the reply", async () => {
    vi.mocked(loadHistory).mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    vi.mocked(chat).mockResolvedValueOnce("still answered");

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key-db-down", "hi");

    expect(reply).toBe("still answered");
    const messagesSent = vi.mocked(chat).mock.calls[0][1];
    expect(messagesSent).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends an attachment as a content block for this turn, but persists only a text marker", async () => {
    vi.mocked(chat).mockResolvedValueOnce("nice chart");

    const agent = new PlainAgent();
    const attachment = { data: Buffer.from("fake-image-bytes"), mediaType: "image/png" as const, filename: "spend.png" };
    const reply = await agent.generateReply("key-attach", "what does this show?", undefined, attachment);

    expect(reply).toBe("nice chart");
    const messagesSent = vi.mocked(chat).mock.calls[0][1];
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
    vi.mocked(chat).mockResolvedValueOnce("follow-up reply");
    await agent.generateReply("key-attach", "and now?");
    const secondMessages = vi.mocked(chat).mock.calls[1][1];
    expect(secondMessages[0]).toEqual({ role: "user", content: "what does this show?\n[attached: spend.png]" });
  });
});

describe("BaseAgent.generateReply — tool-capable agent", () => {
  it("returns text directly when the model doesn't call a tool", async () => {
    vi.mocked(chatWithTools).mockResolvedValueOnce({
      content: [textBlock("no tool needed")],
      stop_reason: "end_turn",
    } as any);

    const agent = new ToolAgent();
    const reply = await agent.generateReply("key2", "just chat");

    expect(reply).toBe("no tool needed");
    expect(agent.calls).toHaveLength(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it("executes a requested tool and feeds the result back for a final answer", async () => {
    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({
        content: [toolUseBlock("call_1", "get_thing", { id: "abc" })],
        stop_reason: "tool_use",
      } as any)
      .mockResolvedValueOnce({
        content: [textBlock("here's your answer")],
        stop_reason: "end_turn",
      } as any);

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
      .mockResolvedValueOnce({
        content: [textBlock("looks like something's wrong on their end")],
        stop_reason: "end_turn",
      } as any);

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
      .mockResolvedValueOnce({
        content: [textBlock("final")],
        stop_reason: "end_turn",
      } as any);

    const agent = new ToolAgent();
    await agent.generateReply("key5", "go");

    // A follow-up turn's outgoing history must be plain strings, proving
    // the tool_use/tool_result scratch work from turn 1 was never stored.
    vi.mocked(chatWithTools).mockResolvedValueOnce({
      content: [textBlock("second turn reply")],
      stop_reason: "end_turn",
    } as any);
    await agent.generateReply("key5", "follow up");

    const thirdCallMessages = vi.mocked(chatWithTools).mock.calls[2][1];
    for (const m of thirdCallMessages) {
      expect(typeof m.content).toBe("string");
    }
  });
});
