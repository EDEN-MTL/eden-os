import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  logSend: vi.fn(async () => {}),
  updateLead: vi.fn(async () => {}),
  sendsToday: vi.fn(async () => 0),
}));
vi.mock("./store", () => store);

import {
  assertEmailChannelConfigured,
  buildEmailMessage,
  canSend,
  canSendEmail,
  classifyReply,
  contextLine,
  handleEmailReply,
  handleReply,
  problemLine,
  sendEmailBatch,
  sendEmailOne,
  sendOne,
  sendSmsBatch,
} from "./outreach";
import { QuarryLead } from "./types";

afterEach(() => vi.clearAllMocks());

const KEYWORDS = {
  positiveKeywords: ["yes", "yeah", "sure", "ok", "okay", "send", "send it", "link", "interested", "oui"],
  negativeKeywords: ["no", "stop", "unsubscribe", "not interested", "remove", "non"],
};

const CONFIG: any = {
  generation: { bookingUrl: "https://booking.test/eden" },
  outreach: {
    ...KEYWORDS,
    senderName: "Jacob",
    dailySendCap: 25,
    minSendSpacingSeconds: 180,
    jitterSeconds: 120,
    templates: {
      screenshot: "Hi, this is {{senderName}} — I put together a quick site redesign for {{businessName}}, wanted you to see it. Want the live link to click around?",
      link: "Here it is — {{previewUrl}}.",
      nudge: "Hey, just checking if you got a chance to look — no pressure!",
    },
    email: {
      fromDomain: "edensites.ca",
      fromAddress: "hello@edensites.ca",
      physicalAddress: "123 Rue Test, Montreal, QC",
      dailySendCap: 15,
      minSendSpacingSeconds: 60,
      jitterSeconds: 60,
      nudgeScheduleDays: [4, 10],
      // Booking-focused, no previewUrl — pitch-time sites do not exist yet.
      templates: {
        subject: "A redesign idea for {{businessName}}",
        pitch: "{{context}} {{problem}} — book: {{bookingUrl}} — unsub: {{unsubscribeUrl}} — {{physicalAddress}}",
        nudge: "Just checking — {{bookingUrl}} — unsub: {{unsubscribeUrl}} — {{physicalAddress}}",
        booking: "Here is the link: {{bookingUrl}} — unsub: {{unsubscribeUrl}} — {{physicalAddress}}",
      },
    },
  },
};

function lead(over: Partial<QuarryLead> = {}): QuarryLead {
  return {
    id: 1, clientId: "eden", placeId: "p1", name: "Chaussures Rivard",
    formattedAddress: null, phone: "+15145550100", phoneLineType: "mobile", isMobile: true,
    email: "info@rivard.ca", emailSource: "own_website_contact_page", hasPublicEmail: true, website: null,
    category: "trade-service", searchQuery: null, rating: null, userRatingsTotal: null,
    businessStatus: null, photoRefs: [], isCandidate: true, reasons: [], outdatedScore: null,
    outdatedReasoning: null, previewUrl: "https://preview.test/rivard",
    previewImageUrl: "https://api.test/api/quarry/images/9.png", generator: "lovable",
    generationError: null, ghlContactId: "c1", ghlOpportunityId: "o1", pipelineStage: "New Lead",
    approvalStatus: "approved", dnclChecked: false, holdoutReason: null, sentAt: null,
    repliedAt: null, emailSentAt: null, emailRepliedAt: null, emailOptedOut: false,
    emailUnsubscribeToken: "tok-123", lastLookupAt: null, createdAt: "", updatedAt: "", ...over,
  };
}

function deps() {
  return {
    sendMMS: vi.fn(async () => ({ messageId: "m1" })),
    sendSMS: vi.fn(async () => ({ messageId: "m2" })),
    moveStage: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
  };
}

function emailDeps() {
  return {
    sendEmail: vi.fn(async () => ({ messageId: "e1" })),
    moveStage: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
  };
}

