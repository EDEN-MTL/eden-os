import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface ChatMessage {
  role: "user" | "assistant";
  // Persisted history is always a plain string — content blocks only ever
  // appear in the scratch working array a tool-use loop builds for itself
  // (every agent runs one now, via BaseAgent's save_note) or as an
  // attachment on the current turn. Widening this rather than introducing
  // a second message type keeps loadHistory's callers unchanged: they only
  // ever push strings, and the SDK accepts both shapes on the same field.
  content: string | Anthropic.MessageParam["content"];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
}

export type AttachmentMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf";

// One list for every caller that accepts a file into a chat turn — the
// dashboard's chat API and Slack's file-upload handling both need the exact
// same allowlist, and a divergence between them would mean the same file
// works from one surface and silently fails from the other.
export const ALLOWED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set<AttachmentMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export function isAttachmentMediaType(mediaType: string): mediaType is AttachmentMediaType {
  return ALLOWED_ATTACHMENT_TYPES.has(mediaType);
}

// Decoded-bytes cap, shared across every attachment entry point (dashboard
// upload, Slack file download) so a file within Slack's own generous size
// limits doesn't sail past what the rest of the system was ever tested
// against — the dashboard path derived this from express.json()'s body
// limit accounting for ~33% base64 overhead; Slack files arrive as raw
// bytes with no such encoding, but the same ceiling still applies.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface Attachment {
  data: Buffer;
  mediaType: AttachmentMediaType;
  filename?: string;
}

/** Turns an uploaded file into the content block Claude expects for its type. */
export function attachmentToBlock(attachment: Attachment): Anthropic.ContentBlockParam {
  const base64 = attachment.data.toString("base64");
  if (attachment.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title: attachment.filename,
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: attachment.mediaType, data: base64 },
  };
}

/**
 * Send a message to Claude with an agent's system prompt.
 * Each agent calls this with their own system prompt and conversation history.
 */
export async function chat(
  systemPrompt: string,
  messages: ChatMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  const { maxTokens = 1024, temperature = 0.7 } = options;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return text || "No response generated.";
  } catch (error) {
    console.error("[CLAUDE] Error:", error);
    throw error;
  }
}

/**
 * Same call as `chat()`, but with tools attached and the raw SDK message
 * returned instead of flattened text — the caller (a tool-use loop) needs
 * `stop_reason` and the individual content blocks (text vs tool_use) to
 * decide whether to execute a tool and continue, or stop.
 */
export async function chatWithTools(
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  options: { maxTokens?: number; temperature?: number } = {}
): Promise<Anthropic.Message> {
  const { maxTokens = 1536, temperature = 0.6 } = options;

  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: messages.map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
  });
}

/**
 * Quick single-turn message — no conversation history needed.
 * Good for generating reports, summaries, or one-off responses.
 */
export async function ask(
  systemPrompt: string,
  userMessage: string,
  options: {
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  return chat(systemPrompt, [{ role: "user", content: userMessage }], options);
}

/**
 * Single-turn ask with an image attached.
 *
 * Used by Quarry to judge how dated a prospect's existing site LOOKS — the
 * case no regex catches, where the markup is fine and the design is from
 * 2009. Those are the best leads in the batch: the owner usually knows.
 *
 * Runs on claude-opus-5 rather than the sonnet id the chat agents use. This
 * is a judgement call made once per lead on an image, not a conversational
 * turn, and a wrong score here silently drops a qualified prospect.
 */
export async function askWithImage(
  systemPrompt: string,
  userMessage: string,
  image: { data: Buffer; mediaType: "image/png" | "image/jpeg" | "image/webp" },
  options: { maxTokens?: number } = {}
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: options.maxTokens ?? 1024,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.data.toString("base64"),
            },
          },
          { type: "text", text: userMessage },
        ],
      },
    ],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
