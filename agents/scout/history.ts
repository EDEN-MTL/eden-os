/**
 * Decides whether a lead that just came through intake is actually a
 * RETURNING lead — one that already belongs to somebody — rather than a
 * genuinely new one. Mark's spec, 2026-10-04: a lead who already has an
 * agent, an appointment, or a live transfer on record must not be lined up
 * for an Iris call; their agent should be told they came back instead.
 *
 * Kept free of I/O, same split as intake.ts's isFirstTouch: the rules are
 * what's most likely to need tuning per client, and they're the part worth
 * testing directly. agents/scout/returning.ts does the live GHL fetching.
 *
 * Why this isn't just isFirstTouch: that only looks at touch tags, ISA
 * notes, and the lead's NEWEST open opportunity. A returning lead gets a
 * FRESH intake-stage card, which becomes "newest" and masks the older card
 * still parked in Live Transferred / Appointment Set; and assignment and
 * appointments were never consulted at all.
 *
 * "Returning" means real AGENT history. An old contact nobody ever worked
 * (only intake or automated follow-up stages, no assignee, no appointment,
 * no tags, no human notes) is deliberately treated as new — Mark's call.
 */

export type HistoryReason =
  | { kind: "assigned"; userId: string }
  | { kind: "worked_stage"; stageId: string }
  | { kind: "touch_tag"; tag: string }
  | { kind: "human_notes" }
  | { kind: "appointment"; count: number };

export interface HistoryContact {
  id: string;
  /** When the contact was first created in GHL (ISO). Missing reads as "can't tell it's old" — i.e. not pre-existing. */
  dateAdded?: string | null;
  assignedTo?: string | null;
  tags?: string[];
  isaNotes?: string | null;
}

export interface HistoryOpportunity {
  id: string;
  createdAt: string;
  pipelineStageId: string;
  assignedTo?: string | null;
}

export interface HistorySubject {
  contact: HistoryContact;
  /** Every opportunity the contact has ever had, any status. */
  opportunities: HistoryOpportunity[];
  appointmentCount: number;
}

export interface HistoryConfig {
  touchedTags: string[];
  /**
   * Stage ids that mean a human worked this lead (Live Transferred,
   * Appointment Set, Deal Closed...). An explicit list rather than "anything
   * past intake" on purpose: 3%'s pipeline also has automated columns
   * (Replied, the DAY-N follow-ups, nurturing buckets) a lead lands in with
   * no human involved, and those must never read as agent history.
   */
  historyStageIds: string[];
  /** A contact younger than this is brand new, whatever else is on it (e.g. auto-assignment at creation). */
  returningMinAgeMinutes: number;
}

export interface LeadHistory {
  returning: boolean;
  reasons: HistoryReason[];
  /** The agent who owns this lead, if any — what the alert goes to. */
  assignedUserId: string | null;
  /** When the lead was first in the system (earliest matching contact's dateAdded). */
  firstSeen: string | null;
  /** Which contact carried the history — the lead's own id, or a duplicate record of the same person. */
  historyContactId: string | null;
}

/**
 * Iris writes its own status lines into the same notes field a human ISA
 * uses ("Iris call Thursday... — No answer", "Iris scheduled a callback...",
 * "Iris: lead asked to be called back..."). Those prove Iris tried, not that
 * an agent did anything, so they never count as human history.
 */
function humanNotes(isaNotes: string | null | undefined): string {
  if (!isaNotes) return "";
  return String(isaNotes)
    .split(/\n|<br\s*\/?>/i)
    .map((line) => line.replace(/^ISA NOTES\s*:\s*/i, "").trim())
    .filter((line) => line !== "" && !/^iris\b/i.test(line))
    .join("\n");
}

function evidenceFor(subject: HistorySubject, config: HistoryConfig, now: Date): { reasons: HistoryReason[]; assignedUserId: string | null } | null {
  const { contact, opportunities, appointmentCount } = subject;

  // A contact created moments ago is new no matter what's on it — a client's
  // GHL may auto-assign or round-robin at creation, and that must not read as
  // "this lead already had an agent."
  const addedMs = contact.dateAdded ? new Date(contact.dateAdded).getTime() : NaN;
  if (Number.isNaN(addedMs) || (now.getTime() - addedMs) / 60_000 < config.returningMinAgeMinutes) return null;

  const reasons: HistoryReason[] = [];
  let assignedUserId: string | null = contact.assignedTo || null;

  // The newest card is the one the intake workflow just created for THIS
  // submission — only skip it when it really is fresh. If even the newest
  // card is old, no new card was made and every card is history.
  const sorted = [...opportunities].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const newest = sorted[sorted.length - 1];
  const newestIsFresh = !!newest && (now.getTime() - new Date(newest.createdAt).getTime()) / 60_000 < config.returningMinAgeMinutes;
  const older = newestIsFresh ? sorted.slice(0, -1) : sorted;

  for (const opp of opportunities) {
    if (opp.assignedTo && !assignedUserId) assignedUserId = opp.assignedTo;
  }
  if (assignedUserId) reasons.push({ kind: "assigned", userId: assignedUserId });

  for (const opp of older) {
    if (config.historyStageIds.includes(opp.pipelineStageId)) reasons.push({ kind: "worked_stage", stageId: opp.pipelineStageId });
  }

  const touched = new Set(config.touchedTags.map((t) => t.trim().toLowerCase()));
  for (const tag of contact.tags || []) {
    if (touched.has(String(tag).trim().toLowerCase())) reasons.push({ kind: "touch_tag", tag: String(tag) });
  }

  if (humanNotes(contact.isaNotes) !== "") reasons.push({ kind: "human_notes" });
  if (appointmentCount > 0) reasons.push({ kind: "appointment", count: appointmentCount });

  return reasons.length > 0 ? { reasons, assignedUserId } : null;
}

export function classifyLeadHistory(input: { self: HistorySubject; duplicates?: HistorySubject[]; now: Date }, config: HistoryConfig): LeadHistory {
  const subjects = [input.self, ...(input.duplicates || [])];
  const reasons: HistoryReason[] = [];
  let assignedUserId: string | null = null;
  let firstSeen: string | null = null;
  let historyContactId: string | null = null;

  for (const subject of subjects) {
    const found = evidenceFor(subject, config, input.now);
    if (!found) continue;
    reasons.push(...found.reasons);
    if (!assignedUserId) assignedUserId = found.assignedUserId;
    if (!historyContactId) historyContactId = subject.contact.id;
    const added = subject.contact.dateAdded || null;
    if (added && (!firstSeen || new Date(added).getTime() < new Date(firstSeen).getTime())) firstSeen = added;
  }

  return { returning: reasons.length > 0, reasons, assignedUserId, firstSeen, historyContactId };
}
