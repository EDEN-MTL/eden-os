/**
 * Durable, cross-conversation notes, backed by agent_notes.
 *
 * agent_conversations (shared/conversation-memory) is scoped per thread on
 * purpose — Forge's chat about one client shouldn't leak into an unrelated
 * DM about another. A note is the opposite: something explicitly asked to
 * be remembered everywhere this agent talks to anyone, in any channel or
 * dashboard session, until someone says otherwise.
 */
import { query } from "../db";

const MAX_NOTES = 50;

/** All of this agent's notes, oldest first, capped so they can't grow unbounded in every prompt. */
export async function loadNotes(agentId: string): Promise<string[]> {
  const rows = await query<{ note: string }>(
    `SELECT note FROM agent_notes WHERE agent_id = $1 ORDER BY id DESC LIMIT $2`,
    [agentId, MAX_NOTES]
  );
  return rows.map((r) => r.note).reverse();
}

export async function saveNote(agentId: string, note: string): Promise<void> {
  await query(`INSERT INTO agent_notes (agent_id, note) VALUES ($1, $2)`, [agentId, note]);
}
