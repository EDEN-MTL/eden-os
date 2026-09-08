import { describe, expect, it } from "vitest";
import { wasAnswered } from "./vapi-webhook";

describe("wasAnswered", () => {
  /**
   * Mark's rule, 2026-09-06: only re-dial a lead who genuinely never
   * answered — a real conversation, however it went (declined, hung up,
   * transferred, ended by Iris), stops the automatic sequence for good.
   *
   * Design flipped, 2026-09-08: this used to be a NOT_ANSWERED blocklist
   * (voicemail, no-answer, a couple of error-prefix checks) defaulting to
   * "answered" for anything else. A real test call hit
   * `call.start.error-get-transport` — the call never actually connected
   * (cost $0) — which fell through that blocklist as "answered" and
   * permanently stopped the lead from ever being retried. Vapi's real
   * endedReason enum has 629 possible values (confirmed against their
   * OpenAPI schema) — no blocklist can enumerate that. Now a small
   * ANSWERED allowlist, with everything else defaulting to "not answered."
   */
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

  it.each([
    "voicemail",
    "no-answer",
    "customer-did-not-answer",
    "customer-busy",
    "silence-timed-out",
    "manually-canceled",
    "call.in-progress.error-sip-outbound-call-failed-to-connect",
    "call.ringing.error-sip-inbound-call-failed-to-connect",
    // The exact real-world case that exposed the old blocklist's gap —
    // confirmed live, 2026-09-08, against a call that cost $0 and never
    // actually connected.
    "call.start.error-get-transport",
    "call.start.error-vapifault-get-org",
    "pipeline-error-eleven-labs-voice-failed",
  ])("treats %s as not answered", (reason) => {
    expect(wasAnswered(reason)).toBe(false);
  });

  it("fails toward RETRYING (treats as not answered) when the reason is missing or unrecognized", () => {
    expect(wasAnswered(null)).toBe(false);
    expect(wasAnswered("some-brand-new-failure-code-vapi-adds-later")).toBe(false);
  });
});
