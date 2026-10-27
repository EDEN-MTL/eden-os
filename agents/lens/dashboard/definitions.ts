/**
 * What every dashboard number means, in one place. The dashboard shows these next to the metric and the PDF
 * prints them, so nobody has to guess a denominator. Keep the wording in step with metrics.ts.
 */
export interface MetricDefinition {
  label: string;
  /** How it is calculated, in plain words, with the denominator named. */
  definition: string;
  /** Where the data comes from. */
  source: "Meta" | "GHL" | "Meta + GHL";
}

export const METRIC_DEFINITIONS = {
  spend: { label: "Ad spend", definition: "Total amount Meta spent on the client's campaigns in the period.", source: "Meta" },
  impressions: { label: "Impressions", definition: "Times the ads were shown. Added up across campaigns and days.", source: "Meta" },
  reach: {
    label: "Reach",
    definition: "Meta counts each person once per day. A longer period adds the days together, so the same person can be counted more than once and the number is higher than true unique reach.",
    source: "Meta",
  },
  clicks: { label: "Clicks", definition: "All clicks on the ads, as Meta reports them.", source: "Meta" },
  ctr: { label: "CTR", definition: "Clicks ÷ impressions × 100.", source: "Meta" },
  cpc: { label: "CPC", definition: "Ad spend ÷ clicks.", source: "Meta" },
  metaLeads: { label: "Leads (Meta)", definition: "Leads Meta itself recorded from the ads (its \"lead\" result).", source: "Meta" },
  cpl: { label: "Cost per lead", definition: "Ad spend ÷ leads Meta recorded.", source: "Meta" },

  totalLeads: { label: "Total leads (GHL)", definition: "Contacts created in GoHighLevel during the period.", source: "GHL" },
  attributedLeads: { label: "Leads with confirmed ad attribution", definition: "GHL leads created in the period that carry a real Meta campaign ID (the long number Meta writes onto the lead). Leads with only a typed campaign name, a Facebook source without a campaign, or nothing are not counted.", source: "Meta + GHL" },
  qualifiedLeads: { label: "Qualified leads", definition: "Leads created in the period that have not been marked unqualified: every lead not in a Not Qualified stage. (A client that lists its own qualified stages counts only those.)", source: "GHL" },
  unqualifiedLeads: { label: "Unqualified leads", definition: "Leads created in the period whose pipeline stage is one of the client's unqualified stages.", source: "GHL" },
  leadToAppointment: {
    label: "Lead-to-appointment rate",
    definition: "Leads created in the period that have at least one non-cancelled appointment ÷ all leads created in the period × 100. A lead with several appointments counts once.",
    source: "GHL",
  },

  appointmentsBooked: {
    label: "Appointments booked",
    definition: "Appointments created (booked) during the period, excluding cancelled, invalid and deleted ones. A rescheduled appointment is the same record, so it counts once.",
    source: "GHL",
  },
  appointmentsBookedAttributed: {
    label: "Booked from ads",
    definition: "Appointments booked in the period by leads with confirmed ad attribution. This is the count used for cost per appointment.",
    source: "Meta + GHL",
  },
  costPerAppointment: { label: "Cost per appointment booked", definition: "Ad spend ÷ appointments booked in the period by leads with confirmed ad attribution.", source: "Meta + GHL" },
  confirmedAppointments: { label: "Confirmed appointments", definition: "Appointments scheduled to occur in the period that are marked confirmed in GHL.", source: "GHL" },
  attendedAppointments: { label: "Appointments attended", definition: "Appointments scheduled in the period that are marked showed.", source: "GHL" },
  noShowAppointments: { label: "No-shows", definition: "Appointments scheduled in the period that are marked no-show.", source: "GHL" },
  showUpRate: {
    label: "Show-up rate",
    definition: "Attended ÷ appointments scheduled in the period that have already passed, × 100. Cancelled, invalid and deleted appointments are left out. Appointments with no outcome recorded stay in the denominator, so a team that does not mark outcomes will see a lower rate.",
    source: "GHL",
  },
  costPerAttended: { label: "Cost per attended appointment", definition: "Ad spend ÷ attended appointments from leads with confirmed ad attribution.", source: "Meta + GHL" },

  closedDeals: { label: "Closed deals", definition: "Deals whose pipeline card moved into the client's closed stage during the period, whether or not they came from ads.", source: "GHL" },
  closedDealsAttributed: { label: "Closed deals from ads", definition: "Closed deals (as above) from leads with confirmed ad attribution.", source: "Meta + GHL" },
  appointmentToSale: {
    label: "Appointment-to-sale rate",
    definition:
      "Of the leads with confirmed ad attribution who had an appointment scheduled in the period (and not cancelled, already passed), the share that have closed a deal to date × 100. It counts leads, so one lead with two appointments counts once, and it follows each lead forward, so it cannot pass 100%.",
    source: "Meta + GHL",
  },
  revenueAttributed: {
    label: "Revenue from ads",
    definition: "The deal value recorded in GHL on closed deals from leads with confirmed ad attribution. A closed deal with no value recorded adds nothing and is counted as missing.",
    source: "Meta + GHL",
  },
  revenueAll: { label: "Revenue, all closed deals", definition: "Deal value recorded on every closed deal in the period, from ads or not.", source: "GHL" },
  otherCosts: { label: "Other marketing costs", definition: "Costs other than ad spend that the team has entered for the period. N/A when none were entered.", source: "GHL" },
  roas: { label: "ROAS", definition: "Revenue from ads ÷ ad spend. Advertising only; not the same as ROI.", source: "Meta + GHL" },
  roi: {
    label: "Marketing ROI",
    definition: "(Revenue from ads − included marketing costs) ÷ included marketing costs × 100, where included costs are ad spend plus any other costs entered. The card says which costs were included.",
    source: "Meta + GHL",
  },
  costPerClosedDeal: { label: "Cost per closed deal", definition: "Ad spend ÷ closed deals from ads in the period.", source: "Meta + GHL" },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

/**
 * For clients whose team records appointments by moving cards and tagging contacts (no GHL calendar), the
 * appointment numbers mean something slightly different. This returns the full definition set with those
 * metrics reworded; anything else is unchanged.
 */
/**
 * For a client whose rule is that every lead came from ads (config allLeadsFromAds), the definitions say so instead of
 * "confirmed ad attribution", so the words on the page match the numbers.
 */
function forAllLeadsFromAds(defs: Record<MetricKey, MetricDefinition>): Record<MetricKey, MetricDefinition> {
  const out = {} as Record<MetricKey, MetricDefinition>;
  for (const key of Object.keys(defs) as MetricKey[]) {
    out[key] = { ...defs[key], definition: defs[key].definition.replace(/leads with confirmed ad attribution/g, "leads (every lead counts as from ads for this client)") };
  }
  out.attributedLeads = { label: "Leads counted as from ads", definition: "All GHL leads created in the period. For this client every lead counts as coming from ads; the closed-deal attribution section shows how many can also be tied to an exact Meta campaign.", source: "Meta + GHL" };
  return out;
}

export function definitionsForBasis(basis: "calendar" | "pipeline", allLeadsFromAds = false): Record<MetricKey, MetricDefinition> {
  const defs = baseDefinitions(basis);
  return allLeadsFromAds ? forAllLeadsFromAds(defs) : defs;
}

function baseDefinitions(basis: "calendar" | "pipeline"): Record<MetricKey, MetricDefinition> {
  if (basis === "calendar") return METRIC_DEFINITIONS;
  const cohort = "Counted from card stages and contact tags for leads that arrived in the period, by where they stand now (this client does not book on a GHL calendar).";
  return {
    ...METRIC_DEFINITIONS,
    leadToAppointment: { label: "Lead-to-appointment rate", definition: `Leads created in the period that have reached the booked stage or later ÷ all leads created in the period × 100. ${cohort}`, source: "GHL" },
    appointmentsBooked: { label: "Appointments booked", definition: `Leads created in the period that reached the booked stage (Appointment Set or later) or carry the booked tag. ${cohort}`, source: "GHL" },
    appointmentsBookedAttributed: { label: "Booked from ads", definition: "Booked leads (as above) with confirmed ad attribution. This is the count used for cost per appointment.", source: "Meta + GHL" },
    confirmedAppointments: { label: "Confirmed appointments", definition: "Not tracked for this client: confirmation is not recorded in the pipeline.", source: "GHL" },
    attendedAppointments: { label: "Appointments attended", definition: `Booked leads now in Showed Up or a later stage, or tagged showed up. ${cohort}`, source: "GHL" },
    noShowAppointments: { label: "No-shows", definition: `Booked leads now in the No-Show stage (and not attended). ${cohort}`, source: "GHL" },
    showUpRate: { label: "Show-up rate", definition: "Attended ÷ (attended + no-show) × 100: only appointments with a recorded outcome. Booked leads still waiting for an outcome are not in this rate.", source: "GHL" },
    appointmentToSale: { label: "Appointment-to-sale rate", definition: "Of the booked leads with confirmed ad attribution, the share that have closed a deal to date × 100.", source: "Meta + GHL" },
  } as Record<MetricKey, MetricDefinition>;
}
