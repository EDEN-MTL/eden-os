/**
 * QUARRY — prospecting and speculative site generation.
 *
 * Finds small businesses with absent or dated websites, verifies the listed
 * number can actually receive a text, builds a real site for them, and pushes
 * the lead into GHL for a screenshot-first outreach sequence.
 *
 * The row in quarry_leads is the source of truth for a prospect. These types
 * mirror it; snake_case fields are the DB shape, and the store layer is the
 * only place that translation happens.
 */

export type QuarryCategory = "trade-service" | "retail-boutique" | "professional";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * The live stage names on Eden's Website Offer Pipeline, transcribed from GHL
 * on 2026-08-26 — not invented here. "Replied Interest" and "Lost/Nurture"
 * read like typos and are not: they are what the pipeline actually says, and
 * sync.ts matches exactly. Change GHL first, then this.
 */
export type QuarryStage =
  | "New Lead"
  | "Screenshot Sent"
  | "Site Sent"
  | "Replied Interest"
  | "Call Booked"
  | "Closed Won"
  | "Lost/Nurture";

export type SendStep = "screenshot" | "link" | "nudge" | "email_pitch" | "email_nudge" | "email_booking";

/** What Google Places gives us before any of our own analysis. */
export interface PlacesResult {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  userRatingsTotal: number | null;
  businessStatus: string | null;
  photoRefs: string[];
  /** The config query that surfaced this result, kept for funnel debugging. */
  searchQuery: string;
  /** Resolved from the config query, not from Google — Places types are too coarse. */
  category: QuarryCategory;
}

export interface TriageResult {
  isCandidate: boolean;
  reasons: string[];
  /** 1-10 from the Claude vision pass. Absent unless vision scoring ran. */
  outdatedScore?: number;
  outdatedReasoning?: string;
}

export interface ContactEnrichment {
  email: string | null;
  emailSource: string | null;
  hasPublicEmail: boolean;
}

export interface PhoneLookup {
  phone: string;
  lineType: string;
  isMobile: boolean;
  carrier: string | null;
  provider: string;
  checkedAt: string;
  raw?: Record<string, unknown>;
}

/**
 * Swappable carrier-lookup provider. Twilio Lookup v2 is the default
 * implementation; the interface exists so Telesign or Neustar can be dropped
 * in without touching the pipeline.
 */
export interface PhoneLookupProvider {
  readonly name: string;
  lookup(phone: string): Promise<PhoneLookup>;
}

export interface GeneratedSite {
  previewUrl: string;
  /** Which SiteGenerator produced it — recorded so a bad batch is traceable. */
  generator: string;
  projectId?: string;
}

/**
 * Swappable site builder. The Lovable MCP adapter is the intended
 * implementation; the interface keeps the rest of the pipeline from caring
 * which engine ran, and lets a failing provider be swapped without a rewrite.
 */
export interface SiteGenerator {
  readonly name: string;
  generate(input: SiteGenerationInput): Promise<GeneratedSite>;
}

export interface SiteGenerationInput {
  lead: QuarryLead;
  /** The category brief, verbatim, from quarry_design_briefs. */
  brief: string;
  /** Resolved Places photo URLs to hand the generator as reference images. */
  photoUrls: string[];
  /** GHL calendar link for the "Book a call" CTA, if one is configured. */
  bookingUrl: string | null;
}

/** A prospect row. Nullable fields are populated as it moves down the pipeline. */
export interface QuarryLead {
  id: number;
  clientId: string;
  placeId: string;
  name: string;
  formattedAddress: string | null;
  phone: string | null;
  phoneLineType: string | null;
  isMobile: boolean | null;
  email: string | null;
  emailSource: string | null;
  hasPublicEmail: boolean;
  website: string | null;
  category: QuarryCategory | null;
  searchQuery: string | null;
  rating: number | null;
  userRatingsTotal: number | null;
  businessStatus: string | null;
  photoRefs: string[];
  isCandidate: boolean | null;
  reasons: string[];
  outdatedScore: number | null;
  outdatedReasoning: string | null;
  previewUrl: string | null;
  previewImageUrl: string | null;
  generator: string | null;
  generationError: string | null;
  ghlContactId: string | null;
  ghlOpportunityId: string | null;
  pipelineStage: string | null;
  approvalStatus: ApprovalStatus;
  dnclChecked: boolean;
  holdoutReason: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  emailSentAt: string | null;
  emailRepliedAt: string | null;
  emailOptedOut: boolean;
  emailNudgeCount: number;
  emailUnsubscribeToken: string | null;
  lastLookupAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunError {
  step: string;
  placeId: string | null;
  name: string | null;
  message: string;
  at: string;
}

export interface QuarryRun {
  id: number;
  clientId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  leadsFound: number;
  leadsQualified: number;
  leadsMobile: number;
  leadsGenerated: number;
  leadsScreenshotted: number;
  leadsSynced: number;
  errors: RunError[];
  triggeredBy: string;
}
