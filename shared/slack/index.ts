import { WebClient } from "@slack/web-api";
import { AgentId, SlackOutgoingMessage } from "../types";

// ─── Agent Slack Clients ───
// Each agent has its own WebClient with its own bot token

interface AgentSlackConfig {
  name: string;
  token: string;
  signingSecret: string;
}

const agentClients: Map<AgentId, WebClient> = new Map();
const agentConfigs: Map<AgentId, AgentSlackConfig> = new Map();

/**
 * Initialize all agent Slack clients.
 * Call this once at server startup.
 */
export function initSlackClients(): void {
  const agents: { id: AgentId; name: string; tokenEnv: string; secretEnv: string }[] = [
    { id: "eden", name: "EDEN", tokenEnv: "EDEN_BOT_TOKEN", secretEnv: "EDEN_SIGNING_SECRET" },
    { id: "scout", name: "Scout", tokenEnv: "SCOUT_BOT_TOKEN", secretEnv: "SCOUT_SIGNING_SECRET" },
    { id: "iris", name: "Iris", tokenEnv: "IRIS_BOT_TOKEN", secretEnv: "IRIS_SIGNING_SECRET" },
    { id: "atlas", name: "Atlas", tokenEnv: "ATLAS_BOT_TOKEN", secretEnv: "ATLAS_SIGNING_SECRET" },
    { id: "ember", name: "Ember", tokenEnv: "EMBER_BOT_TOKEN", secretEnv: "EMBER_SIGNING_SECRET" },
    { id: "muse", name: "Muse", tokenEnv: "MUSE_BOT_TOKEN", secretEnv: "MUSE_SIGNING_SECRET" },
    { id: "forge", name: "Forge", tokenEnv: "FORGE_BOT_TOKEN", secretEnv: "FORGE_SIGNING_SECRET" },
    { id: "lens", name: "Lens", tokenEnv: "LENS_BOT_TOKEN", secretEnv: "LENS_SIGNING_SECRET" },
    { id: "nova", name: "Nova", tokenEnv: "NOVA_BOT_TOKEN", secretEnv: "NOVA_SIGNING_SECRET" },
  ];

  for (const agent of agents) {
    const token = process.env[agent.tokenEnv];
    const secret = process.env[agent.secretEnv];

    if (token) {
      agentClients.set(agent.id, new WebClient(token));
      agentConfigs.set(agent.id, {
        name: agent.name,
        token,
        signingSecret: secret || "",
      });
      console.log(`[SLACK] ${agent.name} client initialized`);
    } else {
      console.warn(`[SLACK] ${agent.name} token not found (${agent.tokenEnv}), skipping`);
    }
  }
}

/**
 * Get the WebClient for a specific agent.
 */
export function getClient(agentId: AgentId): WebClient {
  const client = agentClients.get(agentId);
  if (!client) {
    throw new Error(`No Slack client for agent: ${agentId}`);
  }
  return client;
}

/**
 * Get the signing secret for a specific agent (used for webhook verification).
 */
export function getSigningSecret(agentId: AgentId): string {
  const config = agentConfigs.get(agentId);
  return config?.signingSecret || "";
}

/**
 * Downloads a file a user uploaded in Slack. Slack's file urls
 * (url_private/url_private_download on a message event's `files` entries)
 * are NOT public — they 401 without the bot token that can see the
 * channel, and that token isn't exposed by the WebClient instance itself,
 * so this bypasses the Web API client entirely for a plain authenticated
 * GET.
 */
export async function downloadFile(agentId: AgentId, url: string): Promise<Buffer> {
  const config = agentConfigs.get(agentId);
  if (!config?.token) throw new Error(`No Slack bot token for agent: ${agentId}`);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) throw new Error(`Failed to download Slack file (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send a message as a specific agent.
 */
export async function sendMessage(
  agentId: AgentId,
  message: SlackOutgoingMessage
): Promise<void> {
  const client = getClient(agentId);

  try {
    await client.chat.postMessage({
      channel: message.channel,
      text: message.text,
      thread_ts: message.threadTs,
      unfurl_links: false,
    });
    console.log(
      `[SLACK] ${agentId.toUpperCase()} → #${message.channel}: ${message.text.slice(0, 80)}...`
    );
  } catch (error) {
    console.error(`[SLACK] Error sending as ${agentId}:`, error);
    throw error;
  }
}

/**
 * Send a rich message with blocks as a specific agent.
 */
export async function sendBlocks(
  agentId: AgentId,
  channel: string,
  blocks: any[],
  text: string = "",
  threadTs?: string
): Promise<void> {
  const client = getClient(agentId);

  try {
    await client.chat.postMessage({
      channel,
      text, // fallback for notifications
      blocks,
      thread_ts: threadTs,
      unfurl_links: false,
    });
  } catch (error) {
    console.error(`[SLACK] Error sending blocks as ${agentId}:`, error);
    throw error;
  }
}

/**
 * Slack user id -> real name, cached in-process. userId is global to the
 * whole workspace (not per-agent), and someone's display name doesn't
 * change mid-conversation, so there's no reason to re-fetch it on every
 * message — same reasoning as quarry_phone_lookups caching carrier lookups
 * by number. Cleared only by a process restart.
 */
const userNameCache: Map<string, string | null> = new Map();

/**
 * Resolves a Slack user id to the name they'd actually recognize themselves
 * by — real_name over the raw profile display_name, which is often a
 * lowercase handle. Returns null (never throws) on any lookup failure, so a
 * transient Slack API error degrades to "unknown sender" rather than
 * breaking the whole reply.
 */
export async function getUserRealName(agentId: AgentId, userId: string): Promise<string | null> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;

  try {
    const client = getClient(agentId);
    const result = await client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.profile?.display_name || null;
    userNameCache.set(userId, name || null);
    return name || null;
  } catch (error) {
    console.warn(`[SLACK] Could not resolve real name for ${userId}:`, error);
    return null;
  }
}

/**
 * React to a message as a specific agent.
 */
export async function addReaction(
  agentId: AgentId,
  channel: string,
  timestamp: string,
  emoji: string
): Promise<void> {
  const client = getClient(agentId);

  try {
    await client.reactions.add({
      channel,
      timestamp,
      name: emoji,
    });
  } catch (error) {
    // Ignore "already_reacted" errors
    if ((error as any)?.data?.error !== "already_reacted") {
      console.error(`[SLACK] Error adding reaction as ${agentId}:`, error);
    }
  }
}
