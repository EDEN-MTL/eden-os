/**
 * LEAD STATUS MANAGEMENT — when a nurture lead leaves Ember for good.
 *
 * Mark, 2026-10-01 (his rule, verbatim in spirit): Ember moves a lead to
 * Not Interested only on CLEAR evidence that they're no longer a viable
 * prospect —
 *   - no longer looking to buy or sell;
 *   - already bought; already sold;
 *   - already working with another agent (a particularly strong trigger);
 *   - plans permanently changed, no longer need the agency;
 *   - explicitly asked to stop follow-ups / said they're not interested;
 *   - any other CLEAR situation showing they're not a viable prospect.
 * Never on assumptions. Unresponsive, busy, unsure, delaying, "not ready
 * yet", "next year", "still thinking", "I'll let you know" all stay in
 * nurturing. Clear evidence = status change; uncertainty = keep nurturing.
 *
 * Moving them is permanent: the card goes to the client's
 * ember.notInterestedStage (a lost stage), which Ember never enrolls from,
 * so they're never contacted again — Mark's call, replacing the earlier
 * "retry after 6 months" for these clear cases.
 *
 * How it decides, cheapest and safest first:
 *   1. A stop/unsubscribe request — rules in code (also a CASL opt-out).
 *   2. "Already working with another agent", definitive wording, in their
 *      MOST RECENT message — rules in code (Mark: a strong trigger). If they
 *      wrote again after it, the model weighs the whole thread instead.
 *   3. Anything else that LOOKS like a clear no (bought, sold, no longer
 *      looking, not interested, moved away...) — the model confirms against
 *      the rule above, and must quote the lead's own words; code checks the
 *      quote really is in a message the lead sent.
 *   4. Nothing that looks like a no — keep nurturing, no model call.
 * If the model is needed and can't answer, the verdict is "unsure": don't
 * move, don't text, look again next run.
 */
import { ask } from "../../shared/claude";
import { HistoryMessage, isHardOptOut } from "./history";

export type NotInterestedCategory =
  | "asked_to_stop"
  | "other_agent"
  | "already_bought"
  | "already_sold"
  | "no_longer_looking"
  | "plans_changed"
  | "other_clear";

export type StatusDecision =
  | { verdict: "not_interested"; category: NotInterestedCategory; evidence: string; by: "rule" | "ai" }
  | { verdict: "keep_nurturing"; reason: string }
  | { verdict: "unsure"; reason: string };

const CATEGORIES: NotInterestedCategory[] = [
  "asked_to_stop",
  "other_agent",
  "already_bought",
  "already_sold",
  "no_longer_looking",
  "plans_changed",
  "other_clear",
];

/** Definitive "I have an agent" wording. Hedged versions go to the model. */
const OTHER_AGENT = [
  /\b(i'?m|i am|we'?re|we are|already)\s+(now\s+)?(working|going|listed|signed)\s+with\s+(another|a different|an|a|my own|our own|my|our)\s+(agent|realtor|broker|real estate agent)\b/i,
  /\b(decided|chose|chosen|went|go(ing)?)\s+(to\s+)?(go\s+|work\s+|list\s+)?with\s+(another|a different)\s+(agent|realtor|broker)\b/i,
  /\b(already\s+)?(have|got|found)\s+(an|a|our|my)\s+(agent|realtor|broker)(\s+already)?\b/i,
  /\bsigned\s+with\s+(another|an|a)\s+(agent|realtor|brokerage|broker)\b/i,
];
const HEDGED = /\b(maybe|might|may|thinking (about|of)|considering|not sure|probably|possibly)\b/i;

