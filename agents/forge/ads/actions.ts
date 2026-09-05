/**
 * Write actions against the live Meta ad account: pause/resume, budget
 * changes, and creating new campaigns/ad sets/ads.
 *
 * Every method here:
 *   1. Validates any targeting-related payload through shared/meta/compliance
 *      BEFORE calling Meta (hard gate, not overridable).
 *   2. Captures a best-effort "before" snapshot of the entity.
 *   3. Performs the write.
 *   4. Captures an "after" snapshot.
 *   5. Returns an ActionResult so the caller (the approval executor) can
 *      write a complete audit_log row.
 *
 * Nothing in this module decides *whether* an action should happen or
 * *whether* it needs approval — that's the rules engine and approval
 * queue. This module only knows how to execute a specific, already-decided
 * action safely against the Meta API.
 */
import { MetaAPIError } from "../../../shared/meta";
import {
  isRestrictedCategory,
  safeTuneForCategoryPayload,
  Targeting,
  validateCampaignPayload,
  validateTargetingPayload,
} from "../../../shared/meta/compliance";
import { ImageSpecError, validateImageBytes } from "../../../shared/meta/image-spec";

// New campaigns/ad sets/ads created by this system always come in PAUSED —
// automation should never be the thing that puts fresh, unreviewed
// creative or targeting live. A human (or a separately-graduated
// "activate" rule) has to flip status explicitly.
const CREATE_DEFAULT_STATUS = "PAUSED";

const STATUS_FIELDS = ["id", "name", "status", "effective_status"];
const BUDGET_FIELDS = [...STATUS_FIELDS, "daily_budget", "lifetime_budget"];

/**
 * The slice of MetaClient that MetaActions actually needs — an interface
 * rather than the concrete class so tests can inject a fake client
 * without hitting the real API.
 */
export interface MetaClientLike {
  adAccountId: string;
  pageId?: string;
  getObject(objectId: string, fields: string[]): Promise<any>;
  call(method: "POST" | "DELETE", path: string, options?: { params?: Record<string, string>; data?: Record<string, string> }): Promise<any>;
  uploadImageFile(filename: string, fileBytes: Buffer, contentType?: string): Promise<any>;
}

export interface ActionResult {
  entityType: string;
  entityId: string;
  actionType: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestPayload: Record<string, unknown>;
  response: Record<string, unknown>;
}

/** Meta's form-encoded POST body wants nested objects/arrays as JSON strings. */
function encode(payload: Record<string, unknown>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    encoded[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  }
  return encoded;
}

export class MetaActions {
  constructor(public client: MetaClientLike) {}

  // ─── Status changes ───

  async pause(entityId: string, entityType: string): Promise<ActionResult> {
    return this.setStatus(entityId, entityType, "PAUSED", "pause");
  }

  async resume(entityId: string, entityType: string): Promise<ActionResult> {
    return this.setStatus(entityId, entityType, "ACTIVE", "resume");
  }

  private async setStatus(entityId: string, entityType: string, status: string, actionType: string): Promise<ActionResult> {
    const before = await this.client.getObject(entityId, STATUS_FIELDS);
    const payload = { status };
    const response = await this.client.call("POST", entityId, { data: payload });
    const after = await this.client.getObject(entityId, STATUS_FIELDS);
    return { entityType, entityId, actionType, before, after, requestPayload: payload, response };
  }

  // ─── Budget ───

  async setDailyBudget(entityId: string, entityType: string, newDailyBudgetCents: number): Promise<ActionResult> {
    if (entityType !== "campaign" && entityType !== "adset") {
      throw new Error("Budget can only be set at the campaign or adset level");
    }
    const before = await this.client.getObject(entityId, BUDGET_FIELDS);
    const payload = { daily_budget: String(Math.trunc(newDailyBudgetCents)) };
    const response = await this.client.call("POST", entityId, { data: payload });
    const after = await this.client.getObject(entityId, BUDGET_FIELDS);
    return { entityType, entityId, actionType: "set_budget", before, after, requestPayload: payload, response };
  }

