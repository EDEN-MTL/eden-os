import { describe, expect, it } from "vitest";
import { wasAnswered } from "./vapi-webhook";

describe("wasAnswered", () => {
  /**
   * Mark's rule, 2026-09-06: only re-dial a lead who genuinely never
   * answered — a real conversation, however it went (declined, hung up,
   * transferred, ended by Iris), stops the automatic sequence for good.
   * Confirmed against Vapi's own endedReason string enum rather than
   * guessed at.
   */
  it.each(["voicemail", "no-answer", "customer-did-not-answer", "customer-busy", "silence-timed-out", "manually-canceled"])(
    "treats %s as not answered",
    (reason) => {
      expect(wasAnswered(reason)).toBe(false);
    }
  );

  it.each([
    "customer-ended-call",
    "customer-ended-call-after-warm-transfer-attempt",
    "customer-ended-call-before-warm-transfer",
    "assistant-ended-call",
    "assistant-forwarded-call",
    "exceeded-max-duration",
  ])("treats %s as answered (a real conversation happened)", (reason) => {
    expect(wasAnswered(reason)).toBe(true);
  });

  it("treats any call.in-progress or call.ringing error as not answered — never a real conversation", () => {
    expect(wasAnswered("call.in-progress.error-sip-outbound-call-failed-to-connect")).toBe(false);
    expect(wasAnswered("call.ringing.error-sip-inbound-call-failed-to-connect")).toBe(false);
  });

  it("fails toward NOT retrying (treats as answered) when the reason is missing or unrecognized", () => {
    expect(wasAnswered(null)).toBe(true);
    expect(wasAnswered("some-brand-new-reason-vapi-added-later")).toBe(true);
  });
});
