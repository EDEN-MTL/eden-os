import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/claude", () => ({
  chat: vi.fn(),
  chatWithTools: vi.fn(),
}));
vi.mock("../shared/slack", () => ({
  sendMessage: vi.fn(),
}));

import { chat, chatWithTools } from "../shared/claude";
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
});

describe("BaseAgent.generateReply — no tools (every existing agent)", () => {
  it("calls plain chat(), never chatWithTools(), and stores plain-string history", async () => {
    vi.mocked(chat).mockResolvedValueOnce("hello back");

    const agent = new PlainAgent();
    const reply = await agent.generateReply("key1", "hi");

    expect(reply).toBe("hello back");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chatWithTools).not.toHaveBeenCalled();

    // Second turn proves history round-trips as plain strings. generateReply
    // mutates the same array it hands to chat() right after chat() resolves
    // (appending the assistant reply for storage) — snapshot at call time
    // via mockImplementation rather than reading mock.calls after the fact,
    // or that in-place push shows up in the "before" snapshot too.
    let secondCallMessages: unknown;
    vi.mocked(chat).mockImplementationOnce(async (_sys, msgs) => {
      secondCallMessages = JSON.parse(JSON.stringify(msgs));
      return "second reply";
    });
    await agent.generateReply("key1", "again");
    expect(secondCallMessages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
      { role: "user", content: "again" },
    ]);
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

  it("never persists raw content-block history — only clean text turns", async () => {
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
