/**
 * Backend for the Lens reporting dashboard (read-only). All numbers come from our own database, which the
 * existing Meta and GHL syncs keep fresh, so a request never waits on either API.
 *
 *   GET /api/lens/clients
 *   GET /api/lens/:clientId/kpis?preset=last_30_days&compare=1        (or &preset=custom&from=YYYY-MM-DD&to=YYYY-MM-DD)
 *   GET /api/lens/:clientId/timeseries?preset=...
 *   GET /api/lens/:clientId/campaigns?preset=...
 *   GET /api/lens/:clientId/attribution?preset=...      (the lead-to-revenue chain, the closed-deal ledger, how it is worked out)
 *
 * Same access rule as the rest of the dashboard API: the x-dashboard-key header must match DASHBOARD_API_KEY.
 * Unlike the older routes, a missing key in production is refused rather than waved through: this carries
 * client revenue.
 */
import { Request, Response, Router } from "express";
import { timingSafeStringEqual } from "../shared/security";
import { clientTimezone, listLensClients } from "../agents/lens/dashboard/clients";
import { buildDashboardKpis, loadDashboardInputs } from "../agents/lens/dashboard/data";
import { computeSeries } from "../agents/lens/dashboard/series";
import { computeCampaignTable } from "../agents/lens/dashboard/campaigns";
import { computeAttribution } from "../agents/lens/dashboard/attribution";
import { computeMetrics } from "../agents/lens/dashboard/metrics";
import { DateRange, RangePreset, rangeLabel, resolveRange } from "../agents/lens/dashboard/ranges";
import { toKpiResponse } from "../agents/lens/dashboard/response";

const PRESETS: RangePreset[] = ["today", "yesterday", "last_7_days", "last_30_days", "last_90_days", "this_month", "this_year", "custom"];

export function isValidClientId(clientId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(clientId);
}

export type ParsedQuery = { ok: true; preset: RangePreset; range: DateRange; compare: boolean } | { ok: false; error: string };

/** Reads the period out of the query string, in the client's own timezone. */
export function parsePeriod(query: Request["query"], timeZone: string, now: Date = new Date()): ParsedQuery {
  // ?preset=a&preset=b arrives as an array. Quietly falling back to the default would answer a question nobody asked.
  for (const key of ["preset", "from", "to", "compare"]) {
    if (query[key] !== undefined && typeof query[key] !== "string") return { ok: false, error: `Send "${key}" once, as plain text.` };
  }
  const preset = (typeof query.preset === "string" ? query.preset : "last_30_days") as RangePreset;
  if (!PRESETS.includes(preset)) return { ok: false, error: `Unknown period "${String(query.preset)}". Use one of: ${PRESETS.join(", ")}.` };
  const resolved = resolveRange(preset, timeZone, now, { from: typeof query.from === "string" ? query.from : undefined, to: typeof query.to === "string" ? query.to : undefined });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const compare = query.compare === undefined ? true : !["0", "false", "no"].includes(String(query.compare).toLowerCase());
  return { ok: true, preset, range: resolved.range, compare };
}

export function createLensRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.DASHBOARD_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-key");
    if (req.method === "OPTIONS") return res.status(204).send();
    next();
  });

  router.use((req: Request, res: Response, next) => {
    const requiredKey = process.env.DASHBOARD_API_KEY;
    if (!requiredKey) {
      if (process.env.NODE_ENV === "production") return res.status(503).json({ error: "The reporting dashboard is not available: DASHBOARD_API_KEY is not set on the server." });
      return next();
    }
    const provided = req.headers["x-dashboard-key"];
    if (typeof provided !== "string" || !timingSafeStringEqual(provided, requiredKey)) return res.status(401).json({ error: "Invalid or missing dashboard key" });
    next();
  });

  router.get("/clients", async (_req: Request, res: Response) => {
    try {
      res.json({ clients: await listLensClients() });
    } catch (error) {
      console.error("[LENS-API] clients:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Could not load the client list." });
    }
  });

  /** Shared by the three data routes: validate the client and the period, then hand over the loaded inputs. */
  async function withInputs(req: Request, res: Response, fn: (ctx: NonNullable<Awaited<ReturnType<typeof loadDashboardInputs>>>, range: DateRange) => unknown): Promise<void> {
    const clientId = String(req.params.clientId ?? "");
    if (!isValidClientId(clientId)) {
      res.status(400).json({ error: "Invalid client id." });
      return;
    }
    try {
      const parsed = parsePeriod(req.query, await clientTimezone(clientId));
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const ctx = await loadDashboardInputs(clientId, parsed.range, { compare: parsed.compare });
      if (!ctx) {
        res.status(404).json({ error: `No client "${clientId}".` });
        return;
      }
      res.json(await fn(ctx, parsed.range));
    } catch (error) {
      console.error(`[LENS-API] ${req.path}:`, error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Could not build the report. Try again in a moment." });
    }
  }

  router.get("/:clientId/kpis", async (req: Request, res: Response) => {
    const clientId = String(req.params.clientId ?? "");
    if (!isValidClientId(clientId)) return res.status(400).json({ error: "Invalid client id." });
    try {
      const parsed = parsePeriod(req.query, await clientTimezone(clientId));
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const out = await buildDashboardKpis(clientId, parsed.range, { compare: parsed.compare });
      if (!out) return res.status(404).json({ error: `No client "${clientId}".` });
      res.json(toKpiResponse(out));
    } catch (error) {
      console.error("[LENS-API] kpis:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "Could not build the report. Try again in a moment." });
    }
  });

  router.get("/:clientId/timeseries", (req, res) =>
    withInputs(req, res, (ctx, range) => {
      const { granularity, points } = computeSeries({ ...ctx.base, range });
      return { period: { from: range.from, to: range.to, label: rangeLabel(range), timezone: ctx.timezone }, granularity, points };
    })
  );

  router.get("/:clientId/campaigns", (req, res) =>
    withInputs(req, res, (ctx, range) => {
      const rows = computeCampaignTable({ ...ctx.base, range });
      const totals = computeMetrics({ ...ctx.base, range }).kpis;
      return {
        period: { from: range.from, to: range.to, label: rangeLabel(range), timezone: ctx.timezone },
        rows,
        totals: { spend: totals.spend.value, leads: totals.totalLeads.value, closedDeals: totals.closedDeals.value, revenue: totals.revenueAll.value },
      };
    })
  );

  router.get("/:clientId/attribution", (req, res) =>
    withInputs(req, res, (ctx, range) => ({
      period: { from: range.from, to: range.to, label: rangeLabel(range), timezone: ctx.timezone },
      ...computeAttribution({ ...ctx.base, range, metaHistoryStarts: ctx.metaHistoryStarts }),
    }))
  );

  return router;
}
