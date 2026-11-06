import { getContact, listOpportunitiesInStage, sendSMS } from "../../../shared/ghl";
import { lastInboundText } from "../text-signals";
import { buildDeps, dryRunPost } from "./deps";
import { HomeServicesConfig, listHomeServicesClientIds, loadHomeServicesConfig, readinessProblem } from "./config";
import { enrollLead, guessLanguage, handleInbound, runFollowup } from "./engine";
import { LeadInfo } from "./lead-info";
import { DigestLead, formatDigest } from "./notify";
import { isWeekday, isWithinSendWindow } from "./quiet-hours";
import { HsLead, pgStore } from "./store";

const MAX_ENROLLMENTS_PER_RUN = 10;
const MAX_FOLLOWUPS_PER_RUN = 20;
const REPLY_WINDOW_DAYS = 14;
const STALE_UNSENT_MS = 12 * 3_600_000;

const warnedNotReady = new Set<string>();

/** Clients that are switched on AND complete. A half-filled block is reported once per process, not every minute. */
export function runnableClients(): HomeServicesConfig[] {
  const out: HomeServicesConfig[] = [];
  for (const id of listHomeServicesClientIds()) {
    const config = loadHomeServicesConfig(id);
    if (!config?.enabled) continue;
    const problem = readinessProblem(config);
    if (problem) {
      if (!warnedNotReady.has(id)) {
        warnedNotReady.add(id);
        console.warn(`[IRS-HS] ${id} is enabled but not ready: ${problem}`);
      }
      continue;
    }
    out.push(config);
  }
  return out;
}

