import { afterEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getContact: vi.fn(),
  addContactTags: vi.fn(),
  findOpenOpportunitiesForContact: vi.fn(),
  updateOpportunityStage: vi.fn(),
}));
vi.mock("../shared/ghl", () => ghl);

const slack = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../shared/slack", () => slack);

const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("../agents/iris", () => iris);

vi.mock("../agents/iris/dial-pending", () => ({ reopenForNextAttempt: vi.fn() }));
vi.mock("../shared/db", () => ({ query: vi.fn() }));

import { describeOutcome, formatDuration, moveToFollowUpStage, postCallLogToSlack, tagSequenceExhausted, wasAnswered } from "./vapi-webhook";

afterEach(() => vi.clearAllMocks());

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

/**
 * Real gap found live 2026-09-20: nothing surfaced Iris's unanswered call
 * attempts anywhere in GHL. Mark's fix request had two parts: move the
 * lead's opportunity through the client's own DAY-N/WEEKEND follow-up
 * columns as each attempt goes unanswered, and tag it once the whole
 * sequence is exhausted with no answer at all.
 */
describe("moveToFollowUpStage", () => {
  const followUpStageIds = ["stage-day1-am", "stage-day1-pm", "stage-day2-am"];

  it("moves the opportunity to the stage matching the attempt that just went unanswered", async () => {
    iris.loadIrisConfig.mockReturnValue({ followUpStageIds });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([{ id: "opp-1" }]);

    await moveToFollowUpStage("3-percent-east-coast", "contact-1", 2);

    expect(ghl.updateOpportunityStage).toHaveBeenCalledWith("opp-1", "stage-day1-pm", "loc-1", "key-1");
  });

  it("does nothing when the client has no followUpStageIds configured", async () => {
    iris.loadIrisConfig.mockReturnValue({});

    await moveToFollowUpStage("eden-sub-account-one", "contact-1", 1);

    expect(ghl.getGhlConfig).not.toHaveBeenCalled();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("does nothing when attemptsMade is beyond the configured stage list, rather than crashing", async () => {
    iris.loadIrisConfig.mockReturnValue({ followUpStageIds });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });

    await moveToFollowUpStage("3-percent-east-coast", "contact-1", 99);

    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it("does not throw when the contact has no open opportunity to move", async () => {
    iris.loadIrisConfig.mockReturnValue({ followUpStageIds });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([]);

    await expect(moveToFollowUpStage("3-percent-east-coast", "contact-1", 1)).resolves.toBeUndefined();
    expect(ghl.updateOpportunityStage).not.toHaveBeenCalled();
  });
});

/**
 * Real gap found live 2026-09-20: nothing surfaced Iris's calls anywhere
 * outside our own DB. Mark created #iris-call-logs and asked for every call
 * — real or test, any outcome — to post there.
 */
describe("describeOutcome", () => {
  it("labels a completed live transfer distinctly", () => {
    expect(describeOutcome("assistant-forwarded-call")).toContain("Live transfer completed");
  });

  it("labels a voicemail drop distinctly", () => {
    expect(describeOutcome("voicemail")).toContain("voicemail");
  });

  it("labels a real conversation that didn't transfer", () => {
    expect(describeOutcome("customer-ended-call")).toContain("Answered");
  });

  it("labels anything else as no answer, including the reason", () => {
    expect(describeOutcome("no-answer")).toContain("no-answer");
    expect(describeOutcome(null)).toContain("unknown");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds only", () => {
    expect(formatDuration(17)).toBe("17s");
  });

  it("formats multi-minute durations as minutes and seconds", () => {
    expect(formatDuration(95)).toBe("1m 35s");
  });

  it("falls back to 'unknown' for missing or invalid durations", () => {
    expect(formatDuration(null)).toBe("unknown");
    expect(formatDuration(undefined)).toBe("unknown");
    expect(formatDuration(-1)).toBe("unknown");
  });
});

describe("postCallLogToSlack", () => {
  const message = { call: { customer: { number: "+17097496049" } }, durationSeconds: 17 };

  it("posts to #iris-call-logs with the contact's live name when one resolves", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockResolvedValue({ contact: { firstName: "Bijeesh", lastName: "Varghese" } });

    await postCallLogToSlack("3-percent-east-coast", "contact-1", message, "voicemail");

    expect(slack.sendMessage).toHaveBeenCalledWith(
      "iris",
      expect.objectContaining({
        channel: "iris-call-logs",
        text: expect.stringContaining("Bijeesh Varghese (+17097496049)"),
      })
    );
  });

  it("falls back to the bare phone number when there's no contactId (a manual test call)", async () => {
    await postCallLogToSlack("3-percent-east-coast", null, message, "customer-ended-call");

    expect(ghl.getContact).not.toHaveBeenCalled();
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("+17097496049") }));
  });

  it("still posts using the phone number when the GHL name lookup fails", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getContact.mockRejectedValue(new Error("GHL API down"));

    await expect(postCallLogToSlack("3-percent-east-coast", "contact-1", message, "voicemail")).resolves.toBeUndefined();
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ text: expect.stringContaining("+17097496049") }));
  });

  it("never throws even if Slack itself fails", async () => {
    slack.sendMessage.mockRejectedValue(new Error("Slack API down"));
    await expect(postCallLogToSlack("3-percent-east-coast", null, message, "voicemail")).resolves.toBeUndefined();
  });
});

describe("tagSequenceExhausted", () => {
  it("tags the contact 'iris no answer'", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });

    await tagSequenceExhausted("3-percent-east-coast", "contact-1");

    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["iris no answer"], "loc-1", "key-1");
  });

  it("does not throw when the client has no GHL config", async () => {
    ghl.getGhlConfig.mockResolvedValue(null);

    await expect(tagSequenceExhausted("3-percent-east-coast", "contact-1")).resolves.toBeUndefined();
    expect(ghl.addContactTags).not.toHaveBeenCalled();
  });
});
