/**
 * Module 7's actual send trigger — the manual step run after a batch is
 * approved. Discovery and generation can run on a schedule; sending never
 * does, on purpose, and this is the only place that gets to fire a message
 * at a real stranger.
 */
import { loadQuarryConfig } from "./config";
import { buildEmailDeps, buildOutreachDeps } from "./deps";
import { BatchResult, sendEmailBatch, sendSmsBatch } from "./outreach";
import { listLeads } from "./store";
import { QuarryLead } from "./types";

export class QuarryDisabledError extends Error {
  constructor() {
    super(
      "quarry.enabled is false in the client config — flip it on before running " +
        "a real send. Unlike calibration, sendPending never overrides this: it is " +
        "the command that puts a real message in front of a real stranger."
    );
    this.name = "QuarryDisabledError";
  }
}

function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

const EMPTY_RESULT: BatchResult = { attempted: 0, sent: 0, skipped: [], failed: [], capReached: false };

export interface SendReport {
  smsNudge: BatchResult;
  smsPitch: BatchResult;
  emailNudge: BatchResult;
  emailPitch: BatchResult;
}

export async function sendPending(
  clientId = "eden",
  options: { log?: (line: string) => void } = {}
): Promise<SendReport> {
  const config = loadQuarryConfig(clientId);
  if (!config) throw new Error(`No quarry config for client "${clientId}"`);
  if (!config.enabled) throw new QuarryDisabledError();

  const log = options.log ?? ((line: string) => console.log(`[QRY] ${line}`));
  const approved = await listLeads({ clientId, approvalStatus: "approved" });

  // ── SMS ──
  // Dormant by default since email became the primary channel (2026-08-27).
  // No special-casing needed here: with quarry.phone.enabled off, every
  // lead's isMobile stays null (see pipeline.ts), so both filters below
  // naturally select nobody and these batches run and do nothing. Flipping
  // phone.enabled back on in the config resumes SMS with no code change.
  //
  // Nudges before new pitches: a nudge is time-sensitive — it only makes
  // sense within a window of the first message — while a fresh pitch can
  // simply wait a day if the shared daily cap runs out on nudges first.
  const smsNudgeCandidates = approved.filter(
    (l): l is QuarryLead =>
      !!l.isMobile && !!l.sentAt && !l.repliedAt && daysSince(l.sentAt) >= config.outreach.nudgeAfterDays
  );
  const smsPitchCandidates = approved.filter((l) => l.isMobile && !l.sentAt);

  const outreachDeps = await buildOutreachDeps(clientId);
  log(`SMS: ${smsNudgeCandidates.length} due for a nudge, ${smsPitchCandidates.length} awaiting a first pitch`);
  const smsNudge = await sendSmsBatch(smsNudgeCandidates, "nudge", config, outreachDeps, { clientId, log });
  const smsPitch = await sendSmsBatch(smsPitchCandidates, "screenshot", config, outreachDeps, { clientId, log });

  // ── Email ──
  let emailNudge = EMPTY_RESULT;
  let emailPitch = EMPTY_RESULT;
  if (!config.outreach.email.fromDomain || !config.outreach.email.physicalAddress) {
    log("email channel not configured (fromDomain/physicalAddress unset) — SMS ran, email skipped");
  } else {
    const schedule = config.outreach.email.nudgeScheduleDays;
    const emailNudgeCandidates = approved.filter((l) => {
      if (!l.email || l.emailOptedOut || !l.emailSentAt || l.emailRepliedAt) return false;
      // emailNudgeCount is which touch is next, not which one just went out —
      // a lead with 0 sent is due for schedule[0], with 1 sent due for
      // schedule[1], and once it has caught up to schedule.length there is
      // nothing left to send: this lead has had every touch and no reply.
      if (l.emailNudgeCount >= schedule.length) return false;
      return daysSince(l.emailSentAt) >= schedule[l.emailNudgeCount];
    });
    const emailPitchCandidates = approved.filter((l) => !!l.email && !l.emailOptedOut && !l.emailSentAt);

    const emailDeps = await buildEmailDeps(clientId);
    log(`Email: ${emailNudgeCandidates.length} due for a nudge, ${emailPitchCandidates.length} awaiting a first pitch`);
    emailNudge = await sendEmailBatch(emailNudgeCandidates, "email_nudge", config, emailDeps, { clientId, log });
    emailPitch = await sendEmailBatch(emailPitchCandidates, "email_pitch", config, emailDeps, { clientId, log });
  }

  return { smsNudge, smsPitch, emailNudge, emailPitch };
}