const inFlight = new Set<string>();
async function exclusive(name: string, clientId: string, fn: () => Promise<void>): Promise<void> {
  const key = `${name}:${clientId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await fn();
  } finally {
    inFlight.delete(key);
  }
}

const SKIP_TAGS = ["dnd", "do not call", "needs pedro"];

export type EnrollmentDecision = { enroll: true; info: LeadInfo } | { enroll: false; reason: string; terminal: boolean };

/**
 * Whether a card in the intake stage becomes an Iris conversation. Anything created before go-live
 * is backlog and is never texted from here; a lead without a phone, a do-not-contact tag, or a
 * person already working them is left to the humans. Terminal decisions are recorded so the same
 * card is not re-examined every minute.
 */
export function decideEnrollment(opp: any, contact: any, config: HomeServicesConfig): EnrollmentDecision {
  if (opp?.status && opp.status !== "open") return { enroll: false, reason: "opportunity not open", terminal: true };
  const created = Date.parse(opp?.createdAt ?? "");
  if (Number.isNaN(created) || created < Date.parse(config.enrollNotBefore!)) {
    return { enroll: false, reason: "created before go-live (backlog)", terminal: true };
  }
  const tags: string[] = (contact?.tags ?? []).map((t: string) => String(t).toLowerCase());
  if (SKIP_TAGS.some((t) => tags.includes(t))) return { enroll: false, reason: "do-not-contact or already handed to the owner", terminal: true };
  if (contact?.dnd === true) return { enroll: false, reason: "contact is on do-not-disturb", terminal: true };
  if (!contact?.phone) return { enroll: false, reason: "no phone number", terminal: true };

  const hint = config.languageFieldKey
    ? (contact.customFields ?? contact.customField ?? []).find?.((f: any) => f?.key === config.languageFieldKey || f?.fieldKey === config.languageFieldKey)?.value
    : null;
  const tagHint = tags.find((t) => /^(en|english|anglais)$/.test(t));
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || contact.name || undefined;
  return {
    enroll: true,
    info: {
      fullName,
      phone: contact.phone,
      street: contact.address1 || undefined,
      city: contact.city || undefined,
      postalCode: contact.postalCode || undefined,
      language: guessLanguage(hint ?? tagHint),
    },
  };
}

export async function runHomeServicesIntake(config: HomeServicesConfig): Promise<void> {
  await exclusive("intake", config.clientId, async () => {
    const built = await buildDeps(config.clientId);
    if (!built) return;
    const { deps, access } = built;
    // Column names in the file are resolved to live stage ids inside deps.config.
    const cfg = deps.config;
    let enrolled = 0;
    for (const stageId of cfg.intakeStages) {
      const opps = await listOpportunitiesInStage(access.locationId, cfg.pipelineId, stageId, access.apiKey);
      for (const opp of opps) {
        if (enrolled >= MAX_ENROLLMENTS_PER_RUN) return;
        const contactId = opp.contactId ?? opp.contact?.id;
        if (!contactId || (await pgStore.getLead(cfg.clientId, contactId))) continue;

        const payload = await getContact(contactId, access.locationId, access.apiKey).catch(() => null);
        const contact = payload?.contact ?? payload;
        if (!contact) continue;
        const decision = decideEnrollment(opp, contact, cfg);
        const fresh = (info: LeadInfo, extra: Partial<HsLead> = {}): HsLead => ({
          clientId: cfg.clientId, contactId, opportunityId: opp.id ?? null, status: "active", columnKey: cfg.outreach.firstTouch ? "day1" : null, info,
          followupStep: 0, nextFollowupAt: null,
          // Replies count from the moment the card was created, so one that lands before this poll is not lost.
          lastInboundSeenAt: new Date(opp.createdAt ?? Date.now()),
          lastOutboundAt: null, resolutionReason: null, enrolledAt: new Date(), ...extra,
        });
        const close = (reason: string) => pgStore.insertLead(fresh({}, { status: "closed", columnKey: null, resolutionReason: reason }));
        if (!decision.enroll) {
          if (decision.terminal) await close(decision.reason);
          continue;
        }
        // Someone is already texting this lead: it is theirs.
        if (await deps.teammateIsTexting(fresh(decision.info))) {
          await close("a teammate is already texting this lead");
          continue;
        }
        if (await enrollLead(deps, fresh(decision.info))) {
          enrolled++;
          if (cfg.outreach.firstTouch && stageId !== cfg.columns.day1) await deps.ghl.moveToColumn(fresh(decision.info), cfg.columns.day1);
        }
      }
    }
  });
}

const perContactQueue = new Map<string, Promise<unknown>>();

export async function runHomeServicesReplyPoll(config: HomeServicesConfig): Promise<void> {
  await exclusive("replies", config.clientId, async () => {
    const built = await buildDeps(config.clientId);
    if (!built) return;
    const { deps, access } = built;
    const cutoff = Date.now() - REPLY_WINDOW_DAYS * 86_400_000;
    const leads: HsLead[] = [];
    for (const status of ["active", "needs_pedro", "idle"] as const) leads.push(...(await pgStore.listByStatus(config.clientId, status)));

    for (const lead of leads) {
      if (lead.enrolledAt.getTime() < cutoff) continue;
      const inbound = await lastInboundText(lead.contactId, access.locationId, access.apiKey);
      if (!inbound?.dateAdded) continue;
      const at = new Date(inbound.dateAdded);
      // Nothing from before the card existed counts: that is an older inquiry, not an answer to us.
      if (at.getTime() <= (lead.lastInboundSeenAt?.getTime() ?? lead.enrolledAt.getTime())) continue;

      // Strictly one at a time per lead, in order, so a second text sees the first reply.
      const previous = perContactQueue.get(lead.contactId) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => handleInbound(deps, lead, inbound.text, at));
      perContactQueue.set(lead.contactId, run);
      try {
        await run;
      } catch (error) {
        console.error(`[IRS-HS] Failed handling a reply from ${lead.contactId}:`, error instanceof Error ? error.message : error);
      } finally {
        if (perContactQueue.get(lead.contactId) === run) perContactQueue.delete(lead.contactId);
      }
    }
  });
}

export async function runHomeServicesFollowups(config: HomeServicesConfig): Promise<void> {
  await exclusive("followups", config.clientId, async () => {
    const built = await buildDeps(config.clientId);
    if (!built) return;
    const { deps } = built;
    const due = (await pgStore.dueFollowups(config.clientId, new Date())).slice(0, MAX_FOLLOWUPS_PER_RUN);
    for (const lead of due) {
      try {
        // Re-checked live right before sending: a person may have stepped in since the last pass.
        if (await deps.teammateIsTexting(lead)) {
          await pgStore.updateLead(lead.clientId, lead.contactId, { status: "closed", nextFollowupAt: null, resolutionReason: "a teammate is texting this lead" });
          continue;
        }
        await runFollowup(deps, lead);
      } catch (error) {
        console.error(`[IRS-HS] Follow-up failed for ${lead.contactId}:`, error instanceof Error ? error.message : error);
      }
    }
  });
}

export async function runHomeServicesOutbox(config: HomeServicesConfig): Promise<void> {
  await exclusive("outbox", config.clientId, async () => {
    const built = await buildDeps(config.clientId);
    if (!built) return;
    const { access } = built;
    const live = config.mode === "live";
    const now = new Date();
    for (const row of await pgStore.dueOutbox(config.clientId, now)) {
      const lead = await pgStore.getLead(row.clientId, row.contactId);
      const outOfDate = (row.kind === "first_touch" || row.kind === "followup") && now.getTime() - row.sendAfter.getTime() > STALE_UNSENT_MS;
      const moot = !lead || (row.kind !== "optout_ack" && lead.status === "opted_out") || ((row.kind === "first_touch" || row.kind === "followup") && lead.status !== "active");
      if (outOfDate || moot) {
        await pgStore.markOutbox(row.id, "cancelled", outOfDate ? "stale" : "no longer applies");
        continue;
      }
      if (!isWithinSendWindow(now, config.timezone, config.quietHours.startHour, config.quietHours.endHour)) continue;
      try {
        if (live) await sendSMS(row.contactId, row.body, access.locationId, access.apiKey);
        else await dryRunPost(`draft ${row.kind} to ${lead!.info.fullName ?? row.contactId} (${lead!.info.phone ?? "no phone"}):\n${row.body}`);
        await pgStore.markOutbox(row.id, live ? "sent" : "drafted");
        await pgStore.updateLead(row.clientId, row.contactId, { lastOutboundAt: new Date() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pgStore.markOutbox(row.id, "failed", message);
        console.error(`[IRS-HS] Send failed for ${row.contactId}:`, message);
      }
    }
  });
}

export async function runHomeServicesDigest(config: HomeServicesConfig): Promise<void> {
  await exclusive("digest", config.clientId, async () => {
    if (!isWeekday(new Date(), config.timezone)) return;
    const built = await buildDeps(config.clientId);
    if (!built) return;
    const { deps } = built;
    const cfg = deps.config;
    const candidates = (await pgStore.listByStatus(config.clientId, "active")).filter((l) => l.columnKey === "looseDay" || l.columnKey === "looseNight");
    const open: DigestLead[] = [];
    for (const lead of candidates) {
      const stage = await deps.ghl.currentStageId(lead).catch(() => null);
      // Only the owner moves a lead out of an appointment column; once he has, it is done.
      if (stage && stage !== cfg.columns[lead.columnKey!]) {
        await pgStore.updateLead(lead.clientId, lead.contactId, { status: "closed", resolutionReason: "moved out of the appointment column by the owner" });
        continue;
      }
      open.push({ info: lead.info, column: lead.columnKey as "looseDay" | "looseNight" });
    }
    const text = formatDigest(open, config.notify.language);
    if (text) await deps.alertOwner(text);
  });
}
