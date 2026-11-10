/**
 * The lead review: walks the pipeline stage by stage, reads each lead's real conversation and notes, and says which
 * leads are worth checking in on, with the evidence. Mark, 2026-10-29: Iris and Ember should "go through each
 * stage, check the leads' conversation history, and analyze which lead is worth checking in" — for example a lead
 * who was promised a call and then got nothing from Jacob, Iris, Mark or any agent, and whose notes show they're
 * qualified.
 *
 * Read-only and free (no AI model): it looks for dropped balls a rule can see —
 *   owed_contact       someone promised a call or follow-up, or the lead asked for one, and nobody has tried since
 *   unanswered_reply   the lead's last message is theirs and nobody has answered it
 *   qualified_untouched  the notes show a qualified lead and nobody has tried them in days
 *   only_missed_attempts a promise was made and the only tries since went unanswered, with nobody trying lately
 * It never contacts anyone and never moves a card; it produces a ranked list for a person (or, later, for Iris to
 * act on after a "yes").
 */
import { query } from "../../shared/db";
import {
  getContact,
  getContactAppointments,
  getConversationMessages,
  getConversations,
  getCustomFieldDefs,
  getGhlConfig,
  listOpportunitiesInStage,
  listPipelines,
} from "../../shared/ghl";
import { buildKeyToId, readField } from "../scout/intake";
import { loadIrisConfig } from "./index";
import { callAnswered } from "./followup-cohort";
import { readAppointments } from "./no-show-state";

export type Actor = "lead" | "automation" | "app" | "human" | "iris_call";

export interface ReviewEvent {
  at: number;
  actor: Actor;
  kind: "sms" | "call" | "email";
  direction: "in" | "out";
  text: string;
  /** For a call: did it reach a person. */
  reached?: boolean;
}

