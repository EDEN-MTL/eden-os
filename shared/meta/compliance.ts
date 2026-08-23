/**
 * Meta Special Ad Category compliance guardrails.
 *
 * Ported 1:1 from the standalone Python ad-management prototype's
 * app/meta/compliance.py — verified against Meta's own Marketing API docs
 * (developers.facebook.com/docs/marketing-api/audiences/special-ad-category)
 * on 2026-08-10. Meta changes ad policy with little notice, so re-verify
 * against that page (and the Business Help Center housing policy page)
 * periodically rather than trusting this comment forever.
 *
 * Confirmed current rules for HOUSING (the category Eden runs under; the
 * same rules also apply to EMPLOYMENT and FINANCIAL_PRODUCTS_SERVICES):
 *   - The campaign must declare special_ad_categories + a companion
 *     special_ad_category_country (list of ISO-3166-1 alpha-2 codes).
 *   - No custom age targeting: age_min/age_max are locked to Meta's
 *     default 18-65+ — this module rejects setting them at all rather than
 *     trying to guess which narrower values Meta would reject.
 *   - No gender targeting — genders must be omitted entirely (defaults to
 *     all genders).
 *   - No location exclusions whatsoever (excluded_geo_locations).
 *   - No fine-grained geo targeting: zip code, subcity, neighborhood,
 *     metro_area, small_geo_area, subneighborhood, electoral_district are
 *     all blocked. Pinpoint/radius targeting has a floor of 15 miles
 *     (25 km) in the US/Canada, 15 km in Europe — nothing tighter.
 *   - No lookalike audiences.
 *   - No behavior/demographic targeting and no detailed-targeting
 *     exclusions in flexible_spec — only Meta's pre-approved interest list
 *     for the category is allowed.
 *   - Meta provides tune_for_category as a one-field mechanism on the ad
 *     set that auto-enforces all of the above; prefer it over hand-built
 *     targeting whenever creating a fresh ad set under a restricted
 *     category.
 *
 * This module is a HARD gate, not a rule: ComplianceError here blocks the
 * action unconditionally before it is even eligible to enter the approval
 * queue. A human approval can override a rules-engine recommendation; it
 * cannot override this — there is no bypass flag, by design.
 */

export const RESTRICTED_CATEGORIES = new Set(["HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES"]);

const PROHIBITED_LOCATION_TYPES = [
  "zips", "subcity", "neighborhood", "metro_area",
  "small_geo_area", "subneighborhood", "electoral_district",
] as const;

const MIN_RADIUS_MILES_US_CANADA = 15.0;
const MIN_RADIUS_KM_US_CANADA = 25.0;
const MIN_RADIUS_KM_EUROPE = 15.0;

// EU/EEA + UK — the stricter 15km radius floor applies here per Meta's docs.
const EUROPE_COUNTRY_CODES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO", "GB",
]);

export class ComplianceError extends Error {}

export function isRestrictedCategory(specialAdCategories?: string[] | null): boolean {
  if (!specialAdCategories || specialAdCategories.length === 0) return false;
  return specialAdCategories.some((c) => RESTRICTED_CATEGORIES.has(c));
}

/** Validate a campaign create/update payload before it's sent to Meta. */
export function validateCampaignPayload(payload: {
  special_ad_categories?: string[];
  special_ad_category_country?: string[];
}): void {
  const categories = payload.special_ad_categories;
  if (categories && isRestrictedCategory(categories)) {
    if (!payload.special_ad_category_country || payload.special_ad_category_country.length === 0) {
      throw new ComplianceError(
        "special_ad_category_country is required when " +
          `special_ad_categories includes a restricted category (${JSON.stringify(categories)}).`
      );
    }
  }
}

interface CustomLocation {
  radius?: number;
  distance_unit?: string;
  country?: string;
}

interface FlexibleSpecItem {
  behaviors?: unknown[];
  demographics?: unknown[];
  exclusions?: unknown;
}

interface CustomAudienceRef {
  id?: string;
  subtype?: string;
}

export interface Targeting {
  age_min?: number;
  age_max?: number;
  genders?: number[];
  excluded_geo_locations?: unknown;
  geo_locations?: {
    zips?: unknown[];
    subcity?: unknown[];
    neighborhood?: unknown[];
    metro_area?: unknown[];
    small_geo_area?: unknown[];
    subneighborhood?: unknown[];
    electoral_district?: unknown[];
    custom_locations?: CustomLocation[];
  };
  flexible_spec?: FlexibleSpecItem[];
  exclusions?: unknown;
  custom_audiences?: CustomAudienceRef[];
  excluded_custom_audiences?: CustomAudienceRef[];
}

