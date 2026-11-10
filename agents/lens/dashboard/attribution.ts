/**
 * Closed-deal attribution: follows the chain ad campaign -> lead -> appointment -> attended -> closed deal -> revenue
 * and says, at every step, how much of it is CONFIRMED to come from ads, how much only partly, and how much unknown.
 *
 * Nothing here has its own rules. Each confirmed / partial / unknown column is the same computeMetrics run on only
 * that group's leads, so the columns add up to the totals with nothing counted twice, and the numbers match the KPI
 * cards. The closed-deal ledger lists every deal behind the totals, with the evidence for its attribution, so a
 * reader can check any number by hand.
 */
import { attributionOf, Attribution, computeMetrics, LeadRow, MetricsInput, pipelineStatus } from "./metrics";
import { inRange } from "./ranges";

export interface ChainStep {
  id: "leads" | "booked" | "attended" | "closed" | "revenue";
  label: string;
  unit: "count" | "currency";
  total: number | null;
  confirmed: number | null;
  partial: number | null;
  unknown: number | null;
}

export interface DealRow {
  contactId: string;
  name: string | null;
  leadDate: string;
  closedDate: string;
  daysToClose: number | null;
  value: number | null;
  attribution: Attribution;
  /** Why it was classed that way, in words. */
  evidence: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adId: string | null;
  source: string | null;
  formName: string | null;
  /** Calendar mode: the appointment dates (YYYY-MM-DD). Pipeline mode: empty; see booked / attended. */
  appointments: string[];
  booked: boolean | null;
  attended: boolean | null;
}

export interface SourceRow {
  source: string;
  leads: number;
  confirmed: number;
  partial: number;
  unknown: number;
  booked: number | null;
  closedDeals: number | null;
  revenue: number | null;
}

export interface MethodItem {
  title: string;
  text: string;
}

export interface AttributionReport {
  basis: "calendar" | "pipeline";
  /** Every lead counts as from ads for this client; confirmed / partial / unknown only says how many name a campaign. */
  allLeadsFromAds: boolean;
  ads: { spend: number | null; metaLeads: number | null };
  chain: ChainStep[];
  deals: DealRow[];
  sources: SourceRow[];
  quality: {
    closedDealsMissingValue: { contactId: string; name: string | null }[];
    closedDealsNotConfirmed: number;
    /** Earliest day we hold Meta data for this client; ad spend before it is not in these numbers. */
    metaHistoryStarts: string | null;
  };
  methodology: MethodItem[];
}

const ymd = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function attributionEvidence(lead: LeadRow, status: Attribution, campaignName: string | null): string {
  if (status === "confirmed") {
    const parts = [`Meta campaign ID ${lead.campaignId}${campaignName ? ` (${campaignName})` : ""}`];
    if (lead.adsetId) parts.push(`ad set ${lead.adsetId}`);
    if (lead.adId) parts.push(`ad ${lead.adId}`);
    return parts.join(", ");
  }
  if (status === "partial") {
    if (lead.campaignId) return `Only a typed campaign label ("${lead.campaignId}"), no Meta campaign ID`;
    return `Source is ${lead.source ?? "Facebook"} but no campaign ID was kept`;
  }
  return "No campaign or ad source recorded on the lead";
}

/** The rules, in plain words, shared by the page and the PDF. */
export function methodology(basis: "calendar" | "pipeline", metaHistoryStarts: string | null, allLeadsFromAds = false): MethodItem[] {
  const items = baseMethodology(basis, metaHistoryStarts);
  if (!allLeadsFromAds) return items;
  // The client's rule changes what "counted as from ads" means, so the two rules that spoke of leaving leads out are reworded.
  return items.map((m) =>
    m.title === "What confirms a lead came from an ad"
      ? { title: "What counts as from ads, and what names the campaign", text: "For this client every lead counts as coming from ads, so every lead, appointment and closed deal is in the cards, ROAS and cost per closed deal. A lead is confirmed when its record carries a real Meta campaign ID, the long number Meta's own tracking writes onto the lead (with the ad set and ad IDs when present). Only confirmed leads can be placed on a campaign in the campaign table." }
      : m.title === "Partial and unknown"
        ? { title: "Partial and unknown", text: "Partial means the evidence points at Meta but does not name the campaign: a campaign label someone typed into a link, or a Facebook / paid-social source with no campaign ID kept. Unknown means nothing is recorded (phone calls, referrals, manual entries). Both still count as from ads for this client; they are shown in their own columns, and in the campaign table as one row of revenue not tied to a campaign." }
        : m.title === "Known limits"
          ? { title: m.title, text: m.text.replace("Leads with no campaign ID cannot be traced to an ad. ", "Leads with no campaign ID count as from ads but cannot be placed on a campaign. ") }
          : m
  );
}

