/**
 * Real messages Iris misread (or nearly misread), kept so a mistake that has been corrected once cannot come back unseen.
 * Mark, 2026-11-06: "I want Iris to learn" — the safe form of learning is that every correction becomes a case here
 * (or a unit test, for the ones that are not about reading a message) and runs before a change ships.
 *
 * Two uses:
 *   - corrections.test.ts checks the parsing layer around the model (the clear-stop quote check, the future-time bound)
 *     against what a correct model answer looks like for each case, and that the classifier prompt still carries the
 *     cases it was taught from.
 *   - scripts/check-iris-corrections.ts runs the REAL model over every case and prints N/N per case. Run it before
 *     shipping any change to text-signals.ts. It needs ANTHROPIC_API_KEY, so it runs on Render (or a machine with a key).
 *
 * Add a case whenever someone says "this should not happen" about how Iris read a text. The ledger of every
 * correction, including the ones that are not about a text, is docs/agents/iris-corrections.md.
 */
import type { TextSignal } from "./text-signals";

export interface TextSignalCase {
  id: string;
  /** When it happened, and who (a real lead, so the ledger can point at the thread). */
  found: string;
  /** What the lead texted. */
  message: string;
  /** Our text they were answering, when it matters to the reading. */
  precedingOutbound?: string | null;
  /** Any of these is acceptable. */
  expect: TextSignal["type"][];
  /** What a correct model answer looks like — drives the parsing-layer test. */
  modelOutput: string;
  /** Why the wrong reading was costly. */
  why: string;
  /** The classifier prompt names this message as an example. */
  inPrompt?: boolean;
}

const INTAKE_TEXT = "Just a quick heads-up — you'll receive a quick call from our AI assistant, IRIS. She'll just ask you a few quick questions to make sure we can help you. If you're not available, what would be a good time to speak?";

export const TEXT_SIGNAL_CASES: TextSignalCase[] = [
  {
    id: "beverley-do-not-reach-out",
    found: "2026-11-11, Beverley Bradbury",
    message: "Please do not reach out to me any more.   I will NOT talk to AI",
    expect: ["opt_out"],
    modelOutput: '{"type": "opt_out", "certainty": "clear", "quote": "Please do not reach out to me any more"}',
    why: "A clear stop, sent 28 seconds after Iris's call. It arrived while her row was 'placed' and was ignored: not tagged, card left in Replied.",
  },
  {
    id: "kelly-no-calls",
    found: "2026-11-06, Kelly Joseph",
    message: "Please no Calls",
    precedingOutbound: INTAKE_TEXT,
    expect: ["no_calls"],
    modelOutput: '{"type": "no_calls"}',
    why: "Read as an opt-out: closed, tagged 'do not call', told 'we won't reach out again'. She only refused calls.",
    inPrompt: true,
  },
  {
    id: "catherine-six-pm",
    found: "2026-09-22, Catherine",
    message: "6 pm",
    precedingOutbound: "what's a good time to speak?",
    expect: ["schedule_for"],
    modelOutput: '{"type": "schedule_for", "when": "2026-11-06T22:30:00.000Z"}',
    why: "A bare time answering 'what's a good time to speak?' is a callback request, not noise.",
  },
  {
    id: "chip-correction",
    found: "2026-09-21, live call",
    message: "I'm not looking to sell, I want a CHIP program valuation",
    expect: ["none"],
    modelOutput: '{"type": "none"}',
    why: "A correction of what they want, not a stop and not a time.",
  },
  {
    id: "saife-ys",
    found: "2026-10-01, Saife Sarwar",
    message: "Ys",
    precedingOutbound: INTAKE_TEXT,
    expect: ["call_consent"],
    modelOutput: '{"type": "call_consent"}',
    why: "A typo'd yes to 'you'll receive a call' is permission to call soon.",
  },
  {
    id: "plain-stop",
    found: "2026-11-06, reference case",
    message: "stop texting me",
    expect: ["opt_out"],
    modelOutput: '{"type": "opt_out", "certainty": "clear", "quote": "stop texting me"}',
    why: "A plain stop must still close the lead.",
  },
  {
    id: "no-calls-or-texts",
    found: "2026-11-06, reference case",
    message: "Don't call or text me",
    expect: ["opt_out"],
    modelOutput: '{"type": "opt_out", "certainty": "clear", "quote": "Don\'t call or text me"}',
    why: "Refusing texts as well as calls is a stop, unlike Kelly's message.",
  },
  {
    id: "maame-no-longer-interested",
    found: "2026-11-05, Maame S. Afriyie (said on a call)",
    message: "I'm no longer interested. Again.",
    expect: ["opt_out", "unsure_stop"],
    modelOutput: '{"type": "opt_out", "certainty": "clear", "quote": "I\'m no longer interested"}',
    why: "A plain 'no longer interested' is a stop; either that or a check with the lead is acceptable, a callback time is not.",
  },
  {
    id: "not-interested-right-now",
    found: "2026-11-06, reference case",
    message: "Not interested right now",
    expect: ["unsure_stop", "none"],
    modelOutput: '{"type": "opt_out", "certainty": "unsure", "quote": "Not interested right now"}',
    why: "Temporary. Must never close the lead; checking with them is right.",
  },
  {
    id: "not-today",
    found: "2026-09-22, reference case",
    message: "not today",
    expect: ["none"],
    modelOutput: '{"type": "none"}',
    why: "The classifier prompt names this as 'none', never a stop.",
  },
];
