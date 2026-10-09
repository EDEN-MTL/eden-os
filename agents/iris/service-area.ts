/**
 * What "our service area" means in practice. Mark, 2026-10-09: a seller who
 * said they were in Paradise was told "Paradise isn't in our service area" and
 * the call was ended — but Paradise is part of the St. John's metro area. The
 * old rule was just the city name ("${city} only"), so any suburb, however
 * close, sounded like "somewhere else" to the model.
 *
 * The lists live in client config (market.serviceArea) so another client in
 * another province brings its own geography:
 *   core    — the metro area; never decline, never end a call over it
 *   nearby  — the rest of the surrounding region; carry on as normal and note
 *             the place so an agent can confirm
 *   outside — examples of places that are clearly out, to anchor the model
 */
export interface ServiceAreaConfig {
  core: string[];
  nearby: string[];
  outside: string[];
}

export type PlaceZone = "core" | "nearby" | "outside" | "unknown";

/**
 * The prompt rule every Iris/Ember prompt uses for the service area.
 * `situation` wording differs per channel (a call ends differently from a
 * text); the geography and the "when unsure, don't decline" rule don't.
 */
export function serviceAreaRule(city: string, area: ServiceAreaConfig | undefined, outOfAreaLine: string): string {
  if (!area) {
    return `Our service area is ${city} and the area around it. Only if they're clearly far from ${city} (another region or province), say: "${outOfAreaLine}". If you're not sure where a place is, never assume it's outside — ask once whether it's close to ${city}, or just carry on.`;
  }
  return `SERVICE AREA — ${city} and the surrounding area, not just the city limits.
  IN AREA (never decline, never end a call or conversation over these, and never say they're outside our area): ${area.core.join("; ")}.
  NEARBY (carry on exactly as normal; note the place so an agent can confirm): ${area.nearby.join("; ")}.
  CLEARLY OUTSIDE (only these kinds of places — e.g. ${area.outside.join("; ")}, anywhere off the Avalon Peninsula, or outside Newfoundland): say "${outOfAreaLine}".
  If you're not sure where a place is, or whether it's near ${city}, do NOT assume it's outside: ask once "Is that close to ${city}?" or simply carry on. "The ${city} area", "the city" and any community listed above all count as in area.`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentions(haystack: string, place: string): boolean {
  const needle = normalize(place);
  return needle !== "" && new RegExp(`(^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(haystack);
}

/**
 * Which zone a spoken or typed place falls in — for tests and any code that
 * wants to pre-classify a lead's stated location. The prompt is what decides
 * in a live conversation; this keeps the lists honest and checkable.
 * "Saint John" without the 's (New Brunswick) is never treated as St. John's.
 */
export function classifyPlace(text: string, area: ServiceAreaConfig): PlaceZone {
  const t = normalize(text);
  if (t === "") return "unknown";

  const mentionsNewBrunswick = /\bnew brunswick\b|\bnb\b/.test(t);
  const saintJohns = /\b(st|saint) johns?\b/.test(t);
  if (saintJohns && !mentionsNewBrunswick && /\b(st|saint) john'?s\b/.test(t)) return "core";

  if (area.core.some((p) => mentions(t, p))) return "core";
  if (area.nearby.some((p) => mentions(t, p))) return "nearby";
  if (area.outside.some((p) => mentions(t, p)) || (saintJohns && mentionsNewBrunswick)) return "outside";
  return "unknown";
}
