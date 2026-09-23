/**
 * EMBER — long-term nurture and reactivation.
 *
 * Finds client leads whose opportunity has sat untouched in an open pipeline
 * column past a threshold, works them through a slow SMS/email cadence, and
 * tells the team in #backend-ops the moment one shows life again.
 *
 * The row in ember_nurture_leads is the source of truth for a lead's place
 * in the cadence. snake_case is the DB shape; store.ts is the only place
 * that translation happens (same split as agents/quarry).
 */

export type NurtureStatus =
  | "nurturing"
  | "paused"
  | "replied"
  | "reactivated"
  | "exited"
  | "opted_out"
  | "completed";

export type NurtureChannel = "sms" | "email";

export interface NurtureLead {
  id: number;
  clientId: string;
  ghlContactId: string;
  ghlOpportunityId: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  status: NurtureStatus;
  statusReason: string | null;
  enrolledStageId: string | null;
  enrolledStageName: string | null;
  lastGhlActivityAt: string | null;
  inquiryAt: string | null;
  enteredAt: string;
  touchCount: number;
  lastTouchAt: string | null;
  nextTouchAt: string | null;
  repliedAt: string | null;
  reactivatedAt: string | null;
  unsubscribeToken: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The subset of a GHL opportunity the dormancy scan reads. GHL returns far
 * more; these are the fields confirmed present on a live
 * /opportunities/search result (eden-sub-account-one, 2026-09-23).
 */
export interface GhlOpportunityLite {
  id: string;
  status: string;
  pipelineId: string;
  pipelineStageId: string;
  contactId: string;
  lastStageChangeAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  contact?: { name?: string | null; phone?: string | null; email?: string | null; tags?: string[] } | null;
}
