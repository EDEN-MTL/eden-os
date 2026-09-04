import { describe, expect, it } from "vitest";
import { deriveIntent, intentFromStage, isFirstTouch, normaliseLead, normalizePhone, parseTimelineMonths, parseYesNo, readField, scoreLead, ScoutConfig } from "./intake";

const config: ScoutConfig = {
  pipelineId: "g8DgskR6GqDvRR3A6jnN",
  intakeStages: { "Buyer Leads": "f83b5ac8-e445-4a3e-b1e0-ac99a4747b56" },
  qualifiedTags: ["appt booked", "live transferred"],
  calendars: { buyer: "4Eyz51DOI7TY78gRgBU3", seller: "vbsoYjk2Q6nI66q8u8to" },
  fields: {
    propertyInterest: "contact.lf_proprety",
    budget: "contact.lf_budget",
    timeline: "contact.lf_timeframe",
    preApproved: "contact.are_you_pre_approuved",
    leadSource: "contact.source",
  },
};

describe("readField", () => {
  /**
   * GHL sends custom fields in different shapes depending on which event
   * fired. Handling only one shape reads as null, which is indistinguishable
   * from "the client left it blank".
   */
  it("reads the object shape, keyed with or without the contact. prefix", () => {
    expect(readField({ "contact.lf_budget": "500k" }, "contact.lf_budget")).toBe("500k");
    expect(readField({ lf_budget: "500k" }, "contact.lf_budget")).toBe("500k");
  });

  it("reads the array shape GHL uses on other events", () => {
    expect(readField([{ key: "contact.lf_budget", value: "500k" }], "contact.lf_budget")).toBe("500k");
    expect(readField([{ id: "lf_budget", field_value: "500k" }], "contact.lf_budget")).toBe("500k");
  });

  it("treats empty string as absent, not as an answer", () => {
    expect(readField({ "contact.lf_budget": "" }, "contact.lf_budget")).toBeNull();
  });
});

describe("parseYesNo", () => {
  it("reads the affirmative spellings this client's forms produce", () => {
    for (const v of ["Yes", "yes", "TRUE", "1", "oui"]) expect(parseYesNo(v)).toBe(true);
  });

  /**
   * The distinction that matters: an unrecognised answer must NOT collapse to
   * false. "We never asked" and "they said no" call for different follow-up,
   * and pre-approval is the one signal the ISA actually pre-screens on.
   */
  it("returns null for unrecognised input rather than defaulting to no", () => {
    expect(parseYesNo("working on it")).toBeNull();
    expect(parseYesNo(null)).toBeNull();
    expect(parseYesNo("no")).toBe(false);
  });
});

