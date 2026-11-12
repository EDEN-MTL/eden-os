# Iris corrections ledger

Every time someone says "this should not happen" about what Iris did, it lands here, with the test that now stops it
coming back. Mark, 2026-11-06: "I want Iris to learn." Iris cannot change her own prompt or rules safely (two real people were
lost to an untested prompt change), so learning means this ledger and its tests grow with every correction.

**When Mark or Jacob corrects Iris:** (1) fix it, (2) add the test that fails without the fix, (3) add a row below. If the
mistake was about how a TEXT was read, add a case to `agents/iris/corrections.ts` instead of (or as well as) a unit test: those
cases run in `corrections.test.ts` and, against the real model, in `scripts/check-iris-corrections.ts` (needs the Anthropic key,
so run it on Render) before any change to `text-signals.ts` ships. A change to the call prompt or tools still runs
`scripts/check-iris-call-prompt.ts`.

| Date | Lead | What Iris did wrong | What is right | Pinned by |
|---|---|---|---|---|
| 2026-09-21 | (live call) | Read "I'm not looking to sell, I want a CHIP program valuation" as an opt-out or time request | A correction of what they want: no signal | `corrections.ts` chip-correction |
| 2026-09-22 | Catherine | Ignored a text asking to be called at 6 pm | Reschedule to exactly that time | `corrections.ts` catherine-six-pm, `text-signals.test.ts` |
| 2026-09-25 | Kaitlyn Sheppard | Answered "Yes!" to the intake text by launching into buy-or-sell questions | A bare yes to a call offer is confirming the call | `sms.test.ts` |
| 2026-10-01 | Saife Sarwar | Kept deferring to text after a clear "Ys" to "you'll receive a call" | A clear yes to a call offer means call soon | `corrections.ts` saife-ys |
| 2026-10-13 | Angela Marie | A July reply about pausing a search closed her queue on a fresh form | Only a recent text counts as an instruction | `dial-pending.test.ts` (stale inbound) |
| 2026-10-14 | Jesse Noseworthy | Asked for noon, read "noon" as tomorrow's noon every attempt | Read the time as of when they texted | `dial-pending.test.ts` |
| 2026-10-15 | Samir Benslimane | A lead taken through every question by text was refused a call by the numeric score bar | Qualified by text means Iris calls to connect them | `sms-handoff.test.ts` |
| 2026-11-05 | Melanie Petten | One missed call, no text, next call a day away; her own 6-second call-back counted as a teammate's | Text after the first miss; a lead's own short inbound call is not a teammate's | `vapi-webhook.test.ts`, `human-touch.test.ts`, `callback-watch.test.ts` |
| 2026-11-05 | Maame S. Afriyie | Retried at 10 AM after she asked for 4:30 PM | Retries follow the time the lead asked for | `missed-callback-retry.test.ts` |
| 2026-11-06 | (live call) | Said "I'm Claude, an AI assistant" from the idle check-in | The check-in is a fixed line, never model-generated | `calling.test.ts` |
| 2026-11-06 | Kelly Joseph | "Please no Calls" closed her, tagged 'do not call', told her we would never reach out again | No calls is not no interest: keep qualifying by text | `corrections.ts` kelly-no-calls, `sms.test.ts`, `dial-pending.test.ts` |
| 2026-11-06 | (design) | A maybe-stop was acted on as a certain stop | Reversible by default: check with the lead | `corrections.ts` not-interested-right-now, `text-signals.test.ts`, `sms.test.ts` |
| 2026-11-11 | Michelle Smith Funk (also Ritu Patel 11-05, Jalpesh Patel 09-24) | A lead who agreed to talk to an agent hung up while the transfer was still pending (3 of 5 attempts); nothing but a Slack line followed, no text, no retry | A qualified lead who agreed to an agent is never left with no next step: Iris calls back and connects them again, and texts if they don't answer | `transfer-resume.test.ts`, `vapi-webhook.test.ts` (a transfer that dropped), `dial-pending.test.ts` (the call back), `scripts.test.ts` (the call back after a transfer dropped), `sms.test.ts` |
| 2026-11-11 | Beverley Bradbury | Texted "Please do not reach out to me any more. I will NOT talk to AI" 28 seconds after Iris's call; ignored, because the text handler only answered a lead whose row was 'pending' and a connected call leaves it 'placed'. No tag, card left in Replied | A clear stop is carried out whatever state the row is in: tag "do not call", card to Not Interested, team told | `sms.test.ts` (a stop from a lead Iris just spoke to), `opt-out.test.ts`, `corrections.ts` beverley-do-not-reach-out |
| 2026-11-12 | Magar Bhuma | Both his calls on 11-05 ended with Iris saying "I'm Claude, an AI assistant" and hanging up (the idle check-in, fixed 11-06); then a text, no reply, and a week with nobody on him. The nightly review flagged him every morning (number 8 of 16, summary showed 5) and nothing acted on it | The review's list is acted on every day, by Iris, for the clear cases; leads already with an agent no longer crowd the list; a row parked for a text reply is not "in hand" | `review-followup.test.ts`, `daily-summary.test.ts` |
| 2026-11-12 | Suzanne Lilly | "Please text me." (09-23) closed her row as an opt-out and tagged her 'do not call', the Kelly misread again, found by hand 7 weeks later | Already pinned by `corrections.ts` kelly-no-calls; her tag removed by hand, card to Not Ready | (data fix) |
