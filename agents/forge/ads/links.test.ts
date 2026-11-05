import { describe, expect, it } from "vitest";
import { accountNumber, adsManagerUrl, slackLink } from "./links";
import { formatHealthDigest } from "./health-digest";

const ACT = "act_10150181877529722";

describe("adsManagerUrl", () => {
  it("links a campaign, with the account number and the campaign selected", () => {
    expect(adsManagerUrl(ACT, "campaign", "120247487535900001")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=10150181877529722&selected_campaign_ids=120247487535900001"
    );
  });

  it("links an ad set on the ad sets tab, with its campaign when known", () => {
    expect(adsManagerUrl(ACT, "adset", "120247487535900259", { campaignId: "120247487535900001" })).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/adsets?act=10150181877529722&selected_campaign_ids=120247487535900001&selected_adset_ids=120247487535900259"
    );
    expect(adsManagerUrl(ACT, "adset", "120247487535900259")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/adsets?act=10150181877529722&selected_adset_ids=120247487535900259"
    );
  });

  it("links an ad on the ads tab, with its ad set and campaign when known", () => {
    expect(adsManagerUrl(ACT, "ad", "555", { campaignId: "111", adsetId: "222" })).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads?act=10150181877529722&selected_campaign_ids=111&selected_adset_ids=222&selected_ad_ids=555"
    );
  });

  it("takes the account id with or without the act_ prefix, and gives no link without a usable account or id", () => {
    expect(accountNumber("act_123")).toBe("123");
    expect(accountNumber("123")).toBe("123");
    expect(accountNumber("")).toBeNull();
    expect(accountNumber(undefined)).toBeNull();
    expect(adsManagerUrl(undefined, "ad", "555")).toBeNull();
    expect(adsManagerUrl(ACT, "ad", "not-a-number")).toBeNull();
  });

  it("ignores a parent id that is not a plain number rather than putting it in the address", () => {
    expect(adsManagerUrl(ACT, "ad", "555", { campaignId: "1&evil=1", adsetId: "222" })).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads?act=10150181877529722&selected_adset_ids=222&selected_ad_ids=555"
    );
  });
});

describe("slackLink", () => {
  it("makes a Slack link, escaping the characters Slack reads as markup, and keeps pipes in a name", () => {
    expect(slackLink("https://x.test/a", "Testing | Buyer Video | Sep 2026")).toBe("<https://x.test/a|Testing | Buyer Video | Sep 2026>");
    expect(slackLink("https://x.test/a", "A & B <new>")).toBe("<https://x.test/a|A &amp; B &lt;new&gt;>");
  });
  it("is just the name when there is no link", () => {
    expect(slackLink(null, "Name")).toBe("Name");
  });
});

describe("the daily digest", () => {
  const report: any = {
    clientId: "c", lookbackDays: 14, funnels: [], counts: { healthy: 0, too_early: 0 },
    totals: { spend: 100, leads: 3, cpl: 33, leadSource: "crm" }, dailyBudget: { current: null, cap: null },
    entities: [
      { scope: "ad", id: "555", name: "OCT 2026 image 1", verdict: "scale", reasons: ["5 leads at $35.44 CPL"], recommendation: "Winning ad.", metrics: { spend: 177, cpl: 35.44 }, targetCpl: 45, url: "https://adsmanager.facebook.com/adsmanager/manage/ads?act=1&selected_ad_ids=555" },
      { scope: "adset", id: "222", name: "Testing | Buyer Video | Sep  2026", verdict: "scale", reasons: ["3 leads at $32.59 CPL"], recommendation: "Raise the campaign budget.", metrics: { spend: 98, cpl: 32.59 }, targetCpl: 45 },
    ],
  };

  it("makes each entity's name a link to it in Ads Manager", () => {
    const text = formatHealthDigest("3 Percent East Coast", report);
    expect(text).toContain("• Ad *<https://adsmanager.facebook.com/adsmanager/manage/ads?act=1&selected_ad_ids=555|OCT 2026 image 1>*: 5 leads at $35.44 CPL");
  });

  it("leaves a name plain when it has no link, as before", () => {
    expect(formatHealthDigest("3 Percent East Coast", report)).toContain("• Ad set *Testing | Buyer Video | Sep  2026*: 3 leads");
  });
});
