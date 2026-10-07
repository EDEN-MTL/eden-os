import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getContact: vi.fn(),
  addContactTags: vi.fn(),
  findOpenOpportunitiesForContact: vi.fn(),
  updateOpportunityStage: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  updateContact: vi.fn(),
  sendSMS: vi.fn(),
  getMessage: vi.fn(),
  listLocationUsers: vi.fn(),
}));
vi.mock("../shared/ghl", () => ghl);

const slack = vi.hoisted(() => ({ sendMessage: vi.fn(), uploadFile: vi.fn() }));
vi.mock("../shared/slack", () => slack);

const conversationMemory = vi.hoisted(() => ({ appendHistory: vi.fn() }));
vi.mock("../shared/conversation-memory", () => conversationMemory);

const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("../agents/iris", () => iris);

const dialPending = vi.hoisted(() => ({ reopenForNextAttempt: vi.fn(), reopenAfterMissedCallback: vi.fn(), scheduleExplicitCallback: vi.fn(), holdForTextReply: vi.fn(), SWEEP_SOURCE: "sweep" }));
vi.mock("../agents/iris/dial-pending", () => dialPending);

const db = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock("../shared/db", () => db);

const inbound = vi.hoisted(() => ({ handleInboundCall: vi.fn() }));
vi.mock("../agents/iris/inbound", () => inbound);

const callSignals = vi.hoisted(() => ({ classifyMissedCallback: vi.fn(async () => ({ type: "none" })) }));
vi.mock("../agents/iris/call-signals", () => callSignals);

