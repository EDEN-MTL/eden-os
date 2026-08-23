import { chat, ChatMessage } from "../shared/claude";
import { sendMessage } from "../shared/slack";
import { AgentId, SlackIncomingMessage } from "../shared/types";

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

    history.push({ role: "user", content: userText });
    const trimmedHistory = history.slice(-20);

    const systemPrompt = this.getSystemPrompt();
    const response = await chat(systemPrompt, trimmedHistory);

    trimmedHistory.push({ role: "assistant", content: response });
    this.conversationHistory.set(historyKey, trimmedHistory);

    return response;
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
