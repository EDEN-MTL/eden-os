import { describe, expect, it } from "vitest";
import { decideFromLineType, toE164 } from "./phone";

describe("toE164", () => {
  it("converts Google's national format to E.164", () => {
    // Google returns "(514) 555-0123"; Twilio requires "+15145550123".
    expect(toE164("(514) 555-0123")).toBe("+15145550123");
  });

  it("handles an already-prefixed number", () => {
    expect(toE164("+1 514 555 0123")).toBe("+15145550123");
    expect(toE164("1-514-555-0123")).toBe("+15145550123");
  });

  it("rejects anything it cannot place, rather than guessing", () => {
    // A number of the wrong length must not be padded or assumed — a bad
    // guess here bills a lookup and can text a stranger.
    expect(toE164("555-0123")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe("decideFromLineType", () => {
  it("sends to mobile and personal lines", () => {
    expect(decideFromLineType("mobile", "holdout")).toBe("send");
    expect(decideFromLineType("personal", "holdout")).toBe("send");
  });

  it("rejects landlines", () => {
    expect(decideFromLineType("landline", "holdout")).toBe("reject");
  });

  it("holds VOIP for a human instead of discarding it", () => {
    // Some business VOIP lines receive SMS and some do not. Collapsing these
    // into a reject silently throws away a real slice of the market.
    expect(decideFromLineType("fixedVoip", "holdout")).toBe("holdout");
    expect(decideFromLineType("nonFixedVoip", "holdout")).toBe("holdout");
  });

  it("honours a configured VOIP policy", () => {
    expect(decideFromLineType("fixedVoip", "allow")).toBe("send");
    expect(decideFromLineType("fixedVoip", "reject")).toBe("reject");
  });

  it("holds an unclassifiable number rather than assuming mobile", () => {
    // Twilio returns no line_type for numbers it cannot classify. Defaulting
    // to "send" there means texting landlines.
    expect(decideFromLineType("unknown", "holdout")).toBe("holdout");
    expect(decideFromLineType("", "holdout")).toBe("holdout");
  });
});
