import { describe, expect, it } from "vitest";
import { ageFooter, ageParts, createdChain, formatLaunch, type LiveCreated } from "./age";

const now = new Date("2026-11-06T15:00:00Z");
const at = (iso: string) => Date.parse(iso);

describe("formatLaunch", () => {
  it("gives just the date for this year", () => {
    expect(formatLaunch(at("2026-09-26T14:00:00Z"), now)).toBe("Sep 26");
  });

  it("adds the year for an earlier one", () => {
    expect(formatLaunch(at("2025-12-30T14:00:00Z"), now)).toBe("Dec 30, 2025");
  });

  it("uses the client's calendar day, not UTC", () => {
    // 01:00 UTC on Oct 17 is still the evening of Oct 16 in St. John's.
    expect(formatLaunch(at("2026-10-17T01:00:00Z"), now)).toBe("Oct 16");
  });
});

describe("createdChain", () => {
  const live: LiveCreated = new Map([
    ["c1", { createdAt: at("2026-09-26T12:00:00Z"), campaignId: "c1" }],
    ["s1", { createdAt: at("2026-10-20T12:00:00Z"), campaignId: "c1" }],
    ["a1", { createdAt: at("2026-11-03T12:00:00Z"), campaignId: "c1", adsetId: "s1" }],
  ]);

  it("an ad carries its ad set and campaign", () => {
    expect(createdChain(live, "ad", "a1")).toEqual({ campaign: at("2026-09-26T12:00:00Z"), adset: at("2026-10-20T12:00:00Z"), ad: at("2026-11-03T12:00:00Z") });
  });

  it("an ad set carries its campaign, a campaign only itself", () => {
    expect(Object.keys(createdChain(live, "adset", "s1"))).toEqual(["campaign", "adset"]);
    expect(Object.keys(createdChain(live, "campaign", "c1"))).toEqual(["campaign"]);
  });

  it("is empty when Meta was not read or the id is unknown", () => {
    expect(createdChain(null, "ad", "a1")).toEqual({});
    expect(createdChain(live, "ad", "nope")).toEqual({});
    expect(createdChain(live, "account", "c1")).toEqual({});
  });
});

describe("ageParts / ageFooter", () => {
  const chain = { campaign: at("2026-09-26T12:00:00Z"), adset: at("2026-10-20T12:00:00Z"), ad: at("2026-11-03T12:00:00Z") };

  it("names the launch date at every level, with no day count", () => {
    expect(ageFooter("ad", chain, now)).toBe("🗓️ Campaign: launched Sep 26 · Ad set: launched Oct 20 · Ad: launched Nov 3");
    expect(ageFooter("ad", chain, now)).not.toMatch(/days? old/);
  });

  it("only shows the levels that exist for the entity", () => {
    expect(ageParts("adset", chain, now)).toEqual(["Campaign: launched Sep 26", "Ad set: launched Oct 20"]);
  });

  it("skips a level whose date is unknown, and gives null when none is", () => {
    expect(ageParts("ad", { ad: chain.ad }, now)).toEqual(["Ad: launched Nov 3"]);
    expect(ageFooter("ad", {}, now)).toBeNull();
  });
});
