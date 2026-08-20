# ◆ EDEN OS

**Multi-agent AI operating system for real estate client acquisition.**

EDEN bridges lead generation, marketing, and sales into one continuous pipeline — powered by 9 specialized AI agents orchestrated by a central brain.

## Agents

| Code | Name | Role |
|------|------|------|
| EDN | EDEN | Central Brain — orchestrates all agents |
| SCT | Scout | Lead Capture & Enrichment |
| IRS | Iris | AI ISA — Voice & Text Qualification |
| ATL | Atlas | Routing & Booking |
| EMB | Ember | Nurture & Reactivation |
| MUS | Muse | Content & Marketing |
| FRG | Forge | Ad Engine & Creative Generation |
| LNS | Lens | Analytics & Intelligence |
| NVA | Nova | Client Onboarding |

## Setup

```bash
# Install dependencies
npm install

# Copy env template and fill in your keys
cp .env.example .env

# Run in development
npm run dev

# Build for production
npm run build
npm start
```

## Architecture

- **Server:** Express.js on Render
- **Agents:** Each agent is a module in `/agents/` with its own system prompt and logic
- **Communication:** Slack (9 individual bot apps) + GHL (SMS/email to leads)
- **Intelligence:** Claude API (Anthropic) powers all agent responses
- **Data:** GHL is source of truth, Meta Ads API for campaign data
- **Events:** Internal event bus for agent-to-agent communication

## Webhook Endpoints

```
POST /webhooks/slack/eden     ← EDEN Brain
POST /webhooks/slack/scout    ← Scout
POST /webhooks/slack/iris     ← Iris
POST /webhooks/slack/atlas    ← Atlas
POST /webhooks/slack/ember    ← Ember
POST /webhooks/slack/muse     ← Muse
POST /webhooks/slack/forge    ← Forge
POST /webhooks/slack/lens     ← Lens
POST /webhooks/slack/nova     ← Nova
POST /webhooks/ghl/contact    ← GHL contact events
POST /webhooks/ghl/opportunity ← GHL pipeline events
```
