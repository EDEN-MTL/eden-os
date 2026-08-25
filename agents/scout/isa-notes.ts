/**
 * Parses the free-text ISA NOTES field (contact.isa_notes).
 *
 * This field carries more usable signal than the dedicated form fields do.
 * Measured over 150 live contacts: ISA notes populated on 101, while
 * lf_proprety and are_you_pre_approuved are empty on every single record.
 * The ISA types answers here instead of filling the form in.
 *
 * Two shapes are in use, because sellers and buyers get different scripts:
 *   Buyer:  "Area: st.johns\n1st Time Buyer: yes\nPrice Range: $400K-$600K\n
 *            Pre-approved: no, in the process\nWhen: 1-4 Months"
 *   Seller: "area: , mt.pearl\nreason: relocating\ntimeline: 6 months"
 *
 * Labels vary in case and spacing, values are whatever the ISA typed.
 */

export type Financing =
  | "cash"          // no financing needed at all — strongest position
  | "pre-approved"  // financing secured
  | "in-progress"   // engaged with a lender, not done
  | "not-approved"  // asked and has not started
  | null;           // not recorded

export interface IsaNotes {
  financing: Financing;
  timeline: string | null;
  budget: string | null;
  area: string | null;
  firstTimeBuyer: boolean | null;
}

/**
 * Matches one labelled line.
 *
 * Uses [^\S\n] (horizontal whitespace) rather than \s deliberately: \s
 * matches newlines, so on a blank "Pre-approved:" line the capture group
 * ran on and swallowed the following line. That produced readings like
 * financing = "When: 1-4 Months" — plausible-looking and completely wrong.
 */
function labelled(note: string, label: string): string | null {
  const m = note.match(new RegExp(`^[^\\S\\n]*${label}[^\\S\\n]*:[^\\S\\n]*(.*)$`, "im"));
  const v = (m?.[1] ?? "").trim();
  return v === "" ? null : v;
}

/**
 * Classifies the financing answer.
 *
 * Written against every distinct value in the live account rather than
 * assumed. The distinction that matters: a cash buyer is not a failed
 * pre-approval, they are a better prospect than a pre-approved one — no
 * lender, no appraisal, no financing condition. Real values seen:
 *   yes(4) no(3) "no, in the process"(2) "no need"(2) "paying cash"(1)
 *   cash(1) "not necessary"(1) "working on it"(1)
 *   "no, in the process/some equity"(1) "782 wife is 680 credit"(1)
 */
export function parseFinancing(raw: string | null): Financing {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();

  // Cash first — "no need" and "not necessary" both begin with a negation
  // but mean the opposite of "not approved".
  if (/\bcash\b|no need|not necessary|not needed|n\/a/.test(v)) return "cash";

  // "no, in the process" must beat the bare "no" test below it.
  if (/in the process|working on it|in progress|applying|started/.test(v)) return "in-progress";

  if (/^(yes|y|true|approved|pre[- ]?approved)\b/.test(v)) return "pre-approved";
  if (/^(no|n|false|not)\b/.test(v)) return "not-approved";

  // Anything else — e.g. "782 wife is 680 credit" — is a credit score, not an
  // approval. Unknown rather than guessed; a wrong guess here changes routing.
  return null;
}

export function parseIsaNotes(note: string | null | undefined): IsaNotes {
  const empty: IsaNotes = { financing: null, timeline: null, budget: null, area: null, firstTimeBuyer: null };
  if (!note) return empty;
  const text = String(note);

  const ftb = labelled(text, "1st time buyer");
  return {
    financing: parseFinancing(labelled(text, "pre[- ]?approved")),
    // Buyers get "When:", sellers get "timeline:".
    timeline: labelled(text, "when") ?? labelled(text, "timeline"),
    budget: labelled(text, "price range") ?? labelled(text, "budget"),
    area: labelled(text, "area"),
    firstTimeBuyer: ftb === null ? null : /^(yes|y|true)\b/i.test(ftb) ? true : /^(no|n|false)\b/i.test(ftb) ? false : null,
  };
}
