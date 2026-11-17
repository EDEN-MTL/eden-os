/**
 * Iris's weekly patterns digest (Mark, 2026-11-18): "how can I make Iris smarter, able to see patterns and repetitive
 * problems on her own?" Today a person notices that four leads hung up at the same question, or that she slipped out of
 * character twice, and then asks for a fix. This reads Iris's own records for the last seven days (calls and their
 * transcripts, what the stuck-lead check did) and says what keeps repeating, against the week before, so a repeat is
 * visible the first week it happens and a pattern that comes back is called out as one.
 *
 * Read-only and free: no AI model, no GHL calls, nothing is changed or sent to a lead. It only messages the people in
 * `iris.patternDigest.userIds`. Every "pattern" is a plain count over transcripts, so it can be checked by hand; each
 * comes with the thing a person should look at, never a change Iris makes herself. A person approves the fix (that is
 * the next step up; this is the first one).
 */
import { readdirSync } from "fs";
import { join } from "path";
import { query } from "../../shared/db";
import { sendMessage } from "../../shared/slack";
import { loadIrisConfig } from "./index";
import { callAnswered } from "./followup-cohort";
import { reviewCall } from "./call-review";

export interface PatternDigestConfig {
  enabled: boolean;
  /** Slack user ids the digest is DMed to. */
  userIds: string[];
  /** A hang-up topic or a repeated problem is only called a pattern from this many calls. */
  minRepeat: number;
  lookbackDays: number;
}

export const DEFAULT_PATTERN_DIGEST = { minRepeat: 3, lookbackDays: 7 };

export interface DigestCall {
  contactId: string | null;
  name: string;
  endedReason: string | null;
  transcript: string | null;
  seconds: number;
}

export interface DigestAction {
  name: string;
  action: string;
}

export interface WeekData {
  calls: DigestCall[];
  actions: DigestAction[];
}

export interface TranscriptLine {
  role: "bot" | "user";
  message: string;
}

/** The call log keeps the transcript as "AI: …" / "User: …" lines. */
export function parseTranscript(transcript: string | null): TranscriptLine[] {
  if (!transcript) return [];
  const lines: TranscriptLine[] = [];
  for (const raw of transcript.split("\n")) {
    const m = raw.match(/^\s*(AI|User)\s*:\s*(.*)$/i);
    if (m) lines.push({ role: m[1].toLowerCase() === "ai" ? "bot" : "user", message: m[2].trim() });
    else if (raw.trim() && lines.length) lines[lines.length - 1].message += ` ${raw.trim()}`;
  }
  return lines.filter((l) => l.message !== "");
}

/** What Iris was doing when the lead hung up, from her last line. */
export type Topic = "opening" | "ai_question" | "timeline" | "budget" | "area" | "home_type" | "preapproval" | "realtor" | "connect" | "other";

export function topicOf(botLine: string): Topic {
  const t = botLine.toLowerCase();
  if (/connect you with|one of our (?:buyer |seller )?agents|is that okay/.test(t)) return "connect";
  if (/pre-?approv|mortgage/.test(t)) return "preapproval";
  if (/working with (?:a |an )?(?:realtor|agent)|have an agent|realtor/.test(t)) return "realtor";
  if (/budget|dollars|price range|how much/.test(t)) return "budget";
  if (/timeline|time frame|timeframe|what month|when are you|how soon/.test(t)) return "timeline";
  if (/what area|which area|where are you|neighbou?rhood|looking in/.test(t)) return "area";
  if (/type of home|bedroom|bungalow|town ?house|what kind of home/.test(t)) return "home_type";
  if (/computer or human|an ai|assistant/.test(t)) return "ai_question";
  if (/am i speaking with|how are you doing|this is iris/.test(t)) return "opening";
  return "other";
}

const TOPIC_PHRASE: Record<Topic, string> = {
  opening: "had only just introduced herself",
  ai_question: "was answering whether she is an AI",
  timeline: "asked about their timeline",
  budget: "asked about their budget",
  area: "asked what area they want",
  home_type: "asked what kind of home or how many bedrooms",
  preapproval: "asked about pre-approval",
  realtor: "asked whether they work with a realtor",
  connect: "asked to connect them with an agent",
  other: "was partway through a question",
};

