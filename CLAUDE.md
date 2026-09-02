# EDEN OS — working notes for Claude Code

Multi-agent system running client acquisition for Eden and Eden's clients.
TypeScript monorepo, Express API, Vite/React dashboard, Postgres on Render.

## Commands

```bash
npm test              # vitest — must stay green
npx tsc --noEmit -p . # typecheck; run before every commit
npm run dev           # API on :3000 (or PORT)
```
Dashboard: `cd dashboards/eden-command-ui && npm run dev` (:5173, expects the API on the port in its `.env`).

## Branching

Branch from `dev`, PR into `dev`, promote `dev` → `main` to deploy.
**Never commit to `main` directly.** Render deploys from `main`.

## Layout

```
agents/<name>/index.ts   one agent; extends BaseAgent, exports a singleton
shared/db/               Postgres pool + schema.sql (applied idempotently on boot)
shared/claude/           Anthropic SDK wrapper — chat, tool loop, attachments
shared/conversation-memory/  durable per-thread chat history (Postgres-backed)
shared/agent-notes/      durable cross-conversation notes — save_note tool, every agent gets it
shared/ghl/              GoHighLevel client
shared/meta/             Meta Ads client + compliance gate
shared/slack/            Slack client + per-agent bot config
shared/security/         constant-time secret comparison — use for any API-key/signature check
shared/events/           in-process event bus (typed in shared/types)
shared/scheduler/        cron jobs (hourly Meta sync, weekly Lens report)
shared/tts/              text-to-speech proxy (ElevenLabs) for the dashboard's voice reply
config/clients/<id>.json per-client config — ALL client specifics live here
server/                  Express routers
webhooks/                inbound webhook handlers
```

**Never hardcode client specifics in agent code.** Stage names, field keys,
calendar IDs, thresholds and pipeline IDs are per-client and change without
warning. They belong in `config/clients/<id>.json`.

## GHL gotchas — each of these has already cost real debugging time

1. **Custom fields come back keyed by internal field id, never by `fieldKey`.**
   A contact returns `[{ id: "uOO2RgUu7n1w9LjJHsQQ", value: "4+ months" }]`,
   not `contact.lf_timeframe`. Resolve keys → ids via `getCustomFieldDefs`
   first (`buildFieldIdLookup` in `agents/forge/ads/attribution.ts`,
   `buildKeyToId` in `agents/scout/intake.ts`). Matching on the key alone
   returns null for every field and looks exactly like "the client left it blank".

2. **The contact LIST endpoint always returns `customFields: []`.**
   Populated fields only come back from `GET /contacts/{id}`. Listing and
   reading fields in one pass silently yields nothing.

3. **A wrong field key never throws — it returns null.** So a typo degrades
   scoring or routing quietly. Verify keys resolve against the live location
   before trusting them.

4. **Workflows are read-only over the API** (`workflows.readonly`). Triggers
   cannot be created programmatically. Anything needing a GHL trigger requires
   a human to build a thin workflow in the GHL UI that POSTs to our webhook;
   EDEN owns the logic, GHL just fires the event.

5. **Opportunities carry `pipelineStageId`, not a stage name.** Map ids →
   names via `listPipelines`, or read a config map backwards.

6. **Don't trust stage/status alone for outcomes.** 3% never sets GHL's
   won/lost status — every opportunity reads `open` and the outcome is the
   column the card sits in. See `ghl.outcomeStages` in the client config, and
   `deriveWon` / `derivePipelineActive`.

## Verify against live data before you believe a config

Every config in this repo has had at least one wrong value that typechecked
fine. Field keys with typos, a calendar id differing by one glyph, thresholds
that were mathematically impossible to satisfy, stage names that didn't exist.

Write a throwaway script, run it against the live account, and check that the
fields you depend on are actually populated — not just that they resolve. A
field that exists but is empty on every record is worth knowing about before
you build scoring on top of it.

## Money

Confirm the specific dollar cost with Jacob before doing anything billable —
image generation, voice minutes, new paid services, plan upgrades. A general
"go ahead" on a task is not approval for its costs.

## Style

Comments explain *why*, especially where a value looks arbitrary or wrong.
When you correct something, record what was wrong and how it was found — most
config values here look plausible and are load-bearing.