describe("normalizePhone", () => {
  /**
   * Confirmed live, 2026-09-04: a real GHL form submission stored the
   * phone as "(819) 993-6171", not E.164 — Vapi's create-call API rejects
   * anything else outright, silently failing every automatic dial to that
   * lead until this normalized it first.
   */
  it("converts a real GHL-formatted number to E.164, assuming +1", () => {
    expect(normalizePhone("(819) 993-6171")).toBe("+18199936171");
  });

  it("passes an already-E.164 number through unchanged", () => {
    expect(normalizePhone("+18199936171")).toBe("+18199936171");
  });

  it("handles a bare 11-digit number starting with 1", () => {
    expect(normalizePhone("18199936171")).toBe("+18199936171");
  });

  it("handles common separators: dashes, dots, spaces", () => {
    expect(normalizePhone("819-993-6171")).toBe("+18199936171");
    expect(normalizePhone("819.993.6171")).toBe("+18199936171");
  });

  it("fails closed (null) rather than dialing an unrecognizable shape", () => {
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("deriveIntent", () => {
  it("maps the four lead types this pipeline splits on", () => {
    expect(deriveIntent("Looking to buy")).toBe("buyer");
    expect(deriveIntent("Want to sell my home")).toBe("seller");
    expect(deriveIntent("Downsizing")).toBe("downsize");
    expect(deriveIntent("Upgrading to a bigger place")).toBe("upgrading");
    expect(deriveIntent(null)).toBe("unknown");
  });

  it("checks downsize/upgrade before buy/sell, since those descriptions contain both", () => {
    // "Downsizing — want to sell and buy smaller" must not read as seller.
    expect(deriveIntent("Downsizing - sell current, buy smaller")).toBe("downsize");
  });
});

describe("normaliseLead", () => {
  const payload = {
    id: "abc123",
    firstName: "Dana",
    lastName: "Walsh",
    phone: "+17095551234",
    email: "dana@example.com",
    source: "Facebook",
    tags: ["Appt Booked"],
    customFields: {
      "contact.lf_proprety": "Looking to buy",
      "contact.lf_budget": "$450,000",
      "contact.lf_timeframe": "ASAP",
      "contact.are_you_pre_approuved": "Yes",
      "contact.meta_ad_id": "120xyz",
      "contact.utm_source": "facebook",
    },
  };

  it("normalises a fully-populated lead", () => {
    const lead = normaliseLead(payload, config);
    expect(lead.name).toBe("Dana Walsh");
    expect(lead.intent).toBe("buyer");
    expect(lead.preApproved).toBe(true);
    expect(lead.attributed).toBe(true);
    expect(lead.attribution.metaAdId).toBe("120xyz");
  });

  it("matches qualifying tags case-insensitively — GHL preserves whatever case was typed", () => {
    expect(normaliseLead(payload, config).qualified).toBe(true);
  });

  /**
   * Guards the exact bug found in Mark's config: the GHL field is spelled
   * "are_you_pre_approuved". Reading the correctly-spelled key returns null,
   * which silently scores every lead as if they were not pre-approved.
   */
  it("reads pre-approval from GHL's actual misspelled key", () => {
    expect(normaliseLead(payload, config).preApproved).toBe(true);

    const wrongKey = { ...config, fields: { ...config.fields, preApproved: "contact.are_you_pre_approved" } };
    const misread = normaliseLead(payload, wrongKey);
    expect(misread.preApproved).toBeNull();
    expect(misread.score).toBeLessThan(normaliseLead(payload, config).score);
  });

  it("prefers utm_source over the built-in source field, which never names the ad", () => {
    expect(normaliseLead(payload, config).leadSource).toBe("facebook");
    const noUtm = { ...payload, customFields: { ...payload.customFields, "contact.utm_source": "" } };
    expect(normaliseLead(noUtm, config).leadSource).toBe("Facebook");
  });

  it("marks a lead unattributed when no ad identifiers came through", () => {
    const organic = { ...payload, customFields: { "contact.lf_proprety": "Looking to buy" } };
    const lead = normaliseLead(organic, config);
    expect(lead.attributed).toBe(false);
    expect(lead.preApproved).toBeNull();
  });

  it("keeps score within 0-100 and always explains itself", () => {
    const lead = normaliseLead(payload, config);
    expect(lead.score).toBeGreaterThan(0);
    expect(lead.score).toBeLessThanOrEqual(100);
    expect(lead.scoreReasons.length).toBeGreaterThan(0);
  });

  /**
   * GHL's own workflow "Webhook" action only offers key/value custom data,
   * not a raw JSON body, so there's no way to send tags as a real array
   * through it — {{contact.tags}} arrives as a comma-separated string.
   * Confirmed against GHL's own webhook-action docs, 2026-09-04, while
   * wiring up a real workflow for a second client. Before this fix,
   * isFirstTouch's Array.isArray guard would have silently read every
   * webhook-captured lead as "already touched", permanently blocking
   * Iris's outreach.
   */
  it("handles tags arriving as a comma-separated string, not just an array", () => {
    const withTouchedTags = { ...config, touchedTags: ["appt booked", "live transferred"] };
    const stringTagsPayload = { ...payload, tags: "buyer lead, new construction" };
    const lead = normaliseLead(stringTagsPayload, withTouchedTags);
    expect(lead.firstTouch).toBe(true);
  });

  it("still resolves qualified/firstTouch correctly when tags is missing entirely", () => {
    const noTagsPayload = { ...payload, tags: undefined };
    const lead = normaliseLead(noTagsPayload, config);
    expect(lead.qualified).toBe(false);
    expect(lead.firstTouch).toBe(false); // isFirstTouch fails closed with no tags at all
  });

  /**
   * Opportunity/pipeline data (pipelineStageId) is only present on an
   * opportunity-related trigger — GHL's own docs confirm a plain contact or
   * form-submission trigger never includes it. Without a tag-based
   * fallback, every lead captured via a form-submission workflow would
   * resolve intent "unknown" regardless of the "buyer lead"/"seller lead"
   * tag the form itself applied.
   */
  it("falls back to intent from tags when no pipeline stage data is present at all", () => {
    const formTriggeredPayload = { ...payload, pipelineStageId: undefined, tags: ["buyer lead"] };
    expect(normaliseLead(formTriggeredPayload, config).intent).toBe("buyer");

    const sellerTagPayload = { ...payload, pipelineStageId: undefined, tags: "seller lead" };
    expect(normaliseLead(sellerTagPayload, config).intent).toBe("seller");
  });
});

describe("timeline scoring against real stored values", () => {
  /**
   * These are the exact strings this location stores, counted over 80 live
   * contacts. An earlier version of this scorer used textbook ranges
   * (0-3 / 3-6 / 6-12) and gave "1-4 Months" — the single most common real
   * value, 9 of 21 populated — a score of zero.
   */
  const score = (timeline: string) =>
    scoreLead({
      contactId: "x", name: null, email: null, phone: null, propertyInterest: null,
      budget: null, timeline, preApproved: null, leadSource: null,
      attribution: { fbclid:null, utmSource:null, utmCampaign:null, metaCampaignId:null, metaAdsetId:null, metaAdId:null },
      attributed: false, qualified: false, intent: "unknown",
    });

  it("scores every real value seen in the account", () => {
    // Bands follow the parsed month count: 0 -> 25, 1-3 -> 18, 4-6 -> 10, 7+ -> 5.
    expect(score("ASAP").score).toBe(25);
    expect(score("1-4 Months").score).toBe(18);
    expect(score("1 - 4 months").score).toBe(18);   // same answer, different spacing
    expect(score("4+ months").score).toBe(10);
  });

  it("gives no timeline credit when the field is blank", () => {
    expect(score("").score).toBe(0);
  });
});

describe("intentFromStage", () => {
  /**
   * The lf_proprety field is empty on all 80 live contacts checked, so intent
   * has to come from the intake stage the lead lands in.
   */
  it("reads intent from the four intake stage names", () => {
    expect(intentFromStage("Buyer Leads")).toBe("buyer");
    expect(intentFromStage("Seller Leads")).toBe("seller");
    expect(intentFromStage("Downsize Leads")).toBe("downsize");
    expect(intentFromStage("Upgrading Leads")).toBe("upgrading");
    expect(intentFromStage(null)).toBe("unknown");
  });

  it("prefers the stage over the (empty) form field", () => {
    const cfg: ScoutConfig = {
      pipelineId: "p", intakeStages: {}, qualifiedTags: [],
      calendars: { buyer: "b", seller: "s" },
      fields: { propertyInterest: "contact.lf_proprety", budget: "contact.lf_budget",
                timeline: "contact.lf_timeframe", preApproved: "contact.are_you_pre_approuved",
                leadSource: "contact.source" },
    };
    const lead = normaliseLead({ id: "1", pipelineStageName: "Seller Leads", customFields: {} }, cfg);
    expect(lead.intent).toBe("seller");
  });
});

describe("parseTimelineMonths", () => {
  /**
   * Every value below is real. The survey dropdown and the ISA's free text
   * disagree on format, and two previous string-matching scorers each got a
   * different subset wrong — the second scored 32 of 113 real answers at zero.
   */
  it("reads the survey dropdown values", () => {
    expect(parseTimelineMonths("ASAP")).toBe(0);
    expect(parseTimelineMonths("1-3 Months")).toBe(1);
    expect(parseTimelineMonths("3-6 Months")).toBe(3);
    expect(parseTimelineMonths("4 - 6 months")).toBe(4);
    expect(parseTimelineMonths("6-12 Months")).toBe(6);
    expect(parseTimelineMonths("7 - 12 months")).toBe(7);
    expect(parseTimelineMonths("12 + months")).toBe(12);
  });

  it("reads the ISA's typed values", () => {
    expect(parseTimelineMonths("1-4 Months")).toBe(1);
    expect(parseTimelineMonths("4+ months")).toBe(4);
    expect(parseTimelineMonths("1 - 4 months")).toBe(1);
    expect(parseTimelineMonths("sooner the better")).toBe(0);
    expect(parseTimelineMonths("soon as possible")).toBe(0);
  });

  it("takes the lower bound of a range — 3-6 months means they could move in three", () => {
    expect(parseTimelineMonths("3-6 Months")).toBe(3);
  });

  it("returns null rather than guessing at prose it cannot read", () => {
    expect(parseTimelineMonths("before the winter")).toBeNull();
    expect(parseTimelineMonths("looking at different options not sure yet")).toBeNull();
    expect(parseTimelineMonths(null)).toBeNull();
  });

  it("scores every real survey value non-zero — the bug that prompted this", () => {
    const base = {
      contactId:"x", name:null, email:null, phone:null, propertyInterest:null, budget:null,
      preApproved:null, financing:null, leadSource:null,
      sources:{financing:null,timeline:null,budget:null},
      attribution:{fbclid:null,utmSource:null,utmCampaign:null,metaCampaignId:null,metaAdsetId:null,metaAdId:null},
      attributed:false, qualified:false, intent:"unknown" as const,
    };
    for (const t of ["ASAP","1-3 Months","3-6 Months","4 - 6 months","6-12 Months","7 - 12 months","12 + months"])
      expect(scoreLead({ ...base, timeline: t }).score).toBeGreaterThan(0);
  });
});

describe("field priority", () => {
  /**
   * Budget lives under several keys from successive form revisions. The
   * survey field must win: it is populated on 90 of 150 contacts and is
   * present at lead arrival, while lf_budget is on 12 and only after a call.
   */
  it("prefers the survey field over the LF field", () => {
    const cfg: any = {
      pipelineId:"p", intakeStages:{}, qualifiedTags:[], calendars:{buyer:"b",seller:"s"},
      fields:{ timeline:["contact.when_are_you_looking_to_move","contact.lf_timeframe"],
               budget:["contact.what_is_your_budget","contact.lf_budget"],
               propertyInterest:"contact.lf_proprety", preApproved:"contact.are_you_pre_approuved",
               leadSource:"contact.source" },
    };
    const lead = normaliseLead({ id:"1", customFields:{
      "contact.when_are_you_looking_to_move":"ASAP", "contact.lf_timeframe":"4+ months",
      "contact.what_is_your_budget":">$400K",        "contact.lf_budget":"nope" } }, cfg);
    expect(lead.timeline).toBe("ASAP");
    expect(lead.budget).toBe(">$400K");
  });

  it("falls back down the list when the preferred key is empty", () => {
    const cfg: any = {
      pipelineId:"p", intakeStages:{}, qualifiedTags:[], calendars:{buyer:"b",seller:"s"},
      fields:{ timeline:["contact.when_are_you_looking_to_move","contact.lf_timeframe"],
               budget:"contact.what_is_your_budget", propertyInterest:"contact.lf_proprety",
               preApproved:"contact.are_you_pre_approuved", leadSource:"contact.source" },
    };
    const lead = normaliseLead({ id:"1", customFields:{
      "contact.when_are_you_looking_to_move":"", "contact.lf_timeframe":"1-4 Months" } }, cfg);
    expect(lead.timeline).toBe("1-4 Months");
  });
});

describe("isFirstTouch", () => {
  const touchedTags = ["appt booked", "appointment", "live transferred", "live transfered"];

  it("is true only for a lead nothing has engaged yet", () => {
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags })).toBe(true);
    expect(isFirstTouch({ tags: ["buyer lead", "new construction"], touchedTags })).toBe(true);
  });

  /**
   * 'replied' is deliberately NOT blocking. It is applied when a lead answers
   * the text automation, which is engagement, not a conversation. 10 of 150
   * live contacts had replied and never been called — blocking those would
   * have skipped the most engaged leads on the board.
   */
  it("still opens a sequence for a lead that only answered a text", () => {
    expect(isFirstTouch({ tags: ["buyer lead", "replied"], touchedTags })).toBe(true);
  });

  it("does not open one once a real conversation has happened", () => {
    expect(isFirstTouch({ tags: ["buyer lead", "replied", "appt booked"], touchedTags })).toBe(false);
    expect(isFirstTouch({ tags: ["buyer lead", "replied"], touchedTags, isaNotes: "spoke to them" })).toBe(false);
  });

  it("catches the misspelled live-transfer tag", () => {
    // 'live transfered' (one r) is on 8 contacts against 5 for the correct
    // spelling; missing it would mean re-calling 8 transferred leads.
    expect(isFirstTouch({ tags: ["buyer lead", "live transfered"], touchedTags })).toBe(false);
    expect(isFirstTouch({ tags: ["buyer lead", "live transferred"], touchedTags })).toBe(false);
  });

  /**
   * The case a tags-only guard got wrong on 14 of 150 live contacts. The ISA
   * writes a note and does not always tag, so notes alone must count as
   * evidence that a human has already spoken to this person.
   */
  it("is false when ISA notes exist, even with no touch tag", () => {
    expect(isFirstTouch({
      tags: ["buyer lead"], touchedTags,
      isaNotes: "Area: st.johns\nPre-approved: yes\nWhen: ASAP",
    })).toBe(false);
  });

  it("ignores an empty notes field", () => {
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags, isaNotes: "   " })).toBe(true);
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags, isaNotes: null })).toBe(true);
  });

  it("is false once the lead has moved past the intake columns", () => {
    const intakeStages = { "Buyer Leads": "stage-buyer", "Seller Leads": "stage-seller" };
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags, stageId: "stage-buyer", intakeStages })).toBe(true);
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags, stageId: "stage-appointment-set", intakeStages })).toBe(false);
  });

  it("matches regardless of case or padding, since GHL keeps whatever was typed", () => {
    expect(isFirstTouch({ tags: ["Buyer Lead", "  Appt Booked "], touchedTags })).toBe(false);
  });

  /**
   * Fails closed on purpose. Wrongly skipping a lead costs one trigger cycle;
   * wrongly calling one means a real person is phoned twice by a bot.
   */
  it("treats missing or unconfigured input as already touched", () => {
    expect(isFirstTouch({ tags: undefined, touchedTags })).toBe(false);
    expect(isFirstTouch({ tags: ["buyer lead"], touchedTags: [] })).toBe(false);
    expect(isFirstTouch({ tags: ["buyer lead"] })).toBe(false);
  });
});
