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
- Specific answers (Mark, 2026-11-03): the form only gives buckets ("$299K-$600K", "3-6 months", "ASAP"). Iris used
  to confirm the bucket; now `verifyBudgetLines` / `verifyTimelineLines` narrow a range or bucket ("what specific
  budget do you have in mind?", "any particular timeline in mind?") and `specificAnswersRule` (scripts.ts) adds the
  rule: one follow-up per topic, accept "I don't know", the specific figure replaces the range in the recap and in
  `save_isa_notes`. A single figure or a specific date is still just confirmed (`isBudgetRange`, `isTimelineBucket`).
  Not on no-show calls. Checked with scripts/check-iris-call-prompt.ts (the four "vague budget" cases).
  Text qualification does the same (`specificAnswersSmsRule` + the "ask for a specific number" tags in the Already-known
  block of `buildSmsQualificationPrompt`); no-show texts are untouched.
- Daylight saving and the scheduler: all crons run in `SCHEDULER_TIMEZONE` (America/Toronto). When the clocks go back,
  node-cron skips the repeated hour for jobs pinned to a zone: on 2026-11-01 the every-minute call job paused 06:00-07:00
  UTC and the watchdog posted a false "scheduler stalled". The watchdog now ignores a quiet scheduler for 3 hours after
  the zone's offset changes (`clockChangedRecently`). Calls are unaffected in practice (the hour is the middle of the night).
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

## Home-services text flow (Matama Floors) — `agents/iris/home-services/`

A separate, text-only path for estimate requests (floor sanding), not part of the Vapi/real-estate pipeline above.
It never touches `iris_pending_calls`, Vapi, or the `iris` config block; a client opts in with an
`irisHomeServices` block in `config/clients/<id>.json` and `enabled: true`.

**How it runs at Matama.** Pedro's GHL automation ("1) ... Survey Submission ... Create Opportunity in New Lead
stage" then "2) English/French Floor Sanding Initial Nurture", both in the Matama workflow folder) creates the card
and sends the introduction, the "$500 off" text and the "my virtual assistant Iris will ask a few quick questions,
roughly how many square feet or rooms?" text. **Iris starts when the lead replies**: she acknowledges the size, asks
when they are free (morning / afternoon / evening), then the address (street, neighbourhood, postal code), files the
card in Loose Appointment Day (morning/afternoon/anytime) or Night (evening), writes the contact note and alerts
Pedro with name, address, phone, size, availability and notes. Anything specific the lead says about timing
("after 6pm", "Tuesday the 18th") goes in the note as written; Iris never confirms a time.

- **Ships off and in `dry_run`.** In dry-run nothing reaches a lead or GHL: drafts, would-be stage moves, tags,
  notes and owner alerts are posted to `IRIS_CALL_LOG_CHANNEL` prefixed "DRY RUN". `mode: "live"` must be set explicitly.
- **No GHL workflow needed.** Intake polls the intake stages every minute; replies are polled every 2 minutes
  (same approach as Ember's reply poll). A card's replies count from the moment the card was created. Only cards
  created at/after `enrollNotBefore` are ever enrolled — older ones are backlog, and texting them is a CASL consent
  decision nobody has made (Ember's rule is 6 months from the latest inquiry). `readinessProblem()` refuses to run a
  half-filled block.
- **Columns are stage names, resolved live** (`config.ts` `resolveStageRefs`) against the pipeline on every run
  (cached 10 min). A renamed or deleted column makes the jobs stop and log once, rather than move a lead somewhere wrong.
- **Iris sees the real thread** (`recentTexts`), including what the automation already sent, so a bare "885 ft2"
  makes sense. She is told not to re-introduce herself, and not to confirm the terms of the $500 offer.
- **Guardrails are in code, not just the prompt** (`engine.ts`): `move_to_column` refuses until name, address,
  size, availability and phone are collected (`lead-info.ts` `missingRequired`); a lead already in a Loose column is
  never moved out (only the owner does that); the note and alerts are built from collected facts with "unknown"
  for gaps (`lead-info.ts`, `notify.ts`), never composed by the model; STOP/ARRÊT/unsubscribe is caught by regex
  before the model sees the text (`messages.ts` `isOptOut`); a teammate texting the lead keeps Iris out
  (`checkHumanTouch`).
- **Pedro's text alert is a GHL workflow, not code.** Before moving a card (and before adding the "Needs Pedro"
  tag) Iris fills the contact custom field named by `isaNotesField` ("ISA Notes", multi-line text, must already
  exist) with a plain-text summary: name, address, phone, job, availability, photos, notes (`notify.ts`
  `formatIsaNotes`, built only from collected facts). A workflow in Pedro's sub-account triggers on "pipeline stage
  changed to Loose Appointment Day / Night" (and a second one on tag "Needs Pedro" added) and texts him
  `{{contact.isa_notes}}`. If the field cannot be written the card is not moved, so nothing sits in a Loose column
  unannounced. A card Pedro drags into a Loose column by hand carries stale or empty notes. Slack
  (`notify.slackChannel`) is only a team-visible mirror. In dry-run the would-be field value goes to the Iris log
  channel.
- **Texts are kept short and human in code, not just in the prompt** (`reply-style.ts`): one paragraph, no dashes,
  emoji only if the lead used one first, and a reply over ~230 characters / 3 sentences gets one "say it shorter"
  model retry before it is queued (if that fails the tidied original goes out). A closed lead (not interested,
  out of area, photo-quote) who texts "thanks" gets a short courtesy reply but stays closed and is not re-tagged.
- **Everything outbound goes through `iris_hs_outbox`**: human-sized delay, quiet hours (default 9:00-20:00,
  `America/Toronto`), dry-run and restart safety in one place. Unsent first touches/follow-ups older than 12h are
  cancelled, never sent late.
- **Optional outreach, off at Matama.** `outreach.firstTouch` / `outreach.followups` make Iris send the first text
  and the Day 1-3 cadence herself (`messages.ts` templates, then tag "Long-term Nurture" and stop). Matama's
  automation already does this, so both stay off — turning them on would double-text leads.
- **Known gaps / decisions still open:** backlog enrolment is not wired; no calendar booking (a specific time
  stays in the notes for Pedro to confirm); a photo-only MMS is invisible to the reply poll; two texts sent in quick
  succession are answered as one (the newest wins); the lead-facing templates
  name Pedro / Planchers Matama directly, so a second client means moving those strings into config; whether the GHL
  automation stops its own later reminders once a lead replies is unverified.
- Offline check of the conversation behaviour: `scripts/simulate-matama-iris.ts` (ten scenarios, a second model
  plays the lead, in-memory fakes — costs real model calls, so confirm the budget first).

## Known open items

- `placeCall` ignores `concurrencyBlocked`.
- Automatic cadence retries don't refresh the lead snapshot from GHL.
- Iris SMS channel scoped, not built.
- No decision yet on how the human agent introduces themselves after a merge, or where
  off-script inquiries (e.g. CHIP program evaluations) should transfer.
- The multi-hook nudge → endCall timing hasn't been proven on a fully silent live call.
