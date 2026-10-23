# Ember — nurture / reactivation working notes

Ember re-engages dormant leads by SMS, qualifies them with the client's
`iris.qualificationQuestions` (scored by Iris's `qualify()`), and when a lead is
qualified and agrees, queues an Iris call (`iris_pending_calls`, source `ember`).
Iris never texts Ember's leads (`irisHandleInboundSms` returns false for `ember`).

Turning a client on or off = `ember.enabled` in `config/clients/<id>.json` + deploy.

## Product rules (decided with Mark and Jacob, Sep–Oct 2026)

- **Who**: only `ember.includeStages` (Not Ready and Replied — Long Term Nurturing was removed
  2026-10-24; leads already being worked in a stage taken off the list are dropped quietly). Dormancy per stage via `stageDormancyDays`
  (e.g. Replied after 14 quiet days) and `dormancyThresholdDays`.
- **Stop for good** on clear evidence — asked to stop, bought/sold, working with another
  agent, no longer looking: move to `ember.notInterestedStage`, never contact again
  (`agents/ember/status.ts`). "Not ready / next year / busy / no reply" keep nurturing;
  "not right now" pauses 180 days. "Don't call me" is a call preference, not a texting
  opt-out. One courtesy reply to a no — never after STOP.
- "Are you a bot?" → it's the team's virtual assistant. Never names an individual agent.
- **CASL**: re-approach only within 6 months of the lead's latest inquiry unless express
  consent is confirmed.
- SMS must fit one segment: `smsSafe` drops emoji and folds accents; openers ≤160
  characters including the STOP line; replies trimmed to 160.
- Sends from a pinned number (`ember.outreach.sms.fromNumber`, required). Team members
  (GHL users' phones/emails) and `ember.excludePhones` are skipped.
- After 15 Ember replies in one conversation, hand to a human.

## Self-pause (`agents/ember/health.ts`, `ember_health` table)

Hiccup → 60-minute cool-down, auto-resume (3rd in a day → stop). Number/account refusal
or a STOP spike (≥3 and ≥25% of the day's sends) → stop until Slack `ember_resume_sending`.
A lead is parked after 3 failed sends.

## Gotchas

- Never run `npm run dev` locally against the prod DB — a second scheduler double-dials
  and double-texts.
- There's no `ANTHROPIC_API_KEY` locally, so AI paths (personalized openers, reply
  classification) only run on Render.
- A Twilio number with no inbound SMS URL answers replies with Twilio's default
  auto-reply and the message never reaches GHL. Check that before blaming Ember.
