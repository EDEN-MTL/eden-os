/**
 * Turns a CampaignHealthReport into the daily Slack message Forge posts to
 * Eden's internal ops channel (shared/scheduler runDailyForgeHealthReport).
 *
 * Written to be read on a phone in 20 seconds. Mark, 2026-11-16: "stop the redundant information and the
 * cluttered format". Real posts said the same win three times (the campaign, its ad set and its ad, each with
 * the same leads, the same CPL and a near-identical instruction), printed the same advice under every ad, listed
 * every name a second time under "first launched", and repeated the same two target blocks every day.
 *
 * So: items of one verdict are grouped as a tree (campaign, then the ad sets and ads under it) and each
 * line carries only its own numbers; the instruction is said once per section; the launch date sits on the line
 * of the thing it dates (the top line of a tree also gives the dates of what it sits in); goals and turn-off
 * lines are one line per funnel at the bottom.
 *
 * Pure, so the exact wording is unit-testable without Slack.
 */
import type { CampaignHealthReport, EntityHealth, FunnelSummary } from "./health";
import { slackLink } from "./links";
import { formatLaunch, type CreatedChain } from "./age";

/** Whole dollars: cents on a $30 CPL are noise on a phone. */
function money(n: number): string {
  return `$${n.toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;
}

const SCOPE_LABEL: Record<EntityHealth["scope"], string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad" };
const SCOPE_RANK: Record<EntityHealth["scope"], number> = { campaign: 0, adset: 1, ad: 2 };

function funnelLabel(f: string): string {
  return f === "account" ? "Other campaigns" : `${f[0].toUpperCase()}${f.slice(1)}s`;
}

/** One line per funnel: its goal and the two lines Forge acts on. */
function targetLine(f: FunnelSummary): string {
  const basis = f.targetSource === "auto" ? " (their recent average)" : f.targetSource === "config" ? "" : " (not enough history, using the alert cap)";
  return `• *${funnelLabel(f.funnel)}* ${money(f.targetCpl)}/lead${basis}: turn off at ${money(f.killNoLeadSpend)} with no leads or ${money(f.killCpl)}+/lead · scale at ≤${money(f.scaleCpl)} with ${f.scaleMinLeads}+ leads`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What the numbers say, once, without repeating the goal (it is in the footer) or the verdict (it is the section). */
function stat(e: EntityHealth, root: boolean): string {
  const { spend, lead_count: leads, cpl, frequency, active_days } = e.metrics;
  const perLead = cpl !== null ? `${money(cpl)}/lead` : null;
  switch (e.verdict) {
    case "scale": {
      const under = root && cpl !== null && e.targetCpl > 0 ? ` · ${Math.round((1 - cpl / e.targetCpl) * 100)}% under goal` : "";
      return `${plural(leads, "lead")}${perLead ? ` · ${perLead}` : ""}${under}`;
    }
    case "kill":
      return leads === 0 ? `${money(spend)} spent, no leads` : `${perLead} · ${money(spend)} spent · ${plural(leads, "lead")}`;
    case "refresh_creative":
      return `seen ${frequency?.toFixed(1) ?? "?"}× per person${perLead ? ` · ${perLead}` : ""} · ${plural(leads, "lead")}`;
    case "watch": {
      const near = e.reasons.find((r) => r.startsWith("Close to the kill line"));
      const base = leads === 0 ? `${money(spend)} spent, no leads yet` : `${perLead} · ${money(spend)} spent · ${plural(leads, "lead")}`;
      return near ? `${base} · ${near.replace("Close to the kill line: ", "close to the turn-off line, ")}` : base;
    }
    default:
      // Too new to scale but already under goal.
      return `${plural(leads, "lead")}${perLead ? ` · ${perLead}` : ""} in ${plural(active_days, "day")}`;
  }
}

/**
 * "launched Nov 2", plus the dates of anything it sits in that is not already a line above it in the tree:
 * "(ad set Sep 17, campaign Jul 31)". A line nested under its own ad set and campaign gets just its own date.
 */
function launched(e: EntityHealth, shownAbove: Set<string>, now: Date): string {
  const chain: CreatedChain = e.created ?? {};
  const own = chain[e.scope];
  if (!own) return "";
  const above: Array<[string, number | undefined]> = [];
  if (e.scope === "ad" && !shownAbove.has(e.adsetId ?? "")) above.push(["ad set", chain.adset]);
  if (e.scope !== "campaign" && !shownAbove.has(e.campaignId ?? "")) above.push(["campaign", chain.campaign]);
  const parents = above.flatMap(([label, at]) => (at ? [`${label} ${formatLaunch(at, now)}`] : []));
  return ` · launched ${formatLaunch(own, now)}${parents.length ? ` (${parents.join(", ")})` : ""}`;
}

/** A name that cannot break Slack's bold or link markup. */
const cleanName = (e: EntityHealth) => (e.name ?? e.id).replace(/\*/g, "");

interface Node {
  entity: EntityHealth;
  children: Node[];
}

/** Nests each item under the nearest of its own ad set / campaign that is in the same list. */
function buildTree(items: EntityHealth[]): Node[] {
  const nodes = new Map(items.map((e) => [e.id, { entity: e, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const e = node.entity;
    const parent =
      e.scope === "ad" ? (nodes.get(e.adsetId ?? "") ?? nodes.get(e.campaignId ?? "")) : e.scope === "adset" ? nodes.get(e.campaignId ?? "") : undefined;
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  return roots;
}

function renderNode(node: Node, depth: number, shownAbove: Set<string>, now: Date): string[] {
  const e = node.entity;
  const indent = depth === 0 ? "" : `${"   ".repeat(depth)}↳ `;
  const line = `${indent}${SCOPE_LABEL[e.scope]} *${slackLink(e.url ?? null, cleanName(e))}* — ${stat(e, depth === 0)}${launched(e, shownAbove, now)}`;
  const nowAbove = new Set([...shownAbove, e.id]);
  return [line, ...node.children.flatMap((child) => renderNode(child, depth + 1, nowAbove, now))];
}

/**
 * The instruction for a section, said once. Each distinct recommendation appears one time (campaign's first), and an
 * ad set's "budget lives at the campaign" note is dropped when its campaign is in the section with the real instruction.
 */
function adviceFor(items: EntityHealth[]): string[] {
  const campaignsListed = new Set(items.filter((e) => e.scope === "campaign").map((e) => e.id));
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])
    .filter((e) => !(e.scope === "adset" && e.recommendation.startsWith("Budget lives at the campaign") && campaignsListed.has(e.campaignId ?? "")))
    .map((e) => e.recommendation)
    .filter((r) => (seen.has(r) ? false : (seen.add(r), true)))
    .map((r) => `→ ${r}`);
}

function section(title: string, items: EntityHealth[], withAdvice: boolean, now: Date): string[] {
  if (items.length === 0) return [];
  const roots = buildTree(items).sort((a, b) => b.entity.metrics.spend - a.entity.metrics.spend);
  return ["", title, ...roots.flatMap((n) => renderNode(n, 0, new Set(), now)), ...(withAdvice ? adviceFor(items) : [])];
}

export function formatHealthDigest(clientName: string, report: CampaignHealthReport, now: Date = new Date()): string {
  const by = (v: EntityHealth["verdict"]) => report.entities.filter((e) => e.verdict === v);
  const { totals, dailyBudget } = report;

  const cpl = totals.cpl !== null ? ` · ${money(totals.cpl)}/lead` : "";
  const budget = dailyBudget.current !== null ? ` · ${money(dailyBudget.current)}/day${dailyBudget.cap !== null ? ` (cap ${money(dailyBudget.cap)})` : ""}` : "";
  const leadNote = totals.leadSource === "meta" ? " (Meta's count)" : "";
  const header = [`📊 *Forge daily ad health · ${clientName}*`, `Last ${report.lookbackDays} days: ${money(totals.spend)} spent · ${totals.leads} leads${leadNote}${cpl}${budget}`];

  const actionable = by("kill").length + by("refresh_creative").length + by("scale").length;
  const promising = by("too_early").filter((e) => e.metrics.cpl !== null && e.metrics.cpl <= e.targetCpl);

  const body = [
    ...section("🔴 *Turn off*", by("kill"), true, now),
    ...section("🎨 *Needs new creative*", by("refresh_creative"), true, now),
    ...section("🟢 *Scale*", by("scale"), true, now),
    ...section("🟡 *Watch*", by("watch"), true, now),
    ...section("✨ *Promising, too new to scale*", promising, false, now),
  ];
  if (actionable === 0) body.unshift("", "✅ *Nothing to turn off or scale today.*");

  const quiet = [
    report.counts.healthy ? `${report.counts.healthy} healthy` : null,
    report.counts.too_early ? `${report.counts.too_early} too early to judge` : null,
  ].filter(Boolean);

  return [
    ...header,
    ...body,
    ...(quiet.length ? ["", `Also running: ${quiet.join(" · ")}`] : []),
    "",
    ...report.funnels.map(targetLine),
    ...(report.liveStateError ? ["", `⚠️ Couldn't read live status from Meta (${report.liveStateError}). Paused items may be included.`] : []),
  ].join("\n");
}