describe("classifyReply", () => {
  it("reads a plain yes and a plain no", () => {
    expect(classifyReply("yes please", KEYWORDS)).toBe("positive");
    expect(classifyReply("No", KEYWORDS)).toBe("negative");
  });

  it("reads 'not interested' as a no, even though it contains 'interested'", () => {
    // Checking positives first would send a link to someone who just declined.
    expect(classifyReply("not interested", KEYWORDS)).toBe("negative");
  });

  it("reads 'no thanks, ok' as a no, even though it contains 'ok'", () => {
    expect(classifyReply("no thanks, ok", KEYWORDS)).toBe("negative");
  });

  it("always treats STOP as a no", () => {
    expect(classifyReply("STOP", KEYWORDS)).toBe("negative");
  });

  it("does not mistake 'non' for 'no' or 'unsure' for 'sure'", () => {
    // Whole-word matching. "non" is French for no and is in the negative list;
    // the point here is that substring matching would be wrong either way.
    expect(classifyReply("oui", KEYWORDS)).toBe("positive");
    expect(classifyReply("I'm unsure", KEYWORDS)).toBe("unclear");
  });

  it("returns unclear for anything it cannot read", () => {
    expect(classifyReply("who is this?", KEYWORDS)).toBe("unclear");
    expect(classifyReply("how much would that cost", KEYWORDS)).toBe("unclear");
  });
});

describe("canSend", () => {
  it("allows an approved, mobile, synced lead with a screenshot", () => {
    expect(canSend(lead(), "screenshot").allowed).toBe(true);
  });

  it("blocks a lead nobody approved", () => {
    expect(canSend(lead({ approvalStatus: "pending" }), "screenshot").allowed).toBe(false);
  });

  it("blocks a landline", () => {
    expect(canSend(lead({ isMobile: false, phoneLineType: "landline" }), "screenshot").reason)
      .toMatch(/not a confirmed mobile/);
  });

  it("blocks a second screenshot to the same lead", () => {
    expect(canSend(lead({ sentAt: "2026-08-26T10:00:00Z" }), "screenshot").reason)
      .toMatch(/already sent/);
  });

  it("blocks the link before the screenshot has gone out", () => {
    // The whole sequence depends on the picture landing first.
    expect(canSend(lead({ sentAt: null }), "link").reason).toMatch(/has not gone out/);
  });

  it("blocks a message with nothing to attach or link to", () => {
    expect(canSend(lead({ previewImageUrl: null }), "screenshot").allowed).toBe(false);
    expect(canSend(lead({ sentAt: "t", previewUrl: null }), "link").allowed).toBe(false);
  });
});

describe("sendOne", () => {
  it("sends the screenshot as an attachment and moves the stage", async () => {
    const d = deps();
    const result = await sendOne(lead(), "screenshot", CONFIG, d);

    expect(result.sent).toBe(true);
    expect(d.sendMMS).toHaveBeenCalledWith("c1", expect.stringContaining("Chaussures Rivard"), [
      "https://api.test/api/quarry/images/9.png",
    ]);
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Screenshot Sent");
  });

  it("fills the business name into the template", async () => {
    const d = deps();
    await sendOne(lead(), "screenshot", CONFIG, d);
    const sent = d.sendMMS.mock.calls[0][1];
    expect(sent).toContain("Jacob");
    expect(sent).not.toContain("{{");
  });

  it("logs a failed send instead of swallowing it", async () => {
    // A silent failure makes a carrier problem look like a bad offer.
    const d = deps();
    d.sendMMS.mockRejectedValue(new Error("GHL API Error 429: rate limited"));

    const result = await sendOne(lead(), "screenshot", CONFIG, d);

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/429/);
    expect(store.logSend).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/429/) }));
    expect(store.updateLead).not.toHaveBeenCalled();
  });
});

