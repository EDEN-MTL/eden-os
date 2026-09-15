import { describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_FOLLOW_UP,
  AGENT_UNAVAILABLE_LINE,
  CHECK_AVAILABILITY_ACK_LINES,
  TRANSFER_ATTEMPT_LINES,
  TRANSFER_REINFORM_LINES,
  buildLeadQualificationPrompt,
  buildVoicemailMessage,
  BUYER_QUESTIONS,
  callIdentifyLine,
  callOpeningGreeting,
  callbackRecapLine,
  callOpeningContextLine,
  DOWNSIZER_QUESTIONS,
  EDGE_CASE_RESPONSES,
  expandBudgetShorthand,
  extractFirstName,
  LIVE_TRANSFER_LINES,
  liveTransferLineForIntent,
  NATURAL_TRANSITIONS,
  SELLER_QUESTIONS,
} from "./scripts";
import { IrisConfig } from "./qualification";
import { NormalisedLead } from "../scout/intake";

function hasNoDuplicates(list: string[]): boolean {
  return new Set(list).size === list.length;
}

describe("question sets", () => {
  it.each([
    ["buyer", BUYER_QUESTIONS],
    ["seller", SELLER_QUESTIONS],
    ["downsizer", DOWNSIZER_QUESTIONS],
  ])("%s has non-empty, duplicate-free sms and call questions", (_label, set) => {
    expect(set.sms.length).toBeGreaterThan(0);
    expect(set.call.length).toBeGreaterThan(0);
    expect(hasNoDuplicates(set.sms)).toBe(true);
    expect(hasNoDuplicates(set.call)).toBe(true);
  });

  it("keeps buyer and seller questions distinct from each other", () => {
    const overlap = BUYER_QUESTIONS.sms.filter((q) => SELLER_QUESTIONS.sms.includes(q));
    expect(overlap).toEqual([]);
  });

  it("only asks pre-approval in the buyer set, not seller", () => {
    const mentionsPreApproval = (q: string) => /pre-approved/i.test(q);
    expect(BUYER_QUESTIONS.sms.some(mentionsPreApproval)).toBe(true);
    expect(SELLER_QUESTIONS.sms.some(mentionsPreApproval)).toBe(false);
  });

  it("asks the seller-first-or-buyer-first question before any other downsizer question", () => {
    expect(DOWNSIZER_QUESTIONS.sms[0]).toMatch(/sell first, buy first, or do both/i);
  });
});

describe("EDGE_CASE_RESPONSES.outOfServiceArea", () => {
  /**
   * This system previously had "South Florida" hardcoded into every agent
   * prompt for a Newfoundland client — a real bug. Guarding against ever
   * hardcoding a location here instead of taking it as a parameter.
   */
  it("uses the city it's given rather than a hardcoded location", () => {
    const responses = EDGE_CASE_RESPONSES.outOfServiceArea("St. John's");
    expect(responses.length).toBeGreaterThan(0);
    for (const r of responses) {
      expect(r).toContain("St. John's");
      expect(r).not.toMatch(/florida/i);
    }
  });

  it("reflects whatever city is passed in, not a fixed default", () => {
    const responses = EDGE_CASE_RESPONSES.outOfServiceArea("Halifax");
    for (const r of responses) {
      expect(r).toContain("Halifax");
      expect(r).not.toContain("St. John's");
    }
  });
});

describe("EDGE_CASE_RESPONSES coverage", () => {
  const arrayKeys = [
    "buyerHasAgent",
    "sellerHasAgentOrListed",
    "notPreApproved",
    "leadNotReady",
    "leadStoppedResponding",
    "offTopic",
    "rentalRequest",
    "alreadyBooked",
    "lineBreakingUp",
    "silenceCheckIn",
  ] as const;

  it.each(arrayKeys)("%s has at least one approved phrasing", (key) => {
    const value = EDGE_CASE_RESPONSES[key] as string[];
    expect(Array.isArray(value)).toBe(true);
    expect(value.length).toBeGreaterThan(0);
  });

  it("isRealPerson uses the brand it's given rather than a hardcoded one", () => {
    const responses = EDGE_CASE_RESPONSES.isRealPerson("Mark's Realty");
    expect(responses.length).toBeGreaterThan(0);
    expect(responses[0]).toContain("Mark's Realty");
    expect(responses.join(" ")).not.toMatch(/3% Realty/i);
  });

  it("has single-line responses for situations Iris must never guess at", () => {
    expect(EDGE_CASE_RESPONSES.dontKnowAnswer.length).toBeGreaterThan(0);
    expect(EDGE_CASE_RESPONSES.realEstateAdviceRequest.length).toBeGreaterThan(0);
  });

  it("gives a distinct final message once the two stopped-responding follow-ups are used", () => {
    expect(EDGE_CASE_RESPONSES.leadStoppedRespondingFinal).not.toEqual(
      EDGE_CASE_RESPONSES.leadStoppedResponding[0]
    );
  });
});

describe("liveTransferLineForIntent", () => {
  it("uses the buyer line for buyer and upgrading intents", () => {
    expect(liveTransferLineForIntent("buyer")).toBe(LIVE_TRANSFER_LINES.buyer);
    expect(liveTransferLineForIntent("upgrading")).toBe(LIVE_TRANSFER_LINES.buyer);
  });

  it("uses the seller line for seller and downsize intents", () => {
    expect(liveTransferLineForIntent("seller")).toBe(LIVE_TRANSFER_LINES.seller);
    expect(liveTransferLineForIntent("downsize")).toBe(LIVE_TRANSFER_LINES.seller);
  });

  it("falls back to the general line for unknown intent", () => {
    expect(liveTransferLineForIntent("unknown")).toBe(LIVE_TRANSFER_LINES.general);
  });
});

/**
 * Confirmed live, 2026-09-14 — TWICE, despite an earlier general "M means
 * million" style rule elsewhere in the prompt: a budget like "$3.5M" got
 * spoken back as "3 dollars and 50 cents m". Fixing the data at its
 * source (this function) rather than relying on the model to correctly
 * expand shorthand it sees as raw text every time.
 */
describe("expandBudgetShorthand", () => {
  it("expands a plain M-suffixed amount into million", () => {
    expect(expandBudgetShorthand("$500M")).toBe("$500 million");
  });

  it("expands a decimal M-suffixed amount into million", () => {
    expect(expandBudgetShorthand("$3.5M")).toBe("$3.5 million");
  });

  it("expands a K-suffixed amount into thousand", () => {
    expect(expandBudgetShorthand("$450k")).toBe("$450 thousand");
  });

  it("expands both sides of a range independently", () => {
    expect(expandBudgetShorthand("$3.5M - $5M")).toBe("$3.5 million - $5 million");
    expect(expandBudgetShorthand("$1.5M - $2.5M")).toBe("$1.5 million - $2.5 million");
  });

  it("leaves a budget with no M/K shorthand untouched", () => {
    expect(expandBudgetShorthand("$450,000")).toBe("$450,000");
    expect(expandBudgetShorthand("1000000")).toBe("1000000");
  });

  it("is case-insensitive for the M/K suffix", () => {
    expect(expandBudgetShorthand("$500m")).toBe("$500 million");
    expect(expandBudgetShorthand("$450K")).toBe("$450 thousand");
  });
});

