/**
 * Turns a CampaignHealthReport into the daily Slack message Forge posts to
 * Eden's internal ops channel (shared/scheduler runDailyForgeHealthReport).
 *
 * Written to be read on a phone in 20 seconds: what to turn off, what to
 * scale, what's close to the line, and the targets behind those calls. It
 * lists every action item but only counts the "nothing to do" verdicts,
 * because a list of 11 too-early ads is noise. The exception is a too-early
 * ad that's already beating target: that's the one thing worth a look.
 *
 * Pure, so the exact wording is unit-testable without Slack.
 */
import type { CampaignHealthReport, EntityHealth, FunnelSummary } from "./health";

function money(n: number): string {
  return `$${n.toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;
}

const SCOPE_LABEL: Record<EntityHealth["scope"], string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad" };

function funnelLabel(f: string): string {
  return f === "account" ? "Other campaigns" : `${f[0].toUpperCase()}${f.slice(1)}s`;
}

function targetLine(f: FunnelSummary): string {
  const basis =
    f.targetSource === "auto" && f.basis
      ? `their ${f.basis.days}-day average, ${f.basis.leads} leads`
      : f.targetSource === "config"
        ? "set by hand"
        : "not enough history yet, using the alert cap";
  const budget =
    f.dailyBudget !== null && f.expectedLeadsPerWeek !== null
      ? ` · ${money(f.dailyBudget)}/day ≈ ${f.expectedLeadsPerWeek.toFixed(1)} leads/week`
      : "";
  return (
    `• *${funnelLabel(f.funnel)}:* ${money(f.targetCpl)}/lead (${basis})${budget}\n` +
    `   Turn off at ${money(f.killNoLeadSpend)} with no leads or ${money(f.killCpl)}+/lead · ` +
    `scale at ≤${money(f.scaleCpl)} with ${f.scaleMinLeads}+ leads`
  );
}

/** The reason that carries the actual numbers — skips the "leads are Meta's count" caveat, stated once in the header instead. */
function mainReason(e: EntityHealth): string {
  // For a too-early ad the early-results line is the point of listing it;
  // its "losing delivery to siblings" reason would bury that.
  const early = e.verdict === "too_early" ? e.reasons.find((r) => r.startsWith("Early signal is good")) : undefined;
  return early ?? e.reasons.find((r) => !r.startsWith("Leads are Meta's own count")) ?? e.reasons[0] ?? "";
}

function itemLine(e: EntityHealth, withRecommendation: boolean): string {
  const nearLine = e.reasons.find((r) => r.startsWith("Close to the kill line"));
  let line = `• ${SCOPE_LABEL[e.scope]} *${e.name ?? e.id}*: ${mainReason(e)}`;
  if (nearLine) line += ` ${nearLine}`;
  if (withRecommendation) line += `\n   → ${e.recommendation}`;
  return line;
}

function section(title: string, items: EntityHealth[], withRecommendation: boolean): string[] {
  if (items.length === 0) return [];
  return ["", `${title} (${items.length})`, ...items.map((e) => itemLine(e, withRecommendation))];
}

export function formatHealthDigest(clientName: string, report: CampaignHealthReport): string {
  const by = (v: EntityHealth["verdict"]) => report.entities.filter((e) => e.verdict === v);
  const { totals, dailyBudget } = report;

  const header = [`📊 *Forge daily ad health: ${clientName}*`];
  const cpl = totals.cpl !== null ? ` · ${money(totals.cpl)}/lead` : "";
  header.push(`Last ${report.lookbackDays} days: ${money(totals.spend)} spent · ${totals.leads} leads${cpl}`);
  if (totals.leadSource === "meta") header.push("_Lead counts are Meta's own; none are traced in GHL yet, so lead quality is unknown._");
  if (dailyBudget.current !== null) {
    const cap = dailyBudget.cap !== null ? ` of the ${money(dailyBudget.cap)} cap` : "";
    header.push(`Daily budget: ${money(dailyBudget.current)}${cap}`);
  }

  const actionable = by("kill").length + by("refresh_creative").length + by("scale").length;
  const promising = by("too_early").filter((e) => e.metrics.cpl !== null && e.metrics.cpl <= e.targetCpl);

  const body = [
    ...section("🔴 *Turn off*", by("kill"), true),
    ...section("🎨 *Needs new creative*", by("refresh_creative"), true),
    ...section("🟢 *Scale*", by("scale"), true),
    ...section("🟡 *Watch*", by("watch"), false),
    ...section("✨ *Promising, too new to scale*", promising, false),
  ];
  if (actionable === 0) body.unshift("", "✅ *Nothing to turn off or scale today.*");

  const quiet = [
    report.counts.healthy ? `${report.counts.healthy} healthy` : null,
    report.counts.too_early ? `${report.counts.too_early} too early to judge` : null,
  ].filter(Boolean);

  return [
    ...header,
    ...body,
    ...(quiet.length ? ["", `Also running: ${quiet.join(", ")}.`] : []),
    "",
    "*Targets*",
    ...report.funnels.map(targetLine),
    ...(report.liveStateError ? ["", `⚠️ Couldn't read live status from Meta (${report.liveStateError}). Paused items may be included.`] : []),
    "",
    actionable ? "Ask Forge to make any of these changes." : "No changes needed. Forge will check again tomorrow.",
  ].join("\n");
}
