import { Request, Response, Router } from "express";
import { AgentId } from "../shared/types";
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

const VALID_AGENT_IDS = new Set(Object.keys(agents));

/**
 * HTTP chat API for the eden-command-ui dashboard — lets the frontend
 * talk to any agent directly, without going through Slack.
 */
export function createChatRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const allowedOrigin = process.env.DASHBOARD_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-key");
    if (req.method === "OPTIONS") return res.status(204).send();
    next();
  });

  router.use((req: Request, res: Response, next) => {
    const requiredKey = process.env.DASHBOARD_API_KEY;
    if (!requiredKey) {
      console.warn("[CHAT-API] DASHBOARD_API_KEY not set — running unauthenticated");
      return next();
    }
    const providedKey = req.headers["x-dashboard-key"];
    if (providedKey !== requiredKey) {
      return res.status(401).json({ error: "Invalid or missing dashboard key" });
    }
    next();
  });

  router.post("/:agentId", async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const { message, sessionId } = req.body;

    if (typeof agentId !== "string" || !VALID_AGENT_IDS.has(agentId)) {
      return res.status(404).json({ error: `Unknown agent: ${agentId}` });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in body" });
    }

    const agent = agents[agentId as AgentId];
    const historyKey = `web:${sessionId || "anonymous"}`;

    try {
      const reply = await agent.generateReply(historyKey, message);
      res.json({ reply, agentId });
    } catch (error) {
      console.error(`[CHAT-API] Error from ${agentId}:`, error);
      res.status(502).json({ error: "Agent failed to respond" });
    }
  });

  return router;
}
