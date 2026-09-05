import { describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_FOLLOW_UP,
  AGENT_UNAVAILABLE_LINE,
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
    expect(Object.values(LIVE_TRANSFER_LINES)).not.toContain(AGENT_UNAVAILABLE_LINE);
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
    const line = callOpeningContextLine("seller", "St. John's", null);
    expect(line).toContain("St. John's");
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
    expect(withSource).not.toContain("1. Home Buyer Form");
    expect(withSource).not.toMatch(/reached out through/);
    expect(withoutSource).not.toBeNull();
  });

  it("ends as a question, doing the job of confirming intent so it isn't asked twice", () => {
    const line = callOpeningContextLine("buyer", "St. John's", null);
    expect(line?.trim().endsWith("?")).toBe(true);
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
  it("lists every question as still needed when nothing is known yet", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toContain("Nothing yet — this is a cold first contact.");
    for (const q of IRIS_CONFIG.questions) {
      expect(prompt).toContain(q);
    }
  });

  /**
   * Mark, 2026-09-05: a known fact must become a spoken VERIFYING question
   * ("You were looking to buy a home in {area}, right?"), never a generic
   * "confirm it, don't ask again" instruction — the whole point is Iris
   * sounds like she's checking in, not reading a database dump back at the
   * lead.
   */
  it("turns a known answer into a verifying question and drops it from what's still needed", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller", propertyInterest: "downtown", timeline: "3-6 months" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toContain("I can see you're looking at selling your place in downtown — is that right?");
    expect(prompt).toContain("You mentioned you're looking to sell within 3-6 months — does that still sound right?");
    expect(prompt).not.toContain(IRIS_CONFIG.questions[0]);
    expect(prompt).not.toContain(IRIS_CONFIG.questions[1]);
    expect(prompt).not.toContain(IRIS_CONFIG.questions[3]);
  });

  /**
   * Mark's live feedback, 2026-09-06: with intent known but no area yet, the
   * opening's own contextLine ("I was calling about the form you submitted
   * online about selling your home in St. John's — still the plan?")
   * already confirms bare intent as a question — a second, separate
   * "still the plan?" verifying line right after it would just repeat it.
   */
  it("doesn't ask a redundant bare-intent verifying question when only intent (no area) is known", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).not.toContain("I can see you're looking at selling your home — is that right?");
    expect(prompt).toContain(IRIS_CONFIG.questions[1]);
  });

  it("uses the lead's latest answer over the form's when they conflict, without arguing", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "buyer", propertyInterest: "downtown" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toMatch(/treat THEIR latest answer as the real one/i);
    expect(prompt).toMatch(/never argue or repeat the stale value/i);
  });

  it("skips the financing question for a seller, matching qualification.ts's nextQuestion behavior", () => {
    const lead: NormalisedLead = { ...BLANK_LEAD, intent: "seller" };
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, lead, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).not.toContain(IRIS_CONFIG.questions[4]);
  });

  it("always asks the property-details question — no GHL field captures it yet", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toContain(IRIS_CONFIG.questions[2]);
  });

  it("uses the city and brand it's given rather than a hardcoded one", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "Matama Floors", "Montreal", false, true);
    expect(prompt).toContain("Matama Floors");
    expect(prompt).toContain("Montreal only");
  });

  it("never claims to be human, pulling the real approved wording (with the right brand) rather than inventing new lines", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toContain(EDGE_CASE_RESPONSES.isRealPerson("3 Percent East Coast")[0]);
    expect(prompt).toContain(EDGE_CASE_RESPONSES.dontKnowAnswer);
  });

  it("tells Iris to actually invoke schedule_callback when the tool is available", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true);
    expect(prompt).toContain("schedule_callback");
    expect(prompt).not.toMatch(/do not have a working callback-scheduling tool/i);
  });

  it("tells Iris NOT to claim a scheduled callback when the tool isn't wired up", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toMatch(/do not have a working callback-scheduling tool/i);
    expect(prompt).not.toContain("schedule_callback");
  });

  it("gives Iris the current date and time so she can resolve relative callback requests", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toMatch(/Right now it is/);
  });

  /**
   * Jacob's live feedback, 2026-09-04: the opening felt robotic because
   * Iris's first turn asked "how are you" and stated the calling-about
   * reason all at once, with no room for the lead to actually respond.
   * These instructions sequence it into separate turns instead.
   */
  it("instructs Iris to wait for the name, then ask how they're doing, before anything else", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toMatch(/wait for their answer/i);
    expect(prompt).toMatch(/ask how they're doing/i);
  });

  it("tells Iris never to stack more than one question into a turn", () => {
    const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
    expect(prompt).toMatch(/never stack more than one question/i);
  });

  /**
   * Confirmed live, 2026-09-04: without this, Iris was unconditionally told
   * to "always invoke the transferCall tool" even on a call where no such
   * tool was ever wired in (no transferNumber resolved for this lead) — she
   * said the transfer line and then had nothing to actually invoke.
   */
  describe("transferAvailable", () => {
    it("tells Iris to invoke the transferCall tool when a transfer is available", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, true);
      expect(prompt).toMatch(/invoke the transferCall tool/i);
      expect(prompt).not.toMatch(/do not have a live-transfer tool/i);
    });

    it("tells Iris she has no live-transfer tool, and never to claim one, when none is available", () => {
      const prompt = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", false, false);
      expect(prompt).toMatch(/do not have a live-transfer tool/i);
      expect(prompt).not.toMatch(/invoke the transferCall tool/i);
    });

    it("still gives the scheduling fallback instructions regardless of transfer availability", () => {
      const withTransfer = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, true);
      const withoutTransfer = buildLeadQualificationPrompt(IRIS_CONFIG, BLANK_LEAD, "3 Percent East Coast", "St. John's", true, false);
      expect(withTransfer).toContain("schedule_callback");
      expect(withoutTransfer).toContain("schedule_callback");
    });
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
