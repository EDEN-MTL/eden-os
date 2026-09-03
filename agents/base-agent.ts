import { Attachment, attachmentToBlock, chatWithTools, ChatMessage, isAttachmentMediaType, MAX_ATTACHMENT_BYTES, ToolDef } from "../shared/claude";
import { appendHistory, loadHistory } from "../shared/conversation-memory";
import { loadNotes, saveNote } from "../shared/agent-notes";
import { downloadFile, getUserRealName, sendMessage } from "../shared/slack";
import { AgentId, SlackIncomingMessage } from "../shared/types";

const MAX_TOOL_TURNS = 6;

/**
 * Given to every agent for free — not something a subclass opts into via
 * getTools(). agent_conversations is scoped per thread on purpose, so this
 * is the only way an agent can carry something forward into a conversation
 * happening somewhere else entirely (a different channel, DM, or dashboard
 * session).
 */
const SAVE_NOTE_TOOL: ToolDef = {
  name: "save_note",
  description:
    "Save a short, durable note for your own future reference. Unlike this conversation's history, a note surfaces in EVERY future conversation you have — any channel, thread, or dashboard session, not just this one. Use it when asked to remember something long-term: a standing preference, a fact about a client, an instruction to keep in mind going forward. Don't use it for anything only relevant to this one conversation.",
  input_schema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The fact or instruction to remember going forward, written so it stands on its own without this conversation's context." },
    },
    required: ["note"],
  },
};

/**
 * Base class for all EDEN agents.
 * Each agent extends this with their own system prompt and custom handlers.
 */
export abstract class BaseAgent {
  readonly id: AgentId;
  readonly name: string;
  readonly code: string;

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
   * Override to give an agent tools beyond the save_note every agent
   * already gets from BaseAgent (Forge does this for its ad-engine tools;
   * nothing else does yet). Returning [] — the default — means save_note
   * is the only tool that agent has.
   */
  protected getTools(): ToolDef[] {
    return [];
  }

  /**
   * Override alongside getTools() to actually run a tool call.
   *
   * `attachment` is this turn's file, if any — the same one generateReply
   * received, not something the model can supply as tool_use JSON input
   * (there's no way to inline arbitrary bytes into a tool call). A tool
   * whose job is "do something with the attached file" (uploading it
   * somewhere, say) reads it from here rather than expecting the model to
   * pass file contents as an argument. Unset on any turn without one, and
   * on every tool call after the first within a turn that had one — it
   * doesn't get consumed or cleared, just never regenerated mid-turn.
   */
  protected async executeTool(_name: string, _input: any, _attachment?: Attachment): Promise<string> {
    throw new Error(`${this.code} has no tools configured`);
  }

  /** Backs SAVE_NOTE_TOOL — handled here, not in a subclass, since every agent gets it. */
  private async executeSaveNote(input: { note?: string }): Promise<string> {
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!note) throw new Error("save_note called with no note text");
    await saveNote(this.id, note);
    return "Noted — I'll remember that going forward, in any conversation.";
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

    // Resolved once per message rather than baked into history — Slack is the
    // only channel wired up today, and everyone reaching an agent there is a
    // real, identifiable person, not an anonymous lead. getUserRealName never
    // throws (returns null on lookup failure), so this can't break a reply.
    const senderName = await getUserRealName(this.id, message.userId);
    const attachment = await this.resolveSlackAttachment(message);

    try {
      const response = await this.generateReply(historyKey, message.text, { senderName }, attachment);
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
   * Downloads the file (if any) attached to a Slack message into the same
   * Attachment shape the dashboard's chat API already produces. Never
   * throws — an unsupported type, a download failure, or an oversized file
   * all degrade to "no attachment this turn" (logged, not silent) rather
   * than failing the whole reply, same reasoning as getUserRealName.
   */
  private async resolveSlackAttachment(message: SlackIncomingMessage): Promise<Attachment | undefined> {
    const file = message.file;
    if (!file) return undefined;

    if (!isAttachmentMediaType(file.mimetype)) {
      console.warn(`[${this.code}] Ignoring Slack attachment of unsupported type: ${file.mimetype}`);
      return undefined;
    }

    try {
      const data = await downloadFile(this.id, file.url);
      if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) {
        console.warn(`[${this.code}] Ignoring Slack attachment — ${data.length} bytes is outside the allowed range.`);
        return undefined;
      }
      return { data, mediaType: file.mimetype, filename: file.name };
    } catch (error) {
      console.error(`[${this.code}] Failed to download Slack attachment:`, error);
      return undefined;
    }
  }

