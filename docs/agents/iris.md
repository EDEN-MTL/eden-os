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
- **A failed warm transfer: read the gzip log, not the tool result.** The `transferCall` result ("Transfer failed due to
  user hangup" / "Transfer completed") arrives about 2 seconds after the tool call on every attempt, success or not, so it
  says nothing. The real story is the `call.warmTransferStateChanged` events in `artifact.presignedLogUrl`
  (`PENDING` while the ring group rings, `ACTIVE` once an agent answers) and `call.statusReceived` for the agent leg
  (`ringing`, `completed`). Timeline of the five attempts pulled 2026-11-11: success = PENDING, an agent answers
  in about 16s, the transfer assistant briefs them for about 50s, merged (lead on hold about 67s). Ritu Patel (11-05) = an agent
  answered at 16s but the lead hung up at 71s, just before the merge. Michelle Smith Funk (11-11) = the ring group rang 23s
  and the agent leg ended with nobody answering, Iris said `AGENT_UNAVAILABLE_LINE`, and the lead hung up 4s later.
  Jalpesh Patel (09-24) can't be diagnosed: Vapi no longer returns that call. In all three the endedReason is
  `customer-ended-call-before-warm-transfer` (`TRANSFER_ABANDONED_REASONS` in `vapi-webhook.ts`).
  **What Iris does now (Mark, 2026-11-11, `agents/iris/transfer-resume.ts`):** `handleAbandonedTransfer` puts the lead's
  queue row back to pending, due in 3 minutes, source `transfer-resume`, with `lead.transferResume` holding what she
  learned (her `save_isa_notes`). The call back opens by saying the call got cut off and that she will connect them
  again, asks nothing else, and transfers on a yes (`transferResumeCallLines` in `scripts.ts`; the question keeps
  "connect you with" so the `transferCall` rejection plan lets it through). If that call is not answered, or the second
  transfer drops too, `textTransferResumeQuestion` texts once ("Did you hang up, or would you still like to be
  connected?") and holds the row for a reply; the reply is answered by the text prompt's resume block, which knows they
  are already qualified and uses `schedule_transfer_call` on a yes. Skipped (Slack note only) when a teammate is in touch;
  expires after 48 hours; no agent line = no call. Michelle was texted by hand the same way on 2026-11-11.
  **Second trigger (Mark, 2026-11-17, Jerrick Mendoza):** a lead who hangs up at the moment Iris asks to connect them,
  before any transfer starts, is reported by Vapi as a plain `customer-ended-call`, so none of the above ran and he was
  left qualified with nothing queued. `hungUpAtTransferAsk` (transfer-resume.ts) catches it from the transcript (she spoke
  last, her line was the transfer ask, the lead answered nothing, at least 3 lead turns) and calls the same
  `handleAbandonedTransfer`. Also: the call back is due in 1 minute (was 3); when Iris saved no `save_isa_notes` the retry
  carries Vapi's own call summary so nothing is re-asked; the text has four wordings picked per lead
  (`buildTransferResumeText`, seeded by contact id); and a reply of "not now / not sure" gets a better time offered and
  booked on the lead's own calendar (`check_availability` + `book_appointment`) by the text prompt's resume block. The
  voice prompt for the call back is unchanged, so `check-iris-call-prompt.ts` was not needed.
- **`customer.speech.timeout` hook** fires on the first silence gap anywhere in the call,
  not just at pickup. Fixed by changing *what* it says (`IDLE_NUDGE_VARIATIONS`, short
  check-ins, `triggerMaxCount: 3`), plus a second hook with `endCall` at 30s. Widening the
  timer three times didn't help. An `assistant-ended-call` from that hook must not count
  as answered — see `genuinelyAnswered` in `vapi-webhook.ts`.
  **Never give the `say` hook a `prompt`** (tried Oct 12 to tell a screener's hold from a quiet lead):
  Vapi generates that line without Iris's prompt, and on Magar Bhuma's two calls (2026-11-05) and
  once on Oct 18 the model answered "I'm Claude, an AI assistant, I'm not actually on a phone call"
  into a live conversation, then the endCall hook hung up. It speaks a fixed `exact` line again.
  Chat-testing can't reproduce this (the chat gives the model Iris's prompt); the proof is in the
  call's gzip log (`artifact.presignedLogUrl`): the hook's line never appears as a model request.
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
- ASAP watch (Mark, 2026-11-05; `asap-watch.ts`, config `iris.asapWatch`, off until `enabled`): three passes a day
  (10:15, 1:15, 4:15 St. John's) over active cards NOT in `skipStages` (booked, with an agent, finished, No-Show, the weekend
  cohort's Not Ready). For every lead whose timeline reads ASAP it reads the GHL thread plus Iris's own call transcripts,
  decides if a text is due (`decideAsapText`: not DND, nothing booked, no teammate in touch, not texted in 24h, no call
  due within 6h, lead didn't text last, under 6 texts / 14 days), has the model write ONE text from that history
  (`composeAsapText`; checked: one question, under 320 chars, no emoji/links/opt-out line, one retry), sends it with
  `sendIrisText`, and opens the lead's queue row (source `asap`, call_after infinity) so a reply reaches Iris's text
  handling. A lead who texted last, hit the text cap, or had 14 days of nothing is posted as "needs a person".
  Dry run, never sends: `COMPOSE=1 npx tsx --env-file=.env scripts/asap-watch.ts` (NOW=… to pretend it is later).
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

### The daily lead follow-up (Mark, 2026-11-12 — Magar Bhuma)

Mark's rule (2026-10-29): Iris checks every lead, every day, works out who needs a follow-up, so nobody is missed. The nightly
review (7:30 AM NL, `lead-review.ts`) did the reading but only listed names, and acting needed someone to ask in Slack; nobody
ever did (zero `review` commands in `iris_slack_commands`). Magar was flagged "qualified, untouched" every morning from 11-05
and nothing happened for a week. He was also number 8 of 16 and the summary showed five; 9 of the 16 were leads already with
an agent.
- `review-followup.ts`, 9:50 AM NL daily, `iris.dailyFollowUp` (`enabled`, `maxPerDay` 5, `kinds`, `snoozeDays` 3). Off until
  Mark says go: `npx tsx --env-file=.env scripts/daily-followup.ts` is the dry run (stages, who would be lined up, who is left out).
- Same vetting as the Slack "act on the flagged leads" command (`pickFollowUpLeads`, shared): do-not-call, no-calls, no phone,
  booked / live transferred, a teammate in touch, an inquiry over 180 days old all leave a lead out. Same follow-up: one call at
  a time, one text after a miss (`queueColdLeadSweep`). It never moves a card.
- Never on its own: leads in a with-agent column (`WITH_AGENT_STAGES`), parked columns (`PARKED_STAGES`: Not Ready, Long Term
  Nurturing), or a lead whose last message is theirs (`unanswered_reply`: a person reads it first). Those are listed in Slack.
- A lead followed up is snoozed from the review for `snoozeDays`, so it isn't dialled daily.
- The "Iris already has them in hand" check ignored nothing: a row parked for a text reply (`call_after = infinity`) counted, which
  would have kept Magar out even on a yes. It now counts only a pending row due within a day.
- The morning summary lists every lead nobody has and only counts the ones with an agent.
- The one text after a missed sweep call depends on the last sweep text, not on call attempts (Mark, 2026-11-16, Magar: his
  earlier calls were the cadence's, so attempt 3 was wrongly treated as a second round and he got no text). `sweep-text.ts` reads
  the lead's thread for the sweep wording within 7 days; none = text, found = no second text, unreadable = no text.

### The stuck-lead check (Mark, 2026-11-17 — Jacob: "why are leads still in Day 1 AM, Day 1 PM...?")

Iris owns the pipeline's early stages, so a card that is not moving, has no tag, no notes, or never got a first text or call is
Iris's problem to analyse and resolve. Audit of the 36 early-stage cards on 11-17 found why they sat there:
- **A call that connected but never finished** (hung up in 30-40 s, a bad line, silence) counts as "answered": the queue row
  stays 'placed', nothing re-opens, and the card keeps the stage of the first miss (Chris Snook, Daniel Eiriz, Robert Critch,
  Kaitlyn Sheppard, ...). `moveToFollowUpStage` only ever ran on an *unanswered* attempt.
- Calls that were never answered ran out (3-8 misses) and the card stayed in the last stage (Jerrett Warford, Melanie Petten, Arif Abu).
- A wrong number (Ell Dee, 14 days in Day 1 AM, "Wrong number" on the 11-03 call) nobody closed.
- ~13 old Replied cards (50-90 days; bare phone numbers; no tag, no notes, nobody ever contacted).
- There is no "New Lead" stage in this pipeline: Buyer Leads is the intake column.

`stuck-leads.ts`, 10:20 AM NL daily (after the 9:50 follow-up, so what it lined up reads as "in hand"), `iris.stuckLeads`
(`enabled`, `stagePatterns` regexes on stage names, `stageTags`, `maxCallsPerDay` 4, `maxTextsPerDay` 3, `maxMovesPerDay` 10,
`extraTriesForUnfinishedCalls` 2, `quietDays` 3, `giveUpAfterDays` 5, `maxNudges` 2, `autoContactMaxDays` 60, `recheckDays` 3,
`personRepeatDays` 7). `diagnoseStuckLead` is a pure function (tested); the first matching rule wins:
1. Leave alone: do-not-call, booking ahead, a teammate in touch (live thread read again before any action), a call already lined
   up, waiting on a reply to Iris's text, handled in the last `recheckDays`.
2. A person's: no phone, tagged live transferred but the card never moved, the lead texted last, inquiry over 180 days (Jacob's OK,
   CASL) or over `autoContactMaxDays`, an old lead nobody ever contacted, a qualified lead that stopped moving. Listed in Slack
   once a week (`iris_stuck_actions` remembers).
3. Wrong number (the lead's own words on a call) -> tags "wrong number" + "do not call", card to Not Interested, queue row skipped.
4. Nobody ever contacted (recent lead) -> first call now.
5. Unfinished call (lead hung up / silence at any length; a call Iris ended herself only if under 2 minutes) -> call again at the
   other half of the day (`retryStartAt`), up to 2 extra tries >= 20 h apart; a "no calls" lead gets a text instead.
6. Never reached anyone: one text after the calls, then Not Ready after `giveUpAfterDays` of silence.
7. Talked to Iris, then quiet -> a follow-up text written from the thread (the ASAP watch's writer and checks, its own prompt
   `STUCK_COMPOSER_SYSTEM`, one model call, a few cents a day), at most `maxNudges`, then Not Ready. A qualified lead who has answered us goes to a person; one who never answered a text gets the same follow-ups and move (Mark, 2026-11-17, Magar Bhuma), and the note says a person can pick them up from Not Ready.
Texts reopen the lead's queue row (source "stuck") so a reply is answered by Iris. Dry run: `scripts/stuck-leads.ts` (no writes,
stub text writer). The SMS composer prompt is not covered by `check-iris-call-prompt.ts` (it is a text, not the call prompt).

### "Please no Calls" is not an opt-out (Mark, 2026-11-06 — Kelly Joseph)

A new lead answered the intake text with "Please no Calls". The old classifier called that `opt_out`: row closed, "do not call"
tag (which every watcher reads as stop-everything), "we won't reach out again" sent. Mark: don't assume they no longer want
to talk to us. `classifyInboundText` now has `no_calls` (refuses phone calls only; "don't call or text me" and "not
interested" stay `opt_out`). `markLeadNoCalls` (`agents/iris/sms.ts`) keeps the row `pending` with `call_after = infinity`
(nothing dials), sets `lead.noCalls`, tags the contact **"no calls"**, and Iris qualifies by text: `buildSmsQualificationPrompt`
with `noCalls` acknowledges it, asks the missing questions, drops `schedule_transfer_call`, and ends by asking when one of the
agents can talk to them to send listings (book_appointment, or request_human_followup if they only want text).
`dial-pending.ts` checks the tag live before EVERY dial (sweeps, cohort and retries create fresh rows that don't know the old
text), and Slack "call X" refuses a "no calls" lead. The classifier itself can only be checked on Render (no local Anthropic key).

### Her name cut off on a call screener (Mark, 2026-11-20 — OG Phranky)

A phone-company call screener asked OG Phranky's caller for a name and reason; Iris began "Iris." and the call log shows only "I"
(Mark heard it too). Her instructions were right (say only "Iris."), and Vapi had been given all five characters. Cause: her
`stopSpeakingPlan` had `numWords: 0`, which makes Vapi stop her on any voice activity lasting `voiceSeconds` (0.3 s), so a beep
or line noise chops a half-second word. It is now `numWords: 1`: she stops only for a real transcribed word ("stop", "no", "wait",
"actually" always interrupt at once, "okay"/"yeah" never do, per Vapi's schema); `voiceSeconds` is not used once `numWords` is above
0. Cost: a person talking over her is heard after their first word is transcribed (a fraction of a second later). The automatic call
review also flags a bot line that is only a fragment of her name ("I", "Ir", "Iri"), so a cut-off is never silent again. The
transcript can also drop the name entirely (call 277 shows no bot line though five characters were synthesised), so a missing line
on a screener call is not proof it was not said; a fragment is.

### The client's own agents are not leads (Mark, 2026-11-19)

Genna, Candice, Ashley Fleming, Stephanie Mcgrath, "andrew@ateamnl.ca", Chelsea and five bare phone numbers sat in Replied and were
listed by the stuck-lead check as old inquiries for Jacob to decide on. They are 3% Realty's agents (their phones and emails are
the GHL users'). Ember already skipped team members by phone and email at enrollment; the lead review, the stuck-lead check and the
ASAP watch only skipped Eden's own test emails. `isTestContact` (`agents/iris/lead-review.ts`) now also takes the team
(`loadTeamIdentity`: every GHL user's phone, last ten digits, and email, read once per run; a failed read excludes nobody and
fails nothing) and skips any contact whose phone or email is a team member's. 11 of the 33 early-stage cards were team members.

### Magar still in Buyer Leads two weeks on (Mark, 2026-11-19)

Three calls and two texts and the card never left Buyer Leads. Why: (1) the move to a follow-up column ran only for an unanswered
normal-cadence call or (since 11-17) a connected one; Magar's later calls were unanswered SWEEP/callback calls, which never moved a
card. `moveIntakeCardAfterCall` now runs for every automatic call that did not end in a transfer (not an error). (2) The stuck-lead
check "waited on the reply to Iris's text" and never looked at the column. It now also moves any card still in an intake column
that Iris has already tried to the follow-up column for her attempts (`advanceAttempt`, action `advance_stage`, a note on the card),
whatever else it decides about the lead; assigned, booked, transferred, do-not-call leads and leads a teammate is on are left
alone. (3) **GHL rate limiting**: a scan of ~30 leads got "429 Too Many Requests" on a third of them (Magar, Jerrick, Daniel...)
and skipped them silently; there is no sign the 11-18 10:20 run did anything (no action rows, no Slack post). `ghlRequest` now
repeats a 429 (waits Retry-After, else 1/2/4 s, three times; a 429 means nothing was processed), the scan runs three cards at a time,
and the post says how many cards it could not read.

### A lead assigned to an agent is left alone (Jacob, 2026-11-19 — Sabrina Marie)

Ember reactivated and texted Sabrina Marie (assigned to Justin Penney, tagged live transferred, with Jacob's earlier calls and
texts) as if she were a cold inquiry, and read "I'm working with someone, thank you" as a buying signal. Jacob: "if they are assigned
to an agent, the AI leaves them alone." The rule, checked live from the contact and from any open card (GHL keeps both):
- **Iris:** `checkHumanTouch` (`agents/iris/human-touch.ts`) now answers `human` with `kind: "assigned"` for an assigned lead, so every
  path that already stands down for a teammate (the pre-dial check, text replies, the stuck-lead check, the follow-up cohort, the daily
  follow-up, ASAP and callback watch, the card moves in `reasonToLeaveLead`) stands down for assignment too. It is switched off with
  `includeAssignment: false` only where an agent is expected and the lead is still Iris's to message (the no-show rebook) or where a
  teammate has explicitly asked in Slack (shown to them as a warning). The stuck-lead diagnosis lists an assigned card as "leave".
- **Ember:** a card with an assignment is never enrolled (`classifyForEnrollment`), every touch re-reads the live contact and card and
  exits the lead if it is assigned (`sendTouch`), and a reply from an assigned lead is not answered: the lead exits and the team is
  told in #backend-ops that it is for the agent to answer (`agents/ember/assigned.ts`, `emberHandleInboundMessage`).
About half of the leads of the last six weeks are assigned and new leads are not, so this is a real signal, not a blanket stop. An
assignment made to a service user (for example "Buyer Live Transfer") also counts; if that proves too broad, add an ignore list.
"I'm working with someone" being read as interest is the same bug seen from the other side, and is not changed here.

### Iris contradicted herself in Slack (Mark, 2026-11-18 — Daniel Eiriz)

Iris posted "Daniel Eiriz was qualified and hung up when Iris asked to connect them to an agent". Mark asked in the thread "when
did you qualify this lead?" and she asked for the lead's name, then said he "hasn't been qualified in the system". Three faults:
1. **The post was false.** `hungUpAtTransferAsk` matched "get you connected" in her own opening line ("…then we can get you
   connected with someone who can send over some listings"); Daniel said hello three times and hung up. It now also needs at
   least three different qualifying topics (budget, timeline, area, home type, pre-approval, realtor) in her lines before the
   ask. (A wrong "qualified" had also queued a resume call that skips the questions.)
2. **She did not remember her own post.** Only a few call sites seeded a thread's history. `sendMessage` (shared/slack) now
   remembers every post: a top-level post or a reply goes to that thread's history, a DM to the person's DM history.
3. **Her prompt defined "qualified" as the tags.** It now separates qualified (details gathered, shown in the call and notes)
   from booked/transferred (the tags), tells her to pull the real call before answering a "why did you say that", to own a
   wrong earlier claim first, and to use Slack bold (single asterisks).

### The weekly patterns digest (Mark, 2026-11-18)

"How can Iris be smarter, see patterns and repeated problems on her own?" Step one is `agents/iris/pattern-digest.ts`: every Monday
8:30 AM NL (`iris.patternDigest`, scheduler) Iris DMs Mark what keeps repeating in her own last seven days against the seven before:
hang-ups grouped by what she had just asked (budget, timeline, area, "connect you with an agent", ...), repeated call-review
flags, out-of-character slips ("I'm Claude"), calls where she kept asking the lead to repeat themselves, leads who asked her to hold
on or call later, plus what the stuck-lead check did and who has waited on a person two weeks running. A pattern needs `minRepeat`
(3) calls; a slip is reported even once; one that also happened last week is marked "again". It is plain counts over the call
transcripts: no AI model, no GHL calls, no cost, and it never changes anything. Each pattern says what a person should look at; the
fix is built by hand (with a test and a ledger row) once Mark picks it. Next steps up, not built: Iris drafts the fix and the test for
Mark to approve; then she applies only reversible fixes herself. The call prompt is never changed by her. Preview without sending:
`npx tsx --env-file=.env scripts/pattern-digest.ts`.

### A call that connected but did not transfer moves the card (Mark, 2026-11-17 — Magar Bhuma)

Magar's two first-day calls connected (one ended when they said "hold on, important call", one was the "I'm Claude" slip), neither
reached a transfer, and the card sat in Buyer Leads for eleven days. `moveToFollowUpStage` only ran for a call nobody picked up, and a
connected call leaves the row `placed`, so nothing watched it. `moveIntakeCardAfterCall` (`webhooks/vapi-webhook.ts`) now runs
after every automatic call that connected (or whose transfer was abandoned) and did not end in a successful transfer: if the card is
still in an intake column (`iris.moveAfterConnectedCall.fromStagePatterns`: Buyer/Seller/Downsize/Upgrading Leads) it moves to the
follow-up column for that attempt, with a note. Cards the call itself moved (booked, live transferred, not interested) are not in an
intake column any more, so nothing is pulled back; a lead a teammate has is left alone (`reasonToLeaveLead`). It only moves new
connected calls: cards already stuck are the stuck-lead check's job.

### Busy leads and text-only leads (Mark, 2026-11-17 — Troy Morris)

Troy, on vacation, said no calls for a while and just wanted listings; Iris told him "one of our agents will reach out by text"
before she had qualified him. `buildSmsQualificationPrompt` now has a busy-lead block for every text conversation: acknowledge,
ask when they would be free, offer to ask the few questions by text, qualify by text if they agree, and only then ask when they
could talk to an agent. Until the lead is qualified and a tool has confirmed a booking or the handoff, Iris never says an agent
will call, text or contact them; a lead who just says "later" gets one "when should I check back?" and nothing else.
A lead qualified by text who still refuses calls is not asked again: `request_human_followup` takes `text_only: true`, the CRM
gets a note, and Slack posts "qualified over text, does NOT want phone calls, follow up by hand, no call booked or scheduled" (a
manual-handoff post, never an appointment). If the Slack post fails the tool result says so and Iris must not claim the team was
told. The "no calls" tag still carries the text-only preference. The prompt wording can only be checked on Render (no local
Anthropic key), so watch the first busy-lead threads. The stuck-lead check (below the lead review) still picks up a busy lead who
goes quiet.

### Corrections become tests (Mark, 2026-11-06)

`docs/agents/iris-corrections.md` is the ledger of every time Iris was corrected and the test that pins it. A misread text
becomes a case in `agents/iris/corrections.ts` (checked by `corrections.test.ts`, and against the real model by
`npx tsx --env-file=.env scripts/check-iris-corrections.ts` on Render before any change to `text-signals.ts` ships).

### Reversible by default (Mark, 2026-11-06)

The mistakes that cost leads were misreads acted on irreversibly (Kelly "Please no Calls", Angela's July reply). Rule for any
classifier-driven action: when the message is ambiguous, take the action a person can undo and keep talking. A text stop
(`opt_out` in `text-signals.ts`) is only acted on when the model says `certainty: "clear"` AND the `quote` it gives is
really in the message; anything else is `unsure_stop`: nothing is closed or tagged, the dial is held (`call_after =
infinity`), Iris asks what they mean (`stopCheck` prompt, no tools) and Slack shows the words. A clear stop still closes
the lead but now posts the exact words to the call-log channel. New irreversible actions should follow the same pattern.

### Texting after a missed call (Mark, 2026-11-05 — Melanie Petten)

- After Iris's FIRST unanswered call (a normal new-lead sequence) she texts once (`maybeTextAfterMissedCalls` in
  `webhooks/vapi-webhook.ts`; attempts 2 and 3 are the fallback when the first text could not go). The text is
  `buildMissedCallQualifyText` (`agents/iris/qualify-text.ts`): sorry I missed you, and ONE qualifying question — a form
  range or bucket is narrowed to a specific answer, a missing budget/timeline is asked, and when everything is specific
  she asks for a call with an agent. The lead's reply is handled by the text qualification, which books the call or
  schedules the live transfer. The GHL intake automation still sends its own two texts first; Iris never texts at intake.
- A lead who RINGS BACK and is not picked up gets the same kind of text (`agents/iris/callback-watch.ts`, cron every
  5 minutes, `iris.callbackWatch`). GHL sends no webhook for calls, so it polls the location's recent conversations,
  keeps leads Iris has worked in the last 30 days, and looks for an inbound call under 30 s with nothing after it from
  Iris, a teammate or the lead. One text per call (`callback_texts`, claimed before sending); calls Iris answered
  herself through Vapi (`iris_call_log.triggered_by = 'inbound'`), booked leads, opted-out leads, leads texting with
  Iris and leads a teammate is working are skipped. Overnight calls wait for 8 AM (18 h lookback). Dry run:
  `npx tsx --env-file=.env scripts/callback-watch.ts`.
- `checkHumanTouch` no longer counts a lead's OWN inbound call under 30 s as a teammate's call: GHL stamps the user it
  rang, which made Melanie's call-back look like a teammate had phoned her and would have kept Iris from texting.

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

## A stop is honored whatever state the row is in
A clear stop runs `recordOptOut` (`agents/iris/opt-out.ts`): tag "do not call", card to Not Interested, row closed, words to Slack. It now also covers a lead whose row is `placed` (Beverley Bradbury, 2026-11-11: texted "do not reach out" right after a connected call and was ignored).
