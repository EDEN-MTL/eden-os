# Iris — voice ISA (Vapi) working notes

Iris qualifies new leads by phone through Vapi (Twilio telephony) and live-transfers
qualified ones to the client's ring groups. GHL is the lead source and system of record.
Two separate code paths:

- **Calling pipeline** — `agents/iris/calling.ts`, `scripts.ts`, `dial-pending.ts`,
  `cadence.ts`, `text-signals.ts`, `webhooks/vapi-webhook.ts`, `webhooks/vapi-tools.ts`.
- **Slack persona** — `agents/iris/index.ts` (`IrisAgent`). Its system prompt does **not**
  update itself when the calling pipeline changes. It went stale for 3+ weeks once
  ("calling isn't wired up yet" while calls were live). After any real change to calling
  behaviour, update the persona prompt too.

Iris is **live for real clients** (first: `3-percent-east-coast`, since 2026-09-16).
Anything merged to `main` under `agents/iris/*` or `webhooks/vapi-*` reaches real leads
on the next Render deploy. Validate on `eden-sub-account-one` first.

Kill switch: `npx tsx scripts/disable-iris-calling.ts <clientId>` (enable script mirrors it).
It only gates the dial — it has no effect on whether leads get queued.

## How the pipeline runs

1. A GHL workflow (built by a human in the GHL UI — triggers can't be created over the
   API) POSTs `ContactCreate` to `/webhooks/ghl/contact`.
2. Scout's `lead.captured` handler calls `refreshLead` — a live GHL re-fetch — so only
   `id` and `locationId` in the webhook payload really matter.
3. A row lands in `iris_pending_calls`; the per-minute cron in `dial-pending.ts` dials
   after `CALL_DELAY_MINUTES` (gives the GHL SMS automation a head start).
4. Before every attempt it re-checks live GHL: touched tags, touched stages
   (`iris.liveTransferStageId` + `iris.appointmentSetStageIds`), and the lead's latest
   inbound SMS (`text-signals.ts`: opt-out → tag `do not call`; "call me at 6" →
   one-shot callback clamped to legal hours; anything ambiguous → no change).
5. Cadence: 2 attempts/day × 4 days. Each unanswered attempt moves the opportunity to the
   matching `iris.followUpStageIds` stage; an exhausted sequence gets tag `iris no answer`.
6. Every finished call posts a one-liner to `#iris-call-logs`
   (`IRIS_CALL_LOG_CHANNEL`, literal default in `vapi-webhook.ts`).

## Diagnosing live calls

- Pull the real call from `GET https://api.vapi.ai/call/{vapi_call_id}` and read the raw
  `messages` array (tool calls + results + timestamps). The DB transcript and Vapi's flat
  `transcript` string hide tool calls and timing — several bugs were invisible in them.
- Set a baseline (`MAX(id)` on `iris_pending_calls` / `iris_call_log`) before a test
  submission; the pending row's `call_after` says exactly when the dial will fire.
- Only one Vapi call record exists per outbound call. The transfer assistant's talk with
  the operator isn't separately queryable — `endedReason: assistant-forwarded-call`
  confirms the transfer, not what was said.
- **No leads being called?** Check `iris_pending_calls` row count for the client first.
  An empty queue while GHL clearly has new leads means the GHL intake workflow is broken,
  not Iris. (Once: the workflow's webhook had the test account's `locationId` copy-pasted
  in.) Confirm which GHL account a screenshot comes from — test and real accounts have
  identically named workflows.
- GHL workflow **list** is readable: `GET /workflows/?locationId=…` (Version
  `2021-07-28`). Detail (`/workflows/{id}`) 404s. Good for "is it published / recently
  edited", not for seeing the webhook step.
- Looks like a duplicate Slack message? Query `agent_conversations` first — it tells
  "processed twice" apart from "model kept talking".

## Test techniques that work

- **Backfill a dropped lead**: POST `{type: "ContactCreate", id, locationId}` to the live
  `/webhooks/ghl/contact`. Skip contacts already tagged `replied` / `appt booked` /
  `showed up` / `live transferred`.