import {
  appendCallStatusNote,
  attachRecording,
  createVapiRouter,
  customerSpokeAtAll,
  describeOutcome,
  formatDuration,
  genuinelyAnswered,
  hitCallScreener,
  maybeHonorMissedCallback,
  maybeReopenPendingCall,
  buildSweepMissedCallText,
  formatLiveTransferPost,
  postLiveTransferToSlack,
  moveToFollowUpStage,
  smsConfirmation,
  postCallLogToSlack,
  tagSequenceExhausted,
  wasAnswered,
} from "./vapi-webhook";

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  smsConfirmation.delaysMs = [0, 0];
  ghl.sendSMS.mockResolvedValue({ messageId: "msg-1" });
  ghl.getMessage.mockResolvedValue({ status: "delivered" });
});

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
 * Real gap found live 2026-09-22: calling.ts's new idle-timeout endCall
 * hook (gives up on a lead who never responds even after the "are you
 * still there?" nudge) reports endedReason "assistant-ended-call" —
 * exactly the same as a genuine, real, completed conversation that Iris
 * wrapped up normally. wasAnswered's allowlist alone can't tell these
 * apart; only checking whether the customer actually said anything can.
 */
describe("customerSpokeAtAll", () => {
  it("is true when the customer said real words at any point", () => {
    expect(customerSpokeAtAll({ messages: [{ role: "user", message: "Hello?" }] })).toBe(true);
    expect(customerSpokeAtAll({ messages: [{ role: "bot", message: "Hi" }, { role: "user", message: "Yeah" }] })).toBe(true);
  });

  it("is false when the customer never spoke at all", () => {
    expect(customerSpokeAtAll({ messages: [{ role: "bot", message: "Sorry, are you still there?" }] })).toBe(false);
    expect(customerSpokeAtAll({ messages: [] })).toBe(false);
    expect(customerSpokeAtAll({})).toBe(false);
  });

  it("ignores a user turn with empty/whitespace-only content", () => {
    expect(customerSpokeAtAll({ messages: [{ role: "user", message: "   " }] })).toBe(false);
    expect(customerSpokeAtAll({ messages: [{ role: "user", message: "" }] })).toBe(false);
  });
});

describe("genuinelyAnswered", () => {
  const spoke = { messages: [{ role: "user", message: "Hello?" }] };
  const silent = { messages: [{ role: "bot", message: "Sorry, are you still there?" }] };

  it("matches wasAnswered for every reason except assistant-ended-call", () => {
    expect(genuinelyAnswered("assistant-forwarded-call", silent)).toBe(true);
    expect(genuinelyAnswered("voicemail", spoke)).toBe(false);
    expect(genuinelyAnswered("no-answer", spoke)).toBe(false);
  });

  it("treats assistant-ended-call as genuinely answered only if the customer actually spoke", () => {
    expect(genuinelyAnswered("assistant-ended-call", spoke)).toBe(true);
    expect(genuinelyAnswered("assistant-ended-call", silent)).toBe(false);
  });

  /**
   * Real lead-loss bug found live 2026-09-26 (contact Yv2IP2sS51FuKGkinu4W,
   * "Florida Lisa"): a call-screening service picked up, not the lead. Its
   * scripted turns transcribed as real "customer" speech, so
   * customerSpokeAtAll alone read this as a genuine conversation and the
   * lead's automatic cadence stopped for good after a single attempt.
   */
  it("treats a call-screening service pickup as NOT genuinely answered, even though the customer 'spoke'", () => {
    const screener = {
      messages: [
        { role: "user", message: "Hi. If you record your name and reason for calling, I'll see if this person is available." },
        { role: "bot", message: "Hi. This is Iris with 3 percent East Coast. Am I speaking with Florida Lisa?" },
        { role: "user", message: "I'm sorry. This person is not available. If you would like to leave an additional message, please reply after the tone." },
      ],
    };
    expect(genuinelyAnswered("assistant-ended-call", screener)).toBe(false);
  });
});

describe("hitCallScreener", () => {
  it("detects the distinctive screener phrase regardless of casing", () => {
    expect(hitCallScreener({ messages: [{ role: "user", message: "please RECORD your name and reason for calling" }] })).toBe(true);
  });

  it("is false for a real conversation, even one that mentions being unavailable", () => {
    expect(hitCallScreener({ messages: [{ role: "user", message: "Sorry, he's not available right now, can you call back later?" }] })).toBe(false);
  });

  it("is false with no messages at all", () => {
    expect(hitCallScreener({})).toBe(false);
    expect(hitCallScreener({ messages: [] })).toBe(false);
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
const messageWithUserSpeech = { messages: [{ role: "user", message: "Hello?" }] };
const messageWithNoUserSpeech = { messages: [{ role: "bot", message: "Sorry, are you still there?" }] };

describe("describeOutcome", () => {
  it("labels a completed live transfer distinctly", () => {
    expect(describeOutcome("assistant-forwarded-call", messageWithUserSpeech)).toContain("Live transfer completed");
  });

  it("labels a voicemail drop distinctly", () => {
    expect(describeOutcome("voicemail", messageWithNoUserSpeech)).toContain("voicemail");
  });

  it("labels a real conversation that didn't transfer", () => {
    expect(describeOutcome("customer-ended-call", messageWithUserSpeech)).toContain("Answered");
  });

  it("labels anything else as no answer, including the reason", () => {
    expect(describeOutcome("no-answer", messageWithNoUserSpeech)).toContain("no-answer");
    expect(describeOutcome(null, messageWithNoUserSpeech)).toContain("unknown");
  });

  /**
   * Real gap found live 2026-09-21/22: calling.ts's new idle-timeout
   * endCall hook (gives up on a lead who never responds even after the
   * "are you still there?" nudge) reports the exact same endedReason as
   * a genuine assistant-wrapped-up conversation — "assistant-ended-call".
   * The Slack log must tell these apart, not just the retry logic.
   */
  it("labels the idle-timeout giveup distinctly from a real assistant-ended conversation", () => {
    expect(describeOutcome("assistant-ended-call", messageWithNoUserSpeech)).toMatch(/no response/i);
    expect(describeOutcome("assistant-ended-call", messageWithUserSpeech)).toContain("Answered");
  });

  /**
   * Real near-miss found live 2026-09-24: Jalpesh Patel — fully qualified,
   * agreed to the transfer, disconnected before it actually connected him
   * to an agent. Confirmed against Vapi's real endedReason enum: both the
   * before- and after-attempt variants need their own label, distinct from
   * a generic "answered, no transfer" — this lead needs a manual callback.
   */
  it("labels a disconnect right before/during a transfer attempt distinctly from a generic 'answered, no transfer'", () => {
    expect(describeOutcome("customer-ended-call-before-warm-transfer", messageWithUserSpeech)).toMatch(/manual callback/i);
    expect(describeOutcome("customer-ended-call-after-warm-transfer-attempt", messageWithUserSpeech)).toMatch(/manual callback/i);
  });

  /**
   * Real gap found live 2026-09-26: "Florida Lisa"'s call hit a call-
   * screening service, not the actual lead — Vapi's own voicemailDetection
   * never flagged it (it's an interactive screener, not a static
   * voicemail greeting), so it would otherwise have posted as a plain
   * "Answered (no transfer)", indistinguishable from a real short chat.
   */
  it("labels a call-screening service pickup distinctly, even though the endedReason looks like a real conversation", () => {
    const screener = {
      messages: [
        { role: "user", message: "Hi. If you record your name and reason for calling, I'll see if this person is available." },
      ],
    };
    expect(describeOutcome("assistant-ended-call", screener)).toMatch(/screening/i);
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

/**
 * Real gap found live 2026-09-29: Vapi's "assistant-request" is the ONE
 * message type that needs a real, synchronous JSON response (an assistant
 * to answer with) within ~7.5s — unlike every other message type, which
 * this router acks with a blank 200 before processing. Getting this branch
 * ordered wrong (ack-then-process, same as end-of-call-report) would send
 * Vapi an empty body and fail every real inbound call silently.
 */
describe("POST / — routes assistant-request to Iris's inbound handler", () => {
  function getRootHandler(): (req: any, res: any) => Promise<void> {
    const router = createVapiRouter();
    return (router as any).stack[0].route.stack[0].handle;
  }

  function fakeRes() {
    const res: any = { status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() };
    return res;
  }

  it("responds with the built assistant, not a blank ack, for an assistant-request", async () => {
    inbound.handleInboundCall.mockResolvedValue({ assistant: { firstMessage: "hi" } });
    const res = fakeRes();

    await getRootHandler()({ body: { message: { type: "assistant-request", call: { id: "call-1" } } }, headers: {} }, res);

    expect(inbound.handleInboundCall).toHaveBeenCalledWith({ type: "assistant-request", call: { id: "call-1" } });
    expect(res.json).toHaveBeenCalledWith({ assistant: { firstMessage: "hi" } });
    expect(res.send).not.toHaveBeenCalled();
  });

  it("responds with an error body when the inbound handler can't answer", async () => {
    inbound.handleInboundCall.mockResolvedValue({ error: "Sorry, try again shortly." });
    const res = fakeRes();

    await getRootHandler()({ body: { message: { type: "assistant-request", call: {} } }, headers: {} }, res);

    expect(res.json).toHaveBeenCalledWith({ error: "Sorry, try again shortly." });
  });

  it("still acks with a blank 200 for every other message type, unchanged", async () => {
    const res = fakeRes();

    await getRootHandler()({ body: { message: { type: "end-of-call-report", call: { id: "call-1" } } }, headers: {} }, res);

    expect(res.send).toHaveBeenCalled();
    expect(inbound.handleInboundCall).not.toHaveBeenCalled();
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

  /**
   * Real gap found live 2026-09-23: Mark replied in the Slack THREAD under
   * one of these exact posts asking a follow-up question, and Iris had no
   * idea what she'd just posted — the historyKey a thread reply looks up
   * (channel:<realChannelId>:<rootTs>) had never been seeded, since this
   * call site posts via sendMessage() directly, bypassing generateReply
   * entirely.
   */
  it("seeds the post into Iris's own conversation history, keyed by Slack's real resolved channel id + this message's ts", async () => {
    slack.sendMessage.mockResolvedValue({ ts: "5555.6666", channel: "C0REALCALLLOGS" });

    await postCallLogToSlack("3-percent-east-coast", null, message, "voicemail");

    expect(conversationMemory.appendHistory).toHaveBeenCalledWith(
      "iris",
      "channel:C0REALCALLLOGS:5555.6666",
      "assistant",
      expect.stringContaining("+17097496049")
    );
  });

  it("does not throw, and the post still succeeds, if sendMessage's response is missing ts/channel", async () => {
    slack.sendMessage.mockResolvedValue({});
    await expect(postCallLogToSlack("3-percent-east-coast", null, message, "voicemail")).resolves.toBeUndefined();
    expect(conversationMemory.appendHistory).not.toHaveBeenCalled();
  });

  it("attaches the call recording as a threaded reply once the post succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("fake wav bytes").buffer }));
    slack.sendMessage.mockResolvedValue({ ts: "5555.6666", channel: "C0REALCALLLOGS" });
    conversationMemory.appendHistory.mockResolvedValue(undefined);
    const messageWithRecording = { ...message, call: { ...message.call, id: "call-123" }, artifact: { presignedMonoUrl: "https://example.com/mono.wav" } };

    await postCallLogToSlack("3-percent-east-coast", null, messageWithRecording, "voicemail");

    expect(slack.uploadFile).toHaveBeenCalledWith(
      "iris",
      expect.objectContaining({ channel: "C0REALCALLLOGS", threadTs: "5555.6666", filename: "call-123.wav" })
    );
    vi.unstubAllGlobals();
  });
});

/**
 * Mark's ask, 2026-09-27: attach the real Vapi call recording to the
 * Slack post. Confirmed live: the deprecated plain artifact.recordingUrl
 * 400s (the storage bucket is private), but the presigned URLs Vapi hands
 * back on the SAME end-of-call-report payload work with a real GET — and
 * expire in ~30 minutes, which is exactly why the actual audio gets
 * uploaded to Slack rather than just linking to it.
 */
describe("attachRecording", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads the presigned stereo recording and uploads it as a threaded reply", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("fake wav bytes").buffer });
    const message = { call: { id: "call-123" }, artifact: { presignedStereoUrl: "https://example.com/stereo.wav", presignedMonoUrl: "https://example.com/mono.wav" } };

    await attachRecording(message, "C0REALCALLLOGS", "5555.6666");

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/stereo.wav");
    expect(slack.uploadFile).toHaveBeenCalledWith(
      "iris",
      expect.objectContaining({ channel: "C0REALCALLLOGS", threadTs: "5555.6666", filename: "call-123.wav" })
    );
  });

  it("falls back to the mono URL when stereo isn't present", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("fake wav bytes").buffer });
    const message = { call: { id: "call-123" }, artifact: { presignedMonoUrl: "https://example.com/mono.wav" } };

    await attachRecording(message, "C0REALCALLLOGS", "5555.6666");

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/mono.wav");
  });

  it("does nothing — never throws — when there's no recording URL at all", async () => {
    await expect(attachRecording({ call: { id: "call-123" } }, "C0REALCALLLOGS", "5555.6666")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(slack.uploadFile).not.toHaveBeenCalled();
  });

  it("skips the upload (never throws) when the recording fetch itself fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const message = { call: { id: "call-123" }, artifact: { presignedMonoUrl: "https://example.com/mono.wav" } };

    await expect(attachRecording(message, "C0REALCALLLOGS", "5555.6666")).resolves.toBeUndefined();
    expect(slack.uploadFile).not.toHaveBeenCalled();
  });

  it("never throws even if the Slack upload itself fails", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("fake wav bytes").buffer });
    slack.uploadFile.mockRejectedValueOnce(new Error("Slack API down"));
    const message = { call: { id: "call-123" }, artifact: { presignedMonoUrl: "https://example.com/mono.wav" } };

    await expect(attachRecording(message, "C0REALCALLLOGS", "5555.6666")).resolves.toBeUndefined();
  });
});

/**
 * Mark's explicit instruction, 2026-09-24: the lead's GHL note must update
 * even when the call didn't end in a transfer or booking — before this,
 * the ONLY write to isa_notes was the model-driven save_isa_notes tool,
 * timed to fire right before presenting a transfer, so a call that ended
 * earlier (or was disconnected right before the transfer completed, like a
 * real case found live the same day — Jalpesh Patel) left nothing on the
 * contact record at all.
 */
describe("appendCallStatusNote", () => {
  const message = { call: { customer: { number: "+17097496049" } }, durationSeconds: 42 };
  const CONFIG = {
    questions: [],
    hotScoreThreshold: 75,
    warmScoreThreshold: 40,
    calendars: { buyer: "b", seller: "s" },
    transferNumbers: { buyer: "+1", seller: "+1" },
    callbackNotesFieldKey: "contact.isa_notes",
    timezone: "America/St_Johns",
    writeFields: { timeline: "x", budget: "x", propertyInterest: "x", preApproved: "x" },
    outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
  };

  it("writes a fresh status line when the field was empty", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    iris.loadIrisConfig.mockReturnValue(CONFIG);
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({ contact: { customFields: [] } });

    await appendCallStatusNote("3-percent-east-coast", "contact-1", "voicemail", message);

    expect(ghl.updateContact).toHaveBeenCalledWith(
      "contact-1",
      { customFields: [{ id: "field-notes-1", value: expect.stringContaining("Left voicemail") }] },
      "loc-1",
      "key-1"
    );
  });

  /**
   * Real case this exists for: save_isa_notes may already have written a
   * genuine qualification summary moments earlier in the SAME call — the
   * status line must be appended, never overwrite and destroy it.
   */
  it("appends to an existing note rather than overwriting it — never destroys a real qualification summary", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    iris.loadIrisConfig.mockReturnValue(CONFIG);
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({
      contact: { customFields: [{ id: "field-notes-1", value: "Lead: Jalpesh Patel\nBudget: $350k-400k" }] },
    });

    await appendCallStatusNote("3-percent-east-coast", "contact-1", "customer-ended-call-before-warm-transfer", message);

    const call = ghl.updateContact.mock.calls[0];
    const writtenValue = call[1].customFields[0].value;
    expect(writtenValue).toContain("Lead: Jalpesh Patel\nBudget: $350k-400k");
    expect(writtenValue).toContain("manual callback");
    expect(writtenValue.indexOf("Jalpesh")).toBeLessThan(writtenValue.indexOf("manual callback"));
  });

  it("includes the real outcome and duration in the status line", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    iris.loadIrisConfig.mockReturnValue(CONFIG);
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({ contact: { customFields: [] } });

    await appendCallStatusNote("3-percent-east-coast", "contact-1", "customer-ended-call", message);

    const writtenValue = ghl.updateContact.mock.calls[0][1].customFields[0].value;
    expect(writtenValue).toMatch(/Answered/);
    expect(writtenValue).toContain("42s");
  });

  it("never throws — a failure here must never break the end-of-call handler", async () => {
    ghl.getGhlConfig.mockRejectedValue(new Error("GHL API down"));
    await expect(appendCallStatusNote("3-percent-east-coast", "contact-1", "voicemail", message)).resolves.toBeUndefined();
    expect(ghl.updateContact).not.toHaveBeenCalled();
  });

  it("skips writing (does not throw) when the notes field key doesn't resolve to a real field id", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    iris.loadIrisConfig.mockReturnValue(CONFIG);
    ghl.getCustomFieldDefs.mockResolvedValue([]);

    await appendCallStatusNote("3-percent-east-coast", "contact-1", "voicemail", message);

    expect(ghl.updateContact).not.toHaveBeenCalled();
  });

  it("does nothing when there's no iris config for this client", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    iris.loadIrisConfig.mockReturnValue(null);

    await appendCallStatusNote("3-percent-east-coast", "contact-1", "voicemail", message);

    expect(ghl.getCustomFieldDefs).not.toHaveBeenCalled();
    expect(ghl.updateContact).not.toHaveBeenCalled();
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

/**
 * Real case found live 2026-10-01 (Saife Sarwar): "Ma'am, right now is
 * busy. Can I call you later?" then hung up mid-reply, before
 * schedule_callback ever got a turn to run. endedReason was a genuine
 * pickup, so maybeReopenPendingCall never fires — this is the only place
 * left that can catch a callback request the live call itself missed.
 */
describe("maybeHonorMissedCallback", () => {
  const PENDING_ROW = { id: 69, attempts_made: 1, created_at: new Date("2026-10-01T16:36:06.698Z"), status: "placed" };

  beforeEach(() => {
    db.query.mockResolvedValue([PENDING_ROW]);
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns" });
  });

  it("schedules an explicit callback when the lead named a specific time with no confirmation", async () => {
    const when = new Date("2026-10-01T20:30:00.000Z");
    callSignals.classifyMissedCallback.mockResolvedValue({ type: "schedule_for", when });

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: call me at 6pm\nAI: Sure, let me");

    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledWith("3-percent-east-coast", "contact-1", when);
    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
  });

  /**
   * Mark's spec, 2026-10-01: "later" with no specific time defaults to
   * ~1 hour out — the exact same default webhooks/vapi-tools.ts's live
   * schedule_callback tool uses for the identical scenario — never the
   * normal multi-hour/next-day cadence slot.
   */
  it("schedules a callback ~1 hour out, via the same mechanism as a named time, when the lead asked for 'later' with no specific time", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    callSignals.classifyMissedCallback.mockResolvedValue({ type: "call_later" });
    const before = Date.now();

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: I'm busy, call me later\nAI: No problem at");

    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledTimes(1);
    const [calledClientId, calledContactId, when] = dialPending.scheduleExplicitCallback.mock.calls[0];
    expect(calledClientId).toBe("3-percent-east-coast");
    expect(calledContactId).toBe("contact-1");
    expect((when as Date).getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect((when as Date).getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
  });

  /**
   * Mark's explicit instruction, 2026-10-01: "store the callback time in
   * the lead/opportunity record... not just in Iris's conversational
   * state. Otherwise, the next scheduled call could lose the context of
   * why it is calling back and when the lead requested it." Appends
   * (never overwrites) the SAME field appendCallStatusNote already writes
   * a generic status line to moments earlier in this same handler.
   */
  it("writes a durable note on the contact explaining the callback, appending rather than overwriting", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({ contact: { customFields: [{ id: "field-notes-1", value: "Iris call Oct 1 — Answered. Duration: 38s." }] } });
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes" });
    callSignals.classifyMissedCallback.mockResolvedValue({ type: "call_later" });

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: call me later\nAI: No problem at");

    const writtenValue = ghl.updateContact.mock.calls[0][1].customFields[0].value;
    expect(writtenValue).toContain("Iris call Oct 1 — Answered. Duration: 38s."); // the earlier status line is preserved
    expect(writtenValue).toMatch(/lead asked to be called back/i);
  });

  it("does nothing when no callback was actually missed", async () => {
    callSignals.classifyMissedCallback.mockResolvedValue({ type: "none" });

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: great, talk soon!\nAI: Bye!");

    expect(dialPending.scheduleExplicitCallback).not.toHaveBeenCalled();
    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
  });

  it("does nothing when there's no transcript at all", async () => {
    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", null);

    expect(callSignals.classifyMissedCallback).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does nothing when the pending row has already moved on from 'placed' (something else already handled it)", async () => {
    db.query.mockResolvedValue([{ ...PENDING_ROW, status: "skipped" }]);

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: call me later\nAI: Sure");

    expect(callSignals.classifyMissedCallback).not.toHaveBeenCalled();
  });

  /**
   * The deliberate behavior difference from maybeReopenPendingCall: a row
   * already carrying is_explicit_callback: true (e.g. from an EARLIER,
   * unrelated call_consent-by-text scheduling — agents/iris/dial-pending.ts)
   * must still be checked for a callback missed on THIS call, not skipped
   * outright the way the automatic-retry path skips it.
   */
  it("still checks for a missed callback even when is_explicit_callback is already true on the row", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    db.query.mockResolvedValue([{ ...PENDING_ROW, is_explicit_callback: true }]);
    callSignals.classifyMissedCallback.mockResolvedValue({ type: "call_later" });

    await maybeHonorMissedCallback("3-percent-east-coast", "contact-1", "User: call me later\nAI: No problem at");

    expect(dialPending.scheduleExplicitCallback).toHaveBeenCalledTimes(1);
  });
});