describe("sendBatch", () => {
  it("stops at the daily cap and holds the rest", async () => {
    store.sendsToday.mockResolvedValue(23);
    const d = deps();
    const leads = [lead({ id: 1 }), lead({ id: 2 }), lead({ id: 3 }), lead({ id: 4 })];

    const result = await sendSmsBatch(leads, "screenshot", CONFIG, d, { log: () => {} });

    expect(result.sent).toBe(2);
    expect(result.capReached).toBe(true);
    expect(d.sendMMS).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the cap is already spent", async () => {
    store.sendsToday.mockResolvedValue(25);
    const d = deps();
    const result = await sendSmsBatch([lead()], "screenshot", CONFIG, d, { log: () => {} });
    expect(result.sent).toBe(0);
    expect(d.sendMMS).not.toHaveBeenCalled();
  });

  it("spaces sends with a randomised gap", async () => {
    store.sendsToday.mockResolvedValue(0);
    const d = deps();
    // A message every 180s exactly is a machine, and that is what spam
    // filtering looks for. Jitter must actually vary the gap.
    const randoms = [0, 1];
    let i = 0;
    await sendSmsBatch([lead({ id: 1 }), lead({ id: 2 }), lead({ id: 3 })], "screenshot", CONFIG, d, {
      log: () => {},
      random: () => randoms[i++ % randoms.length],
    });

    expect(d.wait).toHaveBeenCalledTimes(2);
    expect(d.wait.mock.calls[0][0]).toBe(180_000);
    expect(d.wait.mock.calls[1][0]).toBe(180_000 + 120_000);
  });

  it("does not spend the daily allowance on skipped leads", async () => {
    store.sendsToday.mockResolvedValue(24);
    const d = deps();
    const leads = [lead({ id: 1, approvalStatus: "rejected" }), lead({ id: 2 })];

    const result = await sendSmsBatch(leads, "screenshot", CONFIG, d, { log: () => {} });

    expect(result.skipped).toHaveLength(1);
    expect(result.sent).toBe(1);
  });
});

describe("handleReply", () => {
  it("sends the link on a yes", async () => {
    const d = deps();
    const result = await handleReply(lead({ sentAt: "t" }), "yes send it", CONFIG, d);

    expect(result.sentiment).toBe("positive");
    expect(d.sendSMS).toHaveBeenCalledWith("c1", expect.stringContaining("https://preview.test/rivard"));
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Replied Interest");
  });

  it("sends absolutely nothing on a no", async () => {
    // The one thing that must never happen.
    const d = deps();
    const result = await handleReply(lead({ sentAt: "t" }), "no thanks", CONFIG, d);

    expect(result.sentiment).toBe("negative");
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.sendMMS).not.toHaveBeenCalled();
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Lost/Nurture");
  });

  it("sends nothing on an unclear reply and leaves it for a human", async () => {
    const d = deps();
    const result = await handleReply(lead({ sentAt: "t" }), "how much?", CONFIG, d);

    expect(result.sentiment).toBe("unclear");
    expect(d.sendSMS).not.toHaveBeenCalled();
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Replied Interest");
  });

  it("records the reply time whatever the answer was", async () => {
    const d = deps();
    await handleReply(lead({ sentAt: "t" }), "no", CONFIG, d);
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ repliedAt: expect.any(String) }));
  });
});

describe("assertEmailChannelConfigured", () => {
  it("passes when the channel is fully set up", () => {
    expect(() => assertEmailChannelConfigured(CONFIG.outreach.email, CONFIG.generation.bookingUrl)).not.toThrow();
  });

  it("names every missing field rather than failing on the first", () => {
    expect(() =>
      assertEmailChannelConfigured({ ...CONFIG.outreach.email, fromDomain: "", physicalAddress: "" }, "")
    ).toThrow(/fromDomain.*physicalAddress.*bookingUrl/);
  });

  it("refuses to send without a physical address, even if the domain is set", () => {
    // CASL requirement, not a formality — must block on its own.
    expect(() =>
      assertEmailChannelConfigured({ ...CONFIG.outreach.email, physicalAddress: "" }, CONFIG.generation.bookingUrl)
    ).toThrow(/physicalAddress/);
  });

  it("refuses to send without a booking link — it is the only call to action left", () => {
    // The pitch no longer offers a site link; a missing booking URL means
    // an email with nothing at all for the reader to click.
    expect(() => assertEmailChannelConfigured(CONFIG.outreach.email, "")).toThrow(/bookingUrl/);
  });
});