describe("extractFirstName", () => {
  it("returns the first name as-is when there's no honorific", () => {
    expect(extractFirstName("Jason Miller")).toBe("Jason");
  });

  it("strips a leading honorific before taking the first name", () => {
    // Confirmed live, 2026-09-14: a test lead submitted as "Mr. Beast Scott"
    // came back as firstName "Mr." — Iris asked "Am I speaking with mister?"
    // and the transfer briefing said "I have Mr. on the other line."
    expect(extractFirstName("Mr. Beast Scott")).toBe("Beast");
    expect(extractFirstName("Mrs Jane Doe")).toBe("Jane");
    expect(extractFirstName("Dr. Smith")).toBe("Smith");
  });

  it("is case-insensitive for the honorific", () => {
    expect(extractFirstName("MR. Beast")).toBe("Beast");
  });

  it("falls back to \"there\" when there's no name at all", () => {
    expect(extractFirstName(null)).toBe("there");
    expect(extractFirstName(undefined)).toBe("there");
    expect(extractFirstName("")).toBe("there");
  });
});

describe("fallback booking line", () => {
  it("is present and distinct from the live transfer lines", () => {
    expect(AGENT_UNAVAILABLE_LINE.length).toBeGreaterThan(0);
    expect(AGENT_UNAVAILABLE_FOLLOW_UP.length).toBeGreaterThan(0);
    expect(Object.values(LIVE_TRANSFER_LINES).flat()).not.toContain(AGENT_UNAVAILABLE_LINE);
  });
});

describe("NATURAL_TRANSITIONS", () => {
  it("offers more than one variant per channel, so Iris isn't stuck repeating one phrase", () => {
    expect(NATURAL_TRANSITIONS.sms.length).toBeGreaterThan(1);
    expect(NATURAL_TRANSITIONS.call.length).toBeGreaterThan(1);
  });
});

describe("callOpeningGreeting", () => {
  it("is a bare greeting only — no name, no brand, no question", () => {
    const line = callOpeningGreeting();
    expect(line).not.toMatch(/\?/);
    expect(line.length).toBeLessThan(10);
  });
});

describe("callIdentifyLine", () => {
  it("asks to confirm the known name as a question, rather than declaring it", () => {
    const line = callIdentifyLine("Sam");
    expect(line).toContain("Sam");
    expect(line.trim().endsWith("?")).toBe(true);
  });

  it("asks who's on the line instead of using the 'there' placeholder", () => {
    const line = callIdentifyLine("there");
    expect(line).not.toContain("there");
    expect(line).toMatch(/who/i);
  });

  it("is a single short question — no 'how are you' or calling-about reason crammed in", () => {
    const line = callIdentifyLine("Sam");
    expect(line).not.toMatch(/how are you/i);
    expect(line).not.toMatch(/calling about/i);
  });
});

describe("callOpeningContextLine", () => {
  it("uses the city it's given for a seller, not a hardcoded location", () => {
    const lines = callOpeningContextLine("seller", "St. John's", null);
    expect(lines?.some((l) => l.includes("St. John's"))).toBe(true);
  });

  /**
   * Mark's live feedback, 2026-09-06: naming the raw lead source verbatim
   * ("I saw you reached out through 1. Home Buyer Form") read GHL's internal
   * form label out loud, which sounded exactly like what it is — a database
   * field, not a sentence. Never spoken now, regardless of whether one is
   * known — "the form you submitted online" covers it naturally either way.
   */
  it("never speaks the raw lead source value, known or not", () => {
    const withSource = callOpeningContextLine("buyer", "St. John's", "1. Home Buyer Form");
    const withoutSource = callOpeningContextLine("buyer", "St. John's", null);
    expect(withSource?.some((l) => l.includes("1. Home Buyer Form"))).toBe(false);
    expect(withSource?.some((l) => /reached out through/.test(l))).toBe(false);
    expect(withoutSource).not.toBeNull();
  });

  /**
   * Jacob's live feedback, 2026-09-08: ending this on a yes/no gate
   * ("...still the plan?") made Iris sound like she was reciting a script.
   * Now a warm statement — Iris flows into her next question rather than
   * waiting on an explicit "yes" first. Mark's request, 2026-09-09: added
   * more generic transition variants alongside the original — none of them
   * should be a yes/no gate either.
   */
  it("is a warm statement, not a yes/no gate — for every variant", () => {
    const lines = callOpeningContextLine("buyer", "St. John's", null);
    expect(lines).not.toBeNull();
    for (const l of lines!) expect(l.trim().endsWith("?")).toBe(false);
  });

  it("returns null for unknown intent rather than inventing a reason for the call", () => {
    expect(callOpeningContextLine("unknown", "St. John's", "facebook")).toBeNull();
  });
});

const IRIS_CONFIG: IrisConfig = {
  questions: [
    "Are you looking to buy or sell?",
    "What area are you interested in?",
    "What type of home are you looking for, and how many bedrooms and bathrooms do you need?",
    "What's your timeline?",
    "Are you pre-approved? What's your budget range?",
  ],
  hotScoreThreshold: 75,
  warmScoreThreshold: 40,
  calendars: { buyer: "buyer-cal", seller: "seller-cal" },
  transferNumbers: { buyer: "+17097058841", seller: "+17097059439" },
  callbackNotesFieldKey: "contact.isa_notes",
  writeFields: {
    timeline: "contact.lf_timeframe",
    budget: "contact.lf_budget",
    propertyInterest: "contact.lf_proprety",
    preApproved: "contact.are_you_pre_approuved",
  },
  outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
};

const BLANK_LEAD: NormalisedLead = {
  contactId: "c1",
  name: "Sam Test",
  email: null,
  phone: "+15555551234",
  propertyInterest: null,
  bedrooms: null,
  workingWithRealtor: null,
  budget: null,
  timeline: null,
  preApproved: null,
  financing: null,
  sources: { financing: null, timeline: null, budget: null },
  leadSource: null,
  attribution: { fbclid: null, utmSource: null, utmCampaign: null, metaCampaignId: null, metaAdsetId: null, metaAdId: null },
  attributed: false,
  qualified: false,
  firstTouch: true,
  intent: "unknown",
  score: 0,
  scoreReasons: [],
};