function baseMethodology(basis: "calendar" | "pipeline", metaHistoryStarts: string | null): MethodItem[] {
  return [
    {
      title: "The chain",
      text: "Ad campaign, then lead, then appointment booked, then attended, then closed deal, then revenue. Every step counts a person once: a lead is one GHL contact, and one contact is never counted twice in the same step.",
    },
    {
      title: "What confirms a lead came from an ad",
      text: "The lead record carries a real Meta campaign ID, the long number Meta's own tracking writes onto the lead (with the ad set and ad IDs when present). Confirmed leads are the only ones counted as from ads in the cards, ROAS, cost per closed deal and the campaign table.",
    },
    {
      title: "Partial and unknown",
      text: "Partial means the evidence points at Meta but does not prove the campaign: a campaign label someone typed into a link, or a Facebook / paid-social source with no campaign ID kept. Unknown means nothing is recorded (phone calls, referrals, manual entries). Neither is ever counted as from ads, and both are shown in their own column so nothing is hidden.",
    },
    {
      title: "Which period each number belongs to",
      text:
        `Leads: the day the contact was created. Appointments: ${basis === "pipeline" ? "counted from the card stage and tags of the leads that arrived in the period, because this client records appointments by moving cards, so they follow the lead's arrival date" : "booked appointments by the day they were booked; confirmed, attended and no-show by the day they were scheduled"}. Closed deals: the day the card moved into the closed stage, whenever the lead arrived. Ad spend: Meta's own day.`,
    },
    {
      title: "Revenue",
      text: "Only the deal value recorded in GHL on the closed deal. A closed deal with no value adds nothing to revenue and is listed under 'closed deals missing a value'. Nothing is estimated.",
    },
    {
      title: "No double counting",
      text: "Each contact has one opportunity in the client's pipeline as synced from GHL. Cancelled, invalid and deleted appointments are ignored. A rescheduled appointment is the same GHL record, so it counts once, and a lead with several appointments counts once in the lead-level rates.",
    },
    {
      title: "Known limits",
      text:
        `Deals close weeks or months after the ad ran, so a period's ROAS pairs this period's spend with this period's closed deals, whichever month those leads arrived. Leads with no campaign ID cannot be traced to an ad. No lead carries a Facebook click ID, so attribution relies on campaign IDs. ${metaHistoryStarts ? `We hold Meta spend from ${metaHistoryStarts}; earlier spend is not in these figures.` : "No Meta spend history is held for this client."}` +
        (basis === "pipeline" ? " Appointment counts are by where each lead stands now, so a booked lead later moved to Not Interested is no longer counted as booked." : ""),
    },
  ];
}