/** Wording that might be a clear no — only ever a reason to ASK the model. */
const CANDIDATE = [
  /\bnot interested\b/i,
  /\b(bought|purchased|closed on|moved into)\b/i,
  /\b(sold|listed and sold)\b/i,
  /\bno longer\b/i,
  /\b(not|no) (looking|buying|selling|moving) (anymore|any more)\b/i,
  /\b(changed|change of) (our |my )?(plans|mind)\b/i,
  /\b(moved|moving) (away|out of (town|province|the province|the city))\b/i,
  /\b(agent|realtor|broker)\b/i,
  /\b(don'?t|do not) need (your|any|the) (help|services?|assistance)\b/i,
];

function inbound(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.filter((m) => m.direction === "inbound" && m.channel !== "call");
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The model's quote must really be (part of) something the lead sent. */
export function evidenceIsReal(evidence: string, messages: HistoryMessage[]): boolean {
  const q = normalise(evidence);
  if (q.length < 3) return false;
  return inbound(messages).some((m) => normalise(m.body).includes(q));
}

const SYSTEM_PROMPT = `You decide whether a real estate lead should be moved to "Not Interested" — removed from nurturing for good — based ONLY on what the lead themselves wrote. You get their texts/emails (and ours, for context), oldest first.

Move to Not Interested ONLY on clear evidence that they are no longer a potential buyer or seller:
- they are no longer looking to buy or sell
- they already bought a home, or already sold their home
- they are already working with another real estate agent
- their plans have permanently changed and they no longer need the agency's help
- they explicitly asked to stop receiving follow-ups, or said they're no longer interested
- any other CLEAR situation showing they are no longer a viable prospect

Do NOT move them on assumptions. These are NOT Not Interested — keep nurturing:
- no response, or short/neutral replies
- busy, unsure, still thinking ("we're still thinking about it", "things are a little busy right now")
- delaying ("we're probably going to wait until next year", "I'm not ready yet", "I'll let you know when we're ready")
- anything temporary or uncertain

Read the thread in order: if a later message shows renewed interest (e.g. "the other agent didn't work out, we're looking again"), an earlier decline no longer counts.

Examples that DO move: "I already bought a house last month." / "We're no longer looking to buy." / "I decided to work with another agent." / "We've already sold our property." / "Please stop contacting me. I'm not interested anymore."

Respond with ONLY one JSON object, no markdown:
{"verdict":"not_interested","category":"<one of: asked_to_stop, other_agent, already_bought, already_sold, no_longer_looking, plans_changed, other_clear>","evidence":"<the lead's exact words, copied verbatim from ONE of their messages>"}
or
{"verdict":"keep_nurturing","reason":"<short reason>"}

When in doubt, keep_nurturing.`;

function transcript(messages: HistoryMessage[]): string {
  return messages
    .filter((m) => m.channel !== "call")
    .map((m) => `[${m.at?.slice(0, 10) ?? "?"}] ${m.direction === "inbound" ? "LEAD" : "US"}: ${m.body}`)
    .join("\n");
}

function extractJson(raw: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type StatusAskFn = (system: string, user: string) => Promise<string>;

export async function classifyLeadStatus(
  messages: HistoryMessage[],
  askFn: StatusAskFn = (system, user) => ask(system, user, { maxTokens: 200, temperature: 0 })
): Promise<StatusDecision> {
  const theirs = inbound(messages);
  if (theirs.length === 0) return { verdict: "keep_nurturing", reason: "they haven't written anything" };

  // 1. Stop / unsubscribe — anywhere in the thread (CASL: it stands).
  const stop = theirs.find((m) => isHardOptOut(m.body));
  if (stop) return { verdict: "not_interested", category: "asked_to_stop", evidence: stop.body, by: "rule" };

  // 2. Another agent, definitively, as their latest word.
  const latest = theirs[theirs.length - 1];
  if (OTHER_AGENT.some((p) => p.test(latest.body)) && !HEDGED.test(latest.body)) {
    return { verdict: "not_interested", category: "other_agent", evidence: latest.body, by: "rule" };
  }

  // 3. Looks like it might be a clear no — the model confirms.
  if (!theirs.some((m) => CANDIDATE.some((p) => p.test(m.body)))) {
    return { verdict: "keep_nurturing", reason: "nothing that reads as a clear no" };
  }
  let raw: string;
  try {
    raw = await askFn(SYSTEM_PROMPT, transcript(messages));
  } catch (error) {
    return { verdict: "unsure", reason: `status check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = extractJson(raw);
  if (parsed?.verdict === "keep_nurturing") {
    return { verdict: "keep_nurturing", reason: String(parsed.reason ?? "model: keep nurturing").slice(0, 200) };
  }
  if (parsed?.verdict === "not_interested") {
    const evidence = typeof parsed.evidence === "string" ? parsed.evidence.trim() : "";
    // No verifiable quote = no clear evidence. Per the rule, that's not a move.
    if (!evidenceIsReal(evidence, messages)) {
      return { verdict: "keep_nurturing", reason: "model said not interested but couldn't quote the lead — not clear evidence" };
    }
    const category = CATEGORIES.includes(parsed.category) ? (parsed.category as NotInterestedCategory) : "other_clear";
    return { verdict: "not_interested", category, evidence, by: "ai" };
  }
  return { verdict: "unsure", reason: "status check returned something unreadable" };
}

const LABELS: Record<NotInterestedCategory, string> = {
  asked_to_stop: "asked to stop being contacted",
  other_agent: "working with another agent",
  already_bought: "already bought",
  already_sold: "already sold",
  no_longer_looking: "no longer looking",
  plans_changed: "plans changed for good",
  other_clear: "clearly no longer a prospect",
};

export function categoryLabel(category: NotInterestedCategory): string {
  return LABELS[category];
}