  /**
   * Generate a reply for arbitrary callers (Slack, the dashboard's chat API, etc.)
   * — same history + Claude call as handleMessage, minus the Slack-specific bits.
   *
   * History is durable (agent_conversations in Postgres), not an in-process
   * Map — this system deploys often, and Slack/dashboard chat is the actual
   * interface people use it through, so every agent forgetting every
   * conversation on every restart was a real gap. A DB hiccup degrades to
   * "no memory this turn" rather than breaking the reply outright — worth
   * one turn of amnesia, never worth an agent going silent.
   */
  async generateReply(
    historyKey: string,
    userText: string,
    context?: Record<string, any>,
    attachment?: Attachment
  ): Promise<string> {
    const [history, notes] = await Promise.all([
      loadHistory(this.id, historyKey).catch((error) => {
        console.error(`[${this.code}] Failed to load conversation history:`, error);
        return [];
      }),
      loadNotes(this.id).catch((error) => {
        console.error(`[${this.code}] Failed to load notes:`, error);
        return [];
      }),
    ]);

    // Without this, a model asked "do you remember things?" falls back on
    // its own generic training (an LLM has no memory) and confidently
    // denies a capability the system actually has — exactly what happened
    // live: Forge told Jacob it forgets everything, despite history above
    // this turn proving otherwise. Appended here, not baked into any one
    // agent's getSystemPrompt(), so every agent inherits the correction.
    let systemPrompt = `${this.getSystemPrompt(context)}\n\nYour conversation with this specific person, in this specific channel/DM/thread, is saved durably and reloaded on every message here — including across restarts and deploys. If asked whether you remember things, the honest answer is yes for this ongoing conversation (the messages above this one, if any, are it). You do NOT have access to conversations happening in a different channel, thread, or DM. Separately, you have a save_note tool for anything that should be remembered across EVERY conversation, not just this one — use it when asked to remember something long-term.`;
    if (notes.length > 0) {
      systemPrompt += `\n\nNotes you've saved for yourself in past conversations (true across every channel and session, not just this one):\n${notes.map((n) => `- ${n}`).join("\n")}`;
    }

    // Every agent gets save_note whether or not it defines its own tools —
    // it's the only way to carry something into a conversation happening
    // somewhere else entirely, so it can't be something a subclass opts into.
    const tools = [SAVE_NOTE_TOOL, ...this.getTools()];

    const userContent: ChatMessage["content"] = attachment
      ? [attachmentToBlock(attachment), { type: "text", text: userText }]
      : userText;

    // save_note aside, most agents still define no tools of their own —
    // preserve the exact generation settings the old plain chat() call used
    // for them (chatWithTools defaults to a higher token cap and lower
    // temperature, tuned for Forge's tool-heavy replies, not a quick text
    // answer), so unifying onto one code path doesn't silently change how
    // every other agent sounds.
    const genOptions = this.getTools().length === 0 ? { maxTokens: 1024, temperature: 0.7 } : {};
    const reply = await this.runToolLoop(history, systemPrompt, tools, userContent, genOptions, attachment);

    // An attachment is scratch input for this turn only, like a
    // tool_use/tool_result exchange — replaying its raw bytes into every
    // future turn's context would balloon token cost for no benefit once
    // the model has already answered on it. A short marker preserves the
    // fact that a file was shared without persisting the file itself.
    const textForHistory = attachment
      ? `${userText}\n[attached: ${attachment.filename || attachment.mediaType}]`
      : userText;

    try {
      // Sequential, not Promise.all — order matters (user before assistant)
      // and these share one auto-increment id column that defines it.
      await appendHistory(this.id, historyKey, "user", textForHistory);
      await appendHistory(this.id, historyKey, "assistant", reply);
    } catch (error) {
      console.error(`[${this.code}] Failed to persist conversation history:`, error);
    }

    return reply;
  }

  /**
   * Every agent runs through this now, not just ones that define their own
   * getTools()/executeTool() — save_note means there's always at least one
   * tool available. When the model never calls one, this behaves exactly
   * like a plain chat() call: one turn, no tool_use, straight to the reply.
   *
   * Only ever works with plain-text history in and a plain-text reply out —
   * the tool_use/tool_result exchange this turn generates is scratch space
   * for THIS call only, never persisted: Anthropic's API requires every
   * tool_use block to be immediately followed by its tool_result, and a
   * later history read has no way to know not to split the two. The
   * model's own final answer (which IS persisted) already carries the
   * substance of what it found via tools.
   */
  private async runToolLoop(
    priorHistory: ChatMessage[],
    systemPrompt: string,
    tools: ToolDef[],
    userContent: ChatMessage["content"],
    options: { maxTokens?: number; temperature?: number } = {},
    attachment?: Attachment
  ): Promise<string> {
    let working: ChatMessage[] = [...priorHistory, { role: "user", content: userContent }];
    let finalText = "";

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const response = await chatWithTools(systemPrompt, working, tools, options);
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
            content =
              call.name === "save_note" ? await this.executeSaveNote(call.input) : await this.executeTool(call.name, call.input, attachment);
          } catch (error) {
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          return { type: "tool_result" as const, tool_use_id: call.id, content };
        })
      );
      working = [...working, { role: "user", content: toolResults }];
    }

    return finalText || "No response generated.";
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
