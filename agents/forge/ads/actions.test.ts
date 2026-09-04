import { describe, expect, it, vi } from "vitest";
import { ComplianceError } from "../../../shared/meta/compliance";
import { MetaClientLike, MetaActions } from "./actions";

function makeFakeClient(overrides: Partial<MetaClientLike> = {}): MetaClientLike {
  return {
    adAccountId: "act_123",
    pageId: "page_1",
    getObject: vi.fn(async (id: string) => ({ id, status: "ACTIVE", daily_budget: "10000" })),
    call: vi.fn(async (_method, _path, options) => ({ id: "new_id_1", ...options?.data })),
    uploadImageFile: vi.fn(async () => ({ images: { "test.png": { hash: "abc123", url: "https://example.com/x.png" } } })),
    ...overrides,
  };
}

describe("MetaActions — status changes", () => {
  it("pause posts status=PAUSED and captures before/after", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    const result = await actions.pause("123", "campaign");
    expect(result.actionType).toBe("pause");
    expect(client.call).toHaveBeenCalledWith("POST", "123", { data: { status: "PAUSED" } });
  });

  it("resume posts status=ACTIVE", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await actions.resume("123", "campaign");
    expect(client.call).toHaveBeenCalledWith("POST", "123", { data: { status: "ACTIVE" } });
  });
});

describe("MetaActions — budget", () => {
  it("rejects setting budget on anything but campaign/adset", async () => {
    const actions = new MetaActions(makeFakeClient());
    await expect(actions.setDailyBudget("1", "ad", 5000)).rejects.toThrow();
  });

  it("adjustBudgetByPercent computes the new budget correctly", async () => {
    const client = makeFakeClient({
      getObject: vi.fn(async () => ({ daily_budget: "10000" })), // $100.00
    });
    const actions = new MetaActions(client);
    await actions.adjustBudgetByPercent("1", "adset", 20); // +20% -> 12000
    expect(client.call).toHaveBeenCalledWith("POST", "1", { data: { daily_budget: "12000" } });
  });

  it("clamps the adjusted budget to the min/max caps", async () => {
    const client = makeFakeClient({ getObject: vi.fn(async () => ({ daily_budget: "10000" })) });
    const actions = new MetaActions(client);
    await actions.adjustBudgetByPercent("1", "adset", -95, undefined, 500); // would be 500 -> floor 500
    expect(client.call).toHaveBeenCalledWith("POST", "1", { data: { daily_budget: "500" } });

    await actions.adjustBudgetByPercent("1", "adset", 500, 15000); // would be way over -> capped 15000
    expect(client.call).toHaveBeenCalledWith("POST", "1", { data: { daily_budget: "15000" } });
  });

  it("throws if the entity has no daily_budget to adjust", async () => {
    const client = makeFakeClient({ getObject: vi.fn(async () => ({})) });
    const actions = new MetaActions(client);
    await expect(actions.adjustBudgetByPercent("1", "adset", 10)).rejects.toThrow();
  });
});

describe("MetaActions — creation always comes in paused", () => {
  it("createCampaign always sets status=PAUSED regardless of input", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await actions.createCampaign({ name: "Test", objective: "LEAD_GENERATION" });
    const [, , options] = (client.call as any).mock.calls[0];
    expect(JSON.parse(JSON.stringify(options.data))).toMatchObject({ status: "PAUSED" });
  });

  it("createAdset always sets status=PAUSED", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await actions.createAdset({
      campaignId: "1", name: "Test", targeting: {}, optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS",
    });
    const [, , options] = (client.call as any).mock.calls[0];
    expect(options.data.status).toBe("PAUSED");
  });

  it("createAdset defaults to bid_strategy=LOWEST_COST_WITHOUT_CAP when no bid amount is given", async () => {
    // Some ad accounts default to a bid strategy (LOWEST_COST_WITH_BID_CAP
    // or TARGET_COST) that Meta rejects the ad set for unless bid_amount is
    // also set — this must never be left to the account default.
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await actions.createAdset({
      campaignId: "1", name: "Test", targeting: {}, optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS",
    });
    const [, , options] = (client.call as any).mock.calls[0];
    expect(options.data.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(options.data.bid_amount).toBeUndefined();
  });

  it("createAdset switches to bid_strategy=LOWEST_COST_WITH_BID_CAP when a bid amount is given", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await actions.createAdset({
      campaignId: "1", name: "Test", targeting: {}, optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS",
      bidAmountCents: 250,
    });
    const [, , options] = (client.call as any).mock.calls[0];
    expect(options.data.bid_strategy).toBe("LOWEST_COST_WITH_BID_CAP");
    expect(options.data.bid_amount).toBe("250");
  });
});

describe("MetaActions — compliance gate integration", () => {
  it("createCampaign refuses a restricted category with no country list, before ever calling Meta", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(
      actions.createCampaign({ name: "Test", objective: "LEAD_GENERATION", specialAdCategories: ["HOUSING"] })
    ).rejects.toThrow(ComplianceError);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("createAdset refuses age targeting under a restricted category even with tune_for_category off", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(
      actions.createAdset({
        campaignId: "1", name: "Test", targeting: { age_min: 25 },
        optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS",
        specialAdCategories: ["HOUSING"], useTuneForCategory: false,
      })
    ).rejects.toThrow(ComplianceError);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("createAdset allows age_min/age_max under tune_for_category (Meta strips them itself)", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(
      actions.createAdset({
        campaignId: "1", name: "Test", targeting: { age_min: 25, age_max: 40 },
        optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS",
        specialAdCategories: ["HOUSING"], useTuneForCategory: true,
      })
    ).resolves.toBeDefined();
    const [, , options] = (client.call as any).mock.calls[0];
    expect(options.data.tune_for_category).toBe("HOUSING");
  });

  it("createAdset still rejects a fine-grained geo violation even under tune_for_category", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(
      actions.createAdset({
        campaignId: "1", name: "Test",
        targeting: { geo_locations: { zips: [{ key: "90210" }] } },
        optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS",
        specialAdCategories: ["HOUSING"], useTuneForCategory: true,
      })
    ).rejects.toThrow(ComplianceError);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("createAdset with a non-restricted category doesn't validate targeting at all", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(
      actions.createAdset({
        campaignId: "1", name: "Test", targeting: { age_min: 25, genders: [1] },
        optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS",
      })
    ).resolves.toBeDefined();
  });
});

describe("MetaActions — creative", () => {
  it("createAdCreative requires a configured page id", async () => {
    const client = makeFakeClient({ pageId: undefined });
    const actions = new MetaActions(client);
    await expect(
      actions.createAdCreative({ name: "n", imageHash: "h", headline: "h", primaryText: "p", linkUrl: "https://x.com" })
    ).rejects.toThrow(/META_PAGE_ID/);
  });

  it("uploadImage rejects an invalid image before ever calling Meta", async () => {
    const client = makeFakeClient();
    const actions = new MetaActions(client);
    await expect(actions.uploadImage("bad.png", Buffer.from("not an image"))).rejects.toThrow();
    expect(client.uploadImageFile).not.toHaveBeenCalled();
  });
});
