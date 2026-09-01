import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface ChatMessage {
  role: "user" | "assistant";
  // A plain string for every agent that doesn't use tools (all of them,
  // today, except Forge) — content blocks only appear in the scratch
  // history a tool-use loop builds for itself. Widening this rather than
  // introducing a second message type keeps every existing agent's code
  // unchanged: they only ever push strings, and the SDK accepts both
  // shapes on the same field.
  content: string | Anthropic.MessageParam["content"];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
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
