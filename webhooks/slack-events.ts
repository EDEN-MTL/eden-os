import crypto from "crypto";
import { Request, Response, Router } from "express";
import { AgentId, SlackIncomingMessage } from "../shared/types";
import { getSigningSecret } from "../shared/slack";

// Import all agents
import { edenBrain } from "../agents/eden-brain";
import { scoutAgent } from "../agents/scout";
import { irisAgent } from "../agents/iris";
import { atlasAgent } from "../agents/atlas";
import { emberAgent } from "../agents/ember";
import { museAgent } from "../agents/muse";
import { forgeAgent } from "../agents/forge";
import { lensAgent } from "../agents/lens";
import { novaAgent } from "../agents/nova";
import { BaseAgent } from "../agents/base-agent";

// Agent registry
const agents: Record<AgentId, BaseAgent> = {
  eden: edenBrain,
  scout: scoutAgent,
  iris: irisAgent,
  atlas: atlasAgent,
  ember: emberAgent,
  muse: museAgent,
  forge: forgeAgent,
  lens: lensAgent,
  nova: novaAgent,
};

/**
 * Verify that a request actually came from Slack.
 */
function verifySlackSignature(
  signingSecret: string,
  req: Request
): boolean {
  const timestamp = req.headers["x-slack-request-timestamp"] as string;
  const signature = req.headers["x-slack-signature"] as string;

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBaseString)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

/**
 * Create the webhook handler for a specific agent.
 */
function createAgentHandler(agentId: AgentId) {
  return async (req: Request, res: Response) => {
    const body = req.body;

    // Handle Slack URL verification challenge
    if (body.type === "url_verification") {
      return res.json({ challenge: body.challenge });
    }

    // Verify signature
    const signingSecret = getSigningSecret(agentId);
    if (signingSecret && !verifySlackSignature(signingSecret, req)) {
      console.warn(`[WEBHOOK] Invalid signature for ${agentId}`);
      return res.status(401).send("Invalid signature");
    }

    // Acknowledge immediately (Slack expects response within 3 seconds)
    res.status(200).send();

    // Process the event asynchronously
    try {
      const event = body.event;
      if (!event) return;

      // Ignore bot messages (prevent infinite loops)
      if (event.bot_id || event.subtype === "bot_message") return;

      // Ignore message edits and deletes
      if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;

      // Build the incoming message
      const message: SlackIncomingMessage = {
        agentId,
        userId: event.user,
        channelId: event.channel,
        text: event.text || "",
        threadTs: event.thread_ts || event.ts,
        isDM: event.channel_type === "im",
        timestamp: event.ts,
      };

      // Route to the correct agent
      const agent = agents[agentId];
      if (agent) {
        await agent.handleMessage(message);
      }
    } catch (error) {
      console.error(`[WEBHOOK] Error handling ${agentId} event:`, error);
    }
  };
}

/**
 * Create the Express router with all 9 agent webhook routes.
 */
export function createSlackRouter(): Router {
  const router = Router();

  // Mount a route for each agent
  const agentIds: AgentId[] = [
    "eden", "scout", "iris", "atlas",
    "ember", "muse", "forge", "lens", "nova",
  ];

  for (const agentId of agentIds) {
    router.post(`/${agentId}`, createAgentHandler(agentId));
    console.log(`[WEBHOOK] Registered: POST /webhooks/slack/${agentId}`);
  }

  return router;
}
