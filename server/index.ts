import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { initSlackClients } from "../shared/slack";
import { createSlackRouter } from "../webhooks/slack-events";
import { createGHLRouter } from "../webhooks/ghl-webhook";
import { createChatRouter } from "./chat-api";
import { createTtsRouter } from "./tts-api";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(
  express.json({
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

// ─── Initialize & Start ───
async function start() {
  console.log("");
  console.log("  ◆ EDEN OS v0.1.0");
  console.log("  ─────────────────────────────");
  console.log("  Initializing systems...");
  console.log("");

  // Initialize Slack clients for all agents
  initSlackClients();

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
