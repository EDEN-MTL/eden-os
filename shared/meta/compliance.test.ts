import { describe, expect, it } from "vitest";
import {
  ComplianceError,
  isRestrictedCategory,
  safeTuneForCategoryPayload,
  validateCampaignPayload,
  validateTargetingPayload,
} from "./compliance";

describe("isRestrictedCategory", () => {
  it("is false for undefined/empty/NONE", () => {
    expect(isRestrictedCategory(undefined)).toBe(false);
    expect(isRestrictedCategory([])).toBe(false);
    expect(isRestrictedCategory(["NONE"])).toBe(false);
  });

  it("is true for each restricted category", () => {
    expect(isRestrictedCategory(["HOUSING"])).toBe(true);
    expect(isRestrictedCategory(["EMPLOYMENT"])).toBe(true);
    expect(isRestrictedCategory(["FINANCIAL_PRODUCTS_SERVICES"])).toBe(true);
  });
});

describe("validateCampaignPayload", () => {
  it("requires special_ad_category_country when a restricted category is set", () => {
    expect(() => validateCampaignPayload({ special_ad_categories: ["HOUSING"] })).toThrow(ComplianceError);
    expect(() =>
      validateCampaignPayload({ special_ad_categories: ["HOUSING"], special_ad_category_country: [] })
    ).toThrow(ComplianceError);
  });

  it("passes when the country list is present", () => {
    expect(() =>
      validateCampaignPayload({ special_ad_categories: ["HOUSING"], special_ad_category_country: ["US"] })
    ).not.toThrow();
  });

  it("does not require a country for a non-restricted category", () => {
    expect(() => validateCampaignPayload({ special_ad_categories: ["NONE"] })).not.toThrow();
  });
});

describe("validateTargetingPayload — non-restricted category", () => {
  it("allows anything through when the category isn't restricted", () => {
    expect(() =>
      validateTargetingPayload({ age_min: 25, age_max: 40, genders: [1] }, ["NONE"])
    ).not.toThrow();
    expect(() => validateTargetingPayload({ age_min: 25 }, undefined)).not.toThrow();
  });
});

describe("validateTargetingPayload — restricted category", () => {
  const restricted = ["HOUSING"];

  it("rejects age targeting", () => {
    expect(() => validateTargetingPayload({ age_min: 25 }, restricted)).toThrow(ComplianceError);
    expect(() => validateTargetingPayload({ age_max: 55 }, restricted)).toThrow(ComplianceError);
  });

  it("rejects gender targeting", () => {
    expect(() => validateTargetingPayload({ genders: [1] }, restricted)).toThrow(ComplianceError);
  });

  it("rejects location exclusions", () => {
    expect(() => validateTargetingPayload({ excluded_geo_locations: { countries: ["CA"] } }, restricted)).toThrow(
      ComplianceError
    );
  });

  it.each(["zips", "subcity", "neighborhood", "metro_area", "small_geo_area", "subneighborhood", "electoral_district"] as const)(
    "rejects fine-grained geo targeting by '%s'",
    (locType) => {
      expect(() =>
        validateTargetingPayload({ geo_locations: { [locType]: [{ key: "x" }] } }, restricted)
      ).toThrow(ComplianceError);
    }
  );

  it("allows city/region/country geo targeting (not in the prohibited list)", () => {
    expect(() =>
      validateTargetingPayload({ geo_locations: { cities: [{ key: "x" }] } as any }, restricted)
    ).not.toThrow();
  });

  it("rejects a custom_location radius below the US/Canada mile floor", () => {
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 10, distance_unit: "mile", country: "US" }] } },
        restricted
      )
    ).toThrow(ComplianceError);
  });

  it("allows a custom_location radius at/above the US/Canada mile floor", () => {
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 15, distance_unit: "mile", country: "US" }] } },
        restricted
      )
    ).not.toThrow();
  });

  it("applies the km floor (not the mile floor) for kilometer-unit radii", () => {
    // 20km is below the 25km US/Canada km floor even though it'd pass the 15-mile floor if compared numerically
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 20, distance_unit: "kilometer", country: "US" }] } },
        restricted
      )
    ).toThrow(ComplianceError);
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 25, distance_unit: "kilometer", country: "US" }] } },
        restricted
      )
    ).not.toThrow();
  });

  it("applies the stricter 15km European floor for EU/EEA/UK countries", () => {
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 15, distance_unit: "kilometer", country: "FR" }] } },
        restricted
      )
    ).not.toThrow();
    expect(() =>
      validateTargetingPayload(
        { geo_locations: { custom_locations: [{ radius: 10, distance_unit: "kilometer", country: "GB" }] } },
        restricted
      )
    ).toThrow(ComplianceError);
  });

  it("rejects behaviors/demographics in flexible_spec", () => {
    expect(() =>
      validateTargetingPayload({ flexible_spec: [{ behaviors: [{ id: "1" }] }] }, restricted)
    ).toThrow(ComplianceError);
    expect(() =>
      validateTargetingPayload({ flexible_spec: [{ demographics: [{ id: "1" }] }] }, restricted)
    ).toThrow(ComplianceError);
  });

  it("rejects flexible_spec.exclusions and top-level exclusions", () => {
    expect(() =>
      validateTargetingPayload({ flexible_spec: [{ exclusions: { id: "1" } }] }, restricted)
    ).toThrow(ComplianceError);
    expect(() => validateTargetingPayload({ exclusions: { id: "1" } }, restricted)).toThrow(ComplianceError);
  });

  it("rejects lookalike custom audiences regardless of subtype casing", () => {
    expect(() =>
      validateTargetingPayload({ custom_audiences: [{ id: "1", subtype: "LOOKALIKE" }] }, restricted)
    ).toThrow(ComplianceError);
    expect(() =>
      validateTargetingPayload({ custom_audiences: [{ id: "1", subtype: "lookalike" }] }, restricted)
    ).toThrow(ComplianceError);
    expect(() =>
      validateTargetingPayload({ excluded_custom_audiences: [{ id: "1", subtype: "Lookalike" }] }, restricted)
    ).toThrow(ComplianceError);
  });

  it("allows a non-lookalike custom audience", () => {
    expect(() =>
      validateTargetingPayload({ custom_audiences: [{ id: "1", subtype: "CUSTOM" }] }, restricted)
    ).not.toThrow();
  });

  it("allows a fully compliant targeting payload", () => {
    expect(() =>
      validateTargetingPayload(
        {
          geo_locations: { custom_locations: [{ radius: 20, distance_unit: "mile", country: "US" }] },
          flexible_spec: [{}],
          custom_audiences: [{ id: "1", subtype: "CUSTOM" }],
        },
        restricted
      )
    ).not.toThrow();
  });
});

describe("safeTuneForCategoryPayload", () => {
  it("returns the tune_for_category payload for a restricted category", () => {
    expect(safeTuneForCategoryPayload("HOUSING")).toEqual({ tune_for_category: "HOUSING" });
  });

  it("rejects a non-restricted category", () => {
    expect(() => safeTuneForCategoryPayload("NONE")).toThrow(ComplianceError);
  });
});