describe("canSendEmail", () => {
  it("allows an approved lead with a published email, regardless of mobile status", () => {
    // Email has no mobile requirement — that is the whole point of adding it.
    expect(canSendEmail(lead({ isMobile: false, phoneLineType: "landline" }), "email_pitch").allowed).toBe(true);
  });

  it("blocks a lead with no published email", () => {
    expect(canSendEmail(lead({ email: null }), "email_pitch").reason).toMatch(/no published email/);
  });

  it("blocks a lead that opted out", () => {
    expect(canSendEmail(lead({ emailOptedOut: true }), "email_pitch").reason).toMatch(/opted out/);
  });

  it("blocks a second pitch to the same lead", () => {
    expect(canSendEmail(lead({ emailSentAt: "2026-08-27T00:00:00Z" }), "email_pitch").reason)
      .toMatch(/already sent/);
  });

  it("blocks a nudge before any pitch went out", () => {
    expect(canSendEmail(lead({ emailSentAt: null }), "email_nudge").reason)
      .toMatch(/no pitch sent yet/);
  });
});

describe("problemLine", () => {
  it("leads with no website as the strongest signal", () => {
    expect(problemLine(lead({ website: null }))).toMatch(/don't currently have a website/);
  });

  it("names a phone/HTTPS problem in plain language, not the raw finding", () => {
    const line = problemLine(lead({ website: "https://x.com", reasons: ["No viewport meta tag — not mobile responsive"] }));
    expect(line).toMatch(/doesn't work properly on a phone/);
    expect(line).not.toMatch(/viewport/); // must not leak the technical term
  });

  it("names a stale-site problem for a copyright/markup finding", () => {
    const line = problemLine(lead({ website: "https://x.com", reasons: ["Copyright reads 2009"] }));
    expect(line).toMatch(/hasn't been touched in years/);
  });

  it("falls back to the vision pass's own reasoning when nothing else matched", () => {
    const line = problemLine(
      lead({ website: "https://x.com", reasons: ["Looks dated (8/10)"], outdatedReasoning: "Table layout, clip art." })
    );
    expect(line.toLowerCase()).toContain("table layout, clip art");
  });

  it("never leaves the sentence empty for a lead with no readable signal at all", () => {
    // Something must always render — an empty {{problem}} would ship a
    // pitch email with a hole in its opening line.
    expect(problemLine(lead({ website: "https://x.com", reasons: [], outdatedReasoning: null }))).toBeTruthy();
  });
});

describe("contextLine", () => {
  it("cites the rating and review count when both are present", () => {
    const line = contextLine(lead({ rating: 4.7, userRatingsTotal: 32 }));
    expect(line).toContain("4.7 stars");
    expect(line).toContain("32 reviews");
  });

  it("collapses to an empty string when there is no rating, rather than a broken sentence", () => {
    expect(contextLine(lead({ rating: null, userRatingsTotal: null }))).toBe("");
  });

  it("collapses to empty when rating exists but review count does not, avoiding a misleading number", () => {
    expect(contextLine(lead({ rating: 4.7, userRatingsTotal: null }))).toBe("");
  });
});

describe("buildEmailMessage", () => {
  it("fills every template variable, including the problem line and unsubscribe link", () => {
    const msg = buildEmailMessage(lead({ website: null }), "email_pitch", CONFIG);
    expect(msg.subject).toBe("A redesign idea for Chaussures Rivard");
    expect(msg.html).toMatch(/don't currently have a website/);
    expect(msg.html).toContain("https://booking.test/eden");
    expect(msg.html).toContain("/api/quarry/unsubscribe/tok-123");
    expect(msg.html).toContain("123 Rue Test, Montreal, QC");
    expect(msg.html).not.toContain("{{");
  });

  it("does not require a previewUrl — pitch-time sites do not exist yet", () => {
    // Jacob builds the site by hand after someone books, not before the pitch.
    const msg = buildEmailMessage(lead({ previewUrl: null }), "email_pitch", CONFIG);
    expect(msg.html).toContain("https://booking.test/eden");
    expect(msg.html).not.toContain("{{");
  });
});

describe("sendEmailOne", () => {
  it("sends and records emailSentAt", async () => {
    const d = emailDeps();
    const result = await sendEmailOne(lead(), "email_pitch", CONFIG, d);

    expect(result.sent).toBe(true);
    expect(d.sendEmail).toHaveBeenCalledWith(
      "c1",
      "A redesign idea for Chaussures Rivard",
      expect.stringContaining("booking.test/eden"),
      "hello@edensites.ca"
    );
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ emailSentAt: expect.any(String) }));
    // "Screenshot Sent" — the closest fit in a fixed pipeline that predates
    // the booking-first design; see the comment in outreach.ts.
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Screenshot Sent");
  });

  it("does not touch isMobile/SMS state when sending email", async () => {
    const d = emailDeps();
    await sendEmailOne(lead(), "email_pitch", CONFIG, d);
    const patch = store.updateLead.mock.calls[0][1];
    expect(patch).not.toHaveProperty("isMobile");
    expect(patch).not.toHaveProperty("sentAt"); // the SMS-path field, untouched
  });

  it("logs a failed email send rather than swallowing it", async () => {
    const d = emailDeps();
    d.sendEmail.mockRejectedValue(new Error("GHL API Error 400: domain not verified"));
    const result = await sendEmailOne(lead(), "email_pitch", CONFIG, d);
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/domain not verified/);
  });
});

