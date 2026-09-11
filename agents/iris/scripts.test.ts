import { describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_FOLLOW_UP,
  AGENT_UNAVAILABLE_LINE,
  TRANSFER_ATTEMPT_LINES,
  buildLeadQualificationPrompt,
  buildVoicemailMessage,
  BUYER_QUESTIONS,
  callIdentifyLine,
  callOpeningGreeting,
  callbackRecapLine,
  callOpeningContextLine,
  DOWNSIZER_QUESTIONS,
  EDGE_CASE_RESPONSES,
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
    expect(known).toContain("I also see you mentioned a budget around $450k — does that still sound right?");
    expect(known).not.toContain("What's your budget range?");

    const unknown = buildLeadQualificationPrompt(IRIS_CONFIG, { ...BLANK_LEAD, intent: "buyer" }, "3 Percent East Coast", "St. John's", false, true, false);
    expect(unknown).toContain("What's your budget range?");
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
    expect(prompt).toMatch(/great, thanks for picking\s+up!/i);
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
      expect(prompt).toMatch(/NEVER call book_appointment again after a\s*\nsuccess, for the rest of this call/i);
      expect(prompt).toMatch(/it can only create appointments, never move or cancel\s*\none/i);
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
    expect(prompt).toContain('"This is Iris with 3 Percent East Coast."');
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
     * Mark's request, 2026-09-09: an abrupt bare "Goodbye" right after
     * booking an appointment feels rude. That closing used to be something
     * Iris composed herself (six approved variants) — as of 2026-09-11,
     * after this exact confirmation went unspoken on three separate real
     * calls despite prompt fixes, Vapi speaks a guaranteed confirmation
     * automatically instead (see calling.ts's book_appointment wiring and
     * its own test). This checks the prompt tells Iris NOT to add her own
     * version on top of it, not that she composes one herself anymore.
     */
    it("tells Iris not to add her own closing on top of Vapi's guaranteed booking confirmation", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true, true);
      expect(prompt).toMatch(/vapi speaks a guaranteed\s+confirmation automatically/i);
      expect(prompt).toMatch(/say NOTHING right after that tool\s+succeeds/i);
      expect(prompt).toMatch(/don't second-guess it or\s+add your own version on top/i);
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
