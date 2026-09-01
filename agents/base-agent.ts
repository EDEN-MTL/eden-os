import { chat, chatWithTools, ChatMessage, ToolDef } from "../shared/claude";
import { sendMessage } from "../shared/slack";
import { AgentId, SlackIncomingMessage } from "../shared/types";

const MAX_TOOL_TURNS = 6;

/**
 * Base class for all EDEN agents.
 * Each agent extends this with their own system prompt and custom handlers.
 */
export abstract class BaseAgent {
  readonly id: AgentId;
  readonly name: string;
  readonly code: string;
  protected conversationHistory: Map<string, ChatMessage[]> = new Map();

  constructor(id: AgentId, name: string, code: string) {
    this.id = id;
    this.name = name;
    this.code = code;
  }

  /**
   * Each agent defines its own system prompt.
   * Can be dynamic — pull in client data, recent metrics, etc.
   */
  abstract getSystemPrompt(context?: Record<string, any>): string;

  /**
   * Optional: agents can override this to handle messages with custom logic
   * before falling through to the default Claude chat response.
   * Return a string to respond directly, or null to use Claude.
   */
  protected async handleCustom(
    message: SlackIncomingMessage
  ): Promise<string | null> {
    return null;
  }

  /**
   * Override to give an agent real tool access (Forge does; nothing else
   * does yet). Returning [] — the default — keeps generateReply on the
   * exact plain-text path every other agent already relies on.
   */
  protected getTools(): ToolDef[] {
    return [];
  }

  /** Override alongside getTools() to actually run a tool call. */
  protected async executeTool(_name: string, _input: any): Promise<string> {
    throw new Error(`${this.code} has no tools configured`);
  }

  /**
   * Main message handler — called when this agent receives a Slack message.
   */
  async handleMessage(message: SlackIncomingMessage): Promise<void> {
    console.log(
      `[${this.code}] Message from ${message.userId}: ${message.text.slice(0, 80)}`
    );

    // Check for custom handling first
    const customResponse = await this.handleCustom(message);
    if (customResponse) {
      await this.respond(message, customResponse);
      return;
    }

    // Build conversation history key (per user + channel/DM)
    const historyKey = message.isDM
      ? `dm:${message.userId}`
      : `channel:${message.channelId}:${message.threadTs || "main"}`;

    try {
      const response = await this.generateReply(historyKey, message.text);
      await this.respond(message, response);
    } catch (error) {
      console.error(`[${this.code}] Error generating response:`, error);
      await this.respond(
        message,
        "Systems experiencing interference. Retrying..."
      );
    }
  }

  /**
   * Generate a reply for arbitrary callers (Slack, the dashboard's chat API, etc.)
   * — same history + Claude call as handleMessage, minus the Slack-specific bits.
   */
  async generateReply(historyKey: string, userText: string): Promise<string> {
    const history = this.conversationHistory.get(historyKey) || [];
    const systemPrompt = this.getSystemPrompt();
    const tools = this.getTools();

    if (tools.length === 0) {
      const trimmedHistory = [...history, { role: "user" as const, content: userText }].slice(-20);
      const response = await chat(systemPrompt, trimmedHistory);
      trimmedHistory.push({ role: "assistant", content: response });
      this.conversationHistory.set(historyKey, trimmedHistory);
      return response;
    }

    return this.runToolLoop(historyKey, history, systemPrompt, tools, userText);
  }

  /**
   * Tool-use loop for agents that define getTools()/executeTool().
   *
   * The persisted conversationHistory stays plain text — same shape every
   * other agent uses — on purpose. The tool_use/tool_result exchange this
   * turn generates is scratch space for THIS call only and is never
   * trimmed or stored: Anthropic's API requires every tool_use block to be
   * immediately followed by its tool_result, and a later `.slice(-20)` on
   * stored history has no way to know not to cut between the two. Storing
   * only the clean final text side-steps that failure mode entirely, at
   * the cost of the model not literally re-reading old raw tool output —
   * its own final answer each turn (which IS stored) already carries the
   * substance of what it found.
   */
  private async runToolLoop(
    historyKey: string,
    priorHistory: ChatMessage[],
    systemPrompt: string,
    tools: ToolDef[],
    userText: string
  ): Promise<string> {
    let working: ChatMessage[] = [...priorHistory.slice(-20), { role: "user", content: userText }];
    let finalText = "";

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const response = await chatWithTools(systemPrompt, working, tools);
      working = [...working, { role: "assistant", content: response.content }];

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      finalText = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          const call = tu as { id: string; name: string; input: any };
          let content: string;
          try {
            content = await this.executeTool(call.name, call.input);
          } catch (error) {
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          return { type: "tool_result" as const, tool_use_id: call.id, content };
        })
      );
      working = [...working, { role: "user", content: toolResults }];
    }

    const finalReply = finalText || "No response generated.";
    const cleaned = [
      ...priorHistory.slice(-20),
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: finalReply },
    ];
    this.conversationHistory.set(historyKey, cleaned.slice(-20));
    return finalReply;
  }

  /**
   * Send a response back to the same channel/DM, in-thread if applicable.
   */
  protected async respond(
    original: SlackIncomingMessage,
    text: string
  ): Promise<void> {
    await sendMessage(this.id, {
      channel: original.channelId,
      text,
      threadTs: original.threadTs,
    });
  }

  /**
   * Proactively post a message to a channel (not in response to a message).
   * Used for alerts, reports, status updates.
   */
  async post(channel: string, text: string): Promise<void> {
    await sendMessage(this.id, { channel, text });
  }
}
