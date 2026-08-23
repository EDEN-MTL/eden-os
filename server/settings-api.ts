/**
 * Backend for the dashboard's Settings page — lets Meta/GHL credentials be
 * entered through the UI instead of env vars or relaying them through
 * chat. Values are validated against the real API before being saved, and
 * are never read back out — GET only reports "configured" / "not
 * configured", never the actual secret.
 */
import { Request, Response, Router } from "express";
import { query } from "../shared/db";
import { MetaAPIError, MetaClient } from "../shared/meta";
import { getCustomFieldDefs } from "../shared/ghl";

export function createSettingsRouter(): Router {
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

  router.get("/integrations", async (req: Request, res: Response) => {
    const clientId = (req.query.clientId as string) || "eden";
    const [meta, ghl] = await Promise.all([
      query("SELECT 1 FROM meta_credentials WHERE client_id = $1", [clientId]),
      query("SELECT 1 FROM ghl_credentials WHERE client_id = $1", [clientId]),
    ]);
    res.json({
      meta: { configured: meta.length > 0 },
      ghl: { configured: ghl.length > 0 },
    });
  });

  router.post("/meta", async (req: Request, res: Response) => {
    const clientId = (req.body.clientId as string) || "eden";
    const { appId, appSecret, accessToken, adAccountId, pageId } = req.body;

    if (!appId || !appSecret || !accessToken || !adAccountId) {
      return res.status(400).json({ error: "appId, appSecret, accessToken, and adAccountId are all required" });
    }

    try {
      const client = new MetaClient({ appId, appSecret, accessToken, adAccountId, pageId, clientId });
      await client.getObject(adAccountId, ["id", "name"]);
    } catch (error) {
      const message = error instanceof MetaAPIError ? error.message : "Couldn't verify these credentials against Meta";
      return res.status(400).json({ error: `Validation failed: ${message}` });
    }

    await query(
      `INSERT INTO meta_credentials (client_id, app_id, app_secret, access_token, ad_account_id, page_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (client_id) DO UPDATE SET
         app_id = excluded.app_id, app_secret = excluded.app_secret,
         access_token = excluded.access_token, ad_account_id = excluded.ad_account_id,
         page_id = excluded.page_id, updated_at = now()`,
      [clientId, appId, appSecret, accessToken, adAccountId, pageId || null]
    );
    // Clear any stale refreshed-token state from a previous account/token —
    // otherwise auth.ts would keep serving the old token until it expires.
    await query("DELETE FROM meta_tokens WHERE client_id = $1", [clientId]);

    res.json({ configured: true });
  });

  router.post("/ghl", async (req: Request, res: Response) => {
    const clientId = (req.body.clientId as string) || "eden";
    const { apiKey, locationId, attributionPipelineName } = req.body;

    if (!apiKey || !locationId) {
      return res.status(400).json({ error: "apiKey and locationId are both required" });
    }

    try {
      await getCustomFieldDefs(locationId, apiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't verify these credentials against GHL";
      return res.status(400).json({ error: `Validation failed: ${message}` });
    }

    await query(
      `INSERT INTO ghl_credentials (client_id, api_key, location_id, attribution_pipeline_name, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (client_id) DO UPDATE SET
         api_key = excluded.api_key, location_id = excluded.location_id,
         attribution_pipeline_name = excluded.attribution_pipeline_name, updated_at = now()`,
      [clientId, apiKey, locationId, attributionPipelineName || null]
    );

    res.json({ configured: true });
  });

  return router;
}
