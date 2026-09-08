/**
 * Scout's bi-weekly team check-in page — public, no login, gated only by
 * an opaque per-client token (same rationale as the unsubscribe route in
 * server/quarry-api.ts: a non-enumerable UUID, no distinct error message
 * for "wrong token" vs "no token"). Deliberately NOT behind the
 * x-dashboard-key middleware every other /api/* router uses — that's for
 * Eden's own internal dashboard, this is meant for a client's team lead
 * with no Eden login at all.
 */
import { Request, Response, Router } from "express";
import { getCheckinData, renderCheckinPage, updateCheckinItem } from "../agents/scout/checkin";

// Exported individually (rather than only as a built router) so they can
// be unit-tested with plain fake req/res objects, the same way
// webhooks/slack-events.ts exports its handler pieces for direct testing
// instead of only the assembled router.

export function getCheckinPage(_req: Request, res: Response): void {
  res.type("html").send(renderCheckinPage());
}

export async function getCheckinDataHandler(req: Request, res: Response): Promise<void> {
  const data = await getCheckinData(String(req.params.token));
  if (!data) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(data);
}

export async function postCheckinItem(req: Request, res: Response): Promise<void> {
  const { field, value } = req.body || {};
  if (typeof field !== "string" || typeof value !== "boolean") {
    res.status(400).json({ error: "Body must be { field: string, value: boolean }" });
    return;
  }

  const result = await updateCheckinItem(String(req.params.token), String(req.params.ghlEventId), field, value);
  if (result === "invalid-token") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (result === "invalid-field") {
    res.status(400).json({ error: "Invalid field" });
    return;
  }
  res.json({ ok: true });
}

export function createCheckinRouter(): Router {
  const router = Router();
  router.get("/checkin/:token", getCheckinPage);
  router.get("/api/checkin/:token", getCheckinDataHandler);
  router.post("/api/checkin/:token/items/:ghlEventId", postCheckinItem);
  return router;
}
