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
