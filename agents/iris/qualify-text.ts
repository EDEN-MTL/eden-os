/**
 * The first text Iris sends a lead she could not reach — after her first unanswered call, or when the lead rang
 * back and nobody picked up. Mark, 2026-11-05: "if they did not answer the first attempt they should text to
 * qualify those leads and try to book them a call with an agent if they are qualified" (Melanie Petten: one missed
 * call, the next call a day away, and nothing from Iris in between).
 *
 * It does not just say "sorry I missed you". It asks the ONE thing still worth knowing, narrowed the same way the
 * call does (a form range or bucket is turned into a request for a specific answer — see isBudgetRange /
 * isTimelineBucket in scripts.ts), so the reply starts the text qualification that books or hands off to an agent.
 * Deterministic on purpose: no model call, so it can be tested and costs nothing.
 */
import { extractFirstName, isBudgetRange, isTimelineBucket } from "./scripts";

export interface QualifyTextLead {
  name?: string | null;
  intent?: string | null;
  budget?: string | null;
  timeline?: string | null;
}

/** The form leaves these blank or as filler more often than you'd think. */
function known(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim();
  if (!v || /^(?:n\/a|na|none|null|unknown|not sure|not provided|undecided|unsure|-+)$/i.test(v)) return null;
  return v;
}

function isSelling(intent: string | null | undefined): boolean {
  return intent === "seller" || intent === "downsize" || intent === "upgrading";
}

/** One question: the first thing still missing or only approximate, else the step after qualifying (a call with an agent). */
export function qualifyingQuestion(lead: QualifyTextLead): string {
  const budget = known(lead.budget);
  const timeline = known(lead.timeline);
  const selling = isSelling(lead.intent);
  const verb = selling ? "sell" : "make a move";

  const timelineQuestion = (): string | null => {
    if (!timeline) return `When are you hoping to ${verb}?`;
    if (!isTimelineBucket(timeline)) return null;
    if (/asap|soon/i.test(timeline)) return `I see you're hoping to ${verb} as soon as possible. Is there a particular month or date you'd like to be in by?`;
    return `I see you put ${timeline.toLowerCase()} for your timeline. Do you have a particular month in mind?`;
  };

  if (!selling) {
    if (!budget) return "What kind of budget are you working with?";
    if (isBudgetRange(budget)) return `I see ${budget} on your form. What specific budget do you have in mind?`;
  }
  const t = timelineQuestion();
  if (t) return t;
  return "Would a quick call with one of our agents work for you? What day and time suit you?";
}

/** After Iris's own call went unanswered. */
export function buildMissedCallQualifyText(leadName: string | null | undefined, brandName: string, lead: QualifyTextLead): string {
  const first = extractFirstName(leadName ?? lead.name);
  return `Hi ${first}, it's Iris from ${brandName}. Sorry I missed you! I'd love to match you with the right agent. ${qualifyingQuestion(lead)}`;
}

/** After the lead called the number back and nobody answered. */
export function buildCallbackQualifyText(leadName: string | null | undefined, brandName: string, lead: QualifyTextLead): string {
  const first = extractFirstName(leadName ?? lead.name);
  return `Hi ${first}, it's Iris from ${brandName}. I saw you tried calling us back, sorry we missed you! ${qualifyingQuestion(lead)}`;
}
