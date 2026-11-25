/**
 * Plain-words "no" from a lead, read without a model.
 *
 * Mark, 2026-11-25 (Geoff Harris): a lead texted "Not interested anymore" and nothing happened. The text classifier
 * (text-signals.ts) called it "might be a stop", so Iris posted a question in Slack and closed nothing; then the nightly
 * review, whose only stop rule was a text starting with the word "stop", listed him every morning as "texted and
 * nobody has answered". Two fixes, both here because they share the wording:
 *
 *   plainDeclineQuote  a message that is nothing BUT a plain, permanent no ("not interested", "no longer interested",
 *                      "not interested anymore, thanks"). Acted on as a clear stop. Anything with a qualifier or a
 *                      subject ("not interested right now", "not interested in condos", "not interested in a call")
 *                      does not match and still goes to the model, which treats it as a maybe.
 *   isSoftDecline      a polite "not now" that needs no reply ("Not at this time. When I'm ready I'll let you know").
 *                      Never closes anyone: the review uses it so such a lead is reported as having said no, not as
 *                      someone nobody answered.
 *
 * Pure and dependency-free so lead-review.ts, stuck-leads.ts and text-signals.ts can all import it.
 */

const GREETING = String.raw`(?:(?:hi|hello|hey|no|nope|sorry|no thanks?|no thank you|thanks?)[\s,.!]+)*`;
const SUBJECT = String.raw`(?:(?:i'?m|im|i am|we'?re|we are|am)\s+)?`;
const NO_LONGER = String.raw`(?:not|no longer|no more)\s+interested(?:\s+(?:anymore|any more|any longer|at all))?|no longer looking|not looking\s+(?:anymore|any more|any longer|at all)`;
const SIGN_OFF = String.raw`(?:[\s,.!]+(?:thanks?|thank you|thx|sorry|bye|goodbye))*`;
const PLAIN_DECLINE = new RegExp(`^\\s*${GREETING}${SUBJECT}(?:${NO_LONGER})${SIGN_OFF}[\\s.!]*$`, "i");

/** The lead's own words when the whole message is a plain permanent no, otherwise null. The quote is the message itself. */
export function plainDeclineQuote(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 120) return null;
  return PLAIN_DECLINE.test(t) ? t : null;
}

const SOFT_DECLINE = /\b(?:not (?:at this time|right now|at the moment|ready|yet|this year|for now|now)|maybe later|some other time|when i'?m ready|(?:i'?ll|i will|will) (?:reach out|let you know|get back to you|contact you)|no thanks?|no thank you)\b/i;
const ASKS_SOMETHING = /\?|\b(?:call me|give me a call|can you|could you|please call|call (?:back|after|at|around|tomorrow))\b/i;

/** A short, polite "not now" that asks for nothing. Longer messages and anything with a question or a request are real replies. */
export function isSoftDecline(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length > 160) return false;
  if (ASKS_SOMETHING.test(t)) return false;
  return PLAIN_DECLINE.test(t) || SOFT_DECLINE.test(t);
}

/** Notes where someone has written down that the lead turned down contact (Michelle Smith Funk: "Lead declined to be connected at this time"). */
const NOTES_DECLINED = /\b(?:declined to be (?:connected|contacted|transferred)|not interested in (?:being|speaking|talking|a call|an agent|working)|no longer interested|asked (?:us )?not to be|does not want to be (?:contacted|called))\b/i;
export const notesSayDeclined = (notes: string): boolean => NOTES_DECLINED.test(String(notes ?? ""));

/** Cards already in a column for leads who said no or aren't ready: nothing left to move, so nothing to report. */
export const isNoOrParkedStage = (stageName: string): boolean => /not interested|not qualified|not ready|long term|nurtur|endless loop/i.test(String(stageName ?? ""));

/**
 * "Not right now" in plain words (Mark, 2026-11-25: such a lead goes to Not Ready and Ember follows up). Narrower than
 * isSoftDecline: no bare "no thanks" (could be forever), nothing that also says stop or "anymore", no question or request,
 * and never a plain permanent no. Returns the message as the quote, or null.
 */
const NOT_NOW = /\b(?:not (?:interested )?(?:at this time|right now|at the moment|for now|yet|now|this year|this month|this season|next year)|not ready|maybe later|some other time|when i'?m ready|(?:i'?ll|i will|will) (?:reach out|let you know|get back to you|contact you))\b/i;
export const MEANS_STOP = /\b(?:stop|remove|unsubscribe|leave me|harass|spam|never|do not|don'?t|dont|take me off|any ?more|no longer|no more)\b/i;
export function notNowQuote(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 160) return null;
  if (plainDeclineQuote(t) || MEANS_STOP.test(t) || ASKS_SOMETHING.test(t)) return null;
  return NOT_NOW.test(t) ? t : null;
}
