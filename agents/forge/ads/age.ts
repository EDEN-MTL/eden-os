/**
 * When a campaign, ad set or ad first launched, for the bottom of Forge's Slack posts.
 * Mark, 2026-11-06: "so we have a basis for judging the ads from the first launch on how they performed" —
 * then, "just put the date when it was first launched", so a date and no day count.
 *
 * The date is Meta's created_time (the launch), not updated_time: editing an ad does not make it new.
 */

export type AgeScope = "campaign" | "adset" | "ad";

/** Launch times (epoch ms) of an entity and the ones above it; a level that is unknown is simply absent. */
export interface CreatedChain {
  campaign?: number;
  adset?: number;
  ad?: number;
}

/** The slice of the live state this needs, so it can be tested without Meta. */
export type LiveCreated = Map<string, { createdAt?: number; campaignId?: string; adsetId?: string }>;

const DEFAULT_TZ = "America/St_Johns";
const LABEL: Record<AgeScope, string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad" };

/** The launch times for this entity and its parents, read from the live state. */
export function createdChain(live: LiveCreated | null | undefined, scope: string, id: string): CreatedChain {
  if (!live || (scope !== "campaign" && scope !== "adset" && scope !== "ad")) return {};
  const self = live.get(id);
  if (!self) return {};
  const chain: CreatedChain = {};
  const campaignAt = live.get(self.campaignId ?? "")?.createdAt;
  if (scope === "campaign") {
    if (self.createdAt) chain.campaign = self.createdAt;
    return chain;
  }
  if (campaignAt) chain.campaign = campaignAt;
  if (scope === "adset") {
    if (self.createdAt) chain.adset = self.createdAt;
    return chain;
  }
  const adsetAt = live.get(self.adsetId ?? "")?.createdAt;
  if (adsetAt) chain.adset = adsetAt;
  if (self.createdAt) chain.ad = self.createdAt;
  return chain;
}

/** "Sep 26" for this year, "Sep 26, 2025" for an earlier one, on the client's calendar. */
export function formatLaunch(createdMs: number, now: Date, timeZone: string = DEFAULT_TZ): string {
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const created = new Date(createdMs);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", ...(year(created) === year(now) ? {} : { year: "numeric" }) }).format(created);
}

/** The levels this entity sits at, top-down: a campaign has itself, an ad has campaign, ad set and itself. */
function levels(scope: AgeScope): AgeScope[] {
  return scope === "campaign" ? ["campaign"] : scope === "adset" ? ["campaign", "adset"] : ["campaign", "adset", "ad"];
}

/** One part per level that has a launch time, e.g. "Campaign: launched Sep 26". Empty when none is known. */
export function ageParts(scope: string, chain: CreatedChain, now: Date, timeZone?: string): string[] {
  if (scope !== "campaign" && scope !== "adset" && scope !== "ad") return [];
  return levels(scope).flatMap((level) => (chain[level] ? [`${LABEL[level]}: launched ${formatLaunch(chain[level]!, now, timeZone)}`] : []));
}

/** The closing line of a flag post, or null when Meta gave no launch time. */
export function ageFooter(scope: string, chain: CreatedChain, now: Date, timeZone?: string): string | null {
  const parts = ageParts(scope, chain, now, timeZone);
  return parts.length ? `🗓️ ${parts.join(" · ")}` : null;
}
