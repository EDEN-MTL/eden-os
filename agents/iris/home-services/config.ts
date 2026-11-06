import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Per-client config for Iris's home-services text flow (Matama Floors first), read from the
 * `irisHomeServices` block of config/clients/<id>.json. Separate from the real-estate `iris`
 * block on purpose: that one is built around buy/sell intents, ring-group transfers and Vapi
 * calls, none of which a floor-sanding estimate has.
 */

export const COLUMN_KEYS = ["day1", "day2", "day3", "looseDay", "looseNight"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

/** The columns Iris moves a qualified lead into. Only the owner moves a lead back out. */
export const APPOINTMENT_COLUMNS: ReadonlySet<ColumnKey> = new Set(["looseDay", "looseNight"]);

export type Language = "fr" | "en";

export interface HomeServicesConfig {
  clientId: string;
  enabled: boolean;
  /** dry_run: nothing reaches a lead or GHL — drafts and intended actions are posted to Slack instead. */
  mode: "dry_run" | "live";
  timezone: string;
  /** The pipeline the columns belong to. The GHL location also holds unrelated pipelines. */
  pipelineId: string;
  ownerName: string;
  /**
   * Pipeline column per key, as the stage's name (or id). Names are resolved against the live
   * pipeline on every run, so a renamed or deleted column fails loudly instead of moving a lead
   * into the wrong place.
   */
  columns: Record<ColumnKey, string>;
  /** Stages whose cards become Iris conversations (names or ids). */
  intakeStages: string[];
  /**
   * What Iris sends on her own. Both default off: Matama's GHL automation already sends the
   * introduction and the first question, and Iris picks up when the lead replies.
   */
  outreach: { firstTouch: boolean; followups: boolean };
  /**
   * Only leads created at or after this instant are ever enrolled. Everything older is backlog,
   * and texting it is a consent decision (CASL) that has not been made.
   */
  enrollNotBefore: string | null;
  quietHours: { startHour: number; endHour: number };
  /** null = Iris never states a number. Anything she states must be exactly what the owner approved. */
  approvedPricingLine: string | null;
  /** Free text, e.g. "December" — what Iris may say about when new work can start. */
  bookingFrom: string | null;
  largeJobSqFt: number | null;
  /**
   * How the owner hears about a lead. The real alert is a GHL workflow built by the owner's team: Iris fills the
   * contact custom field named `isaNotesField` BEFORE moving the card / adding the tag, and the workflow
   * (trigger: pipeline stage changed to a Loose column, or tag "Needs Pedro" added) texts that field to the owner.
   * `slackChannel` is only an optional mirror for the team.
   */
  isaNotesField: string;
  notify: { language: Language; slackChannel: string | null };
  tags: { needsPedro: string; photoQuote: string; outOfArea: string; notInterested: string; dnd: string; longTermNurture: string };
  /** Contact custom-field key for the lead's language; a tag of "english" / "french" also works. */
  languageFieldKey: string | null;
}

const DEFAULT_TAGS: HomeServicesConfig["tags"] = {
  needsPedro: "Needs Pedro",
  photoQuote: "Photo Quote Request",
  outOfArea: "Out of Area",
  notInterested: "Not Interested",
  dnd: "DND",
  longTermNurture: "Long-term Nurture",
};

function clientConfigDir(): string {
  return join(process.cwd(), "config", "clients");
}

export function parseHomeServicesConfig(raw: any): HomeServicesConfig | null {
  const block = raw?.irisHomeServices;
  if (!block || typeof block !== "object") return null;
  const columns = {} as Record<ColumnKey, string>;
  for (const key of COLUMN_KEYS) columns[key] = String(block.columns?.[key] ?? "");
  return {
    clientId: String(raw.clientId),
    enabled: block.enabled === true,
    mode: block.mode === "live" ? "live" : "dry_run",
    timezone: block.timezone || "America/Toronto",
    pipelineId: String(raw.ghl?.pipelineId ?? ""),
    ownerName: block.ownerName || "Pedro",
    columns,
    intakeStages: Array.isArray(block.intakeStages) ? block.intakeStages.filter(Boolean) : [],
    outreach: { firstTouch: block.outreach?.firstTouch === true, followups: block.outreach?.followups === true },
    enrollNotBefore: typeof block.enrollNotBefore === "string" && block.enrollNotBefore ? block.enrollNotBefore : null,
    quietHours: { startHour: block.quietHours?.startHour ?? 9, endHour: block.quietHours?.endHour ?? 20 },
    approvedPricingLine: typeof block.approvedPricingLine === "string" && block.approvedPricingLine.trim() ? block.approvedPricingLine.trim() : null,
    bookingFrom: typeof block.bookingFrom === "string" && block.bookingFrom.trim() ? block.bookingFrom.trim() : null,
    largeJobSqFt: typeof block.largeJobSqFt === "number" ? block.largeJobSqFt : null,
    isaNotesField: typeof block.isaNotesField === "string" && block.isaNotesField.trim() ? block.isaNotesField.trim() : "ISA Notes",
    notify: {
      language: block.notify?.language === "en" ? "en" : "fr",
      slackChannel: block.notify?.slackChannel || raw.slack?.clientChannel || null,
    },
    tags: { ...DEFAULT_TAGS, ...(block.tags ?? {}) },
    languageFieldKey: block.languageFieldKey || null,
  };
}

export function loadHomeServicesConfig(clientId: string): HomeServicesConfig | null {
  try {
    return parseHomeServicesConfig(JSON.parse(readFileSync(join(clientConfigDir(), `${clientId}.json`), "utf-8")));
  } catch {
    return null;
  }
}

export function listHomeServicesClientIds(): string[] {
  try {
    return readdirSync(clientConfigDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => loadHomeServicesConfig(id) !== null);
  } catch {
    return [];
  }
}

/** The Day 1-3 columns only matter when Iris runs the outreach cadence herself. */
export function requiredColumns(config: HomeServicesConfig): ColumnKey[] {
  const base: ColumnKey[] = ["looseDay", "looseNight"];
  return config.outreach.firstTouch || config.outreach.followups ? ["day1", "day2", "day3", ...base] : base;
}

/**
 * Why this client cannot run yet, or null when it can. A half-filled block must fail loudly here
 * rather than moving leads into a column that is "" or texting before anyone has said go.
 */
export function readinessProblem(config: HomeServicesConfig): string | null {
  if (!config.pipelineId) return "ghl.pipelineId is not set";
  const missingColumns = requiredColumns(config).filter((k) => !config.columns[k]);
  if (missingColumns.length) return `pipeline columns not set: ${missingColumns.join(", ")}`;
  if (config.intakeStages.length === 0) return "intakeStages is empty";
  if (!config.enrollNotBefore || Number.isNaN(Date.parse(config.enrollNotBefore))) return "enrollNotBefore (go-live time) is not set";
  return null;
}

/**
 * Swaps stage names for the live stage ids. A reference that is already an id of a stage in this
 * pipeline is kept; anything that matches no stage is an error naming every miss, so a renamed
 * column is caught on the next run instead of silently skipped.
 */
export function resolveStageRefs(config: HomeServicesConfig, stages: { id: string; name: string }[]): HomeServicesConfig {
  const misses: string[] = [];
  const resolve = (ref: string, label: string): string => {
    const byId = stages.find((s) => s.id === ref);
    const byName = stages.find((s) => s.name.trim().toLowerCase() === ref.trim().toLowerCase());
    const found = byId ?? byName;
    if (!found) misses.push(`${label} "${ref}"`);
    return found?.id ?? ref;
  };
  const columns = { ...config.columns };
  for (const key of requiredColumns(config)) columns[key] = resolve(config.columns[key], `column ${key}`);
  const intakeStages = config.intakeStages.map((ref) => resolve(ref, "intake stage"));
  if (misses.length) {
    throw new Error(`Pipeline has no stage named ${misses.join(", ")} (stages: ${stages.map((s) => s.name).join(", ")})`);
  }
  return { ...config, columns, intakeStages };
}
