/**
 * Forge, wired to the real ad engine.
 *
 * Before this, Forge-in-chat and Forge-the-ad-engine were two unconnected
 * things: this class was a bare system prompt with no tool access, while
 * the actual Meta performance data, attribution, and campaign/adset/ad
 * creation lived in agents/forge/ads/*.ts, only ever called from scripts.
 * Talking to Forge got you a plausible-sounding guess, never a real
 * number or a real action.
 *
 * Scope of what's wired here, and what isn't yet:
 *   - Read: performance metrics, attribution, pending rule-engine actions.
 *   - Act: pause/resume, budget changes, creating a campaign, ad set, ad
 *     creative, or ad. Every write goes through ActionExecutor.executeManual
 *     — the same audited path a human clicking a button in the dashboard
 *     would use. Jacob asking IS the approval; there's no separate
 *     confirmation step, same as the executor's own doc comment says for
 *     the dashboard case.
 *   - Creative comes from an image Jacob attaches to the chat message
 *     itself (upload_ad_image reads it off the turn's attachment, not off
 *     tool_use JSON — there's no way to inline file bytes into a tool
 *     call), NOT from Forge generating one. The Gemini generate-and-review
 *     pipeline (agents/forge/creative/*.ts) is a separate, still-unwired
 *     piece — this is "Jacob already has a finished image, get it live,"
 *     not "make me an image."
 *   - Every create_* tool (campaign, adset, ad) always lands PAUSED —
 *     automation never puts something unreviewed live.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { Attachment, ToolDef } from "../../shared/claude";
import { getMetaConfig, MetaClient } from "../../shared/meta";
import { computeMetrics } from "./ads/metrics";
import { attributionReport } from "./ads/attribution";
import * as queue from "./ads/queue";
import { MetaActions } from "./ads/actions";
import { ActionExecutor } from "./ads/executor";
import { RuleScope } from "./ads/types";

interface ClientSummary {
  clientId: string;
  clientName: string;
  industry?: string;
}

function listClientConfigs(): ClientSummary[] {
  const dir = join(process.cwd(), "config", "clients");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      return { clientId: raw.clientId, clientName: raw.clientName, industry: raw.industry };
    });
}

async function requireMetaClient(clientId: string): Promise<MetaClient> {
  const cfg = await getMetaConfig(clientId);
  if (!cfg) {
    throw new Error(
      `No Meta ad account configured for client "${clientId}". Known clients are listed by the list_clients tool.`
    );
  }
  return new MetaClient(cfg);
}

async function requireExecutor(clientId: string): Promise<ActionExecutor> {
  const client = await requireMetaClient(clientId);
  return new ActionExecutor(new MetaActions(client), clientId);
}

const TOOLS: ToolDef[] = [
  {
    name: "list_clients",
    description: "List every client this system knows about, by clientId. Call this first if you're not sure which clientId to use.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_ad_performance",
    description:
      "Real Meta ad performance for one client, rolled up to campaign, ad set, or ad level, over a trailing lookback window. Returns spend, impressions, clicks, CTR/CPC, plus attributed leads/won-deals/revenue/CPL/ROAS joined in from the CRM. Sorted by spend descending, capped at the top 15 entities.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "e.g. \"eden\" or \"3-percent-east-coast\" — call list_clients if unsure." },
        scope: { type: "string", enum: ["campaign", "adset", "ad"] },
        lookbackDays: { type: "integer", description: "Defaults to 7 if omitted." },
      },
      required: ["clientId", "scope"],
    },
  },
  {
    name: "get_attribution_report",
    description:
      "Per-ad spend, leads, won deals, revenue, CPL and ROAS for one client over an explicit date range. Use for questions like \"how did last month go\" where a rolling lookback window isn't the right frame.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        since: { type: "string", description: "YYYY-MM-DD, inclusive." },
        until: { type: "string", description: "YYYY-MM-DD, inclusive." },
      },
      required: ["clientId", "since", "until"],
    },
  },
  {
    name: "list_pending_actions",
    description: "Actions the automated rules engine has proposed for one client and is holding for approval (or already auto-executed). Useful context before you make your own recommendation.",
    input_schema: {
      type: "object",
      properties: { clientId: { type: "string" } },
      required: ["clientId"],
    },
  },
  {
    name: "pause_entity",
    description: "Pause a campaign, ad set, or ad. Executes immediately and is audited — you asking on Jacob's behalf in this conversation IS the approval, same as him clicking pause in the dashboard.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        entityType: { type: "string", enum: ["campaign", "adset", "ad"] },
        entityId: { type: "string" },
        entityName: { type: "string", description: "For a clean audit-log entry; optional." },
      },
      required: ["clientId", "entityType", "entityId"],
    },
  },
  {
    name: "resume_entity",
    description: "Resume (un-pause) a campaign, ad set, or ad. Same immediate-execution/audit behavior as pause_entity.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        entityType: { type: "string", enum: ["campaign", "adset", "ad"] },
        entityId: { type: "string" },
        entityName: { type: "string" },
      },
      required: ["clientId", "entityType", "entityId"],
    },
  },
  {
    name: "adjust_budget_percent",
    description: "Change a campaign's or ad set's daily budget by a relative percentage (e.g. +25 to scale up, -20 to cut back). Executes immediately.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        entityType: { type: "string", enum: ["campaign", "adset"] },
        entityId: { type: "string" },
        entityName: { type: "string" },
        percent: { type: "number", description: "Positive to increase, negative to decrease." },
        maxDailyBudgetCents: { type: "integer", description: "Ceiling when increasing. Optional." },
        minDailyBudgetCents: { type: "integer", description: "Floor when decreasing. Defaults to 100 (i.e. $1)." },
      },
      required: ["clientId", "entityType", "entityId", "percent"],
    },
  },
  {
    name: "set_daily_budget",
    description: "Set a campaign's or ad set's daily budget to an exact amount. Executes immediately.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        entityType: { type: "string", enum: ["campaign", "adset"] },
        entityId: { type: "string" },
        entityName: { type: "string" },
        dailyBudgetCents: { type: "integer", description: "e.g. 5000 for a $50.00/day budget." },
      },
      required: ["clientId", "entityType", "entityId", "dailyBudgetCents"],
    },
  },
  {
    name: "create_campaign",
    description:
      "Create a new Meta campaign. Always lands PAUSED — automation never puts a fresh, unreviewed campaign live, a human has to activate it in Meta Ads Manager or by asking you to resume it explicitly once they've checked it over.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        name: { type: "string" },
        objective: { type: "string", description: "A Meta campaign objective, e.g. \"OUTCOME_LEADS\"." },
        dailyBudgetCents: { type: "integer", description: "Omit for a campaign-budget-optimization (CBO) campaign where budget lives at the ad set level instead." },
        specialAdCategories: {
          type: "array",
          items: { type: "string", enum: ["HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES", "NONE"] },
          description: "Real estate lead gen is HOUSING — this changes what targeting Meta allows. Ask if you don't already know the client's category.",
        },
      },
      required: ["clientId", "name", "objective"],
    },
  },
  {
    name: "search_ad_regions",
    description:
      "Resolves a free-text place name (e.g. \"Texas\", \"Miami\") into the numeric {key, name, type, country_code} Meta requires for geo_locations.regions/cities/zips in create_adset — a bare place name is not a valid targeting value on its own. Call this once per place before building state/city-level targeting, and use the returned key verbatim.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        queryText: { type: "string", description: "Free-text place name, e.g. \"Texas\"." },
        locationType: { type: "string", enum: ["country", "region", "city", "zip"], description: "Defaults to \"region\" (US states)." },
      },
      required: ["clientId", "queryText"],
    },
  },
  {
    name: "create_adset",
    description:
      "Create a new ad set under an existing campaign. Always lands PAUSED. For state/city-level targeting, call search_ad_regions first to resolve names into keys — Meta rejects bare place names. Targeting fields not covered here (custom audiences) exist on the account — ask if you need something this schema doesn't expose rather than guessing at the shape.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        campaignId: { type: "string" },
        name: { type: "string" },
        optimizationGoal: { type: "string", description: "e.g. \"LEAD_GENERATION\", \"OFFSITE_CONVERSIONS\"." },
        billingEvent: { type: "string", description: "e.g. \"IMPRESSIONS\"." },
        dailyBudgetCents: { type: "integer", description: "Omit entirely if the parent campaign is CBO — Meta rejects an ad-set budget alongside one." },
        targeting: {
          type: "object",
          description:
            "Meta targeting spec subset: age_min, age_max, genders ([1]=male [2]=female), geo_locations.zips, geo_locations.regions/geo_locations.cities ([{key, ...}] from search_ad_regions), or geo_locations.custom_locations ({radius, distance_unit, country}).",
          properties: {
            age_min: { type: "integer" },
            age_max: { type: "integer" },
            genders: { type: "array", items: { type: "integer" } },
            geo_locations: { type: "object" },
          },
        },
        specialAdCategories: { type: "array", items: { type: "string" }, description: "Should match the parent campaign's." },
      },
      required: ["clientId", "campaignId", "name", "optimizationGoal", "billingEvent", "targeting"],
    },
  },
  {
    name: "upload_ad_image",
    description:
      "Uploads the image attached to THIS exact message to Meta as ad creative material, validating it against Meta's image spec first, and returns an image hash. That hash is what create_ad_creative needs — this tool alone doesn't create anything visible. The image must be attached to the same message as this call; a file attached earlier in the conversation is not available here, so if nothing is attached, say so rather than guessing at a hash.",
    input_schema: {
      type: "object",
      properties: { clientId: { type: "string" } },
      required: ["clientId"],
    },
  },
  {
    name: "create_ad_creative",
    description:
      "Creates the actual ad content — image (via a hash from upload_ad_image), headline, body copy, and destination link — as a Meta ad creative object. This is not an ad by itself; pair it with create_ad. Ad creatives are immutable after creation (Meta rejects edits to anything but name/status), so a correction means creating a new one, not patching this one.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        name: { type: "string", description: "Internal label for this creative — not shown to viewers." },
        imageHash: { type: "string", description: "From a prior upload_ad_image call in this conversation." },
        headline: { type: "string", description: "Shown as the bold link title." },
        primaryText: { type: "string", description: "The main ad copy, shown above the image." },
        linkUrl: { type: "string", description: "Where a click goes — the landing page." },
        callToActionType: { type: "string", description: "e.g. LEARN_MORE, SIGN_UP, GET_QUOTE. Defaults to LEARN_MORE." },
        description: { type: "string", description: "Secondary line under the headline on feed placements. Optional." },
      },
      required: ["clientId", "name", "imageHash", "headline", "primaryText", "linkUrl"],
    },
  },
  {
    name: "create_ad",
    description: "Creates the actual ad under an ad set, pointing at a previously created ad creative. Always lands PAUSED, same as create_campaign/create_adset.",
    input_schema: {
      type: "object",
      properties: {
        clientId: { type: "string" },
        adsetId: { type: "string" },
        name: { type: "string" },
        creativeId: { type: "string", description: "From a prior create_ad_creative call." },
      },
      required: ["clientId", "adsetId", "name", "creativeId"],
    },
  },
];

class ForgeAgent extends BaseAgent {
  constructor() {
    super("forge", "Forge", "FRG");
  }

  getSystemPrompt(): string {
    const clients = listClientConfigs()
      .map((c) => `${c.clientId} (${c.clientName}${c.industry ? `, ${c.industry}` : ""})`)
      .join("; ");

    return [
      "You are Forge, EDEN's all-in-one media buyer. You have real, live tool access to Meta ad performance data, attribution, and the ability to pause/resume, change budgets, and create new campaigns, ad sets, ad creatives, and ads — you are not guessing or speaking in the abstract, you are looking at and acting on the actual account.",
      "Act like the media buyer you are, not an order-taker waiting for a fully-specified request. If Jacob hands you images and an offer but no copy, draft headline/primary text/CTA options yourself — grounded in the offer and images he's actually described, not generic filler — rather than waiting to be handed finished copy. Before building anything, run through what a real launch needs (objective and special ad category, targeting, budget structure, the creative, the landing page) and flag or ask about whatever's missing or looks off, instead of silently shipping something incomplete or refusing outright because one field wasn't spelled out. Use get_ad_performance/get_attribution_report to ground suggestions in what's actually worked for this client before, when there's history to draw on.",
      `Known clients: ${clients}. Call list_clients if a client is mentioned that isn't in that list, or ask Jacob which client he means if it's genuinely ambiguous — never assume.`,
      "When Jacob asks you to do something that spends money or changes a live account (pause, resume, budget change, creating a campaign/adset/ad), just do it via the tool — him asking in this conversation is the approval, there's no separate confirmation step to wait for. Every create_* tool always lands PAUSED regardless, so nothing goes live from this alone — he still activates it himself once he's checked it over.",
      "To get an image into a real ad: Jacob attaches the finished image to his chat message (you can't generate one yourself — that's a separate, unwired pipeline), then in order: upload_ad_image (only works on an image attached to that exact message, not one from earlier in the conversation), create_ad_creative with the resulting hash plus headline/copy/landing-page link, then create_ad with the resulting creative id under the ad set. If he hasn't attached anything and asks you to build creative, say so plainly rather than pretending to have an image.",
      "Cite real numbers from your tool calls, not estimates. If a tool call fails or a client has no Meta account configured, say that plainly rather than inventing a plausible-sounding answer.",
      "Respond concisely, like a sharp media buyer texting a client back — not a report.",
    ].join("\n\n");
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string, input: any, attachment?: Attachment): Promise<string> {
    switch (name) {
      case "list_clients":
        return JSON.stringify(listClientConfigs());

      case "search_ad_regions": {
        const client = await requireMetaClient(input.clientId);
        const results = await client.searchGeoLocations(input.queryText, [input.locationType ?? "region"]);
        return JSON.stringify(results);
      }

      case "get_ad_performance": {
        const rows = await computeMetrics(input.scope as RuleScope, input.lookbackDays ?? 7, input.clientId);
        const top = rows.sort((a, b) => b.spend - a.spend).slice(0, 15);
        return JSON.stringify({ totalEntities: rows.length, shown: top.length, rows: top });
      }

      case "get_attribution_report": {
        const rows = await attributionReport(input.since, input.until, input.clientId);
        const top = rows.sort((a, b) => b.spend - a.spend).slice(0, 20);
        return JSON.stringify({ totalAds: rows.length, shown: top.length, rows: top });
      }

      case "list_pending_actions":
        return JSON.stringify(await queue.listPending(input.clientId));

      case "pause_entity": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual("pause", input.entityType, input.entityId, input.entityName ?? null, {}, "jacob-via-chat")
        );
      }

      case "resume_entity": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual("resume", input.entityType, input.entityId, input.entityName ?? null, {}, "jacob-via-chat")
        );
      }

      case "adjust_budget_percent": {
        const executor = await requireExecutor(input.clientId);
        const actionType = input.percent >= 0 ? "increase_budget" : "decrease_budget";
        const payload =
          input.percent >= 0
            ? { percent: input.percent, max_daily_budget_cents: input.maxDailyBudgetCents }
            : { percent: input.percent, min_daily_budget_cents: input.minDailyBudgetCents ?? 100 };
        return JSON.stringify(
          await executor.executeManual(actionType, input.entityType, input.entityId, input.entityName ?? null, payload, "jacob-via-chat")
        );
      }

      case "set_daily_budget": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "set_budget", input.entityType, input.entityId, input.entityName ?? null,
            { daily_budget_cents: input.dailyBudgetCents }, "jacob-via-chat"
          )
        );
      }

      case "create_campaign": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "create_campaign", "campaign", "", input.name,
            {
              name: input.name, objective: input.objective,
              dailyBudgetCents: input.dailyBudgetCents, specialAdCategories: input.specialAdCategories,
            },
            "jacob-via-chat"
          )
        );
      }

      case "create_adset": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "create_adset", "adset", "", input.name,
            {
              campaignId: input.campaignId, name: input.name, targeting: input.targeting,
              optimizationGoal: input.optimizationGoal, billingEvent: input.billingEvent,
              dailyBudgetCents: input.dailyBudgetCents, specialAdCategories: input.specialAdCategories,
            },
            "jacob-via-chat"
          )
        );
      }

      case "upload_ad_image": {
        if (!attachment) {
          throw new Error("No image is attached to this message — attach the image file itself, then ask again in that same message.");
        }
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "upload_image", "image", "", attachment.filename ?? null,
            { filename: attachment.filename ?? `attachment.${attachment.mediaType.split("/")[1] ?? "bin"}`, file_bytes: attachment.data },
            "jacob-via-chat"
          )
        );
      }

      case "create_ad_creative": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "create_ad_creative", "creative", "", input.name,
            {
              name: input.name, imageHash: input.imageHash, headline: input.headline,
              primaryText: input.primaryText, linkUrl: input.linkUrl,
              callToActionType: input.callToActionType, description: input.description,
            },
            "jacob-via-chat"
          )
        );
      }

      case "create_ad": {
        const executor = await requireExecutor(input.clientId);
        return JSON.stringify(
          await executor.executeManual(
            "create_ad", "ad", "", input.name,
            { adset_id: input.adsetId, name: input.name, creative_id: input.creativeId },
            "jacob-via-chat"
          )
        );
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

export const forgeAgent = new ForgeAgent();