/**
 * Mark, 2026-10-05: Saife Sarwar asked for a callback, Iris called at
 * 6:55pm, no answer — and nothing ever tried again, because explicit
 * callback rows were excluded from the retry logic entirely.
 */
describe("maybeReopenPendingCall — missed explicit callbacks", () => {
  const ROW = {
    id: 69,
    attempts_made: 2,
    created_at: new Date("2026-10-01T16:36:06.698Z"),
    status: "placed",
    is_explicit_callback: true,
    source: null,
    callback_misses: 0,
    lead: { name: "Saife Sarwar" },
  };
  const RETRY_AT = new Date("2026-10-02T12:30:00.000Z");

  beforeEach(() => {
    db.query.mockResolvedValue([ROW]);
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes" });
    iris.loadClientBranding.mockReturnValue({ brandName: "3% Realty", city: "St. John's" });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getCustomFieldDefs.mockResolvedValue([]);
  });

  it("retries a missed callback and texts the lead once on the first miss", async () => {
    dialPending.reopenAfterMissedCallback.mockResolvedValue({ reopened: true, callAfter: RETRY_AT, misses: 1, phase: "quick-retry" });

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(dialPending.reopenAfterMissedCallback).toHaveBeenCalledWith(69, "3-percent-east-coast", 2, ROW.created_at, 0);
    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
    expect(ghl.sendSMS).toHaveBeenCalledTimes(1);
    const [contactId, text] = ghl.sendSMS.mock.calls[0];
    expect(contactId).toBe("contact-1");
    expect(text).toContain("Saife");
    expect(text).toContain("3% Realty");
    expect(text).toMatch(/missed you/i);
    expect(text).toMatch(/what time/i);
  });

  it("does not text again on the second miss, and moves the card to the matching follow-up stage", async () => {
    db.query.mockResolvedValue([{ ...ROW, attempts_made: 3, callback_misses: 1 }]);
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", followUpStageIds: ["s1", "s2", "s3"] });
    ghl.findOpenOpportunitiesForContact.mockResolvedValue([{ id: "opp-1" }]);
    dialPending.reopenAfterMissedCallback.mockResolvedValue({ reopened: true, callAfter: RETRY_AT, misses: 2, phase: "cadence" });

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(ghl.sendSMS).not.toHaveBeenCalled();
    expect(ghl.updateOpportunityStage).toHaveBeenCalledWith("opp-1", "s3", "loc-1", "key-1");
  });

  it("tags the lead when the cadence is exhausted", async () => {
    dialPending.reopenAfterMissedCallback.mockResolvedValue({ reopened: false });

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(ghl.addContactTags).toHaveBeenCalledWith("contact-1", ["iris no answer"], "loc-1", "key-1");
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("leaves an Ember handoff one-shot, as before", async () => {
    db.query.mockResolvedValue([{ ...ROW, source: "ember" }]);

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(dialPending.reopenAfterMissedCallback).not.toHaveBeenCalled();
    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("does nothing when the row isn't in the 'placed' state any more (a duplicate webhook)", async () => {
    db.query.mockResolvedValue([{ ...ROW, status: "pending" }]);

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(dialPending.reopenAfterMissedCallback).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("still uses the normal cadence for an ordinary (non-explicit) row", async () => {
    db.query.mockResolvedValue([{ ...ROW, is_explicit_callback: false }]);
    dialPending.reopenForNextAttempt.mockResolvedValue(true);

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1");

    expect(dialPending.reopenForNextAttempt).toHaveBeenCalledWith(69, "3-percent-east-coast", 2, ROW.created_at);
    expect(dialPending.reopenAfterMissedCallback).not.toHaveBeenCalled();
    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });

  it("still retries even if the text fails to send", async () => {
    dialPending.reopenAfterMissedCallback.mockResolvedValue({ reopened: true, callAfter: RETRY_AT, misses: 1, phase: "quick-retry" });
    ghl.sendSMS.mockRejectedValue(new Error("boom"));

    await expect(maybeReopenPendingCall("3-percent-east-coast", "contact-1")).resolves.toBeUndefined();
    expect(dialPending.reopenAfterMissedCallback).toHaveBeenCalled();
  });
});

/**
 * Mark, 2026-10-06: the notes field feeds GHL text notifications billed per
 * segment, so a successful live transfer must leave only Iris's own short
 * summary — not an extra "Live transfer completed" line on top of it.
 */
describe("end-of-call-report — status line on the contact's notes", () => {
  function getRootHandler(): (req: any, res: any) => Promise<void> {
    const router = createVapiRouter();
    return (router as any).stack[0].route.stack[0].handle;
  }
  const res = () => ({ status: vi.fn().mockReturnThis(), send: vi.fn(), json: vi.fn() });

  beforeEach(() => {
    db.query.mockResolvedValue([{ client_id: "3-percent-east-coast", contact_id: "contact-1", triggered_by: "manual" }]);
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({ contact: { customFields: [] } });
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", callbackNotesFieldKey: "contact.isa_notes" });
  });

  it("writes no status line after a successful live transfer", async () => {
    await getRootHandler()(
      { body: { message: { type: "end-of-call-report", endedReason: "assistant-forwarded-call", call: { id: "call-1" }, durationSeconds: 297 } }, headers: {} },
      res()
    );

    expect(ghl.updateContact).not.toHaveBeenCalled();
  });

  it("still writes the status line for any other outcome", async () => {
    await getRootHandler()(
      { body: { message: { type: "end-of-call-report", endedReason: "voicemail", call: { id: "call-2" }, durationSeconds: 12 } }, headers: {} },
      res()
    );

    expect(ghl.updateContact).toHaveBeenCalledTimes(1);
    expect(ghl.updateContact.mock.calls[0][1].customFields[0].value).toMatch(/^Iris call /);
  });
});

/**
 * Mark, 2026-10-07: a cold lead Iris was lined up to call by hand who doesn't
 * pick up (or reaches a voicemail machine) gets one text instead of a retry —
 * and never a voicemail.
 */
describe("maybeReopenPendingCall — unanswered sweep calls", () => {
  const ROW = {
    id: 77,
    attempts_made: 1,
    created_at: new Date("2026-07-14T12:00:00.000Z"),
    status: "placed",
    is_explicit_callback: true,
    source: "sweep",
    callback_misses: 0,
    lead: { name: "Stella Max Clements", intent: "buyer" },
  };

  beforeEach(() => {
    ghl.sendSMS.mockReset().mockResolvedValue({ messageId: "msg-1" });
    slack.sendMessage.mockReset().mockResolvedValue({});
    db.query.mockResolvedValue([ROW]);
    iris.loadIrisConfig.mockReturnValue({ timezone: "America/St_Johns", smsFromNumber: "+17097013598" });
    iris.loadClientBranding.mockReturnValue({ brandName: "3 Percent East Coast", city: "St. John's" });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
  });

  it("names the client's own from number, so a lead last texted from a retired number still gets the text", async () => {
    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", "voicemail");

    expect(ghl.sendSMS).toHaveBeenCalledWith("contact-1", expect.any(String), "loc-1", "key-1", "+17097013598");
  });

  it("says so in the call-log channel — and does not claim a text was sent — when GHL rejects it afterwards", async () => {
    ghl.getMessage.mockResolvedValue({ status: "failed", error: "Failed: Invalid from number. Number not available in account." });

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", "voicemail");

    const posts = slack.sendMessage.mock.calls.map((c: any[]) => c[1].text as string);
    expect(posts.some((t) => t.includes("could NOT be delivered") && t.includes("Invalid from number"))).toBe(true);
    expect(posts.some((t) => t.includes("📱 Texted"))).toBe(false);
  });

  it("also treats a send GHL rejects outright as a failure, not a success", async () => {
    ghl.sendSMS.mockRejectedValue(new Error("GHL API Error 422"));

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", "voicemail");

    const posts = slack.sendMessage.mock.calls.map((c: any[]) => c[1].text as string);
    expect(posts.some((t) => t.includes("could NOT be delivered"))).toBe(true);
    expect(posts.some((t) => t.includes("📱 Texted"))).toBe(false);
  });

  it.each(["voicemail", "customer-did-not-answer", "customer-busy"])("texts once and holds the row open for a reply when the call ended %s", async (reason) => {
    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", reason);

    expect(dialPending.holdForTextReply).toHaveBeenCalledWith(77);
    expect(ghl.sendSMS).toHaveBeenCalledTimes(1);
    expect(ghl.sendSMS.mock.calls[0][1]).toContain("Stella");
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ channel: "iris-call-logs", text: expect.stringContaining("Texted *Stella Max Clements*") }));
    expect(dialPending.reopenForNextAttempt).not.toHaveBeenCalled();
    expect(dialPending.reopenAfterMissedCallback).not.toHaveBeenCalled();
  });

  it("does not text when the call failed technically — nobody was actually missed", async () => {
    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", "call.start.error-get-transport");

    expect(ghl.sendSMS).not.toHaveBeenCalled();
    expect(dialPending.holdForTextReply).not.toHaveBeenCalled();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing once the row has moved on from 'placed'", async () => {
    db.query.mockResolvedValue([{ ...ROW, status: "pending" }]);

    await maybeReopenPendingCall("3-percent-east-coast", "contact-1", "voicemail");

    expect(ghl.sendSMS).not.toHaveBeenCalled();
  });
});

describe("buildSweepMissedCallText", () => {
  it("talks about a home search for a buyer and about selling for a seller", () => {
    expect(buildSweepMissedCallText("Stella Max Clements", "3 Percent East Coast", "buyer")).toBe(
      "Hi Stella, it's Iris from 3 Percent East Coast. I tried to call you about your home search but missed you. Are you still interested, or is there a better time to chat?"
    );
    expect(buildSweepMissedCallText("Roxane White", "3 Percent East Coast", "seller")).toContain("about selling your home");
  });

  it("is plain ASCII, so it stays on the cheaper single-segment encoding", () => {
    expect(buildSweepMissedCallText("Stella", "3 Percent East Coast", "buyer")).toMatch(/^[\x20-\x7E]+$/);
  });
});

/**
 * Mark, 2026-10-07: Iris posts each completed live transfer to the
 * live-transfers channel herself, in the shape Mark had been typing by hand.
 */
describe("formatLiveTransferPost", () => {
  it("matches the post Mark writes by hand, with the notes as bullets", () => {
    expect(
      formatLiveTransferPost({
        intent: "buyer",
        clientLabel: "3% Realty East Coast",
        agentName: "Candice Mayo",
        leadName: "Mylene Misa Badiola",
        notes: "4 beds | Looking near the hospital | First Home | Not pre-approved yet",
      })
    ).toBe(
      "Buyer Live Transfer for 3% Realty East Coast with Candice Mayo\nName: Mylene Misa Badiola\n\nISA NOTES: - 4 beds\n- Looking near the hospital\n- First Home\n- Not pre-approved yet"
    );
  });

  it("calls a seller, downsize or upgrading lead a Seller", () => {
    for (const intent of ["seller", "downsize", "upgrading"]) {
      expect(formatLiveTransferPost({ intent, clientLabel: "X", agentName: "A", leadName: "L", notes: null })).toMatch(/^Seller Live Transfer/);
    }
  });

  it("splits the older multi-line notes too, and leaves Iris's own call-status lines out", () => {
    const out = formatLiveTransferPost({
      intent: "buyer",
      clientLabel: "X",
      agentName: "A",
      leadName: "L",
      notes: "Intent: Buyer\nBudget: $350K\n\nIris call Monday, September 28 at 6:04 PM - Live transfer completed. Duration: 4m 57s.",
    });
    expect(out).toContain("- Intent: Buyer\n- Budget: $350K");
    expect(out).not.toContain("Iris call");
  });

  it("omits the notes section when there are none, and says so honestly when the agent isn't known", () => {
    const out = formatLiveTransferPost({ intent: "buyer", clientLabel: "X", agentName: null, leadName: "L", notes: "" });
    expect(out).not.toContain("ISA NOTES");
    expect(out).toContain("not confirmed on the call");
  });
});

describe("postLiveTransferToSlack", () => {
  beforeEach(() => {
    slack.sendMessage.mockReset().mockResolvedValue({});
    iris.loadIrisConfig.mockReturnValue({
      callbackNotesFieldKey: "contact.isa_notes",
      liveTransferSlack: { channel: "C0BR8F84LUD", clientLabel: "3% Realty East Coast" },
    });
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getCustomFieldDefs.mockResolvedValue([{ fieldKey: "contact.isa_notes", id: "field-notes-1" }]);
    ghl.getContact.mockResolvedValue({
      contact: { firstName: "Rene", lastName: "Manzano", assignedTo: "user-brittany", tags: ["seller lead"], customFields: [{ id: "field-notes-1", value: "Her son's property | Looking to sell early next year | Townhouse" }] },
    });
    ghl.listLocationUsers.mockResolvedValue([{ id: "user-brittany", name: "Brittany Penney", firstName: "Brittany", lastName: "Penney" }]);
    db.query.mockResolvedValue([{ lead: { intent: "seller" } }]);
  });

  it("posts the transfer to the live-transfers channel as Iris", async () => {
    await postLiveTransferToSlack("3-percent-east-coast", "contact-1");

    expect(slack.sendMessage).toHaveBeenCalledTimes(1);
    const [agent, payload] = slack.sendMessage.mock.calls[0];
    expect(agent).toBe("iris");
    expect(payload.channel).toBe("C0BR8F84LUD");
    expect(payload.text).toContain("Seller Live Transfer for 3% Realty East Coast with Brittany Penney");
    expect(payload.text).toContain("Name: Rene Manzano");
    expect(payload.text).toContain("- Townhouse");
  });

  it("falls back to the seller-lead tag for the intent when the lead has no queue row", async () => {
    db.query.mockResolvedValue([]);

    await postLiveTransferToSlack("3-percent-east-coast", "contact-1");

    expect(slack.sendMessage.mock.calls[0][1].text).toMatch(/^Seller Live Transfer/);
  });

  it("posts nothing for a client with no live-transfers channel configured", async () => {
    iris.loadIrisConfig.mockReturnValue({ callbackNotesFieldKey: "contact.isa_notes" });

    await postLiveTransferToSlack("3-percent-east-coast", "contact-1");

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("never throws into the transfer handling when Slack or GHL fails", async () => {
    slack.sendMessage.mockRejectedValue(new Error("not_in_channel"));

    await expect(postLiveTransferToSlack("3-percent-east-coast", "contact-1")).resolves.toBeUndefined();
  });
});
