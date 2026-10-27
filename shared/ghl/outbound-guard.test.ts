import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSendableText, BlockedTextError, outboundTextProblem, setBlockedTextHandler } from "./outbound-guard";

afterEach(() => setBlockedTextHandler(null));

describe("outboundTextProblem", () => {
  it("blocks Marcia Wiseman's garbled text: the contact id sent as the message", () => {
    expect(outboundTextProblem("oTCjDHG2AP4okGSGUsYs", "oTCjDHG2AP4okGSGUsYs")).toMatch(/own id/);
    // even when the id is not the one we were told, an unbroken id-shaped string is not a message
    expect(outboundTextProblem("oTCjDHG2AP4okGSGUsYs", "someone-else")).toMatch(/unbroken string/);
    expect(outboundTextProblem("Hi Marcia, your id is oTCjDHG2AP4okGSGUsYs", "oTCjDHG2AP4okGSGUsYs")).toMatch(/own id/);
  });
  it("blocks empty, unfilled-template and undefined text", () => {
    expect(outboundTextProblem("   ", "c")).toMatch(/empty/);
    expect(outboundTextProblem("Hi {{firstName}}, it's Iris", "c")).toMatch(/placeholder/);
    expect(outboundTextProblem("Hi undefined, it's Iris", "c")).toMatch(/undefined/);
    expect(outboundTextProblem("Your call is at NaN", "c")).toMatch(/NaN/);
    expect(outboundTextProblem("Hi [object Object]", "c")).toMatch(/object/);
    expect(outboundTextProblem(undefined, "c")).toMatch(/not text/);
  });
  it("lets every real kind of message through, including one-word replies", () => {
    for (const ok of [
      "Hi Sabrina, it's Iris from 3 Percent East Coast. Looks like we missed each other. Reply STOP to opt out.",
      "Congratulations",
      "Okay",
      "Yes!",
      "You're all set for Friday, October 23 at 2:00 PM.",
      "No problem at all, we won't reach out again. Take care!",
      "Hi Jacob, call me at 709-555-0100",
    ]) expect(outboundTextProblem(ok, "oTCjDHG2AP4okGSGUsYs")).toBeNull();
  });
});

describe("assertSendableText", () => {
  it("throws and tells the registered handler", () => {
    const handler = vi.fn();
    setBlockedTextHandler(handler);
    expect(() => assertSendableText("abc", "")).toThrow(BlockedTextError);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ contactId: "abc", problem: expect.stringMatching(/empty/) }));
  });
  it("still throws when the handler itself fails", () => {
    setBlockedTextHandler(() => {
      throw new Error("slack down");
    });
    expect(() => assertSendableText("abc", "")).toThrow(BlockedTextError);
  });
  it("does nothing for a real message", () => {
    expect(() => assertSendableText("abc", "Hi there")).not.toThrow();
  });
});
