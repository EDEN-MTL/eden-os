/** Shared builders for Ember's tests. Not imported by production code. */
import { EmberConfig } from "./config";
import { GhlOpportunityLite, NurtureLead } from "./types";

export const DAY = 86_400_000;
export const NOW = new Date("2026-09-23T15:00:00Z"); // 11:00 America/Toronto
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

export const STAGES: Record<string, string> = {
  s_nurture: "Long Term Nurturing",
  s_day1: "DAY 1 - AM FOLLOWUP",
  s_appt: "Appointment Set",
  s_confirmed: "Buyer Confirmed",
  s_closed: "Deal Closed",
  s_lost: "Not Qualified/Not Interested",
};

export const OUTCOME_STAGES = {
  wonStages: ["Deal Closed"],
  lostStages: ["Not Qualified/Not Interested", "No-Show"],
  activeStages: ["Buyer Confirmed", "Seller Confirmed"],
};

export function config(over: Partial<EmberConfig> = {}): EmberConfig {
  return {
    enabled: true,
    pipelineId: "p1",
    dormancyThresholdDays: 45,
    excludeStages: ["Appointment Set"],
    consentWindowDays: 180,
    renewedInterestTags: ["renewed interest"],
    alertChannel: "backend-ops",
    timezone: "America/Toronto",
    sendWindow: { startHour: 10, endHour: 19 },
    outreach: {
      senderName: "Mark's Realty",
      dailySendCap: 20,
      minSendSpacingSeconds: 90,
      jitterSeconds: 120,
      touchScheduleDays: [0, 14, 35],
      positiveKeywords: ["yes", "interested", "still looking"],
      negativeKeywords: ["no", "stop", "not interested"],
      sms: { enabled: true, templates: ["Hi {{firstName}}, it's {{senderName}}. Reply STOP to opt out.", "Touch two {{firstName}}. Reply STOP to opt out."] },
      email: { enabled: false, fromAddress: "", physicalAddress: "", templates: [] },
    },
    ...over,
  };
}

export function opp(over: Partial<GhlOpportunityLite> = {}): GhlOpportunityLite {
  return {
    id: "o1",
    status: "open",
    pipelineId: "p1",
    pipelineStageId: "s_nurture",
    contactId: "c1",
    lastStageChangeAt: daysAgo(60),
    createdAt: daysAgo(100),
    updatedAt: daysAgo(2),
    contact: { name: "Jordan Smith", phone: "+17095550100", email: "j@example.com", tags: [] },
    ...over,
  };
}

export function lead(over: Partial<NurtureLead> = {}): NurtureLead {
  return {
    id: 1,
    clientId: "eden-sub-account-one",
    ghlContactId: "c1",
    ghlOpportunityId: "o1",
    contactName: "Jordan Smith",
    phone: "+17095550100",
    email: "j@example.com",
    status: "nurturing",
    statusReason: null,
    enrolledStageId: "s_nurture",
    enrolledStageName: "Long Term Nurturing",
    lastGhlActivityAt: daysAgo(60),
    inquiryAt: daysAgo(100),
    enteredAt: daysAgo(1),
    touchCount: 0,
    lastTouchAt: null,
    nextTouchAt: daysAgo(1),
    repliedAt: null,
    reactivatedAt: null,
    unsubscribeToken: "tok",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...over,
  };
}
