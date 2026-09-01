/**
 * Durable conversation memory for BaseAgent, backed by agent_conversations.
 *
 * Replaces what used to be an in-process Map on each agent instance. That
 * worked within one server lifetime, but this system deploys often — every
 * deploy wiped every agent's memory of every conversation. Slack and the
 * dashboard chat are the actual interface people use Forge/EDEN/etc.
 * through, so "the agent forgets everything overnight" was a real gap, not
 * a theoretical one.
 */
import { query } from "../db";
import { ChatMessage } from "../claude";

const DEFAULT_LIMIT = 20;

/** Most recent `limit` turns for this agent + conversation thread, oldest first. */
export async function loadHistory(agentId: string, historyKey: string, limit = DEFAULT_LIMIT): Promise<ChatMessage[]> {
  const rows = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM agent_conversations
     WHERE agent_id = $1 AND history_key = $2
     ORDER BY id DESC LIMIT $3`,
    [agentId, historyKey, limit]
  );
  return rows.reverse();
}

export async function appendHistory(agentId: string, historyKey: string, role: "user" | "assistant", content: string): Promise<void> {
  await query(`INSERT INTO agent_conversations (agent_id, history_key, role, content) VALUES ($1, $2, $3, $4)`, [
    agentId,
    historyKey,
    role,
    content,
  ]);
}
