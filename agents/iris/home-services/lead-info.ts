import { ColumnKey, Language } from "./config";

export type VisitWindow = "morning" | "afternoon" | "evening" | "anytime";

/** Everything Iris has actually learned about a lead. A field is absent until the lead (or the form) gave it. */
export interface LeadInfo {
  fullName?: string;
  street?: string;
  /** Neighbourhood or city — Pedro routes loose appointments by area. */
  city?: string;
  postalCode?: string;
  /** When the lead is free for the in-person estimate. Morning/afternoon is Loose Day, evening is Loose Night. */
  visitWindow?: VisitWindow;
  /** Derived from visitWindow, never set directly. */
  visitType?: "day" | "night";
  /** Anything specific about when: "after 6pm", "Saturdays only", "Tuesday the 18th". Goes to the owner as written. */
  availabilityNotes?: string;
  size?: string;
  phone?: string;
  language?: Language;
  service?: string;
  timing?: string;
  photosReceived?: boolean;
  woodType?: string;
  condition?: string;
  stairs?: string;
  occupied?: string;
  finish?: string;
  otherNotes?: string;
  openQuestions?: string;
}

export const INFO_KEYS: ReadonlyArray<keyof LeadInfo> = [
  "fullName", "street", "city", "postalCode", "visitWindow", "availabilityNotes", "size", "phone", "language", "service",
  "timing", "photosReceived", "woodType", "condition", "stairs", "occupied", "finish", "otherNotes", "openQuestions",
];

const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const WINDOWS: readonly string[] = ["morning", "afternoon", "evening", "anytime"];

export const visitTypeFor = (window: VisitWindow): "day" | "night" => (window === "evening" ? "night" : "day");

/** Merges only recognised, non-empty values into the lead's info; unknown keys and blanks never overwrite anything. */
export function mergeInfo(current: LeadInfo, patch: Record<string, unknown>): LeadInfo {
  const next: Record<string, unknown> = { ...current };
  for (const key of INFO_KEYS) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    if (key === "photosReceived") {
      if (typeof value === "boolean") next[key] = value;
    } else if (key === "visitWindow") {
      if (typeof value === "string" && WINDOWS.includes(value)) {
        next.visitWindow = value;
        next.visitType = visitTypeFor(value as VisitWindow);
      }
    } else if (key === "language") {
      if (value === "fr" || value === "en") next[key] = value;
    } else {
      const text = clean(value);
      if (text) next[key] = text;
    }
  }
  return next as LeadInfo;
}

/**
 * What must be collected before the lead is moved to an appointment column: who, where, how big,
 * and when they are free. Service, timing and the rest are welcome but never block the booking.
 */
export function missingRequired(info: LeadInfo): string[] {
  const missing: string[] = [];
  if (!info.fullName) missing.push("full name");
  if (!info.street) missing.push("street address");
  if (!info.city) missing.push("neighbourhood or city");
  if (!info.postalCode) missing.push("postal code");
  if (!info.size) missing.push("approximate size (square feet, or number and type of rooms)");
  if (!info.visitWindow) missing.push("when they are free for the visit (morning, afternoon or evening)");
  if (!info.phone) missing.push("best phone number");
  return missing;
}

/** The column a lead's availability maps to. */
export function columnForVisit(info: LeadInfo): ColumnKey | null {
  if (info.visitType === "day") return "looseDay";
  if (info.visitType === "night") return "looseNight";
  return null;
}

export function formatPostalFsa(postalCode?: string): string {
  return (postalCode ?? "").replace(/\s+/g, "").slice(0, 3).toUpperCase();
}

const unknown = (v: string | undefined) => v ?? "unknown";

/** The contact note. Facts only — "unknown" for anything not collected, never a guess. */
export function buildSummaryNote(info: LeadInfo, column: string, date: string): string {
  const visit = info.visitWindow ? `${info.visitWindow}${info.availabilityNotes ? ` — ${info.availabilityNotes}` : ""}` : unknown(info.availabilityNotes);
  return [
    `IRIS SUMMARY — ${date}`,
    `Column: ${column}`,
    `Name / Language: ${unknown(info.fullName)} / ${info.language === "fr" ? "French" : info.language === "en" ? "English" : "unknown"}`,
    `Address / Neighbourhood / Postal code: ${unknown(info.street)} / ${unknown(info.city)} / ${unknown(info.postalCode)}`,
    `Best number: ${unknown(info.phone)}`,
    `Approx. size: ${unknown(info.size)}`,
    `Available for the estimate: ${visit}`,
    `Service: ${unknown(info.service)}`,
    `Timing: ${unknown(info.timing)}`,
    `Wood type & condition: ${[info.woodType, info.condition].filter(Boolean).join(", ") || "unknown"}`,
    `Stairs: ${unknown(info.stairs)}`,
    `Occupied/vacant, furniture: ${unknown(info.occupied)}`,
    `Photos received: ${info.photosReceived ? "yes" : "no"}`,
    `Other notes: ${unknown(info.otherNotes)}`,
    `Open questions for Pedro: ${info.openQuestions ?? "none"}`,
  ].join("\n");
}