- **Full dry-run against a real client**: create contact → fill custom fields (resolve
  keys to ids first) → create the opportunity (API-created contacts don't get one) →
  enroll in the real workflow with `POST /contacts/{id}/workflow/{workflowId}`. This
  exercises GHL's own automation, not just our half.
- Test contacts are reused and carry stale appointments; test names are adversarial
  ("Mr. Beast Scott"). Check the raw submitted name before blaming the model.

## Vapi lessons (each cost multiple live calls)

- **Platform field before prompt.** If a "model ignores instruction" bug survives 2–3
  prompt fixes and fires suspiciously fast or consistently, look for a Vapi field doing
  it mechanically. `firstMessage` under `assistant-waits-for-user` is spoken verbatim
  before the model runs — the "bare Hi" bug was that field for days.
- **Structural over prompt.** Tool-call boundaries can be guaranteed (`rejectionPlan`,
  a tool's own `messages`). Free-form speech order can't — say so instead of promising a
  4th wording tweak.
- **Never personalize a guaranteed message** with anything that can change mid-call
  (e.g. the lead's name — they may correct it). The model can't intercept that channel.
- **Hand IDs forward.** When a later tool needs "which record", an earlier tool returns
  the exact id to reuse (`isoTime` from `check_availability`, `matchedUserId`,
  `appointmentId`). Never let a tool guess "the most recent one".
- **After transfer, Iris has no audio.** Warm transfer completes via SIP REFER; Vapi
  steps out. Any "say something after the merge" feature is infeasible. Warm transfer
  needs Twilio (not Telnyx).
- **`customer.speech.timeout` hook** fires on the first silence gap anywhere in the call,
  not just at pickup. Fixed by changing *what* it says (`IDLE_NUDGE_VARIATIONS`, short
  check-ins, `triggerMaxCount: 3`), plus a second hook with `endCall` at 30s. Widening the
  timer three times didn't help. An `assistant-ended-call` from that hook must not count
  as answered — see `genuinelyAnswered` in `vapi-webhook.ts`.
- **Voicemail**: keep `voicemailDetection` on; "no voicemail message" means omitting
  `voicemailMessage` (Vapi then hangs up). False positives on live pickups: backoff is at
  5s/5s; the next step is provider `google`, which changes behaviour and possibly cost —
  decide with the team, don't switch silently.
- `rejectionPlan` regexes must cover natural agreement phrasing and both word orders, or
  transfers get silently rejected.
- Concurrency is Vapi's account-wide slot limit (visible in Vapi's dashboard). `placeCall`
  doesn't yet check `concurrencyBlocked` — a blocked call would strand the lead.
- dotenv turns `KEY=` into `""`; Vapi rejects an empty `serverUrl`.

## Slack-side

- Proactive posts (`BaseAgent.post()`, `postCallLogToSlack`) seed conversation history
  under Slack's **resolved** channel id + `ts`, so thread replies have context. Posts made
  before 2026-09-23 have no seeded history.
- Iris's Slack tools: `iris_lookup_lead`, `iris_pipeline_stats`.
- Acting on the nightly lead review (`iris_act_on_review`, `prepareReviewActionCommand` in slack-commands.ts):
  Mark or Jacob says "act on the flagged leads", Iris re-reads every flagged lead LIVE (the review is up to a day
  old) and drops anyone do-not-call, booked, without a phone, touched by a teammate (calls count), already queued
  or called since the review, or whose inquiry is over 180 days old (unless they texted last). One summary, one
  yes, then the same sweep as "follow up on Jacob's calls" (one call at a time, one text after a miss). A review
  older than 36h is refused. Stored as `iris_slack_commands.kind = 'review'`.

## Per-client setup for a new client going live

`iris.liveTransferStageId`, `iris.appointmentSetStageIds`, `iris.followUpStageIds`
(one per cadence slot, in order), `iris.timezone`, transfer ring groups — every id
verified live with `listPipelines`, never guessed. `VAPI_PHONE_NUMBER_ID` is still a
single global env var; it moves into client config when a second client needs Iris.

## Known open items

- `placeCall` ignores `concurrencyBlocked`.
- Automatic cadence retries don't refresh the lead snapshot from GHL.
- Iris SMS channel scoped, not built.
- No decision yet on how the human agent introduces themselves after a merge, or where
  off-script inquiries (e.g. CHIP program evaluations) should transfer.
- The multi-hook nudge → endCall timing hasn't been proven on a fully silent live call.