describe("sendEmailBatch", () => {
  it("refuses to run when the email channel is not configured", async () => {
    store.sendsToday.mockResolvedValue(0);
    const badConfig = { ...CONFIG, outreach: { ...CONFIG.outreach, email: { ...CONFIG.outreach.email, fromDomain: "" } } };
    await expect(sendEmailBatch([lead()], "email_pitch", badConfig, emailDeps(), { log: () => {} }))
      .rejects.toThrow(/fromDomain/);
  });

  it("uses the EMAIL cap, not the SMS cap", async () => {
    // Email's cap (15) is deliberately lower than SMS's (25) for a fresh
    // sending domain. A shared cap would let email burn through SMS's
    // allowance or vice versa.
    store.sendsToday.mockResolvedValue(14);
    const d = emailDeps();
    const result = await sendEmailBatch(
      [lead({ id: 1 }), lead({ id: 2 })],
      "email_pitch",
      CONFIG,
      d,
      { log: () => {} }
    );
    expect(result.sent).toBe(1);
    expect(result.capReached).toBe(true);
  });
});

describe("handleEmailReply", () => {
  it("opts the lead out of email on a negative reply", async () => {
    const d = emailDeps();
    const result = await handleEmailReply(lead({ emailSentAt: "t" }), "unsubscribe", CONFIG, d);

    expect(result.sentiment).toBe("negative");
    expect(store.updateLead).toHaveBeenCalledWith(1, expect.objectContaining({ emailOptedOut: true }));
  });

  it("does not touch SMS eligibility when opting out of email", async () => {
    // Declining email is not a statement about text messages — the two are
    // separate consent channels.
    const d = emailDeps();
    await handleEmailReply(lead({ emailSentAt: "t" }), "stop", CONFIG, d);
    const patch = store.updateLead.mock.calls.find((c: any) => c[1].emailOptedOut)?.[1];
    expect(patch).not.toHaveProperty("isMobile");
  });

  it("moves a positive reply to Replied Interest without opting out", async () => {
    const d = emailDeps();
    const result = await handleEmailReply(lead({ emailSentAt: "t" }), "yes please", CONFIG, d);
    expect(result.sentiment).toBe("positive");
    expect(d.moveStage).toHaveBeenCalledWith("o1", "Replied Interest");
    expect(store.updateLead).not.toHaveBeenCalledWith(1, expect.objectContaining({ emailOptedOut: true }));
  });

  it("auto-sends the booking link on a positive reply — closes the gap that killed the old SMS numbers", async () => {
    // 342 people replied positively to the old cold-SMS blast and almost none
    // of them ever got a next step back. A "yes" here must not just sit in
    // the CRM waiting for a human to notice.
    const d = emailDeps();
    const result = await handleEmailReply(lead({ emailSentAt: "t" }), "sure, sounds good", CONFIG, d);

    expect(result.outcome?.sent).toBe(true);
    expect(d.sendEmail).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.stringContaining("https://booking.test/eden"),
      "hello@edensites.ca"
    );
  });

  it("does not auto-send anything on an unclear reply — a wrong guess is worse than a slow human", async () => {
    const d = emailDeps();
    const result = await handleEmailReply(lead({ emailSentAt: "t" }), "how much does this cost?", CONFIG, d);
    expect(result.sentiment).toBe("unclear");
    expect(result.outcome).toBeUndefined();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing on a negative reply — the one thing that must never happen", async () => {
    const d = emailDeps();
    await handleEmailReply(lead({ emailSentAt: "t" }), "no thanks", CONFIG, d);
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
});
