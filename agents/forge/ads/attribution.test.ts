import { describe, expect, it } from "vitest";
import { buildFieldIdLookup, deriveWon, extractAttribution } from "./attribution";

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
