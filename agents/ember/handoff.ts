/**
 * Ember → Iris handoff. Mark, 2026-09-24: the goal for an old lead is the
 * same as for a new one — qualify them (plans, timeline, budget...) and get
 * them live-transferred to an agent. Iris already qualifies by text
 * (agents/iris/sms.ts) and places the transfer calls, so Ember doesn't
 * build a second qualifier: when an old lead replies to a reactivation
 * text, Ember opens an Iris row for them (source 'ember') and passes the
 * reply straight to Iris, who answers it and takes the conversation from
 * there. New and old leads are then scored and transferred identically.
 */
import { refreshLead } from "../scout";
import { loadIrisConfig } from "../iris";
import { clampToLegalCallingWindow } from "../iris/cadence";
import { irisHandleInboundSms } from "../iris/sms";
import { AlertFn, formatReactivationAlert, REACTIVATABLE } from "./alerts";
import { EmberConfig } from "./config";
import { transitionStatus, upsertIrisHandoff } from "./store";
import { NurtureLead } from "./types";

/**
 * If the text conversation goes quiet after they reply, Iris makes ONE
 * call attempt this long after the reply (row is one-shot — see
 * upsertIrisHandoff). Iris's pause-while-texting gate holds it off while
 * they're still actively texting.
 */
const COLD_FALLBACK_CALL_HOURS = 24;

export type HandoffResult = "handed_off" | "not_available";

export interface HandoffDeps {
  refreshLead: typeof refreshLead;
  irisHandleInboundSms: typeof irisHandleInboundSms;
}

const LIVE_DEPS: HandoffDeps = { refreshLead, irisHandleInboundSms };

export async function handOffToIris(
  lead: NurtureLead,
  text: string,
  ctx: { config: EmberConfig; clientName: string; alert: AlertFn; now?: Date; deps?: HandoffDeps }
): Promise<HandoffResult> {
  const deps = ctx.deps ?? LIVE_DEPS;
  const now = ctx.now ?? new Date();
  const irisConfig = loadIrisConfig(lead.clientId);
  if (!irisConfig) return "not_available";

  // Fresh read, same as every Iris dial: the snapshot Ember took at
  // enrollment can be weeks old.
  const fresh = await deps.refreshLead(lead.ghlContactId, lead.clientId);
  if (!fresh || !fresh.phone) return "not_available";
  const leadForIris = { ...fresh, intent: fresh.intent !== "unknown" ? fresh.intent : lead.intent };

  const timezone = irisConfig.timezone || ctx.config.timezone;
  const callAfter = clampToLegalCallingWindow(new Date(now.getTime() + COLD_FALLBACK_CALL_HOURS * 3_600_000), timezone);
  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 140);

  // Row state first: if the Iris row or the transition fails, nothing has
  // been sent yet and the reply falls back to a plain human alert.
  const claimed = await transitionStatus(lead.id, [...REACTIVATABLE, "replied"], {
    status: "handed_off",
    statusReason: `replied "${snippet}" — handed to Iris`,
    repliedAt: now.toISOString(),
    nextTouchAt: null,
  });
  if (!claimed) return "handed_off"; // another path already handed this lead off
  await upsertIrisHandoff(lead.clientId, lead.ghlContactId, leadForIris, callAfter);

  try {
    await ctx.alert(
      formatReactivationAlert(
        lead,
        `replied "${snippet}" — Iris is qualifying them by text and will call for a live transfer if they qualify`,
        ctx.clientName,
        now
      )
    );
  } catch (error) {
    console.error(`[EMB] handoff alert failed for lead ${lead.id}:`, error);
  }

  const answered = await deps.irisHandleInboundSms(lead.ghlContactId, text);
  if (!answered) {
    console.warn(`[EMB] Iris did not pick up the handoff for lead ${lead.id} — the reply is unanswered, a human should follow up.`);
  }
  return "handed_off";
}
