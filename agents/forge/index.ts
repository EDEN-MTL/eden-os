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
 *   - Act: pause/resume, budget changes, creating a campaign or ad set.
 *     Every write goes through ActionExecutor.executeManual — the same
 *     audited path a human clicking a button in the dashboard would use.
 *     Jacob asking IS the approval; there's no separate confirmation step,
 *     same as the executor's own doc comment says for the dashboard case.
 *   - NOT wired: generating/uploading creative and attaching it to an ad.
 *     That pipeline (Gemini image gen -> Meta upload -> ad creative -> ad)
 *     is real and tested (agents/forge/creative/*.ts, ads/actions.ts) but
 *     pointless to expose here until chat can actually show Jacob the
 *     image — neither the dashboard panel nor Slack renders one today.
 *     Wiring it before that would mean Forge creating real ad objects
 *     around creative nobody reviewed. Fix the display gap first.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { BaseAgent } from "../base-agent";
import { ToolDef } from "../../shared/claude";
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

async function requireExecutor(clientId: string): Promise<ActionExecutor> {
  const cfg = await getMetaConfig(clientId);
  if (!cfg) {
    throw new Error(
      `No Meta ad account configured for client "${clientId}". Known clients are listed by the list_clients tool.`
    );
  }
  const client = new MetaClient(cfg);
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
    name: "create_adset",
    description:
      "Create a new ad set under an existing campaign. Always lands PAUSED. Targeting fields not covered here (radius targeting, custom audiences) exist on the account — ask if you need something this schema doesn't expose rather than guessing at the shape.",
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
          description: "Meta targeting spec subset: age_min, age_max, genders ([1]=male [2]=female), geo_locations.zips or geo_locations.custom_locations ({radius, distance_unit, country}).",
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
      "You are Forge, EDEN's all-in-one media buyer. You have real, live tool access to Meta ad performance data, attribution, and the ability to pause/resume, change budgets, and create new campaigns and ad sets — you are not guessing or speaking in the abstract, you are looking at and acting on the actual account.",
      `Known clients: ${clients}. Call list_clients if a client is mentioned that isn't in that list, or ask Jacob which client he means if it's genuinely ambiguous — never assume.`,
      "When Jacob asks you to do something that spends money or changes a live account (pause, resume, budget change, creating a campaign/ad set), just do it via the tool — him asking in this conversation is the approval, there's no separate confirmation step to wait for. New campaigns and ad sets always land PAUSED regardless, so nothing goes live from this alone.",
      "You do NOT yet have a way to generate or attach creative (images/ad copy) to an ad through this chat — that pipeline exists but isn't wired here because chat can't display an image back to Jacob for review yet. If asked to build creative, say so plainly and point to the existing image-generation workflow instead of pretending to do it.",
      "Cite real numbers from your tool calls, not estimates. If a tool call fails or a client has no Meta account configured, say that plainly rather than inventing a plausible-sounding answer.",
      "Respond concisely, like a sharp media buyer texting a client back — not a report.",
    ].join("\n\n");
  }

  protected getTools(): ToolDef[] {
    return TOOLS;
  }

  protected async executeTool(name: string, input: any): Promise<string> {
    switch (name) {
      case "list_clients":
        return JSON.stringify(listClientConfigs());

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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

export const forgeAgent = new ForgeAgent();
