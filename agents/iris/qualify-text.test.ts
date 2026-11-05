import { describe, expect, it } from "vitest";
import { buildCallbackQualifyText, buildMissedCallQualifyText, qualifyingQuestion } from "./qualify-text";

describe("qualifyingQuestion", () => {
  it("asks a buyer for a budget when the form has none, treating filler as none", () => {
    expect(qualifyingQuestion({ intent: "buyer", budget: null, timeline: "June 2027" })).toBe("What kind of budget are you working with?");
    expect(qualifyingQuestion({ intent: "buyer", budget: "Not sure", timeline: "June 2027" })).toBe("What kind of budget are you working with?");
  });

  it("narrows a budget range to a specific figure", () => {
    expect(qualifyingQuestion({ intent: "buyer", budget: "$299K-$600K", timeline: "3-6 Months" })).toBe("I see $299K-$600K on your form. What specific budget do you have in mind?");
  });

  it("narrows a timeline bucket once the budget is specific, and an ASAP one to a date", () => {
    expect(qualifyingQuestion({ intent: "buyer", budget: "$450,000", timeline: "3-6 Months" })).toBe("I see you put 3-6 months for your timeline. Do you have a particular month in mind?");
    expect(qualifyingQuestion({ intent: "buyer", budget: "$450,000", timeline: "ASAP" })).toContain("as soon as possible");
  });

  it("asks a seller the timeline, never a budget", () => {
    expect(qualifyingQuestion({ intent: "seller", budget: null, timeline: null })).toBe("When are you hoping to sell?");
  });

  it("moves on to a call with an agent when everything is specific", () => {
    expect(qualifyingQuestion({ intent: "buyer", budget: "$450,000", timeline: "June 2027" })).toContain("a quick call with one of our agents");
  });
});

describe("the two openers", () => {
  const lead = { name: "Melanie Petten", intent: "buyer", budget: "$299K-$600K", timeline: "3-6 Months" };
  it("says sorry about the missed call and asks one thing, with no opt-out line", () => {
    const text = buildMissedCallQualifyText("Melanie Petten", "3 Percent East Coast", lead);
    expect(text).toBe("Hi Melanie, it's Iris from 3 Percent East Coast. Sorry I missed you! I'd love to match you with the right agent. I see $299K-$600K on your form. What specific budget do you have in mind?");
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text).not.toMatch(/stop/i);
  });
  it("says it saw them call back", () => {
    expect(buildCallbackQualifyText("Melanie Petten", "3 Percent East Coast", lead)).toBe("Hi Melanie, it's Iris from 3 Percent East Coast. I saw you tried calling us back, sorry we missed you! I see $299K-$600K on your form. What specific budget do you have in mind?");
  });
});
