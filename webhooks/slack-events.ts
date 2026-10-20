import crypto from "crypto";
import { Request, Response, Router } from "express";
import { AgentId, SlackIncomingMessage } from "../shared/types";
import { getSigningSecret } from "../shared/slack";
import { handleApprovalClick, KEEP_ACTION_ID, PAUSE_ACTION_ID, ClickOutcome } from "../agents/forge/ads/approval";

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
import { quarryAgent } from "../agents/quarry";
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
  quarry: quarryAgent,
};

/**
 * Verify that a request actually came from Slack. Exported for direct unit
 * testing (the length-mismatch/DoS regression in particular can't be
 * exercised through the full route without a real Express req/res cycle).
 */
export function verifySlackSignature(
  signingSecret: string,
  req: Request
): boolean {
  const timestamp = req.headers["x-slack-request-timestamp"] as string;
  const signature = req.headers["x-slack-signature"] as string;

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const sigBaseString = `v0:${timestamp}:${rawBody?.toString("utf8") ?? JSON.stringify(req.body)}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBaseString)
      .digest("hex");

  const expected = Buffer.from(mySignature);
  const provided = Buffer.from(signature);

  // crypto.timingSafeEqual throws RangeError on a byte-length mismatch
  // instead of returning false — and x-slack-signature is an
  // attacker-controlled header, so any request with a signature of the
  // "wrong" length (trivial to send, no secret required) hit this
  // uncaught inside an async Express handler. Express 4 doesn't catch a
  // rejected promise from an async route handler, so that became an
  // unhandled rejection — which crashes the whole process by default on
  // this Node version, taking down every agent's webhook and the
  // dashboard API with it. A pre-auth, no-secret-needed DoS.
  if (expected.length !== provided.length) return false;

  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Pulls the first file (if any) off a Slack message event into the plain
 * {url, mimetype, name} shape SlackIncomingMessage carries. Exported for
 * direct unit testing — the fallback from url_private_download to
 * url_private, and tolerating a missing/empty files array, are easy to get
 * wrong silently since neither shows up until someone actually attaches a
 * file in Slack.
 */
export function extractFileFromEvent(event: any): SlackIncomingMessage["file"] {
  const firstFile = Array.isArray(event.files) ? event.files[0] : null;
  if (!firstFile) return undefined;
  return { url: firstFile.url_private_download || firstFile.url_private, mimetype: firstFile.mimetype, name: firstFile.name };
}

/**
 * True when this delivery is Slack re-sending an event it already sent us
 * once — Slack retries (with X-Slack-Retry-Num: 1, 2, 3...) whenever it does
 * not see our 200 inside its ~3 second window, for any reason on either
 * side. Exported for direct unit testing.
 *
 * We ack synchronously at the very top of the handler and do all real work
 * afterward, so a retry is never a safety net here — it is a second,
 * fully duplicate run of whatever the original message asked for, on a
 * shared single-process instance where "for any reason" is easy to trip
 * (every other agent's work shares the same event loop). Confirmed live
 * 2026-09-06: one Slack message ("go find and send emails to 25 more
 * businesses in Brockville") produced two identical acknowledgments and
 * two full discovery runs, back to back, for exactly this reason.
 */
export function isSlackRetryDelivery(req: Request): boolean {
  return Boolean(req.headers["x-slack-retry-num"]);
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

    if (isSlackRetryDelivery(req)) {
      console.log(
        `[WEBHOOK] Ignoring Slack retry #${req.headers["x-slack-retry-num"]} for ${agentId} — already processed the original delivery`
      );
      return;
    }

    // Process the event asynchronously
    try {
      const event = body.event;
      if (!event) return;

      // Ignore bot messages (prevent infinite loops)
      if (event.bot_id || event.subtype === "bot_message") return;

      // Ignore message edits and deletes
      if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;

      // A message with a file attached carries it in event.files — only
      // ever the first one is used, same one-attachment-per-turn contract
      // as the dashboard's chat API. This is metadata only (the bot token
      // needed to actually download it lives one layer up, in shared/slack).
      const file = extractFileFromEvent(event);

      // Build the incoming message
      const message: SlackIncomingMessage = {
        agentId,
        userId: event.user,
        channelId: event.channel,
        text: event.text || "",
        threadTs: event.thread_ts || event.ts,
        isDM: event.channel_type === "im",
        timestamp: event.ts,
        file,
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
 * Button presses on Forge's flags (agents/forge/ads/approval.ts). Slack posts these as a
 * form field `payload` holding JSON, to the Interactivity Request URL set on the Forge Slack app:
 * https://<server>/webhooks/slack/forge/interactive. Exported for direct testing.
 */
export async function handleForgeInteraction(
  payload: any,
  deps: {
    click?: (actionId: string, pendingId: number, userId: string) => Promise<ClickOutcome>;
    respond?: (url: string, body: Record<string, unknown>) => Promise<void>;
  } = {}
): Promise<void> {
  if (payload?.type !== "block_actions") return;
  const click = deps.click ?? ((a, p, u) => handleApprovalClick(a, p, u));
  const respond =
    deps.respond ??
    (async (url: string, body: Record<string, unknown>) => {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    });

  for (const action of payload.actions ?? []) {
    if (action?.action_id !== PAUSE_ACTION_ID && action?.action_id !== KEEP_ACTION_ID) continue;
    const pendingId = Number(action.value);
    const userId = payload.user?.id;
    if (!Number.isInteger(pendingId) || !userId || !payload.response_url) continue;
    const outcome = await click(action.action_id, pendingId, userId);
    await respond(
      payload.response_url,
      outcome.replace
        ? { replace_original: true, text: outcome.text, blocks: [{ type: "section", text: { type: "mrkdwn", text: outcome.text } }] }
        : { response_type: "ephemeral", replace_original: false, text: outcome.text }
    );
  }
}

function createForgeInteractiveHandler() {
  return async (req: Request, res: Response) => {
    // Unlike the event routes, this one changes the ad account, so an unsigned request is never accepted.
    const signingSecret = getSigningSecret("forge");
    if (!signingSecret || !verifySlackSignature(signingSecret, req)) {
      console.warn("[WEBHOOK] Invalid or unsigned forge interactive request");
      return res.status(401).send("Invalid signature");
    }
    // Slack wants the 200 inside 3 seconds; the pause itself happens after.
    res.status(200).send();
    try {
      const raw = req.body?.payload;
      if (typeof raw !== "string") return;
      await handleForgeInteraction(JSON.parse(raw));
    } catch (error) {
      console.error("[WEBHOOK] Error handling forge interaction:", error);
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
    "ember", "muse", "forge", "lens", "nova", "quarry",
  ];

  for (const agentId of agentIds) {
    router.post(`/${agentId}`, createAgentHandler(agentId));
    console.log(`[WEBHOOK] Registered: POST /webhooks/slack/${agentId}`);
  }

  router.post("/forge/interactive", createForgeInteractiveHandler());
  console.log("[WEBHOOK] Registered: POST /webhooks/slack/forge/interactive");

  return router;
}