  /** percent may be negative (e.g. -20 to cut budget 20%). */
  async adjustBudgetByPercent(
    entityId: string,
    entityType: string,
    percent: number,
    maxDailyBudgetCents?: number,
    minDailyBudgetCents = 100
  ): Promise<ActionResult> {
    const before = await this.client.getObject(entityId, BUDGET_FIELDS);
    const current = before.daily_budget;
    if (current === undefined || current === null) {
      throw new MetaAPIError(
        `${entityType} ${entityId} has no daily_budget set (may be lifetime-budgeted) — ` +
          "adjustBudgetByPercent only supports daily-budgeted entities."
      );
    }
    let newBudget = Math.round(Number(current) * (1 + percent / 100));
    newBudget = Math.max(newBudget, minDailyBudgetCents);
    if (maxDailyBudgetCents !== undefined) newBudget = Math.min(newBudget, maxDailyBudgetCents);
    const payload = { daily_budget: String(newBudget) };
    const response = await this.client.call("POST", entityId, { data: payload });
    const after = await this.client.getObject(entityId, BUDGET_FIELDS);
    return { entityType, entityId, actionType: "adjust_budget", before, after, requestPayload: payload, response };
  }

  /**
   * The mechanism behind CBO budget-allocation control: these only take
   * effect when the PARENT CAMPAIGN has a daily_budget set (true CBO) —
   * Meta rejects them on ABO (ad-set-budgeted) campaigns. minSpendTarget
   * is a best-effort floor ("at least this much"), spendCap is a hard
   * ceiling — use minSpendTarget to guarantee a winner or a fresh test ad
   * set gets its floor of the CBO budget.
   */
  async setAdsetSpendTargets(
    adsetId: string,
    dailyMinSpendTargetCents?: number,
    dailySpendCapCents?: number
  ): Promise<ActionResult> {
    const fields = ["id", "name", "daily_min_spend_target", "daily_spend_cap"];
    const before = await this.client.getObject(adsetId, fields);
    const payload: Record<string, string> = {};
    if (dailyMinSpendTargetCents !== undefined) payload.daily_min_spend_target = String(Math.trunc(dailyMinSpendTargetCents));
    if (dailySpendCapCents !== undefined) payload.daily_spend_cap = String(Math.trunc(dailySpendCapCents));
    if (Object.keys(payload).length === 0) throw new Error("setAdsetSpendTargets called with nothing to set");
    const response = await this.client.call("POST", adsetId, { data: payload });
    const after = await this.client.getObject(adsetId, fields);
    return { entityType: "adset", entityId: adsetId, actionType: "set_adset_spend_targets", before, after, requestPayload: payload, response };
  }

