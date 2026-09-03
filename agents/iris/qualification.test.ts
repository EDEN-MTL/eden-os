import { describe, expect, it } from "vitest";
import {
  BLANK_ANSWERS,
  calendarForIntent,
  decideOutcome,
  fieldWritesFor,
  IrisConfig,
  isComplete,
  nextQuestion,
  qualify,
  QualificationAnswers,
  scoreQualification,
  transferNumberForIntent,
} from "./qualification";

const config: IrisConfig = {
  questions: [
    "Are you looking to buy or sell?",
    "What area are you interested in?",
    "What type of home are you looking for, and how many bedrooms and bathrooms do you need?",
    "What's your timeline?",
    "Are you pre-approved? What's your budget range?",
  ],
  hotScoreThreshold: 75,
  warmScoreThreshold: 40,
  calendars: { buyer: "4Eyz51DOI7TY78gRgBU3", seller: "vbsoYjk2Q6nI66q8u8to" },
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

describe("nextQuestion / isComplete", () => {
  it("asks in order: intent, area, property details, timeline, financing", () => {
    expect(nextQuestion(config, BLANK_ANSWERS)).toBe(config.questions[0]);
    expect(nextQuestion(config, { ...BLANK_ANSWERS, intent: "buyer" })).toBe(config.questions[1]);
    expect(nextQuestion(config, { ...BLANK_ANSWERS, intent: "buyer", area: "Mount Pearl" })).toBe(
      config.questions[2]
    );
    expect(
      nextQuestion(config, {
        ...BLANK_ANSWERS,
        intent: "buyer",
        area: "Mount Pearl",
        propertyDetails: "3 bed, 2 bath",
      })
    ).toBe(config.questions[3]);
    expect(
      nextQuestion(config, {
        ...BLANK_ANSWERS,
        intent: "buyer",
        area: "Mount Pearl",
        propertyDetails: "3 bed, 2 bath",
        timeline: "ASAP",
      })
    ).toBe(config.questions[4]);
  });

  it("is complete once every applicable question has an answer", () => {
    const answers: QualificationAnswers = {
      intent: "buyer",
      area: "Mount Pearl",
      propertyDetails: "3 bed, 2 bath",
      timeline: "ASAP",
      financing: "pre-approved",
      budget: "$450,000",
    };
    expect(nextQuestion(config, answers)).toBeNull();
    expect(isComplete(config, answers)).toBe(true);
  });

  /**
   * Financing is a buyer-financing concept. A pure seller has nothing to
   * qualify there, so the question is skipped rather than left dangling.
   */
  it("skips the financing question for a pure seller", () => {
    const answers: QualificationAnswers = {
      intent: "seller",
      area: "Downtown St. John's",
      propertyDetails: "3 bed bungalow",
      timeline: "1-4 Months",
      financing: null,
      budget: null,
    };
    expect(nextQuestion(config, answers)).toBeNull();
    expect(isComplete(config, answers)).toBe(true);
  });

  it("still asks financing for downsize and upgrading intents, which involve buying", () => {
    for (const intent of ["downsize", "upgrading"] as const) {
      const answers: QualificationAnswers = {
        intent,
        area: "St. John's",
        propertyDetails: "3 bed, 2 bath",
        timeline: "ASAP",
        financing: null,
        budget: null,
      };
      expect(nextQuestion(config, answers)).toBe(config.questions[4]);
    }
  });

  it("throws rather than silently mis-mapping when the question count doesn't match", () => {
    const badConfig: IrisConfig = { ...config, questions: [...config.questions, "One more?"] };
    expect(() => nextQuestion(badConfig, BLANK_ANSWERS)).toThrow(/expects 5 qualification questions/);
  });
});

describe("scoreQualification", () => {
  it("scores a cash buyer with an urgent timeline as hot", () => {
    const { score } = scoreQualification({
      intent: "buyer",
      area: "Mount Pearl",
      propertyDetails: "3 bed, 2 bath",
      timeline: "ASAP",
      financing: "cash",
      budget: "$450,000",
    });
    // +45 cash, +25 wants to move now, +10 budget, +10 intent known, +5 phone (in-call)
    expect(score).toBe(95);
  });

  it("scores not-approved with a distant timeline low", () => {
    const { score } = scoreQualification({
      intent: "buyer",
      area: "unsure",
      propertyDetails: null,
      timeline: "12+ months",
      financing: "not-approved",
      budget: null,
    });
    // -10 not approved, +5 long timeline, +10 intent known, +5 phone (in-call)
    expect(score).toBe(10);
  });

  /**
   * The exact point of the financing scale: a cash buyer needs no lender, no
   * appraisal, no financing condition — they must never score below someone
   * merely pre-approved, let alone as a negative.
   */
  it("scores a cash buyer higher than an otherwise-identical pre-approved buyer", () => {
    const base = { intent: "buyer" as const, area: "x", propertyDetails: null, timeline: "ASAP", budget: "$400,000" };
    const cash = scoreQualification({ ...base, financing: "cash" }).score;
    const preApproved = scoreQualification({ ...base, financing: "pre-approved" }).score;
    expect(cash).toBeGreaterThan(preApproved);
  });

  it("scores financing in-progress between pre-approved and not-approved", () => {
    const base = { intent: "buyer" as const, area: "x", propertyDetails: null, timeline: "ASAP", budget: "$400,000" };
    const preApproved = scoreQualification({ ...base, financing: "pre-approved" }).score;
    const inProgress = scoreQualification({ ...base, financing: "in-progress" }).score;
    const notApproved = scoreQualification({ ...base, financing: "not-approved" }).score;
    expect(preApproved).toBeGreaterThan(inProgress);
    expect(inProgress).toBeGreaterThan(notApproved);
  });
});

describe("decideOutcome", () => {
  /**
   * Per the VA/ISA pipeline SOP: live transfer is attempted for EVERY
   * qualified lead, regardless of how high the score is — there is no tier
   * that skips straight to booking. hotScoreThreshold is intentionally
   * unused here.
   */
  it("transfers at or above the warm threshold, however high the score goes", () => {
    expect(decideOutcome(config, 40)).toBe("transfer");
    expect(decideOutcome(config, 75)).toBe("transfer");
    expect(decideOutcome(config, 95)).toBe("transfer");
  });

  it("nurtures below the warm threshold", () => {
    expect(decideOutcome(config, 39)).toBe("nurture");
    expect(decideOutcome(config, 0)).toBe("nurture");
  });
});

describe("calendarForIntent", () => {
  it("routes buyer and upgrading intents to the buyer calendar", () => {
    expect(calendarForIntent(config, "buyer")).toBe(config.calendars.buyer);
    expect(calendarForIntent(config, "upgrading")).toBe(config.calendars.buyer);
  });

  it("routes seller and downsize intents to the seller calendar", () => {
    expect(calendarForIntent(config, "seller")).toBe(config.calendars.seller);
    expect(calendarForIntent(config, "downsize")).toBe(config.calendars.seller);
  });

  it("has no calendar for unknown intent", () => {
    expect(calendarForIntent(config, "unknown")).toBeNull();
  });
});

describe("transferNumberForIntent", () => {
  it("routes buyer and upgrading intents to the buyer ring group", () => {
    expect(transferNumberForIntent(config, "buyer")).toBe(config.transferNumbers.buyer);
    expect(transferNumberForIntent(config, "upgrading")).toBe(config.transferNumbers.buyer);
  });

  it("routes seller and downsize intents to the seller ring group", () => {
    expect(transferNumberForIntent(config, "seller")).toBe(config.transferNumbers.seller);
    expect(transferNumberForIntent(config, "downsize")).toBe(config.transferNumbers.seller);
  });

  it("has no transfer number for unknown intent", () => {
    expect(transferNumberForIntent(config, "unknown")).toBeNull();
  });
});

describe("qualify", () => {
  /**
   * The SOP's core rule: ANY qualified lead gets "transfer" — a top score
   * gets the exact same outcome as a lead that just barely cleared the bar.
   * There is no separate "good enough to book directly" tier.
   */
  it("transfers a hot cash buyer, same outcome as any other qualified lead", () => {
    const result = qualify(config, {
      intent: "buyer",
      area: "Mount Pearl",
      propertyDetails: "3 bed, 2 bath",
      timeline: "ASAP",
      financing: "cash",
      budget: "$450,000",
    });
    expect(result.score).toBe(95);
    expect(result.outcome).toBe("transfer");
  });

  it("nurtures a seller with no financing signal", () => {
    const result = qualify(config, {
      intent: "seller",
      area: "St. John's",
      propertyDetails: "3 bed bungalow",
      timeline: "1-4 Months",
      financing: null,
      budget: null,
    });
    // +18 near-term timeline (parsed to 1 month), +10 intent known, +5 phone (in-call) = 33
    expect(result.score).toBe(33);
    expect(result.outcome).toBe("nurture");
  });

  it("transfers a lead that just clears the warm threshold", () => {
    const result = qualify(config, {
      intent: "buyer",
      area: "Mount Pearl",
      propertyDetails: "3 bed, 2 bath",
      timeline: "1-4 Months",
      financing: null,
      budget: "$300,000",
    });
    // +18 near-term timeline, +10 budget, +10 intent known, +5 phone (in-call) = 43
    expect(result.score).toBe(43);
    expect(result.outcome).toBe("transfer");
  });
});

describe("fieldWritesFor", () => {
  /**
   * The financing field is empty on every live contact checked because the
   * human ISA never writes the answer back as a real field value — if Iris
   * asks and doesn't write it, it inherits the exact same blind spot.
   */
  it("writes the financing answer as its actual value, not a yes/no", () => {
    const writes = fieldWritesFor(
      { intent: "buyer", area: "x", propertyDetails: null, timeline: "ASAP", financing: "cash", budget: null },
      config.writeFields
    );
    expect(writes["contact.are_you_pre_approuved"]).toBe("cash");
  });

  it("writes intent to the propertyInterest field as buyer/seller/downsize/upgrading", () => {
    const writes = fieldWritesFor(
      { intent: "downsize", area: "x", propertyDetails: null, timeline: "ASAP", financing: null, budget: null },
      config.writeFields
    );
    expect(writes["contact.lf_proprety"]).toBe("downsize");
  });

  it("omits fields that were never answered rather than writing empty strings", () => {
    const writes = fieldWritesFor(BLANK_ANSWERS, config.writeFields);
    expect(writes).toEqual({});
  });
});
