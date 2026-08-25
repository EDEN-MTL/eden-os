import { describe, expect, it } from "vitest";
import { deriveIntent, intentFromStage, normaliseLead, parseYesNo, readField, scoreLead, ScoutConfig } from "./intake";

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
    expect(score("ASAP").score).toBe(25);
    expect(score("1-4 Months").score).toBe(15);
    expect(score("1 - 4 months").score).toBe(15);   // same answer, different spacing
    expect(score("4+ months").score).toBe(5);
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
