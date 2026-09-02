/**
 * Iris's qualification state machine — questions, branching, scoring, and
 * the book/transfer/nurture decision.
 *
 * Kept free of I/O (no Vapi, no GHL calls) so the logic that decides whether
 * a real buyer gets booked with a real agent or live-transferred can be unit
 * tested without placing a call or spending money — same split as
 * `agents/scout/intake.ts` vs `agents/scout/index.ts`.
 */
import { NormalisedLead, scoreLead } from "../scout/intake";
import { Financing } from "../scout/isa-notes";

export type CallIntent = NormalisedLead["intent"];

/**
 * Where Iris writes each answer after a call, per the Iris build-brief
 * update: Iris must write structured fields, never prose into isa_notes —
 * that field is exactly why Scout needs a prose parser in the first place,
 * and writing to it again would automate the bottleneck instead of fixing
 * it. These are single, specific field keys, not scout.fields' read-priority
 * lists — Scout reads whichever candidate is populated; Iris always writes
 * to the one field the ISA has historically written (the "LF" fields).
 */
export interface IrisWriteFields {
  timeline: string; // contact.lf_timeframe
  budget: string; // contact.lf_budget
  propertyInterest: string; // contact.lf_proprety
  preApproved: string; // contact.are_you_pre_approuved
}

export interface OutreachCadenceConfig {
  attemptsPerDay: number;
  days: number;
  recheckBeforeEachAttempt: boolean;
}

export interface IrisConfig {
  /**
   * The four-question list in client config today. Per the Iris build
   * brief, this is a placeholder — Jacob has a fuller qualification script
   * that hasn't landed yet. assertQuestionShape() below fails loudly rather
   * than silently mis-mapping answers if the shape changes.
   */
  questions: string[];
  hotScoreThreshold: number;
  warmScoreThreshold: number;
  calendars: { buyer: string; seller: string };
  /**
   * Real ring-group numbers, one agent pool per intent — everyone under the
   * number rings simultaneously, first pickup wins (Mark's description).
   * Used by Vapi's transferCall tool; see calling.ts's buildCallPayload.
   */
  transferNumbers: { buyer: string; seller: string };
  /**
   * Single write target for the callback note (iris.callbacks.notesFieldKey
   * in client config) — same field scout.fields.isaNotes reads from, but
   * named separately here on purpose: that's a read-priority list (several
   * historical field names), while this is the one specific field Iris
   * writes to, same split as writeFields below vs scout.fields.
   * This is NOT the "never write prose into isa_notes" field from the
   * qualification write-up — Jacob's brief is explicit that a callback
   * request note IS meant to land here, since it becomes client-facing
   * output, not raw Q&A prose. Mark, 2026-09-03: no GHL calendar involved
   * here anymore — a requested callback is a note plus Iris herself
   * re-dialing at that time (see dial-pending.ts's is_explicit_callback),
   * not a booked calendar slot. See webhooks/vapi-tools.ts's
   * handleScheduleCallback.
   */
  callbackNotesFieldKey: string;
  writeFields: IrisWriteFields;
  outreachCadence: OutreachCadenceConfig;
}

export interface QualificationAnswers {
  intent: CallIntent;
  area: string | null;
  timeline: string | null;
  budget: string | null;
  /**
   * Not a yes/no. Real answers on this account include "paying cash", "no
   * need" and "not necessary" — three negations describing the strongest
   * possible buyer. Modelling this as a boolean scores your best prospects
   * as negatives.
   */
  financing: Financing;
}

export const BLANK_ANSWERS: QualificationAnswers = {
  intent: "unknown",
  area: null,
  timeline: null,
  budget: null,
  financing: null,
};

export type QualificationOutcome = "book" | "transfer" | "nurture";

export interface QualificationResult {
  answers: QualificationAnswers;
  score: number;
  scoreReasons: string[];
  outcome: QualificationOutcome;
  calendarId: string | null;
  tag: "appt booked" | "live transferred" | null;
}

/**
 * Positional concepts behind today's four placeholder questions: buy/sell,
 * area, timeline, financing+budget. There is no way to connect free-form
 * question text to structured fields other than position, since the
 * questions are plain strings in config — so this throws instead of
 * silently mis-mapping if the question count ever changes.
 */
const EXPECTED_QUESTION_COUNT = 4;

function assertQuestionShape(questions: string[]): void {
  if (questions.length !== EXPECTED_QUESTION_COUNT) {
    throw new Error(
      `Iris expects ${EXPECTED_QUESTION_COUNT} qualification questions (intent, area, timeline, ` +
        `financing) but config supplied ${questions.length}. The positional mapping in ` +
        `nextQuestion() needs updating before qualifying calls against this script.`
    );
  }
}