/**
 * Validate an ad set `targeting` object against Special Ad Category rules.
 * Call for BOTH create and update of any ad set under a restricted
 * category, before the request ever reaches Meta.
 */
export function validateTargetingPayload(targeting: Targeting, specialAdCategories?: string[] | null): void {
  if (!isRestrictedCategory(specialAdCategories)) return;
  const categoriesLabel = JSON.stringify(specialAdCategories);

  if (targeting.age_min !== undefined || targeting.age_max !== undefined) {
    throw new ComplianceError(
      `Age targeting (age_min/age_max) is not permitted for special_ad_categories=${categoriesLabel}. ` +
        "Meta locks age to 18-65+ for Housing/Employment/Financial Products & Services ads — " +
        "omit these fields entirely rather than setting them to the default."
    );
  }

  if (targeting.genders !== undefined) {
    throw new ComplianceError(
      `Gender targeting ('genders') is not permitted for special_ad_categories=${categoriesLabel}. ` +
        "Omit this field (it defaults to all genders)."
    );
  }

  if (targeting.excluded_geo_locations) {
    throw new ComplianceError(
      `Location exclusions ('excluded_geo_locations') are not supported for special_ad_categories=${categoriesLabel}.`
    );
  }

  const geo = targeting.geo_locations || {};
  for (const locType of PROHIBITED_LOCATION_TYPES) {
    if ((geo as Record<string, unknown[] | undefined>)[locType]?.length) {
      throw new ComplianceError(
        `Geo targeting by '${locType}' is not permitted for special_ad_categories=${categoriesLabel}. ` +
          "Use city/region/country targeting, or a compliant-radius custom_location, instead."
      );
    }
  }

  for (const radiusLoc of geo.custom_locations || []) {
    const radius = radiusLoc.radius;
    if (radius === undefined || radius === null) continue;
    const unit = radiusLoc.distance_unit || "mile";
    const country = (radiusLoc.country || "").toUpperCase();
    const floor =
      unit === "kilometer"
        ? EUROPE_COUNTRY_CODES.has(country)
          ? MIN_RADIUS_KM_EUROPE
          : MIN_RADIUS_KM_US_CANADA
        : MIN_RADIUS_MILES_US_CANADA;
    if (radius < floor) {
      throw new ComplianceError(
        `Pinpoint radius targeting of ${radius} ${unit}(s) is below the minimum ${floor} ${unit}(s) ` +
          `required for special_ad_categories=${categoriesLabel}.`
      );
    }
  }

  for (const spec of targeting.flexible_spec || []) {
    for (const bannedKey of ["behaviors", "demographics"] as const) {
      if (spec[bannedKey]?.length) {
        throw new ComplianceError(
          `'${bannedKey}' targeting is not permitted for special_ad_categories=${categoriesLabel}. ` +
            "Only Meta's pre-approved interest list is allowed for these categories."
        );
      }
    }
    if (spec.exclusions) {
      throw new ComplianceError(
        `Detailed-targeting exclusions (flexible_spec.exclusions) are not permitted for special_ad_categories=${categoriesLabel}.`
      );
    }
  }

  if (targeting.exclusions) {
    throw new ComplianceError(
      `Detailed-targeting exclusions are not permitted for special_ad_categories=${categoriesLabel}.`
    );
  }

  const audiences = [...(targeting.custom_audiences || []), ...(targeting.excluded_custom_audiences || [])];
  for (const aud of audiences) {
    if (aud.subtype && aud.subtype.toUpperCase() === "LOOKALIKE") {
      throw new ComplianceError(
        `Lookalike audiences are not permitted for special_ad_categories=${categoriesLabel}. ` +
          `Audience ${aud.id} is a lookalike — remove it from targeting.`
      );
    }
  }
}

/**
 * Meta's own auto-enforcement mechanism: setting tune_for_category on an
 * ad set makes Meta itself strip/adjust age, gender, radius, and location
 * fields for compliance. Prefer this over hand-built targeting whenever
 * creating a fresh ad set under a restricted category — it's a smaller
 * surface area for us to get wrong than reimplementing Meta's own rules.
 */
export function safeTuneForCategoryPayload(category: string): { tune_for_category: string } {
  if (!RESTRICTED_CATEGORIES.has(category)) {
    throw new ComplianceError(`tune_for_category is only meaningful for restricted categories, got ${JSON.stringify(category)}`);
  }
  return { tune_for_category: category };
}