/** Turns a GHL conversation into events, labelling who each message really came from (see human-touch.ts for why). */
export function eventsFromMessages(messages: any[]): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  for (const m of messages) {
    const at = Date.parse(m?.dateAdded ?? "");
    if (Number.isNaN(at) || m?.status === "failed") continue;
    const kind = m.messageType === "TYPE_SMS" ? "sms" : m.messageType === "TYPE_CALL" ? "call" : m.messageType === "TYPE_EMAIL" ? "email" : null;
    if (!kind) continue;
    const text = String(m.body ?? "").trim();
    if (m.direction === "inbound") {
      if (kind === "call") continue; // a missed inbound call isn't a message to answer
      out.push({ at, actor: "lead", kind, direction: "in", text });
      continue;
    }
    let actor: Actor;
    if (m.source === "workflow") actor = "automation";
    else if (m.meta?.marketplace) actor = "app";
    else if (typeof m.userId === "string" && m.userId !== "") actor = "human";
    else actor = "app";
    const seconds = Number(m.meta?.call?.duration ?? 0) || 0;
    out.push({ at, actor, kind, direction: "out", text, ...(kind === "call" ? { reached: m.status === "completed" && seconds >= 30 } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Iris's own phone calls never appear in GHL, so they come from her call log. */
export function eventsFromIrisCalls(calls: { created_at: Date | string; ended_reason: string | null; transcript: string | null }[]): ReviewEvent[] {
  return calls.map((c) => ({
    at: new Date(c.created_at).getTime(),
    actor: "iris_call" as const,
    kind: "call" as const,
    direction: "out" as const,
    text: "",
    reached: callAnswered({ ended_reason: c.ended_reason, transcript: c.transcript }),
  }));
}

/** Someone telling the lead they'll be called or followed up. (The intake automation's "you'll receive a call from IRIS" counts: it IS a promise.) */
const PROMISE = /\b(?:will|'ll|going to|gonna) (?:give you a (?:quick )?call|call you|reach out|be in touch|follow up|text you|get in touch)|you(?:'ll| will) (?:receive|get) a (?:quick )?call|expect a (?:quick )?call|call you (?:back|tomorrow|later|then|at|on)|give you a (?:quick )?call|(?:have|get) (?:\w+ )?(?:reach|call)(?:ing)? out/i;
/** The lead asking to be called, or naming a time. */
const REQUEST = /\b(?:call me|give me a call|can you call|could you call|please call|call (?:back|after|at|around|tomorrow|me)|better time|reach me|available (?:after|at|between|on)|(?:after|around) \d|weekday|late afternoon|in the (?:morning|evening|afternoon))\b/i;
const STOP = /^\s*(?:stop|unsubscribe|remove me|cancel|quit|end)\b/i;

export interface LeadFacts {
  contactId: string;
  name: string;
  stageName: string;
  tags: string[];
  dnd: boolean;
  hasPhone: boolean;
  notes: string;
  assignedTo: string | null;
  createdAt: number | null;
  events: ReviewEvent[];
  /** Iris's queue row, if any. */
  irisQueue: { status: string; callAfter: number | null } | null;
}

export type FindingKind = "owed_contact" | "unanswered_reply" | "qualified_untouched" | "only_missed_attempts";

export interface Finding {
  kind: FindingKind;
  contactId: string;
  name: string;
  stageName: string;
  score: number;
  /** One line: what's wrong. */
  headline: string;
  /** What the lead and we actually said, with dates. */
  evidence: string[];
  /** Who last tried and when, in words. */
  lastContact: string;
  suggested: string;
  assignedTo: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A promise this fresh isn't late yet. */
const PROMISE_GRACE_MS = 6 * HOUR;
const UNANSWERED_REPLY_AFTER_MS = 3 * HOUR;
const QUALIFIED_UNTOUCHED_AFTER_MS = 5 * DAY;
const HUMAN_WORKING_WINDOW_MS = 3 * DAY;
const PROMISE_MAX_AGE_MS = 21 * DAY;
const AUTOMATION_PROMISE_MAX_AGE_MS = 5 * DAY;

/** How many of the usual qualifying facts the notes carry (budget, timeline, area, pre-approval, bedrooms, type). */
export function qualifiedSignals(notes: string, tags: string[]): number {
  let n = 0;
  if (/\$\s?\d|\b\d{2,3}\s?k\b|budget|price range/i.test(notes)) n++;
  if (/timeline|asap|\d+\s?(?:-|to)?\s?\d*\s?months?|this year|next year|spring|summer|fall|winter/i.test(notes)) n++;
  if (/\barea\b|neighbou?rhood|communit|torbay|mount pearl|paradise|cbs|goulds|kilbride|downtown|st\.? john/i.test(notes)) n++;
  if (/pre-?approv|approved for|financing|mortgage|cash/i.test(notes)) n++;
  if (/\bbed(?:room)?s?\b|bath|single family|townhouse|condo|apartment|property type/i.test(notes)) n++;
  if (tags.some((t) => /sms qualified|^qualified$/i.test(t))) n += 2;
  return n;
}

const ago = (ms: number, now: number): string => {
  const d = (now - ms) / DAY;
  return d < 1 ? `${Math.max(1, Math.round((now - ms) / HOUR))}h ago` : `${Math.round(d)}d ago`;
};
const shortDate = (ms: number): string => new Date(ms).toISOString().slice(5, 10);
const quote = (t: string): string => `“${t.replace(/\s+/g, " ").slice(0, 110)}”`;

/** Finds what's wrong with one lead, or nothing. Pure. */
export function analyzeLead(f: LeadFacts, nowDate: Date): Finding[] {
  const now = nowDate.getTime();
  if (f.dnd || f.tags.some((t) => /do not call/i.test(t)) || !f.hasPhone) return [];
  const events = f.events;
  if (events.length === 0 && !f.notes) return [];

  const attempts = events.filter((e) => e.direction === "out" && (e.actor === "human" || e.actor === "app" || e.actor === "iris_call"));
  const humanOut = events.filter((e) => e.direction === "out" && e.actor === "human");
  const lastAttempt = attempts.at(-1);
  const lastHuman = humanOut.at(-1);
  const lastReached = [...events].reverse().find((e) => e.direction === "in" || (e.kind === "call" && e.reached));
  const humanWorking = Boolean(lastHuman && now - lastHuman.at < HUMAN_WORKING_WINDOW_MS);
  // Iris has a call lined up within a day, so this isn't dropped.
  const irisSoon = Boolean(f.irisQueue && f.irisQueue.status === "pending" && f.irisQueue.callAfter !== null && f.irisQueue.callAfter < now + DAY);
  const signals = qualifiedSignals(f.notes, f.tags);
  const lastContact = lastAttempt
    ? `${lastAttempt.actor === "human" ? "a teammate" : lastAttempt.actor === "iris_call" ? "Iris (call)" : "Iris/Ember (text)"} ${ago(lastAttempt.at, now)}${lastAttempt.reached === false ? ", not answered" : ""}`
    : "nobody has tried since they came in";
  const base = { contactId: f.contactId, name: f.name, stageName: f.stageName, lastContact, assignedTo: f.assignedTo };
  const findings: Finding[] = [];

  // The promise or request that created an obligation.
  // The intake automation's "you'll receive a call from IRIS" is a promise Iris's own sequence keeps, so it only
  // counts while that sequence could still be running; a person's or Iris's own promise counts for longer.
  const promises = events.filter(
    (e) =>
      (e.direction === "out" && e.actor !== "lead" && PROMISE.test(e.text) && (e.actor !== "automation" || now - e.at < AUTOMATION_PROMISE_MAX_AGE_MS)) ||
      (e.direction === "in" && e.kind === "sms" && REQUEST.test(e.text) && !STOP.test(e.text))
  );
  const latestPromise = promises.at(-1);

  // Older than a few weeks it is history, not a dropped ball: the lead has long since moved on or been handled.
  if (latestPromise && now - latestPromise.at > PROMISE_GRACE_MS && now - latestPromise.at < PROMISE_MAX_AGE_MS && !irisSoon) {
    const after = attempts.filter((e) => e.at > latestPromise.at + 60_000);
    const reachedAfter = events.some((e) => e.at > latestPromise.at + 60_000 && (e.direction === "in" || (e.kind === "call" && e.reached)));
    const evidence = [`${latestPromise.direction === "in" ? "They asked" : "They were told"} (${shortDate(latestPromise.at)}): ${quote(latestPromise.text)}`];
    if (after.length === 0) {
      findings.push({
        ...base,
        kind: "owed_contact",
        score: 80 + signals * 4 + (now - latestPromise.at < 7 * DAY ? 10 : 0),
        headline: `Was promised a call or follow-up ${ago(latestPromise.at, now)} and nobody has tried since`,
        evidence,
        suggested: "Call them today, and tell them you're following up on what they were promised.",
      });
    } else if (!reachedAfter && !humanWorking && now - after[after.length - 1].at > 2 * DAY) {
      findings.push({
        ...base,
        kind: "only_missed_attempts",
        score: 50 + signals * 3,
        headline: `Was promised a call ${ago(latestPromise.at, now)}; since then only unanswered tries (${after.length}), the last ${ago(after[after.length - 1].at, now)}`,
        evidence,
        suggested: "Try once more at a different time of day, or text them: they've never actually been reached.",
      });
    }
  }

  // The lead spoke last and nobody answered.
  const last = events.at(-1);
  if (last && last.direction === "in" && last.kind === "sms" && !STOP.test(last.text) && now - last.at > UNANSWERED_REPLY_AFTER_MS && now - last.at < 21 * DAY) {
    findings.push({
      ...base,
      kind: "unanswered_reply",
      score: 70 + signals * 3 + (now - last.at < 3 * DAY ? 10 : 0),
      headline: `They texted ${ago(last.at, now)} and nobody has answered`,
      evidence: [`They said (${shortDate(last.at)}): ${quote(last.text)}`],
      suggested: "Answer their message, since it's the last word in the thread.",
    });
  }

  // Qualified on paper, and nobody has tried in days.
  const recentlyTried = lastAttempt && now - lastAttempt.at < QUALIFIED_UNTOUCHED_AFTER_MS;
  const recentInbound = lastReached && lastReached.direction === "in" && now - lastReached.at < QUALIFIED_UNTOUCHED_AFTER_MS;
  const ageOk = f.createdAt === null || now - f.createdAt < 60 * DAY;
  if (signals >= 3 && !recentlyTried && !recentInbound && !humanWorking && !irisSoon && ageOk && findings.length === 0) {
    findings.push({
      ...base,
      kind: "qualified_untouched",
      score: 55 + signals * 4,
      headline: `Qualified in the notes (${signals} details) and nobody has tried them for ${lastAttempt ? ago(lastAttempt.at, now).replace(" ago", "") : "days"}`,
      evidence: [`Notes: ${quote(f.notes)}`],
      suggested: "Call them: the qualifying is done, they only need the conversation with an agent.",
    });
  }
  return findings;
}

/** The post. */
export function formatFindings(findings: Finding[], scanned: number, max = 10): string {
  if (findings.length === 0) return `🔎 *Lead review:* I went through ${scanned} leads and found nobody who looks dropped.`;
  const lines = [`🔎 *Lead review: ${findings.length} lead${findings.length === 1 ? "" : "s"} worth checking in on* (of ${scanned} reviewed)`];
  for (const f of findings.slice(0, max)) {
    lines.push("", `*${f.name}* — ${f.stageName}`, `• ${f.headline}`);
    for (const e of f.evidence) lines.push(`• ${e}`);
    lines.push(`• Last tried: ${f.lastContact}`, `• _${f.suggested}_`);
  }
  if (findings.length > max) lines.push("", `…and ${findings.length - max} more.`);
  return lines.join("\n");
}

// Stages where the outcome is a person's: a lead who showed up, closed or is under contract is not a dropped ball,
// and No-Show cards have their own follow-up (agents/iris/no-show.ts).
const DEFAULT_SKIP_STAGES = ["Deal Closed", "Not Qualified/Not Interested", "International Numbers", "Listing Active", "Buyer Confirmed", "Seller Confirmed", "Showed Up", "No-Show"];

/** Eden's own test leads (Mark's and Jacob's test numbers and emails) must never show up as leads worth checking in on. */
export function isTestContact(contact: { email?: string | null; tags?: string[] }, emailDomains: string[] = []): boolean {
  const email = String(contact.email ?? "").toLowerCase();
  if (emailDomains.some((d) => email.endsWith(`@${d.toLowerCase()}`))) return true;
  return (contact.tags ?? []).some((t) => /^test$|test lead/i.test(String(t)));
}

export interface ReviewResult {
  findings: Finding[];
  scanned: number;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Reads the whole pipeline for one client. `onlyStages` narrows it (e.g. Ember's stages). */
export async function reviewClient(clientId: string, options: { now?: Date; onlyStages?: string[]; skipStages?: string[]; concurrency?: number } = {}): Promise<ReviewResult> {
  const now = options.now ?? new Date();
  const ghl = await getGhlConfig(clientId);
  const config = loadIrisConfig(clientId);
  if (!ghl || !config) return { findings: [], scanned: 0 };
  const skip = new Set((options.skipStages ?? DEFAULT_SKIP_STAGES).map((s) => s.toLowerCase()));
  const only = options.onlyStages ? new Set(options.onlyStages.map((s) => s.toLowerCase())) : null;

  const defs = await getCustomFieldDefs(ghl.locationId, ghl.apiKey);
  const keyToId = buildKeyToId(defs);
  const cards: { opp: any; stageName: string }[] = [];
  for (const p of await listPipelines(ghl.locationId, ghl.apiKey)) {
    for (const s of p.stages ?? []) {
      const name = String(s.name);
      if (skip.has(name.toLowerCase()) || (only && !only.has(name.toLowerCase()))) continue;
      for (const o of await listOpportunitiesInStage(ghl.locationId, p.id, s.id, ghl.apiKey)) if (o?.status !== "lost" && o?.status !== "won") cards.push({ opp: o, stageName: name });
    }
  }
  // One card per contact: the newest.
  const byContact = new Map<string, { opp: any; stageName: string }>();
  for (const c of cards) {
    const id = c.opp.contactId ?? c.opp.contact?.id;
    if (!id) continue;
    const prev = byContact.get(id);
    if (!prev || Date.parse(c.opp.updatedAt ?? 0) > Date.parse(prev.opp.updatedAt ?? 0)) byContact.set(id, c);
  }
  const ids = [...byContact.keys()];

  const calls = await query<{ contact_id: string; created_at: Date; ended_reason: string | null; transcript: string | null }>(
    `SELECT contact_id, created_at, ended_reason, transcript FROM iris_call_log WHERE client_id = $1 AND created_at > now() - interval '90 days'`,
    [clientId]
  );
  const callsBy = new Map<string, typeof calls>();
  for (const c of calls) callsBy.set(c.contact_id, [...(callsBy.get(c.contact_id) ?? []), c]);
  const queue = await query<{ contact_id: string; status: string; call_after: Date | string }>(`SELECT contact_id, status, call_after FROM iris_pending_calls WHERE client_id = $1`, [clientId]);
  const queueBy = new Map(queue.map((q) => [q.contact_id, q]));

  const results = await pool(ids, options.concurrency ?? 5, async (contactId): Promise<Finding[]> => {
    try {
      const { opp, stageName } = byContact.get(contactId)!;
      const rawContact = await getContact(contactId, ghl.locationId, ghl.apiKey);
      const contact = rawContact?.contact ?? rawContact;
      if (!contact) return [];
      if (config.leadReview?.excludeContactIds?.includes(contactId) || isTestContact(contact, config.leadReview?.excludeEmailDomains)) return [];
      const convo = await getConversations(contactId, ghl.locationId, ghl.apiKey);
      const convId = convo?.conversations?.[0]?.id;
      const messages: any[] = convId ? (await getConversationMessages(convId, ghl.locationId, ghl.apiKey, 80))?.messages?.messages ?? [] : [];
      const events = [...eventsFromMessages(messages), ...eventsFromIrisCalls(callsBy.get(contactId) ?? [])].sort((a, b) => a.at - b.at);
      const q = queueBy.get(contactId);
      const raw = q?.call_after as unknown;
      const callAfter = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? (/inf/i.test(raw) ? null : Date.parse(raw)) : typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      const facts: LeadFacts = {
        contactId,
        name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.name || contactId,
        stageName,
        tags: (contact.tags ?? []).map((t: string) => String(t)),
        dnd: contact.dnd === true,
        hasPhone: Boolean(contact.phone),
        notes: String(readField(contact.customFields, config.callbackNotesFieldKey, keyToId) ?? ""),
        assignedTo: contact.assignedTo ?? opp.assignedTo ?? null,
        createdAt: contact.dateAdded ? Date.parse(contact.dateAdded) : null,
        events,
        irisQueue: q ? { status: q.status, callAfter: callAfter !== null && Number.isFinite(callAfter) ? callAfter : null } : null,
      };
      const found = analyzeLead(facts, now);
      if (found.length === 0) return [];
      // Only now spend a call on appointments: a lead with one booked ahead is not dropped.
      const appts = await getContactAppointments(contactId, ghl.locationId, ghl.apiKey).catch(() => []);
      if (readAppointments(appts, now, config.timezone || "America/St_Johns").upcoming) return [];
      return found;
    } catch (error) {
      console.error(`[REVIEW] ${contactId}:`, error instanceof Error ? error.message : error);
      return [];
    }
  });
  // One finding per lead: the strongest.
  const best = new Map<string, Finding>();
  for (const f of results.flat()) if (!best.has(f.contactId) || best.get(f.contactId)!.score < f.score) best.set(f.contactId, f);
  return { findings: [...best.values()].sort((a, b) => b.score - a.score), scanned: ids.length };
}

// ─── Stored runs, snoozes, and the nightly loop ───

export interface StoredReview {
  ranAt: Date;
  scanned: number;
  findings: Finding[];
}

export async function saveReview(clientId: string, result: ReviewResult): Promise<void> {
  await query(`INSERT INTO lead_review_runs (client_id, scanned, findings) VALUES ($1, $2, $3)`, [clientId, result.scanned, JSON.stringify(result.findings)]);
  await query(`DELETE FROM lead_review_runs WHERE client_id = $1 AND ran_at < now() - interval '30 days'`, [clientId]);
}

/** The newest stored run with snoozed leads removed, or null when there has never been one. */
export async function latestReview(clientId: string): Promise<StoredReview | null> {
  const runs = await query<{ ran_at: Date; scanned: number; findings: Finding[] }>(
    `SELECT ran_at, scanned, findings FROM lead_review_runs WHERE client_id = $1 ORDER BY ran_at DESC LIMIT 1`,
    [clientId]
  );
  if (!runs[0]) return null;
  const snoozed = await query<{ contact_id: string }>(`SELECT contact_id FROM lead_review_snoozes WHERE client_id = $1 AND until > now()`, [clientId]);
  const hidden = new Set(snoozed.map((r) => r.contact_id));
  return { ranAt: new Date(runs[0].ran_at), scanned: runs[0].scanned, findings: (runs[0].findings ?? []).filter((f) => !hidden.has(f.contactId)) };
}

export type SnoozeResult = { status: "snoozed"; name: string; until: Date } | { status: "not_found" } | { status: "ambiguous"; candidates: string[] };

/** "Stop flagging Samir for two weeks": matches by name among the leads currently flagged. */
export async function snoozeByName(clientId: string, nameFragment: string, days: number, reason: string, requestedBy: string): Promise<SnoozeResult> {
  const review = await latestReview(clientId);
  const wanted = nameFragment.trim().toLowerCase();
  const matches = (review?.findings ?? []).filter((f) => f.name.toLowerCase().includes(wanted));
  if (!wanted || matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.map((m) => m.name) };
  const days_ = Math.min(Math.max(Math.round(days) || 14, 1), 120);
  const until = new Date(Date.now() + days_ * DAY);
  await query(
    `INSERT INTO lead_review_snoozes (client_id, contact_id, contact_name, until, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, contact_id) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason, requested_by = EXCLUDED.requested_by, created_at = now()`,
    [clientId, matches[0].contactId, matches[0].name, until, reason, requestedBy]
  );
  return { status: "snoozed", name: matches[0].name, until };
}

/** The stored review as a post, for Iris (everything) or Ember (only her stages). */
export function reviewForLens(review: StoredReview, lens: "iris" | "ember", emberStages: string[] = [], max = 10): { findings: Finding[]; text: string } {
  const stages = new Set(emberStages.map((s) => s.toLowerCase()));
  const findings = lens === "ember" ? review.findings.filter((f) => stages.has(f.stageName.toLowerCase())) : review.findings;
  const ranAgo = Math.max(1, Math.round((Date.now() - review.ranAt.getTime()) / HOUR));
  return { findings, text: `${formatFindings(findings, review.scanned, 10)}
_(reviewed ${ranAgo}h ago; the review runs every night)_` };
}

/** Scheduler entry point (nightly). One client failing never stops the next. */
export async function runNightlyLeadReview(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await import("fs")).readdirSync((await import("path")).join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    if (!loadIrisConfig(clientId)?.leadReview) continue;
    try {
      const result = await reviewClient(clientId);
      await saveReview(clientId, result);
      console.log(`[REVIEW] ${clientId}: ${result.findings.length} worth checking in on, of ${result.scanned} reviewed.`);
    } catch (error) {
      console.error(`[REVIEW] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