describe("buildLeadQualificationPrompt", () => {
  it("lists every still-genuinely-unknown item when nothing is known yet", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain("Nothing yet — this is a cold first contact.");
    expect(prompt).toContain(IRIS_CONFIG.questions[0]); // intent unknown
    expect(prompt).toContain(IRIS_CONFIG.questions[1]); // area — never has a data source
    expect(prompt).toContain("What type of home are you looking for?");
    expect(prompt).toContain("How many bedrooms and bathrooms do you need?");
    expect(prompt).toContain(IRIS_CONFIG.questions[3]); // timeline unknown
    expect(prompt).toContain("Are you preapproved for a mortgage yet?");
    expect(prompt).toContain("What's your budget range?");
  });

  /**
   * Mark, 2026-09-05/06: a known fact must become a spoken VERIFYING
   * question, never a generic "confirm it, don't ask again" instruction —
   * the whole point is Iris sounds like she's checking in, not reading a
   * database dump back at the lead. propertyInterest is PROPERTY TYPE
   * ("Single Family Home"), not area — confirmed live, 2026-09-06, against
   * eden-sub-account-one's real "LF Property" field; the fixture below uses
   * a realistic property-type value rather than the old (semantically
   * wrong) area-shaped one this test used before that was caught.
   */
  it("turns a known answer into a verifying question and drops it from what's still needed", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller", propertyInterest: "bungalow", timeline: "3-6 months" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain("You mentioned you're looking for a bungalow — is that still what you're after?");
    expect(prompt).toContain("You mentioned you're looking to sell within 3-6 months — does that still sound right?");
    expect(prompt).not.toContain(IRIS_CONFIG.questions[0]);
    expect(prompt).not.toContain("What type of home are you looking for?");
    expect(prompt).not.toContain(IRIS_CONFIG.questions[3]);
  });

  it("always asks the area question fresh — no client checked so far has a real field for it", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain(IRIS_CONFIG.questions[1]);
  });

  it("verifies bedroom count when known, asks it fresh when not", () => {
    const known = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, bedrooms: "4" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(known).toContain("And you needed 4 bedrooms, right?");
    expect(known).not.toContain("How many bedrooms and bathrooms do you need?");

    const unknown = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(unknown).toContain("How many bedrooms and bathrooms do you need?");
  });

  /**
   * Confirmed live, 2026-09-06: a real lead's known $450k budget was still
   * asked cold on every test call — captured for scoring, never actually
   * verified in conversation.
   */
  it("verifies budget when known, asks it fresh when not", () => {
    const known = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, intent: "buyer", budget: "$450k" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(known).toContain("I also see you mentioned a budget around $450 thousand — does that still sound right?");
    expect(known).not.toContain("What's your budget range?");

    const unknown = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, intent: "buyer" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(unknown).toContain("What's your budget range?");
  });

  /**
   * Confirmed live, 2026-09-14 — TWICE, despite an earlier general style
   * rule: "$3.5M" got read back as "3 dollars and 50 cents m". Fixed at
   * the source (expandBudgetShorthand) rather than relying on the model
   * to expand M/K correctly every time it reads the raw string.
   */
  it("expands M/K budget shorthand into words before it ever reaches the model", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, intent: "buyer", budget: "$3.5M - $5M" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain("$3.5 million - $5 million");
    expect(prompt).not.toMatch(/\$3\.5M\b/);
  });

  it("verifies existing agent representation when known, says nothing when it isn't", () => {
    const hasOne = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, workingWithRealtor: true }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(hasOne).toContain("I also see you mentioned you're already working with a realtor — is that still the case?");

    const doesNot = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, workingWithRealtor: false }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(doesNot).toContain("I also see you mentioned you're not currently working with a realtor — still accurate?");

    const unknown = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(unknown).not.toMatch(/working with a realtor/i);
  });

  it("uses the lead's latest answer over the form's when they conflict, without arguing", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "buyer", propertyInterest: "condo" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/treat THEIR latest answer as the real one/i);
    expect(prompt).toMatch(/never argue or repeat the stale value/i);
  });

  it("skips the financing and budget questions for a seller, matching qualification.ts's nextQuestion behavior", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).not.toContain("Are you preapproved for a mortgage yet?");
    expect(prompt).not.toContain("What's your budget range?");
  });

  /**
   * Mark's live feedback, 2026-09-08 (reviewing recent Vapi call recordings):
   * tone was drifting across a single call instead of staying consistent —
   * the old prompt only had a single throwaway "match the lead's energy"
   * adjective, no concrete instruction on how to read or hold a tone.
   */
  /**
   * Jacob's live feedback, 2026-09-08 (reviewing a call recording): Iris was
   * reciting the verifying/context lines almost word-for-word, which read
   * as stiff and scripted rather than conversational.
   */
  it("tells Iris to paraphrase in her own words and vary phrasing, not recite verbatim", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "buyer", propertyInterest: "condo" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/not a script to read/i);
    expect(prompt).toMatch(/small library of DIFFERENT ways to ask the same thing/i);
    expect(prompt).toMatch(/never pick the same shape twice in this call/i);
  });

  /**
   * Jacob's live feedback, 2026-09-08: every verifying question landed on
   * the exact same shape ("You mentioned X. Does that still sound right?"),
   * repeated back to back in the same call. Each fact now offers several
   * differently-shaped phrasings rather than one fixed template.
   */
  it("gives multiple differently-shaped phrasing options per verified fact, not one fixed template", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "buyer", propertyInterest: "condo", bedrooms: "3" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain("You mentioned you're looking for a condo — is that still what you're after?");
    expect(prompt).toContain("Ok so, you're set on a condo, right?");
    expect(prompt).toContain("And you needed 3 bedrooms, right?");
    expect(prompt).toContain("Still looking for 3 bedrooms?");
  });

  it("skips filler acknowledgment and goes straight to the identify question on a bare pickup", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/skip any filler like/i);
    expect(prompt).toMatch(/great,\s+thanks for picking\s+up!/i);
  });

  it("tells Iris to mirror the lead's tone and hold it for the rest of the call", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/mirror the lead, then hold it/i);
    expect(prompt).toMatch(/don't swing from upbeat to flat to upbeat again/i);
    expect(prompt).toMatch(/shift with them at that point and hold the new tone/i);
  });

  it("uses the city and brand it's given rather than a hardcoded one", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "Matama Floors", "Montreal", false, true, false);
    expect(prompt).toContain("Matama Floors");
    expect(prompt).toContain("Montreal only");
  });

  it("never claims to be human, pulling the real approved wording (with the right brand) rather than inventing new lines", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toContain(EDGE_CASE_RESPONSES.isRealPerson("3 Percent East Coast")[0]);
    expect(prompt).toContain(EDGE_CASE_RESPONSES.dontKnowAnswer);
  });

  it("tells Iris to actually invoke schedule_callback when the tool is available", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, false);
    expect(prompt).toContain("schedule_callback");
    expect(prompt).not.toMatch(/do not have a working callback-scheduling tool/i);
  });

  it("tells Iris NOT to claim a scheduled callback when the tool isn't wired up", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/do not have a working callback-scheduling tool/i);
    expect(prompt).not.toContain("schedule_callback");
  });

  it("gives Iris the current date and time so she can resolve relative callback requests", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/Right now it is/);
  });

  /**
   * Jacob's live feedback, 2026-09-04: the opening felt robotic because
   * Iris's first turn asked "how are you" and stated the calling-about
   * reason all at once, with no room for the lead to actually respond.
   * These instructions sequence it into separate turns instead.
   */
  it("instructs Iris to wait for the name, then ask how they're doing, before anything else", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/wait for their answer/i);
    expect(prompt).toMatch(/ask how they're doing/i);
  });

  it("tells Iris never to stack more than one question into a turn", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/never stack more than one question/i);
  });

  /**
   * Mark, 2026-09-06: reading a full formatted date/timezone offset out
   * loud (e.g. "GMT minus 2:30") sounds exactly like reading a database
   * field — confirmed live when Iris did precisely that while explaining a
   * suggested callback time.
   */
  it("tells Iris to speak day/time simply and never read out a timezone offset", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/never read out the exact/i);
    expect(prompt).toMatch(/date, month, year, or a timezone offset/i);
    expect(prompt).toMatch(/only give the exact/i);
    expect(prompt).toMatch(/date if the lead actually asks for it/i);
  });

  /**
   * Confirmed live, 2026-09-04: without this, Iris was unconditionally told
   * to "always invoke the transferCall tool" even on a call where no such
   * tool was ever wired in (no transferNumber resolved for this lead) — she
   * said the transfer line and then had nothing to actually invoke.
   */
  /**
   * Mark's live feedback, 2026-09-08 (reviewing more call recordings):
   * property type and bedroom/bathroom count kept landing several
   * questions apart instead of back to back.
   */
  it("tells Iris to ask bedrooms/bathrooms immediately after property type, before anything else", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/property type, then bedrooms\/bathrooms, always back to back/i);
    expect(prompt).toMatch(/before timeline, budget, area, financing, or anything else/i);
  });

  /**
   * Mark's live feedback, 2026-09-08: Iris said some variant of "just a
   * sec" more than ten times in a row while a tool call was running.
   */
  it("bans repeated stalling filler like 'just a sec' during a tool call", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/never say "just a sec/i);
    expect(prompt).toMatch(/more than ONCE while a tool call is/i);
  });

  /**
   * Confirmed live, 2026-09-14: a budget written as "$1.5M - $2.5M" got
   * read back as "1 dollar and 50 cents to 2 dollars and 50 cents" — the
   * M/K shorthand was misread as a decimal point followed by cents.
   */
  it("tells Iris M/K budget shorthand means million/thousand, never cents or a decimal", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/"\$1\.5M - \$2\.5M" got read back as "1 dollar and 50 cents/i);
    expect(prompt).toMatch(/"\$1\.5M"\s+means one point five MILLION dollars/i);
    expect(prompt).toMatch(/never read\s+the digits and the letter as if the letter were a currency symbol/i);
  });

  /**
   * Mark's live feedback, 2026-09-14: a single call used "This will just
   * take a sec," "Just a sec," "This will take a sec," and "Hold on a
   * sec" across four separate tool calls in about a minute — none
   * individually repeated within one wait (already banned), but the whole
   * call still sounded robotic since every transition reached for some
   * "sec" filler variant.
   */
  it("tells Iris to vary calendar-checking transitions across the WHOLE call, not just within one wait", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, budget: "$500k" }, "3 Percent East Coast", "St. John's", true, true, true);
    expect(prompt).toMatch(/This ALSO applies ACROSS the whole call, not just within one wait/i);
    expect(prompt).toMatch(/four separate tool calls in about a minute/i);
    expect(prompt).toContain("Yeah, absolutely. Let me see what we have open.");
  });

  /**
   * Mark's spec, 2026-09-14: an "acknowledge before finding another time"
   * bank for when a proposed time is declined without a counter-time —
   * distinct from CHECK_AVAILABILITY_ACK_LINES, which is for a time the
   * LEAD named.
   */
  it("gives Iris a distinct acknowledgment bank for declining a proposed time without naming another", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, budget: "$500k" }, "3 Percent East Coast", "St. John's", true, true, true);
    expect(prompt).toContain("No problem. Let me see what else we have.");
    expect(prompt).toContain("Gotcha. Let's see what else is open.");
  });

  /**
   * Mark's spec, 2026-09-14: if Iris accidentally talks over the lead, she
   * should apologize and yield rather than continuing — and after any
   * interruption, never re-ask something the lead already answered.
   */
  it("tells Iris to apologize and yield if she interrupts the lead, and never re-ask an already-answered question after", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/If\s+you realize YOU were the one talking over THEM/i);
    expect(prompt).toMatch(/don't say the\s+apology and immediately continue with your own next line/i);
    expect(prompt).toMatch(/if they already answered the\s+question you were about to ask, don't ask it again/i);
  });

  /**
   * Mark's spec, 2026-09-14: genuinely new — hearing issues weren't
   * handled at all before. Rephrase, don't repeat verbatim, when the lead
   * can't hear; ask for a repeat, never guess, when Iris can't hear them.
   */
  it("tells Iris to rephrase (not repeat verbatim) when the lead can't hear her, and to ask for a repeat rather than guess when she can't hear them", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/do NOT just repeat your exact previous line at the same pace/i);
    expect(prompt).toMatch(/THEN rephrase the same question shorter and simpler/i);
    expect(prompt).toMatch(/If YOU can't clearly hear the LEAD/i);
    expect(prompt).toMatch(/Never record or act on\s+information you didn't actually hear clearly/i);
  });

  /**
   * Mark's live feedback, 2026-09-11: after confirming budget with "And
   * budget wise, still around 1000000?", Iris asked the NEXT question (a
   * different topic, area) as "Budget wise, what area are you interested
   * in?" — carrying the previous question's own topic tag onto an
   * unrelated question, reading as a garbled half-finished transition.
   */
  it("tells Iris not to carry a question's topic tag onto the next, unrelated question", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, budget: "$1,000,000" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/the NEXT question opens fresh — never carry the topic tag/i);
    expect(prompt).toMatch(/Budget\s+wise, what area are you interested/i);
    expect(prompt).toMatch(/start the next one clean/i);
  });

  describe("identity name-drop", () => {
    /**
     * Mark's spec, 2026-09-13: after the identity name-drop bug recurred
     * on multiple real calls despite several rounds of prose reinforcement,
     * consolidated into one tight mechanical rule set (forbidden list,
     * correct list, identity lock) instead of accumulating more narrative.
     */
    it("tells Iris the lead's name is already known, and gives her the exact mechanical identify sequence", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Justin" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/This call NEVER discovers who the lead is/i);
      expect(prompt).toContain('"Hi, am I speaking with Justin?"');
      expect(prompt).toMatch(/no exceptions and no creative rewording/i);
    });

    it("gives Iris an explicit forbidden-phrasing list, never describing the lead instead of naming them", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Justin" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/FORBIDDEN — never say any version of these/i);
      expect(prompt).toContain('"Am I speaking to you?"');
      expect(prompt).toMatch(/Am I speaking to the lead\/person who submitted the \(buyer\/seller\) form\?/i);
      expect(prompt).toMatch(/Are you the person\/buyer\/seller who submitted the form\?/i);
    });

    it("gives Iris an explicit correct-phrasing list and an identity lock once confirmed", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Justin" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/CORRECT — "Hi, am I speaking with Justin\?" itself/i);
      expect(prompt).toMatch(/IDENTITY LOCK: the moment they confirm/i);
      expect(prompt).toMatch(/Never ask again in any form/i);
    });

    it("points to the consolidated identity rule from the 'How you sound' paraphrase exception, without repeating the whole history", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Justin" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/ONE NAMED EXCEPTION: the identify line \("Hi, am I speaking with Justin\?"\) is not a\s+paraphrase target/i);
      expect(prompt).toMatch(/see "How you open the\s+call" above for the exact rule/i);
    });

    /**
     * Real operator/lead feedback, 2026-09-15: on a bare pickup or when
     * nothing's been said yet, Iris was saying only a bare "Hi" and
     * waiting for the lead to ask who she was before actually introducing
     * herself — same class of bug just fixed on the transfer-assistant
     * opening. Fixed by folding the self-introduction directly into steps
     * 1 and 3, matching step 2's already-correct pattern, and removing the
     * old separate step 4 (now redundant — she introduces herself in the
     * very first turn instead of after identity is confirmed).
     *
     * Refined further, 2026-09-15 (Mark's own written spec): made "Hi,
     * this is Iris with [company]. Am I speaking with [name]?" the single
     * CANONICAL default line — "Hi" belongs to the greeting/self-intro at
     * the front, not repeated a second time in front of the identity
     * question — rather than one of several rotated variants.
     */
    it("has Iris introduce herself in the same turn as the identity question on a bare pickup, not a bare 'Hi' that waits to be asked", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Justin" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/Bare pickup \("Hello\?", "Hey", "Yeah\?"\) → skip any filler/i);
      expect(prompt).toContain('"Hi, this is Iris with 3 Percent East Coast. Am I speaking with Justin?" — this is the canonical default');
      expect(prompt).toMatch(/Never just a bare "Hi" that waits for them to ask\s+who you are/i);
      expect(prompt).toMatch(/Nothing from them yet at all → say\s+"Hi, this is Iris with 3 Percent East Coast\. Am I speaking with Justin\?"/i);
      // The old separate "introduce yourself" step is gone — she already
      // did it in her opening turn, and is told not to repeat it.
      expect(prompt).toMatch(/you already introduced yourself by\s+name in your opening turn above — never introduce yourself a second time/i);
      expect(prompt).not.toMatch(/4\. Introduce yourself by name/i);
    });
  });

  describe("transferAvailable", () => {
    /**
     * Mark's live feedback, 2026-09-08: Iris invoked transferCall silently
     * right after hearing agreement, leaving the lead in dead air (which
     * she then filled with a repeated "just a sec" loop) instead of telling
     * them what was actually happening.
     */
    it("tells Iris to announce the transfer attempt before invoking the tool", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      for (const line of TRANSFER_ATTEMPT_LINES) expect(prompt).toContain(line);
      expect(prompt).toMatch(/never invoke it silently without saying this first/i);
    });

    /**
     * Mark's request, 2026-09-09: added from a real recording of Jacob (the
     * human ISA) doing a live transfer himself — keep the original lines,
     * add these as a second option so Iris can switch between them instead
     * of repeating one script every call.
     */
    it("offers Jacob's real transfer phrasing as a second option, not a replacement", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, intent: "buyer" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toContain("Perfect. We'll connect you with one of our buyer agents to send over some available home options.");
      expect(prompt).toContain("I'm just the assistant, so let me connect you with one of our buyer agents — they'll have access to send over some real listings.");
      expect(prompt).toMatch(/pick ONE of these\s*\n\(never repeat the same one call after call\)/i);
    });

    /**
     * Mark's live feedback, 2026-09-08: Iris offered the live transfer while
     * the lead was still mid-answer on the last qualifying question.
     */
    it("gates the transfer behind every verifying and still-needed item being fully answered", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/only once EVERY item above is\s*\nactually done/i);
      expect(prompt).toMatch(/never offer the transfer until\s*\nthe lead has completely finished answering the last thing you asked them/i);
    });

    /**
     * Mark's spec, 2026-09-12: a live transfer previously left the ISA
     * notes field untouched — the receiving agent had no summary at all
     * unless a callback happened instead. Called once qualification is
     * done, before presenting either outcome, silently.
     */
    it("tells Iris to save ISA notes once qualification is done, silently, using the final corrected values", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/call save_isa_notes ONCE with a\s*\nstructured summary/i);
      expect(prompt).toMatch(/Call it silently, in the background —\s*\nnever announce it or mention it to the lead/i);
      expect(prompt).toMatch(/Use the FINAL, corrected\s*\nvalues if anything changed/i);
    });

    /**
     * Mark's live feedback, 2026-09-08: Iris repeated "hold on a sec" / "this
     * will just take a sec" in a loop right after the transfer failed,
     * instead of silently checking the calendar.
     */
    it("tells Iris to say nothing at all while the scheduling tool runs after a failed transfer", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/go STRAIGHT into scheduling — do not say\s+anything else first/i);
      expect(prompt).toMatch(/say NOTHING while your scheduling tool is\s+running — not even once/i);
    });

    it("tells Iris to invoke the transferCall tool when a transfer is available", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/invoke the transferCall tool/i);
      expect(prompt).not.toMatch(/do not have a live-transfer tool/i);
    });

    /**
     * Jacob's live feedback, 2026-09-08 (reviewing a call recording): after
     * transferCall failed and Iris fell back to scheduling, the lead later
     * agreeing to a proposed callback time ("yeah") got misread as
     * agreement to a fresh transfer attempt, firing "Transferring the call
     * now" a second time right as the call should have wrapped up with a
     * confirmed booking.
     */
    it("tells Iris never to attempt a second transferCall once she's fallen back to scheduling", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/never invoke transferCall a second\s+time in the same call/i);
    });

    /**
     * Mark's live feedback, 2026-09-08: a real call had Iris attempt a
     * transfer, fall back to booking, successfully book an appointment —
     * and then STILL go back and attempt the transfer a second time right
     * after the booking had already succeeded.
     */
    it("tells Iris a successful transfer or booking ends the connect-the-lead attempt for the whole call", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/exactly ONE attempt at connecting the lead to a person/i);
      expect(prompt).toMatch(/never say the transfer line, never mention connecting them to an\s*\nagent, and never invoke transferCall again/i);
    });

    /**
     * Mark's spec, 2026-09-11 (section 24.9): an extra two-round layer for
     * the case the lead just missed the transfer announcement (distracted,
     * muted for a second) rather than either agreeing or saying they're
     * unavailable — a short re-confirm first, then a still-there check,
     * never assuming consent from silence at either stage.
     */
    it("tells Iris silence is never consent, and to re-check in two rounds before falling back to the standard quiet-lead rule", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/do NOT invoke transferCall and do NOT assume either agreement or unavailability/i);
      expect(prompt).toMatch(/Silence is NEVER consent to transfer/i);
      expect(prompt).toMatch(/ROUND 1: re-check with a short confirmation/i);
      for (const line of TRANSFER_REINFORM_LINES) expect(prompt).toContain(line);
      expect(prompt).toMatch(/ROUND 2 \(only if STILL silent after round 1\)/i);
      expect(prompt).toMatch(/follow the standard "if the lead goes quiet" two-check-in rule/i);
    });

    it("clarifies the silence-before-transfer rounds are separate from the agent's own ring/hold time", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/separate from the agent actually ringing after a real transfer is invoked/i);
    });

    it("tells Iris she has no live-transfer tool, and never to claim one, when none is available", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, false, false);
      expect(prompt).toMatch(/do not have a live-transfer tool/i);
      expect(prompt).not.toMatch(/invoke the transferCall tool/i);
    });

    it("still gives the scheduling fallback instructions regardless of transfer availability", () => {
      const withTransfer = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, false);
      const withoutTransfer = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, false, false);
      expect(withTransfer).toContain("schedule_callback");
      expect(withoutTransfer).toContain("schedule_callback");
    });
  });

  /**
   * Mark, 2026-09-06: built once a real client calendar existed to verify
   * against — check_and_book_appointment replaces schedule_callback
   * entirely for a call where a real callbackCalendarId resolved, since
   * offering both would leave Iris with two overlapping ways to handle the
   * same situation.
   */
  describe("calendarAvailable", () => {
    it("tells Iris to use check_availability and book_appointment, never schedule_callback, when a real calendar is available", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toContain("check_availability");
      expect(prompt).toContain("book_appointment");
      expect(prompt).not.toContain("schedule_callback");
    });

    it("tells Iris never to assume a time is open — check_availability decides", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/never assume a\s+time\s+is\s+open/i);
      expect(prompt).toMatch(/check_availability tells you/i);
      expect(prompt).toMatch(/every isoTime you ever pass to book_appointment/i);
    });

    /**
     * Mark's request, 2026-09-08: a booked appointment should carry lead
     * details and notes from the conversation, not just a generic booking
     * note. Structured facts are baked in automatically (calling.ts's
     * buildAppointmentLeadSummary) — this covers the optional free-text
     * half only Iris can supply, for whatever came up fresh in the call.
     */
    it("tells Iris about the optional conversationNotes argument, for fresh details only", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/OPTIONAL conversationNotes argument/i);
      expect(prompt).toMatch(/never restate the standard facts already covered above/i);
    });

    it("falls back to schedule_callback when no real calendar is available, even with booking tools on", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, false);
      expect(prompt).toContain("schedule_callback");
      expect(prompt).not.toContain("check_availability");
      expect(prompt).not.toContain("book_appointment");
    });

    /**
     * Mark's live feedback, 2026-09-06: Iris kept asking "what day and
     * time works best for you?" up front on a real test call instead of
     * just checking and proposing a time herself — the lead shouldn't have
     * to invent a time from nothing when Iris can just go look and offer
     * one. Only propose a guessed time when the lead hasn't stated a
     * preference; a real ask-directly fallback still exists once every
     * real same-day option has been proposed and declined.
     */
    it("tells Iris to propose a real time herself only once the lead has no stated preference", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/only when the lead hasn't given you any preference at all/i);
      expect(prompt).toMatch(/only once you've proposed every real option left for today/i);
    });

    /**
     * Mark's live feedback, 2026-09-10: a lead countered a proposed 6:30
     * slot with "how about 7?" and Iris never checked whether 7 was
     * actually open — she just declared 6:30 "locked in" and moved on
     * without ever running the tool against the time the lead actually
     * asked for.
     */
    it("tells Iris to check the lead's own stated time preference before falling back to her own guess", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/listen for a day\/time preference from the lead before you check anything/i);
      expect(prompt).toMatch(/that is your very next\s*\n?check_availability attempt/i);
      expect(prompt).toMatch(/check THAT time next via\s+check_availability again — their stated preference always wins/i);
    });

    /**
     * Mark's spec, 2026-09-12: a varied acknowledgment library for the
     * moment right before checking a lead-named time — never a single
     * canned line, and never implying the time is already available.
     */
    it("gives Iris a varied acknowledgment library before checking a lead-named time, never assuming it's open", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      for (const line of CHECK_AVAILABILITY_ACK_LINES) expect(prompt).toContain(line);
      expect(prompt).toMatch(/never automatically book it and never assume it's available just\s*\nbecause they named it/i);
      expect(prompt).toMatch(/don't make them repeat the time back to you/i);
    });

    /**
     * Mark's spec, 2026-09-12 (section 36.2): even Iris's own first guessed
     * time (the "no preference given" branch) must be presented and agreed
     * to before book_appointment is called — the prior wording had her book
     * it immediately on a guess, relying only on Vapi's post-booking
     * confirmation to cover for it. That's a different guarantee (never
     * hang up unconfirmed) than this one (never book unconfirmed).
     */
    it("tells Iris to wait for real agreement before booking even her own first guessed time, never booking on a guess", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/then STOP and wait for their\s+actual answer/i);
      expect(prompt).toMatch(/never book on a\s+guess, even when it's your very own first guessed time/i);
      expect(prompt).not.toMatch(/don't wait for a reply first/i);
    });

    /**
     * Confirmed live, 2026-09-06: a real call had Iris stuck in a loop
     * telling the lead "I'm having trouble with the time format" over and
     * over, even after they clearly reconfirmed the same time twice — an
     * internal tool-formatting error surfaced as a fake "technical issue"
     * to a lead who'd done nothing wrong. This never repeats without a
     * hard stop, since an LLM instruction alone doesn't guarantee it won't
     * loop again some other way.
     */
    it("tells Iris never to blame a fake technical issue on the lead, and to stop retrying after two failures", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/never repeat\s+words like "technical issue" or "trouble with the/i);
      expect(prompt).toMatch(/if it fails twice in a\s*\n?row, stop trying/i);
      expect(prompt).toMatch(/do not\s*\n?call book_appointment again\s*\nthis call/i);
    });

    /**
     * Mark's live feedback, 2026-09-08: a lead got double-booked — Iris
     * booked 6:30, the lead asked for 7 instead, and Iris called the tool
     * again rather than recognizing 6:30 was already locked in, creating a
     * second separate appointment nobody wanted. Confirmed live against
     * the real GHL calendar: both appointments existed simultaneously.
     */
    it("tells Iris never to call book_appointment again once it's already booked one", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/NEVER call book_appointment again after a\s+success, for the\s+rest of this call/i);
      expect(prompt).toMatch(/it can only create appointments, never move or cancel\s*\none/i);
    });

    /**
     * Mark's spec, 2026-09-12: a lead changing their mind after a real
     * booking must get a genuine reschedule via the new
     * reschedule_appointment tool — a real GHL update confirmed live
     * 2026-09-12, not the old "teammate will follow up" deflection (which
     * only ever existed because no real reschedule capability did).
     */
    it("gives Iris a real reschedule flow via reschedule_appointment, not a deflection, when the lead changes their mind after booking", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/that is a real RESCHEDULE, never a fresh\s+booking/i);
      expect(prompt).toContain("reschedule_appointment");
      expect(prompt).toMatch(/updates the SAME appointment record/i);
      expect(prompt).toMatch(/No problem at all — we can definitely move that for you/i);
      expect(prompt).toMatch(/Alright, just to confirm — you're good for \[new day\/time\], correct\?/i);
      expect(prompt).toMatch(/never claim a new time is\s+already set, booked, or locked in/i);
    });

    /**
     * Mark's live audit, 2026-09-13: reschedule_appointment previously
     * could only guess "the most recent appointment for this contact" —
     * risking grabbing a real, unrelated, older appointment from a
     * completely different earlier call. Requiring the exact
     * appointmentId book_appointment handed back closes that gap.
     */
    it("tells Iris reschedule_appointment requires the exact appointmentId from book_appointment's own result", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/requires the exact appointmentId that book_appointment's own success\s+result gave you earlier this call/i);
      expect(prompt).toMatch(/never\s+guess or invent this value/i);
    });

    /**
     * Mark's "PRO TIP" instruction: rescheduling shouldn't feel like
     * restarting the whole booking flow from zero, and repeated changes of
     * mind should be handled calmly, not with frustration.
     */
    it("tells Iris a reschedule should feel like a short continuation, and to stay calm through repeated changes", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/should feel like a short continuation, not\s+a restart/i);
      expect(prompt).toMatch(/never re-run the full original booking script/i);
      expect(prompt).toMatch(/don't\s+show any frustration, keep acknowledgments short and neutral/i);
    });
  });

  /**
   * Mark's live feedback, 2026-09-08: a lead asked "who am I speaking with?"
   * right at pickup and Iris just repeated her own identify question back
   * at them instead of actually answering who was calling. Promoted to a
   * standalone "Rules you must never break" entry (rather than a clause
   * buried in the opening-sequence steps) after Mark raised it again —
   * the same pattern used for other rules that needed reinforcement this
   * session (e.g. the "one outcome only" transfer rule).
   */
  it("tells Iris to directly answer if the lead asks who's calling, instead of deflecting", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/If the lead asks "who is this\?" or "who am I speaking with\?"/i);
    expect(prompt).toMatch(/ANSWER IT DIRECTLY/);
    expect(prompt).toMatch(/"This is Iris\s+with 3 Percent East Coast\."/);
  });

  /**
   * Mark's live feedback, 2026-09-09: a real call had a known name ("Mark")
   * available, and Iris still said "Am I speaking with you?" instead of
   * using it — the broad "vary your phrasing" instruction elsewhere in the
   * prompt apparently licensed dropping the name from the one line whose
   * entire purpose is confirming it.
   */
  it("tells Iris she must say the actual name when confirming who she's speaking with, never a generic substitute", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/you\s+MUST actually say that name — never substitute "you" or any generic/i);
    expect(prompt).toMatch(/never blend the two\s+into something meaningless like "am I speaking with you\?"/i);
  });

  describe("ending the call", () => {
    /**
     * Mark's live feedback, 2026-09-08: Iris ended a call after her
     * scheduling tool kept failing, having neither transferred the lead nor
     * booked anything — a lead left with no outcome at all.
     */
    it("tells Iris never to end the call without a real transfer or a real confirmed booking", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/never end the call unless ONE of these is actually true/i);
      expect(prompt).toMatch(/the lead was successfully connected via live transfer/i);
      expect(prompt).toMatch(/a real appointment or callback was actually confirmed/i);
    });

    /**
     * Mark's live feedback, 2026-09-08: Iris said "Goodbye" twice in a row
     * before ending — a real call recording still showed this even after
     * the first "say it once" fix, so this adds an explicit fallback for
     * the case where the model somehow gets another turn after endCall.
     */
    it("tells Iris to say goodbye exactly once, not repeat it before ending", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toMatch(/say your goodbye line exactly ONCE/i);
      expect(prompt).toMatch(/never say another farewell word or repeat "goodbye"/i);
      expect(prompt).toMatch(/if for any reason you get another\s*\nturn after invoking endCall, say NOTHING at all/i);
    });

    /**
     * Mark's spec, 2026-09-12: a bare "Goodbye" is weak for the plain-
     * ending case (lead says they're done, nothing was booked or
     * transferred) — warm, name-personalized variants instead, distinct
     * from the two-check-in quiet-lead ending's own fixed final line.
     */
    it("gives Iris warm, name-personalized closing variants for a plain ending, distinct from the quiet-lead final line", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Jason Lee" }, "3 Percent East Coast", "St. John's", false, true, false);
      expect(prompt).toContain('"Alright, Jason, really appreciate your time — talk soon!"');
      expect(prompt).toMatch(/separate from the two-check-in quiet-lead ending below/i);
    });

    /**
     * Mark's request, 2026-09-09: an abrupt bare "Goodbye" right after
     * booking an appointment feels rude. Vapi speaks a guaranteed
     * confirmation automatically (see calling.ts's book_appointment
     * wiring and its own test) as the structural guarantee — but Mark's
     * spec, 2026-09-13, explicitly reversed the earlier "say NOTHING
     * extra" rule: now that the guarantee is never at risk, warm
     * follow-through (even repeating the day/time naturally) is
     * encouraged, not forbidden.
     */
    it("tells Iris warm follow-through after Vapi's guaranteed booking confirmation is encouraged, not forbidden", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/vapi\s+speaks a guaranteed\s+confirmation automatically/i);
      expect(prompt).toMatch(/warm, human follow-through is not just allowed, it's\s+expected/i);
      expect(prompt).toContain('"Okay, you\'re all set for 3:30 PM tomorrow."');
      expect(prompt).toMatch(/never contradict Vapi's own line/i);
    });

    /**
     * Mark's spec, 2026-09-13: after a positive closing acknowledgment,
     * Iris should acknowledge naturally THEN close warmly with a real,
     * name-personalized line — not a generic "say a brief acknowledgment."
     */
    it("gives Iris a rich acknowledge-then-warmly-close bank for a plain closing acknowledgment after booking", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toContain('"Perfect. We\'ll talk to you then. Have a great day!"');
      expect(prompt).toContain('"Perfect, [name]. Thanks so much for your time, and we\'ll talk to you then."');
      expect(prompt).toMatch(/not a system reciting "your appointment has\s+been successfully confirmed"/i);
    });

    /**
     * Mark's live feedback, 2026-09-14: a lead said a bare "Okay" after
     * the booking confirmation — since "okay" wasn't explicitly spelled
     * out in the closing-acknowledgment trigger list, Iris fell back to a
     * flat "Goodbye" instead of the warm-closing bank above.
     */
    it("treats a bare 'okay' as a closing acknowledgment, not just the longer listed phrases", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/A plain closing acknowledgment — "okay," "perfect,"/i);
      expect(prompt).toMatch(/Don't require an exact match against this list/i);
    });

    /**
     * Mark's spec, 2026-09-13, considered and deliberately declined: a
     * separate one-shot "wait ~2s then say goodbye" path for silence after
     * a booking. It would trip endCall's own structural rejectionPlan,
     * which only unblocks on a real reply or the exact "hold off for now"
     * line — so silence after a booking still goes through the existing
     * two-check-in sequence, not a new invented closing line.
     */
    it("keeps the existing two-check-in sequence for silence after a booking, rather than a new closing line that would trip the endCall gate", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/deliberately NOT adopted: a separate\s+one-shot/i);
      expect(prompt).toMatch(/would get\s+silently rejected by that same check/i);
      expect(prompt).toMatch(/its final line \("No worries — I'll hold off for now\.\.\."\)/i);
    });

    /**
     * Mark's spec, 2026-09-12: closing lines should be warm, name-
     * personalized, and end with the "reply to the text" nudge (reduces
     * no-shows, keeps the conversation open) — for the schedule_callback
     * path specifically, since it has no Vapi-guaranteed confirmation of
     * its own and Iris still composes this closing herself.
     */
    it("personalizes the schedule_callback closing with the lead's name and the 'reply to the text' nudge", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Jason Lee" }, "3 Percent East Coast", "St. John's", true, true, false);
      expect(prompt).toMatch(/warm, confident, and forward-\s+moving, not a flat sign-off/i);
      expect(prompt).toContain('"Perfect, Jason — you\'re all set for [time].');
      expect(prompt.match(/feel free to reply to the text/gi)?.length).toBeGreaterThanOrEqual(6);
    });

    /**
     * Mark's spec, 2026-09-12 ("END CALL LOGIC — APPOINTMENT CONFIRMED"):
     * a real question or new concern right after the booking confirmation
     * is not the same as a closing acknowledgment ("okay", "thanks") —
     * the prior wording treated any reply at all as permission to hang up,
     * which would have ended the call over an unanswered question.
     */
    it("tells Iris to answer a real question or concern after the booking confirmation, not treat it as permission to hang up", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/a real\s+question, hesitation, or new concern is NOT the same as a closing/i);
      expect(prompt).toMatch(/answer\s+or address it naturally first.*and do NOT invoke endCall yet/is);
      expect(prompt).toMatch(/never treat every reply as\s+automatic permission to hang up/i);
      expect(prompt).toMatch(/never reopen\s+qualification or restart any part of the earlier conversation/i);
    });
  });

  /**
   * From Mark's 2026-09-09 IRIS safety guardrails: if the person on the
   * line explicitly denies being the lead, Iris must not assume they are
   * anyway and must not continue qualification.
   */
  it("tells Iris never to assume identity if the person denies being the lead", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/explicitly denies being the lead/i);
    expect(prompt).toMatch(/do NOT continue into qualification/i);
  });

  /**
   * Mark's spec, 2026-09-12: a name correction ("it's Mike, not Michael")
   * is a different case from denying being the lead entirely — the CRM
   * needs to actually get fixed, not just verbally acknowledged.
   */
  it("tells Iris to call update_lead_name on a name correction, distinct from denying being the lead", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Michael Test" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/This is a DIFFERENT case from the one above/i);
    expect(prompt).toMatch(/call update_lead_name with exactly what they said/i);
    expect(prompt).toMatch(/is this Michael\?/i);
  });

  /**
   * Mark's live feedback, 2026-09-12: on a real call the identify line got
   * dropped entirely, the lead had to volunteer his own name unprompted
   * ("Are you going to add my name?" ... "My name is Mark"), and Iris
   * never called update_lead_name even though she correctly used "Mark"
   * for the rest of her own speech — the CRM still showed the stale form
   * name. This covers that case explicitly, not just a spoken correction.
   */
  it("tells Iris to call update_lead_name even when the lead volunteers their name unprompted, not just on a correction", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, name: "Michael Test" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/you\s+never actually said their name at all/i);
    expect(prompt).toMatch(/the lead has to volunteer their\s+own name unprompted/i);
    expect(prompt).toMatch(/Are\s+you going to add my name\?/i);
  });

  /**
   * From Mark's 2026-09-09 IRIS safety guardrails: never invent discovery
   * questions beyond what's already listed to verify/gather (credit score,
   * income, household size, why they're moving, etc.).
   */
  it("tells Iris never to invent qualifying questions beyond what's already listed", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true, false);
    expect(prompt).toMatch(/never invent\s+additional discovery questions beyond those/i);
    expect(prompt).toMatch(/credit score, income, household size/i);
  });
});

