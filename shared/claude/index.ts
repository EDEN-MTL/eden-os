import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
