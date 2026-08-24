/**
 * Backend for the dashboard's Clients pages — a roster of real clients
 * (from config/clients/*.json) plus, per client, their real GHL pipeline
 * data and Meta ad performance (via the same attribution/metrics engine
 * Forge already built), and the pending-approval queue for that client's
 * ads.
 *
 * "eden" (Eden's own growth account) deliberately doesn't appear here —
 * it has no config/clients/eden.json, since this page is about the
 * clients Eden manages for others, not Eden itself.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Request, Response, Router } from "express";
import { query } from "../shared/db";
import { getMetaConfig, MetaClient, MetaAPIError } from "../shared/meta";
import { ComplianceError } from "../shared/meta/compliance";
import { attributionReport } from "../agents/forge/ads/attribution";
import * as queue from "../agents/forge/ads/queue";
import { MetaActions } from "../agents/forge/ads/actions";
import { ActionExecutor, ExecutionError } from "../agents/forge/ads/executor";

const CLIENTS_DIR = join(process.cwd(), "config", "clients");

interface ClientConfigFile {
  clientId: string;
  clientName: string;
  ghl?: { locationId?: string; pipelineId?: string; calendarId?: string };
  meta?: { adAccountId?: string; pageId?: string };
  forge?: { cplThreshold?: number; roasTarget?: number; dailyBudgetCap?: number };
}

function loadClientConfigs(): ClientConfigFile[] {
  let files: string[] = [];
  try {
    files = readdirSync(CLIENTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(readFileSync(join(CLIENTS_DIR, f), "utf-8")));
}

function loadClientConfig(clientId: string): ClientConfigFile | null {
  return loadClientConfigs().find((c) => c.clientId === clientId) || null;
}

async function integrationStatus(clientId: string) {
  const [meta, ghl] = await Promise.all([
    query("SELECT 1 FROM meta_credentials WHERE client_id = $1", [clientId]),
    query("SELECT 1 FROM ghl_credentials WHERE client_id = $1", [clientId]),
  ]);
  return { metaConfigured: meta.length > 0, ghlConfigured: ghl.length > 0 };
}

function last30Days(): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

export function createClientsRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const allowedOrigin = process.env.DASHBOARD_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-key");
    if (req.method === "OPTIONS") return res.status(204).send();
    next();
  });

  router.use((req: Request, res: Response, next) => {
    const requiredKey = process.env.DASHBOARD_API_KEY;
    if (!requiredKey) return next();
    if (req.headers["x-dashboard-key"] !== requiredKey) {
      return res.status(401).json({ error: "Invalid or missing dashboard key" });
    }
    next();
  });

  router.get("/", async (_req: Request, res: Response) => {
    const configs = loadClientConfigs();
    const clients = await Promise.all(
      configs.map(async (c) => {
        const status = await integrationStatus(c.clientId);
        const { since, until } = last30Days();
        const report = await attributionReport(since, until, c.clientId).catch(() => []);
        const spend = report.reduce((sum, r) => sum + r.spend, 0);
        const leadCount = report.reduce((sum, r) => sum + r.lead_count, 0);
        return {
          clientId: c.clientId,
          clientName: c.clientName,
          configured: status.metaConfigured && status.ghlConfigured,
          metaConfigured: status.metaConfigured,
          ghlConfigured: status.ghlConfigured,
          spendLast30d: Math.round(spend * 100) / 100,
          leadsLast30d: leadCount,
        };
      })
    );
    res.json({ clients });
  });

  router.get("/:clientId", async (req: Request, res: Response) => {
    const clientId = req.params.clientId as string;
    const config = loadClientConfig(clientId);
    if (!config) return res.status(404).json({ error: `No client config for ${JSON.stringify(clientId)}` });

    const status = await integrationStatus(clientId);
    const { since, until } = last30Days();
    const [report, recentLeads, pending] = await Promise.all([
      attributionReport(since, until, clientId).catch(() => []),
      query(
        "SELECT id, meta_campaign_id, meta_adset_id, meta_ad_id, pipeline_stage, deal_value, won, created_at FROM ad_leads WHERE client_id = $1 ORDER BY created_at DESC LIMIT 15",
        [clientId]
      ),
      queue.listPending(clientId),
    ]);

    res.json({
      clientId: config.clientId,
      clientName: config.clientName,
      metaConfigured: status.metaConfigured,
      ghlConfigured: status.ghlConfigured,
      forgeRules: config.forge || null,
      adPerformance: report,
      recentLeads,
      pendingActions: pending,
      appointments: { available: false, reason: "Atlas (routing & booking) isn't built yet — no appointment data exists." },
    });
  });

  router.get("/:clientId/pending-actions", async (req: Request, res: Response) => {
    res.json({ pendingActions: await queue.listPending(req.params.clientId as string) });
  });

  async function buildExecutor(clientId: string): Promise<ActionExecutor> {
    const metaConfig = await getMetaConfig(clientId);
    if (!metaConfig) throw new MetaAPIError("Meta isn't configured for this client yet");
    return new ActionExecutor(new MetaActions(new MetaClient(metaConfig)), clientId);
  }

  router.post("/:clientId/pending-actions/:id/approve", async (req: Request, res: Response) => {
    const pendingActionId = Number(req.params.id);
    const decidedBy = (req.body.decidedBy as string) || "dashboard";
    try {
      const executor = await buildExecutor(req.params.clientId as string);
      await queue.decide(pendingActionId, "approved", decidedBy);
      const result = await executor.executePending(pendingActionId, decidedBy, false);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof ComplianceError || error instanceof MetaAPIError || error instanceof ExecutionError
          ? error.message
          : "Failed to execute action";
      res.status(400).json({ error: message });
    }
  });

  router.post("/:clientId/pending-actions/:id/reject", async (req: Request, res: Response) => {
    const pendingActionId = Number(req.params.id);
    const decidedBy = (req.body.decidedBy as string) || "dashboard";
    try {
      const executor = await buildExecutor(req.params.clientId as string);
      await executor.reject(pendingActionId, decidedBy, req.body.reason || "");
      res.json({ status: "rejected" });
    } catch {
      res.status(400).json({ error: "Failed to reject action" });
    }
  });

  return router;
}
