/**
 * Serves ONLY the read-only Lens API on a local port, against the database in .env, so the dashboard page can be
 * developed without starting the whole server (Slack bots, schedulers, webhooks). Read-only: it never writes.
 *
 *   npx tsx scripts/lens-dev-api.ts            (port 3000, or PORT)
 */
import "dotenv/config";
import express from "express";
import { createLensRouter } from "../server/lens-api";

const app = express();
app.use("/api/lens", createLensRouter());
app.get("/health", (_req, res) => res.json({ status: "ok" }));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Lens dev API on http://localhost:${port}/api/lens`));
