import { describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_FOLLOW_UP,
  AGENT_UNAVAILABLE_LINE,
  BUYER_QUESTIONS,
  CALL_OPENING_GREETING,
  callbackRecapLine,
  callOpeningContextLine,
  DOWNSIZER_QUESTIONS,
  EDGE_CASE_RESPONSES,
  LIVE_TRANSFER_LINES,
  liveTransferLineForIntent,
  NATURAL_TRANSITIONS,
  SELLER_QUESTIONS,
} from "./scripts";

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
    "isRealPerson",
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

describe("CALL_OPENING_GREETING", () => {
  it("identifies Iris by name rather than a human alias", () => {
    expect(CALL_OPENING_GREETING).toContain("Iris");
  });
});

describe("callOpeningContextLine", () => {
  it("uses the city it's given for a seller, not a hardcoded location", () => {
    const line = callOpeningContextLine("seller", "St. John's", null);
    expect(line).toContain("St. John's");
  });

  it("mentions the lead source when one is known", () => {
    const line = callOpeningContextLine("buyer", "St. John's", "facebook");
    expect(line).toContain("facebook");
  });

  it("omits any source clause when the lead carries no attribution", () => {
    const line = callOpeningContextLine("buyer", "St. John's", null);
    expect(line).not.toBeNull();
    expect(line).not.toMatch(/reached out through/);
  });

  it("returns null for unknown intent rather than inventing a reason for the call", () => {
    expect(callOpeningContextLine("unknown", "St. John's", "facebook")).toBeNull();
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
