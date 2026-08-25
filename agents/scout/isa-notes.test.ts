import { describe, expect, it } from "vitest";
import { parseFinancing, parseIsaNotes } from "./isa-notes";

/**
 * Every string below was taken verbatim from the live 3% account. Guessing at
 * these once already produced a scorer that gave the single most common real
 * timeline value a score of zero.
 */
describe("parseFinancing — real values from the account", () => {
  it("treats cash buyers as cash, not as a failed pre-approval", () => {
    // The distinction that matters most: three of these begin with a negation
    // but describe the strongest possible buyer.
    expect(parseFinancing("paying cash")).toBe("cash");
    expect(parseFinancing("cash")).toBe("cash");
    expect(parseFinancing("no need")).toBe("cash");
    expect(parseFinancing("not necessary")).toBe("cash");
  });

  it("reads secured financing", () => {
    expect(parseFinancing("yes")).toBe("pre-approved");
  });

  it("separates in-progress from a flat no", () => {
    expect(parseFinancing("no, in the process")).toBe("in-progress");
    expect(parseFinancing("no, in the process/some equity")).toBe("in-progress");
    expect(parseFinancing("working on it")).toBe("in-progress");
  });

  it("reads a flat no", () => {
    expect(parseFinancing("no")).toBe("not-approved");
  });

  /**
   * "782 wife is 680 credit" is a credit score, not an approval. Guessing
   * either way would change how the lead is routed, so it stays unknown.
   */
  it("returns null for answers that are not an approval status", () => {
    expect(parseFinancing("782 wife is 680 credit")).toBeNull();
    expect(parseFinancing("")).toBeNull();
    expect(parseFinancing(null)).toBeNull();
  });
});

describe("parseIsaNotes", () => {
  const buyer = [
    "Area: st.johns",
    "1st Time Buyer: yes",
    "Type of house: NC",
    "Bed: 3",
    "Bath: 2",
    "Notes:",
    "Price Range: $400K-$600K",
    "Pre-approved: no, in the process",
    "When: 1-4 Months",
  ].join("\n");

  const seller = "area: , mt.pearl\nreason: relocating\ntimeline: 6 months";

  it("parses the buyer note format", () => {
    const n = parseIsaNotes(buyer);
    expect(n.financing).toBe("in-progress");
    expect(n.timeline).toBe("1-4 Months");
    expect(n.budget).toBe("$400K-$600K");
    expect(n.area).toBe("st.johns");
    expect(n.firstTimeBuyer).toBe(true);
  });

  it("parses the seller note format, which uses different labels", () => {
    const n = parseIsaNotes(seller);
    expect(n.timeline).toBe("6 months");
    expect(n.area).toBe(", mt.pearl");
    expect(n.financing).toBeNull();
  });

  /**
   * Regression guard for a real bug. \s matches newlines, so on a blank
   * "Pre-approved:" line the capture ran on and swallowed the NEXT line,
   * yielding financing values like "When: 1-4 Months" — plausible-looking
   * and completely wrong. Sixteen of thirty-three records hit this.
   */
  it("does not let a blank value swallow the following line", () => {
    const blank = "Price Range: $400K-$600K\nPre-approved:\nWhen: 1-4 Months";
    const n = parseIsaNotes(blank);
    expect(n.financing).toBeNull();
    expect(n.timeline).toBe("1-4 Months");
    expect(n.budget).toBe("$400K-$600K");
  });

  it("handles an absent or empty note", () => {
    expect(parseIsaNotes(null).financing).toBeNull();
    expect(parseIsaNotes("").timeline).toBeNull();
  });
});
