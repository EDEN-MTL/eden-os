/**
 * Provisions the GHL custom fields the attribution linker depends on.
 *
 * WHY THIS EXISTS: attribution joins a GHL lead back to the exact Meta
 * campaign/adset/ad that produced it, keyed on values stored in custom
 * fields on the Contact. If those fields don't exist on the location,
 * every synced lead has null attribution and the whole "which ad actually
 * made money" question is unanswerable — the sync still runs, it just
 * silently produces nothing useful. Both real client locations were found
 * with ZERO attribution fields, so this closes that gap.
 *
 * IMPORTANT — this is only step 1 of 3. Creating the fields does NOT make
 * attribution work on its own. Also required:
 *   2. The landing page must read fbclid + utm_* from the URL on load and
 *      submit them into these fields (GHL form field mapping).
 *   3. Each Meta ad set's URL parameters must stamp Meta's own IDs:
 *      utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}
 *      &utm_content={{ad.id}}&utm_term={{adset.id}}
 * Without 2 and 3 the fields exist but stay empty. checkAttributionReadiness
 * reports on step 1 only — it cannot see whether 2 and 3 are done.
 */
import { createCustomField, getCustomFieldDefs } from "../../../shared/ghl";
import { FieldMap } from "./attribution";

/**
 * GHL slugifies the display name into fieldKey server-side, so the name
 * has to be chosen to produce the key we want. "fbclid" -> contact.fbclid,
 * "utm_source" -> contact.utm_source, etc. We verify after creating rather
 * than trusting the slugification, since a mismatch silently breaks the
 * join.
 */
function nameForKey(fieldKey: string): string {
  return fieldKey.replace(/^contact\./, "");
}

export interface ProvisionResult {
  created: string[];
  alreadyPresent: string[];
  /** Fields that were created but whose resulting fieldKey didn't match what the field map expects. */
  mismatched: { expected: string; got: string }[];
}

/**
 * Creates any attribution field from `fieldMap` that doesn't already exist
 * on the location. Idempotent: existing fields are left untouched, so this
 * is safe to re-run.
 */
export async function provisionAttributionFields(
  locationId: string,
  fieldMap: FieldMap,
  apiKey?: string
): Promise<ProvisionResult> {
  const existing = await getCustomFieldDefs(locationId, apiKey);
  const existingKeys = new Set(existing.map((f: any) => f.fieldKey).filter(Boolean));

  const wanted = Object.entries(fieldMap)
    .filter(([internalName]) => !internalName.startsWith("_"))
    .map(([, fieldKey]) => fieldKey);

  const result: ProvisionResult = { created: [], alreadyPresent: [], mismatched: [] };

  for (const fieldKey of wanted) {
    if (existingKeys.has(fieldKey)) {
      result.alreadyPresent.push(fieldKey);
      continue;
    }
    const created = await createCustomField(locationId, nameForKey(fieldKey), "TEXT", apiKey);
    const gotKey = created?.customField?.fieldKey ?? created?.fieldKey;
    result.created.push(fieldKey);
    if (gotKey && gotKey !== fieldKey) {
      result.mismatched.push({ expected: fieldKey, got: gotKey });
    }
  }

  return result;
}

export interface AttributionReadiness {
  ready: boolean;
  presentFields: string[];
  missingFields: string[];
  note: string;
}

/**
 * Reports whether the attribution FIELDS exist. Deliberately does not
 * claim attribution "works" — it cannot see whether the landing page and
 * Meta URL parameters are wired up, which are equally required.
 */
export async function checkAttributionReadiness(
  locationId: string,
  fieldMap: FieldMap,
  apiKey?: string
): Promise<AttributionReadiness> {
  const existing = await getCustomFieldDefs(locationId, apiKey);
  const existingKeys = new Set(existing.map((f: any) => f.fieldKey).filter(Boolean));

  const wanted = Object.entries(fieldMap)
    .filter(([internalName]) => !internalName.startsWith("_"))
    .map(([, fieldKey]) => fieldKey);

  const presentFields = wanted.filter((k) => existingKeys.has(k));
  const missingFields = wanted.filter((k) => !existingKeys.has(k));

  return {
    ready: missingFields.length === 0,
    presentFields,
    missingFields,
    note:
      missingFields.length === 0
        ? "Fields exist. Attribution still also requires the landing page to capture fbclid/utm_* into them, and Meta ad set URL parameters to stamp campaign/adset/ad IDs."
        : `${missingFields.length} attribution field(s) missing — leads will sync with null attribution until these exist.`,
  };
}
