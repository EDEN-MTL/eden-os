import { Language } from "./config";
import { LeadInfo, VisitWindow } from "./lead-info";

/**
 * What the owner reads when a lead needs him. Built here from the facts Iris actually collected —
 * never composed by the model — so an alert cannot contain anything the lead did not say.
 */

export type AlertKind = "looseDay" | "looseNight" | "needsPedro";

const WINDOW_LABEL: Record<Language, Record<VisitWindow, string>> = {
  fr: { morning: "matin", afternoon: "après-midi", evening: "soir", anytime: "n'importe quand" },
  en: { morning: "morning", afternoon: "afternoon", evening: "evening", anytime: "any time" },
};

const unknown = (v: string | undefined) => v ?? "?";

function address(info: LeadInfo): string {
  const parts = [info.street, info.city, info.postalCode].filter(Boolean);
  return parts.length ? parts.join(", ") : "?";
}

function job(info: LeadInfo): string {
  return [info.size ? `~${info.size}` : null, info.service, info.woodType, info.condition].filter(Boolean).join(" · ") || "?";
}

function availability(info: LeadInfo, language: Language): string {
  const window = info.visitWindow ? WINDOW_LABEL[language][info.visitWindow] : "?";
  return [window, info.availabilityNotes, info.timing].filter(Boolean).join(" · ");
}

export function formatAlert(kind: AlertKind, info: LeadInfo, language: Language, opts: { reason?: string } = {}): string {
  const fr = language === "fr";
  const name = unknown(info.fullName);

  if (kind === "needsPedro") {
    return [`🔴 NEEDS PEDRO: ${name}${info.city ? `, ${info.city}` : ""}`, opts.reason ?? "?", info.phone ? `📞 ${info.phone}` : null].filter(Boolean).join("\n");
  }

  const header = kind === "looseDay" ? (fr ? "🟡 LOOSE – JOUR" : "🟡 LOOSE – DAY") : fr ? "🌙 LOOSE – SOIR" : "🌙 LOOSE – NIGHT";
  const lines = [
    `${header}: ${name}`,
    `📍 ${address(info)}`,
    `📞 ${unknown(info.phone)}`,
    `📐 ${job(info)}`,
    `🕒 ${fr ? "Disponible" : "Available"}: ${availability(info, language)}`,
    `📷 ${fr ? "Photos" : "Photos"}: ${info.photosReceived ? (fr ? "oui" : "yes") : fr ? "non" : "no"}`,
  ];
  if (info.otherNotes) lines.push(`📝 ${info.otherNotes}`);
  if (info.openQuestions) lines.push(`❓ ${info.openQuestions}`);
  lines.push(fr ? "Détails dans les notes GHL." : "Details in the GHL notes.");
  return lines.join("\n");
}

/**
 * The text the GHL workflow sends the owner: the "ISA Notes" contact field. Plain text, no emoji (an emoji
 * pushes an SMS into the expensive 70-character encoding), one fact per line, built only from collected facts.
 */
export function formatIsaNotes(kind: AlertKind, info: LeadInfo, language: Language, opts: { reason?: string } = {}): string {
  const fr = language === "fr";
  const name = unknown(info.fullName);
  const lines: string[] = [];
  if (kind === "needsPedro") {
    lines.push(`${fr ? "À RAPPELER" : "NEEDS PEDRO"}: ${name}`, `${fr ? "Raison" : "Reason"}: ${opts.reason ?? "?"}`);
  } else {
    const header = kind === "looseDay" ? (fr ? "LOOSE JOUR" : "LOOSE DAY") : fr ? "LOOSE SOIR" : "LOOSE NIGHT";
    lines.push(`${header}: ${name}`);
  }
  lines.push(`${fr ? "Adresse" : "Address"}: ${address(info)}`, `${fr ? "Tél" : "Phone"}: ${unknown(info.phone)}`);
  lines.push(`${fr ? "Travaux" : "Job"}: ${job(info)}`);
  lines.push(`${fr ? "Disponible" : "Available"}: ${availability(info, language)}`);
  lines.push(`Photos: ${info.photosReceived ? (fr ? "oui" : "yes") : fr ? "non" : "no"}`);
  if (info.otherNotes) lines.push(`Notes: ${info.otherNotes}`);
  if (info.openQuestions) lines.push(`${fr ? "À clarifier" : "To clarify"}: ${info.openQuestions}`);
  return lines.join("\n");
}

export interface DigestLead {
  info: LeadInfo;
  column: "looseDay" | "looseNight";
}

/** The weekday-morning list: open loose leads grouped by neighbourhood, so visits can be planned around where the crew is working. */
export function formatDigest(leads: DigestLead[], language: Language): string | null {
  if (leads.length === 0) return null;
  const fr = language === "fr";
  const byArea = new Map<string, DigestLead[]>();
  for (const lead of leads) {
    const area = lead.info.city ?? (fr ? "Secteur inconnu" : "Unknown area");
    byArea.set(area, [...(byArea.get(area) ?? []), lead]);
  }
  const lines = [fr ? `☀️ Estimations à planifier (${leads.length})` : `☀️ Estimates to schedule (${leads.length})`];
  for (const [area, group] of [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`\n${area}`);
    for (const { info } of group) {
      lines.push(`• ${unknown(info.fullName)} (${availability(info, language)}): ${job(info)}, ${address(info)}, ${unknown(info.phone)}`);
    }
  }
  return lines.join("\n");
}
