/**
 * The status transitions that end a lead's cadence because something
 * happened on the lead's side, plus the #backend-ops alert that goes with
 * reactivation. Shared by all three places that can notice it — the hourly
 * scan, the GHL webhooks, and the pre-send recheck — so the same event
 * produces the same row state and the same alert whichever sees it first.
 */
import { sendMessage } from "../../shared/slack";
import { transitionStatus } from "./store";
import { NurtureLead } from "./types";

export type AlertFn = (text: string) => Promise<void>;

/**
 * Posts as Ember, falling back to the EDEN bot. EMBER_BOT_TOKEN was not set
 * in the local .env when Ember was built (2026-09-23), and an alert that
 * silently fails because one agent's bot isn't installed is exactly the
 * "Lead X is showing buying signals" message nobody ever sees.
 */
export function slackAlert(channel: string): AlertFn {
  return async (text: string) => {
    try {
      await sendMessage("ember", { channel, text });
      return;
    } catch (error) {
      console.warn("[EMB] posting as Ember failed, retrying as EDEN:", error instanceof Error ? error.message : error);
    }
    await sendMessage("eden", { channel, text });
  };
}

function monthsAgo(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const months = Math.floor((now.getTime() - new Date(iso).getTime()) / (30 * 86_400_000));
  if (months < 1) return "under a month ago";
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export function formatReactivationAlert(
  lead: NurtureLead,
  reason: string,
  clientName: string,
  now: Date = new Date()
): string {
  const who = lead.contactName || lead.phone || lead.email || lead.ghlContactId;
  const since = monthsAgo(lead.inquiryAt, now);
  const lines = [
    `🔥 *Reactivation* — ${clientName}`,
    `*${who}*${since ? ` (first inquired ${since})` : ""} is showing buying signals again: ${reason}.`,
    `Ember had sent ${lead.touchCount} nurture touch${lead.touchCount === 1 ? "" : "es"}; the cadence is stopped so a human can take it from here.`,
  ];
  const contact = [lead.phone, lead.email].filter(Boolean).join(" · ");
  if (contact) lines.push(contact);
  return lines.join("\n");
}

/** Statuses a reactivation can still happen from. `completed` is included on
 *  purpose: a lead who ignored every touch and then moves months later is
 *  exactly the case the alert exists for. */
export const REACTIVATABLE = ["nurturing", "paused", "completed"];

/**
 * Marks a lead reactivated and alerts. Returns false (and does nothing) if
 * the lead is already in a state where this would be a duplicate or wrong —
 * the scan and a webhook can both see the same stage move.
 */
export async function markReactivated(
  lead: NurtureLead,
  reason: string,
  ctx: { clientName: string; alert: AlertFn; now?: Date }
): Promise<boolean> {
  const now = ctx.now ?? new Date();
  const won = await transitionStatus(lead.id, REACTIVATABLE, {
    status: "reactivated",
    statusReason: reason,
    reactivatedAt: now.toISOString(),
    nextTouchAt: null,
  });
  if (!won) return false;
  try {
    await ctx.alert(formatReactivationAlert(lead, reason, ctx.clientName, now));
  } catch (error) {
    // The row is already marked; a failed Slack post must not undo that or
    // the cadence would resume texting someone a human should be calling.
    console.error(`[EMB] reactivation alert failed for lead ${lead.id}:`, error);
  }
  return true;
}

/** The deal closed or was marked lost — stop quietly, nothing to alert. */
export async function markExited(lead: NurtureLead, reason: string): Promise<boolean> {
  return transitionStatus(lead.id, REACTIVATABLE, { status: "exited", statusReason: reason, nextTouchAt: null });
}
