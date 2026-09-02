// Side-effect import, NOT `import dotenv` + `dotenv.config()`.
// TypeScript emits every `require` above the first statement in the CJS
// output, so `dotenv.config()` used to run AFTER shared/db had already been
// loaded — and shared/db builds its Pool at module scope from
// process.env.DATABASE_URL. The result was a pool pointed at localhost:5432
// on every local run while .env sat there looking correct. Render masks it
// by injecting env vars into the process directly.
import "dotenv/config";

import express from "express";
import { initSlackClients } from "../shared/slack";
import { createSlackRouter } from "../webhooks/slack-events";
import { createGHLRouter } from "../webhooks/ghl-webhook";
import { initDb } from "../shared/db";
import { startScheduler } from "../shared/scheduler";
import { createChatRouter } from "./chat-api";
import { createTtsRouter } from "./tts-api";
import { createSettingsRouter } from "./settings-api";
import { createClientsRouter } from "./clients-api";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(
  express.json({
    // 12mb, not the 100kb default — a base64-encoded chat attachment
    // (images, PDFs) inflates ~33% over its raw bytes; chat-api.ts caps the
    // decoded file itself at 8MB, this just has to fit the encoded form.
    limit: "12mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ───
app.get("/", (_req, res) => {
  res.json({
    system: "EDEN OS",
    version: "0.1.0",
    status: "operational",
    agents: [
      "eden", "scout", "iris", "atlas",
      "ember", "muse", "forge", "lens", "nova",
    ],
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ─── Webhook Routes ───
app.use("/webhooks/slack", createSlackRouter());
app.use("/webhooks/ghl", createGHLRouter());
app.use("/api/chat", createChatRouter());
app.use("/api/tts", createTtsRouter());
app.use("/api/settings", createSettingsRouter());
app.use("/api/clients", createClientsRouter());

// ─── Initialize & Start ───
async function start() {
  console.log("");
  console.log("  ◆ EDEN OS v0.1.0");
  console.log("  ─────────────────────────────");
  console.log("  Initializing systems...");
  console.log("");

  // Initialize Slack clients for all agents
  initSlackClients();

  // Set up the database schema (idempotent)
  await initDb();

  // Nothing in the system ran on its own before this.
  startScheduler();

  console.log("");
  console.log("  ─────────────────────────────");

  // Start server
  app.listen(PORT, () => {
    console.log(`  Server online: port ${PORT}`);
    console.log("  All systems nominal.");
    console.log("");
  });
}

start().catch((error) => {
  console.error("  ✗ EDEN OS failed to start:", error);
  process.exit(1);
});