export function computeAttribution(input: MetricsInput & { metaHistoryStarts?: string | null }): AttributionReport {
  const known = input.knownCampaignIds ?? new Set(input.meta.map((r) => r.campaignId));
  const total = computeMetrics(input);
  const basis = total.detail.appointmentBasis;
  const statusOf = (l: LeadRow) => attributionOf(l, known);

  const subset = (leads: LeadRow[]) => {
    const contacts = new Set(leads.map((l) => l.contactId));
    return computeMetrics({ ...input, meta: [], leads, appointments: input.appointments.filter((a) => a.contactId && contacts.has(a.contactId)), sources: { meta: false, appointments: input.sources?.appointments ?? true } }).kpis;
  };
  const groups: Record<Attribution, ReturnType<typeof subset>> = {
    confirmed: subset(input.leads.filter((l) => statusOf(l) === "confirmed")),
    partial: subset(input.leads.filter((l) => statusOf(l) === "partial")),
    unknown: subset(input.leads.filter((l) => statusOf(l) === "unknown")),
  };
  const step = (id: ChainStep["id"], label: string, unit: ChainStep["unit"], key: "totalLeads" | "appointmentsBooked" | "attendedAppointments" | "closedDeals" | "revenueAll"): ChainStep => ({
    id,
    label,
    unit,
    total: total.kpis[key].value,
    confirmed: groups.confirmed[key].value,
    partial: groups.partial[key].value,
    unknown: groups.unknown[key].value,
  });
  const chain = [
    step("leads", "Leads created", "count", "totalLeads"),
    step("booked", "Appointments booked", "count", "appointmentsBooked"),
    step("attended", "Appointments attended", "count", "attendedAppointments"),
    step("closed", "Deals closed", "count", "closedDeals"),
    step("revenue", "Revenue recorded", "currency", "revenueAll"),
  ];

  // ── The closed deals behind the totals, one row each ──
  const names = input.campaignNames ?? new Map<string, string>();
  const closedStages = input.config.closedStages.map((s) => s.trim().toLowerCase());
  const closed = closedStages.length
    ? input.leads.filter((l) => closedStages.includes(String(l.stage ?? "").trim().toLowerCase()) && inRange(l.closedAt, input.range, input.timeZone))
    : [];
  const pipelineMode = basis === "pipeline" && input.config.pipeline;
  const deals: DealRow[] = closed
    .map((l) => {
      const status = statusOf(l);
      const appts = input.appointments.filter((a) => a.contactId === l.contactId && !["cancelled", "invalid", "deleted"].includes(a.status));
      const flags = pipelineMode ? pipelineStatus(l, input.config.pipeline!) : null;
      const leadDay = ymd(l.createdAt, input.timeZone);
      const closedDay = l.closedAt ? ymd(l.closedAt, input.timeZone) : leadDay;
      return {
        contactId: l.contactId,
        name: l.name ?? null,
        leadDate: leadDay,
        closedDate: closedDay,
        daysToClose: l.closedAt ? Math.max(0, Math.round((l.closedAt.getTime() - l.createdAt.getTime()) / 86_400_000)) : null,
        value: l.dealValue && l.dealValue > 0 ? l.dealValue : null,
        attribution: status,
        evidence: attributionEvidence(l, status, l.campaignId ? names.get(l.campaignId) ?? l.campaignLabel ?? null : null),
        campaignId: status === "confirmed" ? l.campaignId : null,
        campaignName: l.campaignId ? names.get(l.campaignId) ?? l.campaignLabel ?? null : l.campaignLabel ?? null,
        adsetId: l.adsetId ?? null,
        adId: l.adId ?? null,
        source: l.source ?? null,
        formName: l.formName ?? null,
        appointments: pipelineMode ? [] : appts.map((a) => ymd(a.start, input.timeZone)).sort(),
        booked: flags ? flags.booked : appts.length > 0,
        attended: flags ? flags.attended : appts.some((a) => a.status === "attended"),
      };
    })
    .sort((a, b) => b.closedDate.localeCompare(a.closedDate) || (b.value ?? 0) - (a.value ?? 0));

  // ── By original lead source ──
  const label = (l: LeadRow) => (l.source ? l.source.split(" / ")[0].trim() || "(none)" : "(none)");
  const inPeriod = input.leads.filter((l) => inRange(l.createdAt, input.range, input.timeZone) || closed.includes(l));
  const bySource = new Map<string, LeadRow[]>();
  for (const l of inPeriod) bySource.set(label(l), [...(bySource.get(label(l)) ?? []), l]);
  const sources: SourceRow[] = [...bySource.entries()]
    .map(([source, leads]) => {
      const k = subset(leads);
      const created = leads.filter((l) => inRange(l.createdAt, input.range, input.timeZone));
      return {
        source,
        leads: created.length,
        confirmed: created.filter((l) => statusOf(l) === "confirmed").length,
        partial: created.filter((l) => statusOf(l) === "partial").length,
        unknown: created.filter((l) => statusOf(l) === "unknown").length,
        booked: k.appointmentsBooked.value,
        closedDeals: k.closedDeals.value,
        revenue: k.revenueAll.value,
      };
    })
    .filter((r) => r.leads > 0 || (r.closedDeals ?? 0) > 0)
    .sort((a, b) => b.leads - a.leads);

  const metaHistoryStarts = input.metaHistoryStarts ?? null;
  return {
    basis,
    ads: { spend: total.kpis.spend.value, metaLeads: total.kpis.metaLeads.value },
    chain,
    deals,
    sources,
    quality: {
      closedDealsMissingValue: deals.filter((d) => d.value === null).map((d) => ({ contactId: d.contactId, name: d.name })),
      closedDealsNotConfirmed: deals.filter((d) => d.attribution !== "confirmed").length,
      metaHistoryStarts,
    },
    allLeadsFromAds: total.detail.allLeadsFromAds,
    methodology: methodology(basis, metaHistoryStarts, total.detail.allLeadsFromAds),
  };
}