describe("callbackRecapLine", () => {
  it("names the assigned agent when routing has picked one", () => {
    const line = callbackRecapLine("tomorrow at 9:30am", "Jenna Hickey", "seller");
    expect(line).toContain("Jenna Hickey");
  });

  it("falls back to 'one of our team' rather than inventing a name", () => {
    const line = callbackRecapLine("tomorrow at 9:30am", null, "buyer");
    expect(line).toContain("one of our team");
  });

  it("states the seller goal for seller and downsize intents", () => {
    expect(callbackRecapLine("today at 7pm", null, "seller")).toContain("sell this house");
    expect(callbackRecapLine("today at 7pm", null, "downsize")).toContain("sell this house");
  });

  it("states the buyer goal for buyer and upgrading intents", () => {
    expect(callbackRecapLine("today at 7pm", null, "buyer")).toContain("find the right home");
    expect(callbackRecapLine("today at 7pm", null, "upgrading")).toContain("find the right home");
  });
});

describe("buildVoicemailMessage", () => {
  it("identifies Iris by name and uses the brand it's given, not a hardcoded one", () => {
    const message = buildVoicemailMessage("Matama Floors");
    expect(message).toContain("Iris");
    expect(message).toContain("Matama Floors");
  });

  it("points to a text follow-up rather than promising a specific callback time", () => {
    const message = buildVoicemailMessage("3 Percent East Coast");
    expect(message).toMatch(/text/i);
    expect(message).not.toMatch(/\d{1,2}(:\d{2})?\s*(am|pm)/i);
  });
});