/**
 * Next unanswered question, or null once qualification is complete.
 *
 * Financing is a buyer concept — a pure seller has nothing to qualify there,
 * so that question is skipped for seller intent. This is the one branch
 * justified by domain knowledge without guessing at Jacob's real script;
 * downsize/upgrading leads still get asked since both involve buying.
 */
export function nextQuestion(config: IrisConfig, answers: QualificationAnswers): string | null {
  assertQuestionShape(config.questions);
  const [intentQ, areaQ, timelineQ, financingQ] = config.questions;

  if (answers.intent === "unknown") return intentQ;
  if (answers.area === null) return areaQ;
  if (answers.timeline === null) return timelineQ;
  if (answers.intent !== "seller" && answers.financing === null) return financingQ;
  return null;
}

export function isComplete(config: IrisConfig, answers: QualificationAnswers): boolean {
  return nextQuestion(config, answers) === null;
}

/**
 * Delegates to Scout's scoreLead rather than a second scoring formula, so a
 * lead scores the same way whether the signal came from a GHL field, ISA
 * notes, or a live call answer. `phone` is always present by construction —
 * this is a phone call — and attribution/leadSource/qualified/firstTouch
 * don't apply to an in-call qualification, so they're passed as
 * unknown/false.
 */
export function scoreQualification(answers: QualificationAnswers): { score: number; reasons: string[] } {
  return scoreLead({
    contactId: "",
    name: null,
    email: null,
    phone: "in-call",
    propertyInterest: null,
    budget: answers.budget,
    timeline: answers.timeline,
    preApproved:
      answers.financing === null ? null : answers.financing === "cash" || answers.financing === "pre-approved",
    financing: answers.financing,
    sources: { financing: null, timeline: null, budget: null },
    leadSource: null,
    attribution: {
      fbclid: null,
      utmSource: null,
      utmCampaign: null,
      metaCampaignId: null,
      metaAdsetId: null,
      metaAdId: null,
    },
    attributed: false,
    qualified: false,
    firstTouch: false,
    intent: answers.intent,
  });
}

export function decideOutcome(config: IrisConfig, score: number): QualificationOutcome {
  if (score >= config.hotScoreThreshold) return "book";
  if (score >= config.warmScoreThreshold) return "transfer";
  return "nurture";
}

/**
 * Config only carries buyer/seller consultation calendars (build brief:
 * "Two calendars. Iris picks by intent."). Downsize and upgrading leads are
 * hybrid — a downsizer has to list before they buy, an upgrader has to
 * qualify to buy before they list — so each routes to the calendar for the
 * transaction that has to happen first.
 */
export function calendarForIntent(config: IrisConfig, intent: CallIntent): string | null {
  if (intent === "seller" || intent === "downsize") return config.calendars.seller;
  if (intent === "buyer" || intent === "upgrading") return config.calendars.buyer;
  return null;
}

/** Same buyer/seller-first-transaction mapping as calendarForIntent, for the ring-group transfer number instead of the booking calendar. */
export function transferNumberForIntent(config: IrisConfig, intent: CallIntent): string | null {
  if (intent === "seller" || intent === "downsize") return config.transferNumbers.seller;
  if (intent === "buyer" || intent === "upgrading") return config.transferNumbers.buyer;
  return null;
}

/**
 * Full decision from a completed (or partial) set of answers. Callers
 * should only treat the result as final once isComplete() is true.
 */
export function qualify(config: IrisConfig, answers: QualificationAnswers): QualificationResult {
  const { score, reasons } = scoreQualification(answers);
  const outcome = decideOutcome(config, score);
  const calendarId = outcome === "book" ? calendarForIntent(config, answers.intent) : null;
  const tag = outcome === "book" ? "appt booked" : outcome === "transfer" ? "live transferred" : null;

  return { answers, score, scoreReasons: reasons, outcome, calendarId, tag };
}

/**
 * GHL fields to write back after the call, keyed by the field itself rather
 * than by GHL's internal field id — resolving key -> id via buildKeyToId is
 * the caller's job, same split as everywhere else this matters.
 *
 * `contact.are_you_pre_approuved` is empty on every live contact checked
 * because the human ISA captures the answer verbally or in free-text notes
 * instead of writing it back. If Iris asks the question, it must write the
 * answer as a real field value, not prose into isa_notes — that field
 * exists as a parser target (agents/scout/isa-notes.ts) precisely because
 * the data is trapped in prose today, and writing more prose there would
 * automate the bottleneck instead of fixing it.
 */
export function fieldWritesFor(answers: QualificationAnswers, fields: IrisWriteFields): Record<string, string> {
  const writes: Record<string, string> = {};
  if (answers.financing !== null) writes[fields.preApproved] = answers.financing;
  if (answers.timeline !== null) writes[fields.timeline] = answers.timeline;
  if (answers.budget !== null) writes[fields.budget] = answers.budget;
  if (answers.intent !== "unknown") writes[fields.propertyInterest] = answers.intent;
  return writes;
}