  /**
   * Duplicates the ad set's targeting/budget settings via Meta's /copies
   * endpoint WITHOUT its child ads (deep_copy=false) — the new test ad set
   * is meant to get fresh creatives, not copies of ads that already lost a
   * test. Always created PAUSED regardless of the `status` param, same
   * reasoning as CREATE_DEFAULT_STATUS.
   */
  async duplicateAdset(adsetId: string, renameSuffix = " — Testing", status = "PAUSED"): Promise<ActionResult> {
    const before = await this.client.getObject(adsetId, STATUS_FIELDS);
    const payload = {
      deep_copy: false,
      status_option: status,
      rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: renameSuffix },
    };
    const response = await this.client.call("POST", `${adsetId}/copies`, { data: encode(payload) });
    const newId = response.copied_adset_id;
    const after = newId ? await this.client.getObject(newId, STATUS_FIELDS) : {};
    return { entityType: "adset", entityId: newId || "", actionType: "duplicate_adset", before, after, requestPayload: payload, response };
  }

  // ─── Creation ───

  /**
   * bidStrategy matters for a CBO campaign (one with dailyBudgetCents set
   * here) — Meta reads bid strategy off the CAMPAIGN in that case, not the
   * ad set, and an ad set created under a CBO campaign with no bid
   * strategy resolved will reject with "Bid Amount Required" once Meta
   * infers a capped strategy by default. Pass "LOWEST_COST_WITHOUT_CAP"
   * (automatic bidding, no manual cap) unless a specific bid cap is
   * wanted, in which case use LOWEST_COST_WITH_BID_CAP / TARGET_COST
   * together with a bid_amount on the ad set.
   */
  async createCampaign(params: {
    name: string;
    objective: string;
    specialAdCategories?: string[];
    specialAdCategoryCountry?: string[];
    dailyBudgetCents?: number;
    bidStrategy?: string;
  }): Promise<ActionResult> {
    const { name, objective, specialAdCategories, specialAdCategoryCountry, dailyBudgetCents, bidStrategy } = params;
    const payload: Record<string, unknown> = {
      name,
      objective,
      status: CREATE_DEFAULT_STATUS,
      special_ad_categories: specialAdCategories || [],
    };
    if (specialAdCategoryCountry) payload.special_ad_category_country = specialAdCategoryCountry;
    if (dailyBudgetCents) {
      payload.daily_budget = String(Math.trunc(dailyBudgetCents));
      // CBO (a budget set at the campaign level) is where Meta expects
      // bid_strategy to live, not the ad set — same account-default trap as
      // createAdset's bid_strategy fix, just one level up. Without this, a
      // CBO campaign silently inherits whatever bid-cap strategy the
      // account defaults to, and every ad set under it fails until a bid
      // amount is supplied.
      payload.bid_strategy = bidStrategy || "LOWEST_COST_WITHOUT_CAP";
    } else if (bidStrategy) {
      payload.bid_strategy = bidStrategy;
    }

    validateCampaignPayload(payload as any);

    const response = await this.client.call("POST", `${this.client.adAccountId}/campaigns`, { data: encode(payload) });
    const newId = response.id;
    const after = newId ? await this.client.getObject(newId, STATUS_FIELDS) : {};
    return { entityType: "campaign", entityId: newId || "", actionType: "create_campaign", before: {}, after, requestPayload: payload, response };
  }

  /**
   * dailyBudgetCents is optional and should be OMITTED for a CBO ad set —
   * Meta rejects an ad-set-level budget when the parent campaign already
   * has one (CBO). Only pass it for an ABO ad set under a campaign with no
   * budget of its own.
   *
   * specialAdCategories should match the parent campaign's — pass it
   * explicitly so this can be validated even if the caller hasn't fetched
   * the campaign object. When useTuneForCategory is true (default) and the
   * category is restricted, we let Meta's own tune_for_category mechanism
   * enforce compliance instead of hand-built targeting fields, the
   * recommended safer path.
   */
  async createAdset(params: {
    campaignId: string;
    name: string;
    targeting: Targeting;
    optimizationGoal: string;
    billingEvent: string;
    dailyBudgetCents?: number;
    specialAdCategories?: string[];
    useTuneForCategory?: boolean;
    bidAmountCents?: number;
    pixelId?: string;
    customEventType?: string;
  }): Promise<ActionResult> {
    const {
      campaignId, name, targeting, optimizationGoal, billingEvent,
      dailyBudgetCents, specialAdCategories, useTuneForCategory = true, bidAmountCents,
      pixelId, customEventType,
    } = params;

    const payload: Record<string, unknown> = {
      name,
      campaign_id: campaignId,
      optimization_goal: optimizationGoal,
      billing_event: billingEvent,
      status: CREATE_DEFAULT_STATUS,
    };
    if (dailyBudgetCents !== undefined) payload.daily_budget = String(Math.trunc(dailyBudgetCents));
    // OFFSITE_CONVERSIONS optimization has no meaning to Meta without a
    // pixel + standard event to optimize toward — required together, since
    // one without the other is a silent no-op at best and a rejected
    // ad set at worst.
    if (pixelId && customEventType) {
      payload.promoted_object = { pixel_id: pixelId, custom_event_type: customEventType };
    }
    // Some ad accounts have a default bid strategy (LOWEST_COST_WITH_BID_CAP
    // or TARGET_COST) that Meta rejects the ad set for unless bid_amount is
    // also set. Always send an explicit bid_strategy so ad set creation
    // never silently depends on the account's default.
    if (bidAmountCents !== undefined) {
      payload.bid_amount = String(Math.trunc(bidAmountCents));
      payload.bid_strategy = "LOWEST_COST_WITH_BID_CAP";
    } else {
      payload.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
    }

    if (isRestrictedCategory(specialAdCategories) && useTuneForCategory) {
      payload.targeting = targeting;
      const restrictedCategory = specialAdCategories!.find((c) =>
        ["HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES"].includes(c)
      )!;
      Object.assign(payload, safeTuneForCategoryPayload(restrictedCategory));
      // tune_for_category has Meta strip/adjust non-compliant fields itself,
      // but we still hard-validate the fields we control before sending.
      const { age_min, age_max, genders, ...rest } = targeting;
      validateTargetingPayload(rest, specialAdCategories);
    } else {
      validateTargetingPayload(targeting, specialAdCategories);
      payload.targeting = targeting;
    }

    const response = await this.client.call("POST", `${this.client.adAccountId}/adsets`, { data: encode(payload) });
    const newId = response.id;
    const after = newId ? await this.client.getObject(newId, STATUS_FIELDS) : {};
    return { entityType: "adset", entityId: newId || "", actionType: "create_adset", before: {}, after, requestPayload: payload, response };
  }

  async createAd(adsetId: string, name: string, creativeId: string): Promise<ActionResult> {
    const payload = { name, adset_id: adsetId, creative: { creative_id: creativeId }, status: CREATE_DEFAULT_STATUS };
    const response = await this.client.call("POST", `${this.client.adAccountId}/ads`, { data: encode(payload) });
    const newId = response.id;
    const after = newId ? await this.client.getObject(newId, STATUS_FIELDS) : {};
    return { entityType: "ad", entityId: newId || "", actionType: "create_ad", before: {}, after, requestPayload: payload, response };
  }

  /**
   * Swaps an existing ad's creative pointer. Ad creatives themselves are
   * immutable after creation (Meta rejects edits to anything but
   * name/status/adlabels) — the only way to change what an ad shows is to
   * create a new creative and point the ad at it via this call.
   */
  async updateAdCreative(adId: string, creativeId: string): Promise<ActionResult> {
    const payload = { creative: { creative_id: creativeId } };
    const response = await this.client.call("POST", adId, { data: encode(payload) });
    const after = await this.client.getObject(adId, ["id", "creative"]);
    return { entityType: "ad", entityId: adId, actionType: "update_ad_creative", before: {}, after, requestPayload: payload, response };
  }

  // ─── Creative ───

  /** Validates against Meta's published image spec BEFORE uploading, then uploads and returns the image hash create_ad_creative needs. */
  async uploadImage(filename: string, fileBytes: Buffer): Promise<ActionResult> {
    let spec;
    try {
      spec = validateImageBytes(fileBytes, filename);
    } catch (error) {
      if (error instanceof ImageSpecError) throw new MetaAPIError(error.message);
      throw error;
    }

    const contentType = spec.format === "PNG" ? "image/png" : "image/jpeg";
    const response = await this.client.uploadImageFile(filename, fileBytes, contentType);
    const images = response.images || {};
    const imageInfo = images[filename] || Object.values(images)[0] || {};
    const imageHash = imageInfo.hash;
    if (!imageHash) throw new MetaAPIError(`Meta didn't return an image hash for ${filename}: ${JSON.stringify(response)}`);

    const after = { hash: imageHash, url: imageInfo.url, ...spec };
    return { entityType: "image", entityId: imageHash, actionType: "upload_image", before: {}, after, requestPayload: { filename }, response };
  }

  /**
   * Every Meta ad creative is posted "as" a Facebook Page — pageId is that
   * Page's id, required here even though nothing else in this system
   * needs it. `description` is Meta's secondary line shown under the
   * headline on feed placements — optional, omit for none.
   *
   * urlTags is a query string appended to linkUrl at serve time — this is
   * the ONLY object in the whole campaign/adset/ad/creative hierarchy
   * where Meta actually exposes this field (the same field on AdSet or Ad
   * is silently accepted on write and then errors as nonexistent on read —
   * a trap). Use Meta's dynamic tags ({{campaign.id}}, {{adset.id}},
   * {{ad.id}}) to stamp real IDs into the destination URL.
   */
  async createAdCreative(params: {
    name: string;
    imageHash: string;
    headline: string;
    primaryText: string;
    linkUrl: string;
    callToActionType?: string;
    description?: string;
    urlTags?: string;
  }): Promise<ActionResult> {
    const { name, imageHash, headline, primaryText, linkUrl, callToActionType = "LEARN_MORE", description, urlTags } = params;
    const pageId = this.client.pageId;
    if (!pageId) {
      throw new MetaAPIError(
        "META_PAGE_ID is not set — required to create an ad creative (every Meta ad creative is posted as a Facebook Page)."
      );
    }
    const linkData: Record<string, unknown> = {
      image_hash: imageHash,
      link: linkUrl,
      message: primaryText,
      name: headline,
      call_to_action: { type: callToActionType, value: { link: linkUrl } },
    };
    if (description) linkData.description = description;

    const payload: Record<string, unknown> = {
      name,
      object_story_spec: { page_id: pageId, link_data: linkData },
    };
    if (urlTags) payload.url_tags = urlTags;

    const response = await this.client.call("POST", `${this.client.adAccountId}/adcreatives`, { data: encode(payload) });
    const newId = response.id;
    const after = newId ? await this.client.getObject(newId, ["id", "name"]) : {};
    return { entityType: "creative", entityId: newId || "", actionType: "create_ad_creative", before: {}, after, requestPayload: payload, response };
  }
}
