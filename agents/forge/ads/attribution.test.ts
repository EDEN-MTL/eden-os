import { describe, expect, it } from "vitest";
import { buildFieldIdLookup, deriveWon, derivePipelineActive, extractAttribution } from "./attribution";

describe("buildFieldIdLookup", () => {
  const fieldMap = {
    _comment: "should be skipped",
    fbclid: "contact.fbclid",
    utm_campaign: "contact.utm_campaign",
    meta_campaign_id: "contact.meta_campaign_id",
  };

  it("maps internal names to field ids via fieldKey", () => {
    const defs = [
      { id: "f1", fieldKey: "contact.fbclid" },
      { id: "f2", fieldKey: "contact.utm_campaign" },
    ];
    const lookup = buildFieldIdLookup(defs, fieldMap);
    expect(lookup).toEqual({ fbclid: "f1", utm_campaign: "f2" });
  });

  it("skips keys starting with underscore (e.g. _comment)", () => {
    const lookup = buildFieldIdLookup([], fieldMap);
    expect(lookup).not.toHaveProperty("_comment");
  });

  it("omits a mapping when the field key isn't found on the location", () => {
    const lookup = buildFieldIdLookup([{ id: "f1", fieldKey: "contact.fbclid" }], fieldMap);
    expect(lookup).toEqual({ fbclid: "f1" });
    expect(lookup.utm_campaign).toBeUndefined();
  });
});

describe("extractAttribution", () => {
  it("reads values by custom field id, not name", () => {
    const contact = {
      customFields: [
        { id: "f1", value: "abc123" },
        { id: "f2", value: "999" },
      ],
    };
    const result = extractAttribution(contact, { fbclid: "f1", meta_campaign_id: "f2" });
    expect(result).toEqual({ fbclid: "abc123", meta_campaign_id: "999" });
  });

  it("returns null for a mapped field with no value on the contact", () => {
    const result = extractAttribution({ customFields: [] }, { fbclid: "f1" });
    expect(result.fbclid).toBeNull();
  });

  it("handles a contact with no customFields at all", () => {
    const result = extractAttribution({}, { fbclid: "f1" });
    expect(result.fbclid).toBeNull();
  });
});

describe("deriveWon", () => {
  it("maps 'won' -> true, 'lost' -> false, anything else -> null", () => {
    expect(deriveWon("won")).toBe(true);
    expect(deriveWon("WON")).toBe(true);
    expect(deriveWon("lost")).toBe(false);
    expect(deriveWon("open")).toBeNull();
    expect(deriveWon(undefined)).toBeNull();
  });
});

describe("deriveWon — stage fallback for teams not using won/lost status", () => {
  const map = { wonStages: ["Deal Closed"], lostStages: ["Not Qualified/Not Interested", "No-Show"] };

  it("prefers explicit status over stage when status is decisive", () => {
    // Status is the more reliable signal, so it must win even if the stage disagrees.
    expect(deriveWon("won", "Not Qualified/Not Interested", map)).toBe(true);
    expect(deriveWon("lost", "Deal Closed", map)).toBe(false);
  });

  it("treats abandoned as lost", () => {
    expect(deriveWon("abandoned", undefined, map)).toBe(false);
  });

  it("falls back to stage when status is open — the real 3 Percent case", () => {
    // All 149 of their opportunities are status "open"; the outcome lives in the stage.
    expect(deriveWon("open", "Deal Closed", map)).toBe(true);
    expect(deriveWon("open", "Not Qualified/Not Interested", map)).toBe(false);
    expect(deriveWon("open", "No-Show", map)).toBe(false);
  });

  it("matches stage names case- and whitespace-insensitively", () => {
    expect(deriveWon("open", "  deal closed  ", map)).toBe(true);
  });

  it("returns null for a mid-pipeline stage", () => {
    expect(deriveWon("open", "Appointment Set", map)).toBe(null);
  });

  it("returns null when no stage map is configured, rather than guessing", () => {
    expect(deriveWon("open", "Deal Closed")).toBe(null);
  });
});

describe("derivePipelineActive", () => {
  // Mirrors 3 Percent East Coast: a signed buyer and a live listing are real
  // commitments, but the money is not in the door.
  const map = {
    wonStages: ["Deal Closed"],
    lostStages: ["No-Show"],
    activeStages: ["Buyer Confirmed", "Listing Active"],
  };

  it("flags committed-but-unbanked stages", () => {
    expect(derivePipelineActive("open", "Buyer Confirmed", map)).toBe(true);
    expect(derivePipelineActive("open", "Listing Active", map)).toBe(true);
  });

  it("does not flag early stages that carry no commitment", () => {
    expect(derivePipelineActive("open", "New Lead", map)).toBe(false);
  });

  /**
   * The point of the whole split: Jacob was explicit that these stages are
   * NOT won. If they ever also read as won, they would inflate revenue from
   * $11,247 to ~$30,295 on deals that have not closed, and ROAS with it.
   */
  it("keeps active stages strictly out of won", () => {
    for (const stage of map.activeStages) {
      expect(deriveWon("open", stage, map)).toBeNull();
    }
  });

  it("never double-counts a resolved deal as active", () => {
    expect(derivePipelineActive("open", "Deal Closed", map)).toBe(false);
    expect(derivePipelineActive("open", "No-Show", map)).toBe(false);
    expect(derivePipelineActive("won", "Buyer Confirmed", map)).toBe(false);
  });

  it("is inert when a client has no activeStages configured", () => {
    expect(derivePipelineActive("open", "Buyer Confirmed", { wonStages: ["Deal Closed"] })).toBe(false);
    expect(derivePipelineActive("open", "Buyer Confirmed", undefined)).toBe(false);
  });

  it("matches stage names case- and whitespace-insensitively, as GHL text drifts", () => {
    expect(derivePipelineActive("open", "  buyer confirmed ", map)).toBe(true);
  });
});
