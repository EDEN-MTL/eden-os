# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm run dev         # tsx watch server/index.ts — hot-reloading dev server
npm run build        # tsc — compiles to dist/
npm start          # node dist/server/index.js — run the compiled build
npm run lint        # eslint . --ext .ts
```

There is no test suite yet (no test runner installed, no test script in package.json).

Local development needs a `.env` file (see `.env.example`) with at minimum `ANTHROPIC_API_KEY` and the `<AGENT>_BOT_TOKEN` / `<AGENT>_SIGNING_SECRET` pairs for whichever Slack agents you're testing — the server won't crash without them, but `shared/slack` skips initializing any agent whose token is missing (logged as a warning), and `shared/claude` calls will fail without the Anthropic key.

## Architecture

This is a monorepo for **EDEN OS**, a multi-agent Slack-based system where each of 9 agents is a separate Slack app/bot backed by one shared Express server.

**Agent pattern (`agents/base-agent.ts`):** Every agent extends the abstract `BaseAgent` class, which owns the entire message-handling lifecycle — a subclass only needs to implement `getSystemPrompt()`. `BaseAgent.handleMessage()`:
1. calls the agent's overridable `handleCustom()` hook first (return a string to short-circuit with non-Claude logic; return `null` to fall through — the default no-ops);
2. maintains per-conversation history in-memory (`Map` keyed by `dm:<user>` or `channel:<channelId>:<threadTs>`, capped at the last 20 messages — history is lost on server restart, there's no persistence layer);
3. calls `shared/claude`'s `chat()` with the system prompt + history;
4. posts the reply back to Slack via `shared/slack`'s `sendMessage()`, threaded if the incoming message was.

Only `agents/eden-brain` has a fleshed-out system prompt and event-bus subscriptions. The other 8 (`scout`, `iris`, `atlas`, `ember`, `muse`, `forge`, `lens`, `nova`) are one-line-system-prompt stubs with no `handleCustom` override, no event subscriptions, and no use of the `shared/ghl` or `shared/meta` clients yet — building out an agent mostly means writing its system prompt, overriding `handleCustom` for anything that shouldn't go through Claude, and wiring event subscriptions/API calls as needed.

**Slack transport (`webhooks/slack-events.ts`):** Each agent gets its own route, `POST /webhooks/slack/<agentId>`, registered in a loop over the 9 `AgentId`s. Each route independently: answers the Slack `url_verification` challenge, verifies the per-app HMAC signature (via `getSigningSecret` from `shared/slack`, using that agent's own signing secret — different apps have different secrets), ignores bot/edit/delete events to prevent loops, then builds a `SlackIncomingMessage` and calls that agent's `handleMessage()`. `shared/slack` holds a `Map<AgentId, WebClient>`, populated once at boot by `initSlackClients()` (called from `server/index.ts`) — each agent posts through its *own* bot token, not a shared one.

**Event bus (`shared/events`):** A thin wrapper around `eventemitter3` — `eventBus.publish(type, agentId, clientId, data)` and `eventBus.subscribe(type, handler)`. Note the wrapper does not override `EventEmitter.emit` directly (that broke TypeScript's generic signature); logging happens in a private `emitEvent` method that `publish()` calls instead. `webhooks/ghl-webhook.ts` publishes `lead.captured` when GHL reports a new contact, but no agent currently subscribes to that event — `eden-brain`'s three subscriptions (`alert.bottleneck`, `lead.qualified`, `appointment.booked`) are all `console.log` placeholders. The event bus is fully wired but largely unconsumed; this is the main gap between "scaffold" and "working pipeline."

**External API clients (`shared/ghl`, `shared/meta`):** Both are complete, working REST wrappers (contacts/pipeline/calendar/SMS for GHL; campaigns/ad sets/insights for Meta) — they just aren't called from any agent yet. When building out an agent's real logic, use these rather than writing new fetch calls.

**Client config (`config/clients/*.json`):** Matches the `ClientConfig` type in `shared/types`. Credential fields use an `env:VAR_NAME` string convention (e.g. `"apiKey": "env:GHL_3PCT_API_KEY"`) — this is documentation-only right now; no code resolves these references yet, so don't assume a config loader exists.

**Path aliases:** `tsconfig.json` declares `@shared/*`, `@agents/*`, `@config/*`, but nothing in the codebase uses them and there's no `tsconfig-paths` (or equivalent) wired into the build/dev scripts — relative imports (`../shared/...`) are what actually resolves at runtime.

**Deployment:** Single Express server (`server/index.ts`) deployed as one Render web service, auto-deploying from `main`. All secrets (per-agent Slack bot tokens + signing secrets, `ANTHROPIC_API_KEY`, and eventually GHL/Meta keys) are Render environment variables, not committed anywhere.

**Git:** `main` and `dev` are both protected (PR required, no force-push/delete). Feature branches are prefixed by owner (`jacob/...`, `mark/...`) per the team's two-person split.