const TOPIC_ADVICE: Record<Topic, string> = {
  opening: "The first ten seconds: the opener, or calls landing at a bad moment.",
  ai_question: "How she answers and moves on after being asked if she is an AI.",
  timeline: "How the timeline question is worded: does it feel like a quiz?",
  budget: "How the budget question is worded: a lead who gave a range may not want to name a number.",
  area: "Whether the area question needs an easier way to answer (a place name Iris keeps mishearing?).",
  home_type: "Whether the home-type question comes too early, or is mis-heard on a bad line.",
  preapproval: "Whether pre-approval feels like a credit check at that point in the call.",
  realtor: "Whether the realtor question sounds like she is checking whether they are taken.",
  connect: "The ask to connect with an agent: leads hang up before saying yes. Check the wording and whether a time can be offered first.",
  other: "Read two of the transcripts; the cause is not one question.",
};

const SLIP = /\bi(?:'|’)?m claude\b|language model|text[- ]based ai|i should clarify|i(?:'|’)?m not actually on a phone|as an ai assistant, i (?:can(?:not|'t)|don't)/i;
const AUDIO_TROUBLE = /line (?:broke|cut|is breaking)|breaking up|cut out|didn(?:'|’)?t (?:quite )?(?:catch|get) (?:that|what)|could you say that again|repeat that/i;
const ASKED_TO_WAIT = /\b(?:hold on|one second|one sec|hang on|give me a (?:sec|minute|moment)|call me (?:back )?(?:later|tomorrow)|call (?:me )?later|i(?:'|’)?m (?:at work|busy|driving)|not a good time|bad time|can(?:'|’)?t talk)\b/i;

export interface CallFacts {
  call: DigestCall;
  lines: TranscriptLine[];
  connected: boolean;
  transferred: boolean;
  hungUp: boolean;
  lastTopic: Topic | null;
  slipped: boolean;
  audioTrouble: boolean;
  askedToWait: boolean;
  flags: string[];
}

export function factsFor(call: DigestCall): CallFacts {
  const lines = parseTranscript(call.transcript);
  const connected = callAnswered({ ended_reason: call.endedReason, transcript: call.transcript } as never) && lines.some((l) => l.role === "user");
  const transferred = call.endedReason === "assistant-forwarded-call";
  const hungUp = connected && call.endedReason === "customer-ended-call";
  const lastBot = [...lines].reverse().find((l) => l.role === "bot");
  const bot = lines.filter((l) => l.role === "bot");
  const user = lines.filter((l) => l.role === "user");
  const flags = connected
    ? reviewCall({ lines, endedReason: call.endedReason, durationSeconds: call.seconds, machineOnly: false, transferSucceeded: transferred }).flags
    : [];
  return {
    call,
    lines,
    connected,
    transferred,
    hungUp,
    lastTopic: hungUp && lastBot ? topicOf(lastBot.message) : null,
    slipped: bot.some((l) => SLIP.test(l.message)),
    audioTrouble: bot.filter((l) => AUDIO_TROUBLE.test(l.message)).length >= 2,
    askedToWait: connected && user.some((l) => ASKED_TO_WAIT.test(l.message)) && !transferred,
    flags,
  };
}

/** A short, stable name for a review flag, so "Iris said a figure the wrong way" counts as one kind of problem. */
export function flagKind(flag: string): string {
  return flag.split(/[:(]/)[0].replace(/\s+/g, " ").trim().replace(/[.,;]$/, "");
}

export interface WeekStats {
  total: number;
  connected: number;
  transferred: number;
  hangups: number;
  byTopic: Map<Topic, string[]>;
  byFlag: Map<string, string[]>;
  slips: string[];
  audio: string[];
  waits: string[];
  actions: Map<string, number>;
  personNames: string[];
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

export function weekStats(data: WeekData): WeekStats {
  const facts = data.calls.map(factsFor);
  const byTopic = new Map<Topic, string[]>();
  const byFlag = new Map<string, string[]>();
  for (const f of facts) {
    if (f.lastTopic) byTopic.set(f.lastTopic, [...(byTopic.get(f.lastTopic) ?? []), f.call.name]);
    for (const k of unique(f.flags.map(flagKind))) byFlag.set(k, [...(byFlag.get(k) ?? []), f.call.name]);
  }
  const actions = new Map<string, number>();
  for (const a of data.actions) actions.set(a.action, (actions.get(a.action) ?? 0) + 1);
  return {
    total: facts.length,
    connected: facts.filter((f) => f.connected).length,
    transferred: facts.filter((f) => f.transferred).length,
    hangups: facts.filter((f) => f.hungUp).length,
    byTopic,
    byFlag,
    slips: facts.filter((f) => f.slipped).map((f) => f.call.name),
    audio: facts.filter((f) => f.audioTrouble).map((f) => f.call.name),
    waits: facts.filter((f) => f.askedToWait).map((f) => f.call.name),
    actions,
    personNames: unique(data.actions.filter((a) => a.action === "person").map((a) => a.name)),
  };
}

export interface Pattern {
  key: string;
  headline: string;
  who: string[];
  count: number;
  advice: string;
  lastWeek: number;
}

export function findPatterns(cur: WeekStats, prev: WeekStats, minRepeat: number): Pattern[] {
  const out: Pattern[] = [];
  for (const [topic, who] of cur.byTopic) {
    if (who.length < minRepeat) continue;
    out.push({
      key: `hangup:${topic}`,
      headline: `${who.length} of ${cur.hangups} hang-ups came right after Iris ${TOPIC_PHRASE[topic]}`,
      who,
      count: who.length,
      advice: TOPIC_ADVICE[topic],
      lastWeek: prev.byTopic.get(topic)?.length ?? 0,
    });
  }
  for (const [kind, who] of cur.byFlag) {
    if (who.length < Math.max(2, minRepeat - 1)) continue;
    out.push({
      key: `flag:${kind}`,
      headline: `${who.length} calls were flagged by the call review: ${kind}`,
      who,
      count: who.length,
      advice: "Open two of them in the call log; the review quotes the exact line.",
      lastWeek: prev.byFlag.get(kind)?.length ?? 0,
    });
  }
  if (cur.slips.length >= 1) {
    out.push({ key: "slip", headline: `Iris stepped out of character on ${cur.slips.length} call${cur.slips.length === 1 ? "" : "s"} (said she is Claude or a text-based AI)`, who: cur.slips, count: cur.slips.length, advice: "Read the line in the transcript. This one is always a bug, never a pattern to live with.", lastWeek: prev.slips.length });
  }
  if (cur.audio.length >= minRepeat) {
    out.push({ key: "audio", headline: `${cur.audio.length} calls had Iris asking the lead to repeat themselves two or more times`, who: cur.audio, count: cur.audio.length, advice: "A bad line, or a speech-recognition problem with names and places (Montrose / Mount Pearl). Check whether it is the same words each time.", lastWeek: prev.audio.length });
  }
  if (cur.waits.length >= Math.max(2, minRepeat - 1)) {
    out.push({ key: "waits", headline: `${cur.waits.length} leads said they were busy, asked to hold, or asked for a call later`, who: cur.waits, count: cur.waits.length, advice: "Check each got a callback time or a text, not a quiet ending.", lastWeek: prev.waits.length });
  }
  return out.sort((a, b) => Number(b.lastWeek > 0) - Number(a.lastWeek > 0) || b.count - a.count);
}

const names = (list: string[], max = 4): string => {
  const u = unique(list);
  return u.length <= max ? u.join(", ") : `${u.slice(0, max).join(", ")} and ${u.length - max} more`;
};
const pct = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : "–");

export function formatPatternDigest(label: string, cur: WeekStats, prev: WeekStats, patterns: Pattern[]): string {
  const lines: string[] = [`📊 *Iris weekly patterns* — ${label}`, ""];
  lines.push(
    `*The week:* ${cur.total} calls (${prev.total} the week before); ${cur.connected} reached a person (${pct(cur.connected, cur.total)}, was ${pct(prev.connected, prev.total)}); ${cur.transferred} transferred (was ${prev.transferred}); ${cur.hangups} hung up mid-call (was ${prev.hangups}).`
  );
  const done = ["call_again", "text_follow_up", "park_not_ready", "close_wrong_number"].map((k) => [k, cur.actions.get(k) ?? 0] as const).filter(([, n]) => n > 0);
  const label2: Record<string, string> = { call_again: "calls queued", text_follow_up: "follow-up texts", park_not_ready: "moved to Not Ready", close_wrong_number: "wrong numbers closed" };
  if (done.length) lines.push(`*Stuck-lead check:* ${done.map(([k, n]) => `${n} ${label2[k]}`).join(", ")}.`);

  lines.push("");
  if (patterns.length === 0) {
    lines.push("*Patterns:* nothing repeated enough this week to call a pattern.");
  } else {
    lines.push("*What keeps repeating:*");
    patterns.forEach((p, i) => {
      const again = p.lastWeek > 0 ? ` ⚠️ _again: ${p.lastWeek} last week_` : "";
      lines.push(`${i + 1}. ${p.headline} (${names(p.who)}).${again}`);
      lines.push(`    _Worth a look:_ ${p.advice}`);
    });
  }

  const stillWaiting = cur.personNames.filter((n) => prev.personNames.includes(n));
  if (stillWaiting.length) lines.push("", `*Still waiting on a person for a second week:* ${names(stillWaiting, 8)}.`);
  lines.push("", "_Counts come straight from the call transcripts, so each can be checked by hand. Tell me which to fix and I will build it with a test._");
  return lines.join("\n");
}

// ─── The scan ───

const DAY = 86_400_000;

async function loadWeek(clientId: string, from: Date, to: Date): Promise<WeekData> {
  const calls = await query<{ contact_id: string | null; ended_reason: string | null; transcript: string | null; created_at: Date; ended_at: Date | null; name: string | null }>(
    `SELECT l.contact_id, l.ended_reason, l.transcript, l.created_at, l.ended_at,
            (SELECT p.lead->>'name' FROM iris_pending_calls p WHERE p.client_id = l.client_id AND p.contact_id = l.contact_id ORDER BY p.created_at DESC LIMIT 1) AS name
       FROM iris_call_log l
      WHERE l.client_id = $1 AND l.triggered_by = 'automatic' AND l.status = 'ended' AND l.created_at >= $2 AND l.created_at < $3`,
    [clientId, from, to]
  );
  const actions = await query<{ contact_name: string | null; action: string }>(
    `SELECT contact_name, action FROM iris_stuck_actions WHERE client_id = $1 AND created_at >= $2 AND created_at < $3`,
    [clientId, from, to]
  );
  return {
    calls: calls.map((c) => ({
      contactId: c.contact_id,
      name: c.name?.trim() || "a lead",
      endedReason: c.ended_reason,
      transcript: c.transcript,
      seconds: c.ended_at ? Math.max(0, (new Date(c.ended_at).getTime() - new Date(c.created_at).getTime()) / 1000) : 0,
    })),
    actions: actions.map((a) => ({ name: a.contact_name?.trim() || "a lead", action: a.action })),
  };
}

const fmtDay = (d: Date): string => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/St_Johns" });

export async function runPatternDigest(clientId: string, options: { now?: Date; send?: boolean } = {}): Promise<{ text: string | null; patterns: Pattern[] }> {
  const cfg = loadIrisConfig(clientId)?.patternDigest;
  if (!cfg?.enabled) return { text: null, patterns: [] };
  const now = options.now ?? new Date();
  const span = cfg.lookbackDays * DAY;
  const [curData, prevData] = await Promise.all([loadWeek(clientId, new Date(now.getTime() - span), now), loadWeek(clientId, new Date(now.getTime() - 2 * span), new Date(now.getTime() - span))]);
  const cur = weekStats(curData);
  const prev = weekStats(prevData);
  const patterns = findPatterns(cur, prev, cfg.minRepeat);
  const text = formatPatternDigest(`${fmtDay(new Date(now.getTime() - span))} to ${fmtDay(now)}`, cur, prev, patterns);
  if (options.send) {
    const recipients = cfg.userIds.length ? cfg.userIds : (loadIrisConfig(clientId)?.callAlerts?.userIds ?? []);
    for (const userId of recipients) {
      await sendMessage("iris", { channel: userId, text }).catch((error) => console.error("[PATTERNS] Slack DM failed:", error instanceof Error ? error.message : error));
    }
  }
  return { text, patterns };
}

export async function runPatternDigestAll(): Promise<void> {
  let files: string[] = [];
  try {
    files = readdirSync(join(process.cwd(), "config", "clients"));
  } catch {
    return;
  }
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const clientId = f.replace(/\.json$/, "");
    if (!loadIrisConfig(clientId)?.patternDigest?.enabled) continue;
    try {
      const r = await runPatternDigest(clientId, { send: true });
      console.log(`[PATTERNS] ${clientId}: ${r.patterns.length} pattern(s) sent.`);
    } catch (error) {
      console.error(`[PATTERNS] ${clientId}:`, error instanceof Error ? error.message : error);
    }
  }
}
