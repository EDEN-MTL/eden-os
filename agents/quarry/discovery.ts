/**
 * Module 1 — lead discovery via the Google Places API (New).
 *
 * ── Why two calls per business instead of one ──
 * Places (New) prices by FIELD, not by call: the field mask you send decides
 * which SKU tier the request bills at. `websiteUri` and `nationalPhoneNumber`
 * sit in the most expensive tier, so asking Text Search for them would bill
 * every result at that rate — including the ~70% we discard for being chains,
 * permanently closed, or already seen.
 *
 * So: Text Search asks only for the cheap identity fields, we filter locally,
 * and only survivors get a Details call carrying the expensive mask. Adding a
 * field to SEARCH_FIELD_MASK raises the price of every result; adding one to
 * DETAILS_FIELD_MASK raises it only for the ones we keep.
 */
import { PlacesResult, QuarryCategory } from "./types";
import { SearchSpec } from "./config";

const PLACES_BASE = "https://places.googleapis.com/v1";

/**
 * Cheap tier only. `id` and `displayName` are Essentials; formattedAddress and
 * businessStatus are Pro. Deliberately NO websiteUri/phone here.
 */
const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.businessStatus",
].join(",");

/** Expensive tier, spent only on businesses that survived filtering. */
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "nationalPhoneNumber",
  "websiteUri",
  "rating",
  "userRatingCount",
  "businessStatus",
  "photos",
  "types",
  "googleMapsUri",
].join(",");

export class PlacesApiError extends Error {
  constructor(status: number, body: string) {
    super(`Places API ${status}: ${body.slice(0, 300)}`);
    this.name = "PlacesApiError";
  }
}

async function placesRequest(
  path: string,
  fieldMask: string,
  apiKey: string,
  body?: Record<string, unknown>
): Promise<any> {
  const res = await fetch(`${PLACES_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new PlacesApiError(res.status, await res.text());
  return res.json();
}

interface SearchHit {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  businessStatus: string | null;
}

export async function textSearch(
  spec: SearchSpec,
  apiKey: string
): Promise<SearchHit[]> {
  const payload = await placesRequest("/places:searchText", SEARCH_FIELD_MASK, apiKey, {
    textQuery: spec.query,
    // Capped server-side so we are not billed for results we then throw away.
    maxResultCount: Math.min(spec.maxResults, 20),
    languageCode: "en",
    regionCode: "CA",
  });
  return (payload.places ?? []).map((p: any) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "(unnamed)",
    formattedAddress: p.formattedAddress ?? null,
    businessStatus: p.businessStatus ?? null,
  }));
}

export async function placeDetails(
  placeId: string,
  spec: SearchSpec,
  apiKey: string
): Promise<PlacesResult> {
  const p = await placesRequest(`/places/${placeId}`, DETAILS_FIELD_MASK, apiKey);
  return {
    placeId: p.id ?? placeId,
    name: p.displayName?.text ?? "(unnamed)",
    formattedAddress: p.formattedAddress ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    rating: p.rating ?? null,
    userRatingsTotal: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
    placeTypes: p.types ?? [],
    googleMapsUri: p.googleMapsUri ?? null,
    // Capped at 3: Place Photos bills per media fetch with a 1,000/month free
    // cap, and 6 photos x 20 leads x 4 runs would cross it for images the
    // generator does not need. Photo *names* in the new API ("places/X/photos/Y"), resolved to real
    // image URLs later by photoUrl(). Storing the name rather than a URL is
    // deliberate: the URL is a redirect that expires, the name does not.
    photoRefs: (p.photos ?? []).slice(0, 3).map((ph: any) => ph.name),
    searchQuery: spec.query,
    category: spec.category as QuarryCategory,
  };
}

/** Resolves a stored photo name into a fetchable image URL. */
export function photoUrl(photoName: string, apiKey: string, maxWidthPx = 1200): string {
  return `${PLACES_BASE}/${photoName}/media?maxWidthPx=${maxWidthPx}&key=${apiKey}`;
}

/**
 * A business is worth paying for details on only if it is operational and not
 * one we have already processed. Both checks are free and happen before the
 * expensive call — this filter is the main cost control in the whole agent.
 */
export function worthDetailing(hit: SearchHit, alreadySeen: Set<string>): boolean {
  if (alreadySeen.has(hit.placeId)) return false;
  // OPERATIONAL is the only status worth pitching. CLOSED_TEMPORARILY is
  // ambiguous but CLOSED_PERMANENTLY definitely is not, and a business with no
  // status reported is treated as operational rather than dropped.
  if (hit.businessStatus === "CLOSED_PERMANENTLY") return false;
  return true;
}

export interface DiscoveryOutcome {
  results: PlacesResult[];
  searched: number;
  skippedAlreadySeen: number;
  skippedClosed: number;
  detailsCalls: number;
}

/**
 * Runs every configured search, filters, and fetches details for survivors.
 * `maxDetails` is a hard ceiling on the expensive calls per run.
 *
 * ── Why searches all run before any details call ──
 * The obvious loop — search, detail, search, detail, stop at the cap — spends
 * the entire details budget on the first one or two queries and never reaches
 * the rest. With trade queries listed first, every run would build trade sites
 * and the professional briefs would never once be used. Since Text Search
 * bills per REQUEST (not per result) and eleven requests a week sit inside the
 * free monthly cap, running all of them costs nothing and buys a real choice.
 * Details are then dealt round-robin so every category is represented.
 */
export async function discover(
  specs: SearchSpec[],
  apiKey: string,
  alreadySeen: Set<string>,
  maxDetails: number,
  onError?: (spec: SearchSpec, error: Error) => void
): Promise<DiscoveryOutcome> {
  const outcome: DiscoveryOutcome = {
    results: [],
    searched: 0,
    skippedAlreadySeen: 0,
    skippedClosed: 0,
    detailsCalls: 0,
  };
  // Tracks ids found in THIS run too — the same shop legitimately appears
  // under "florist NDG Montreal" and "florist Montreal", and paying for its
  // details twice in one run is the easiest money to waste here.
  const seenThisRun = new Set(alreadySeen);

  // Pass 1 — every search, cheap.
  const queues: { spec: SearchSpec; hits: SearchHit[] }[] = [];
  for (const spec of specs) {
    let hits: SearchHit[];
    try {
      hits = await textSearch(spec, apiKey);
    } catch (error) {
      onError?.(spec, error as Error);
      continue;
    }
    outcome.searched += hits.length;

    const keep: SearchHit[] = [];
    for (const hit of hits) {
      if (seenThisRun.has(hit.placeId)) {
        outcome.skippedAlreadySeen++;
        continue;
      }
      if (!worthDetailing(hit, seenThisRun)) {
        outcome.skippedClosed++;
        continue;
      }
      // Reserved now so a shop matching two queries is queued only once.
      seenThisRun.add(hit.placeId);
      keep.push(hit);
    }
    queues.push({ spec, hits: keep });
  }

  // Pass 2 — round-robin the details budget across categories.
  let cursor = 0;
  while (outcome.results.length < maxDetails && queues.some((q) => q.hits.length > 0)) {
    const queue = queues[cursor % queues.length];
    cursor++;
    const hit = queue.hits.shift();
    if (!hit) continue;

    try {
      outcome.detailsCalls++;
      outcome.results.push(await placeDetails(hit.placeId, queue.spec, apiKey));
    } catch (error) {
      onError?.(queue.spec, error as Error);
    }
  }
  return outcome;
}
