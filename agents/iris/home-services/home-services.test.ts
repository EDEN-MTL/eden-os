import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ChatMessage } from "../../../shared/claude";
import { HomeServicesConfig, parseHomeServicesConfig, readinessProblem, requiredColumns, resolveStageRefs } from "./config";
import { HsDeps, enrollLead, handleInbound, runFollowup } from "./engine";
import { LeadInfo, buildSummaryNote, columnForVisit, mergeInfo, missingRequired } from "./lead-info";
import { firstTouchText, followupText, isOptOut } from "./messages";
import { formatAlert, formatDigest } from "./notify";
import { isTooLong, sentenceCount, tidyReply } from "./reply-style";
import { clampToSendWindow, isWithinSendWindow } from "./quiet-hours";
import { HsLead, createMemoryStore } from "./store";
import { decideEnrollment } from "./jobs";
import { buildSystemPrompt, ThreadText } from "./prompt";

const COLUMNS = { day1: "S-d1", day2: "S-d2", day3: "S-d3", looseDay: "S-day", looseNight: "S-night" };

function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "matama-floors",
    ghl: { pipelineId: "P1" },
    slack: { clientChannel: "matama-floors-eden" },
    irisHomeServices: {
      enabled: true,
      columns: COLUMNS,
      intakeStages: ["S-d1"],
      enrollNotBefore: "2026-11-01T00:00:00Z",
      ...overrides,
    },
  };
}

const config = (overrides: Record<string, unknown> = {}): HomeServicesConfig => parseHomeServicesConfig(rawConfig(overrides))!;

const FULL: LeadInfo = {
  fullName: "Marie Tremblay", street: "1456 rue Beaubien Est", city: "Rosemont", postalCode: "H2G 1K7", size: "700 pi²",
  visitWindow: "evening", visitType: "night", phone: "514-555-0100", language: "fr",
};

describe("config", () => {
  it("defaults to dry_run, off, and no outreach of her own", () => {
    const c = parseHomeServicesConfig({ clientId: "x", irisHomeServices: {} })!;
    expect(c.mode).toBe("dry_run");
    expect(c.enabled).toBe(false);
    expect(c.outreach).toEqual({ firstTouch: false, followups: false });
  });

  it("only goes live when explicitly set", () => {
    expect(config({ mode: "live" }).mode).toBe("live");
    expect(config({ mode: "LIVE" }).mode).toBe("dry_run");
  });

  it("only needs the Loose columns unless Iris runs the cadence herself", () => {
    expect(requiredColumns(config())).toEqual(["looseDay", "looseNight"]);
    expect(requiredColumns(config({ outreach: { followups: true } }))).toEqual(["day1", "day2", "day3", "looseDay", "looseNight"]);
  });

  it("is not ready until the columns, intake, go-live time and an owner channel exist", () => {
    expect(readinessProblem(config())).toBeNull();
    expect(readinessProblem(config({ columns: { ...COLUMNS, looseNight: "" } }))).toMatch(/looseNight/);
    expect(readinessProblem(config({ columns: { ...COLUMNS, day2: "" } }))).toBeNull();
    expect(readinessProblem(config({ outreach: { followups: true }, columns: { ...COLUMNS, day2: "" } }))).toMatch(/day2/);
    expect(readinessProblem(config({ intakeStages: [] }))).toMatch(/intake/);
    expect(readinessProblem(config({ enrollNotBefore: null }))).toMatch(/go-live/);
    // Slack is only a mirror: the owner is texted by his GHL workflow from the ISA Notes field, so no channel is fine.
    expect(readinessProblem(parseHomeServicesConfig({ ...rawConfig(), slack: {} })!)).toBeNull();
    expect(config().isaNotesField).toBe("ISA Notes");
  });

  it("returns null for a client with no block at all", () => {
    expect(parseHomeServicesConfig({ clientId: "3-percent-east-coast", iris: {} })).toBeNull();
  });
});

describe("resolveStageRefs", () => {
  const stages = [
    { id: "id-new", name: "New Lead" },
    { id: "id-d1", name: "Day 1" },
    { id: "id-day", name: "Loose Appointment Day" },
    { id: "id-night", name: "Loose Appointment Night" },
  ];
  const named = () => config({ columns: { day1: "Day 1", day2: "Day 2", day3: "Day 3", looseDay: "Loose Appointment Day", looseNight: "loose appointment night" }, intakeStages: ["New Lead", "id-d1"] });

  it("swaps names for live stage ids, ignoring case, and keeps ids it already has", () => {
    const resolved = resolveStageRefs(named(), stages);
    expect(resolved.columns.looseDay).toBe("id-day");
    expect(resolved.columns.looseNight).toBe("id-night");
    expect(resolved.intakeStages).toEqual(["id-new", "id-d1"]);
  });

  it("does not demand the Day 2/3 columns when Iris is not running the cadence", () => {
    expect(() => resolveStageRefs(named(), stages)).not.toThrow();
  });

  it("fails loudly, naming the column, when the pipeline no longer has one", () => {
    const renamed = stages.map((s) => (s.id === "id-night" ? { ...s, name: "Evening Visit" } : s));
    expect(() => resolveStageRefs(named(), renamed)).toThrow(/column looseNight "loose appointment night"/);
  });
});

describe("lead info", () => {
  it("ignores blanks, unknown keys and invalid enums when merging", () => {
    const merged = mergeInfo({ fullName: "A" }, { fullName: "  ", city: "Verdun", visitWindow: "whenever", language: "de", bogus: "x", photosReceived: "yes", visitType: "night" });
    expect(merged).toEqual({ fullName: "A", city: "Verdun" });
  });

  it("derives the Loose Day/Night type from the availability window", () => {
    expect(mergeInfo({}, { visitWindow: "morning" })).toMatchObject({ visitWindow: "morning", visitType: "day" });
    expect(mergeInfo({}, { visitWindow: "afternoon" })).toMatchObject({ visitType: "day" });
    expect(mergeInfo({}, { visitWindow: "evening" })).toMatchObject({ visitType: "night" });
    expect(mergeInfo({}, { visitWindow: "anytime" })).toMatchObject({ visitType: "day" });
  });

  it("needs only who, where, how big and when they are free", () => {
    expect(missingRequired({})).toHaveLength(7);
    expect(missingRequired(FULL)).toEqual([]);
    expect(missingRequired({ ...FULL, service: undefined, timing: undefined, language: undefined })).toEqual([]);
    expect(missingRequired({ ...FULL, postalCode: undefined })).toEqual(["postal code"]);
    expect(missingRequired({ ...FULL, visitWindow: undefined })[0]).toMatch(/morning, afternoon or evening/);
  });

  it("maps availability to a column", () => {
    expect(columnForVisit({ visitType: "day" })).toBe("looseDay");
    expect(columnForVisit({ visitType: "night" })).toBe("looseNight");
    expect(columnForVisit({})).toBeNull();
  });

  it("writes 'unknown' rather than guessing in the contact note", () => {
    const note = buildSummaryNote({ fullName: "Luc" }, "looseDay", "2026-11-03");
    expect(note).toContain("Address / Neighbourhood / Postal code: unknown / unknown / unknown");
    expect(note).toContain("Photos received: no");
    expect(note).toContain("Open questions for Pedro: none");
  });

  it("keeps anything specific the lead said about timing in the note", () => {
    const note = buildSummaryNote({ ...FULL, availabilityNotes: "après 18h, samedi OK" }, "looseNight", "2026-11-03");
    expect(note).toContain("Available for the estimate: evening — après 18h, samedi OK");
  });
});

describe("send window", () => {
  const tz = "America/Toronto";
  it("keeps an in-window time", () => {
    const t = new Date("2026-11-03T15:00:00Z"); // 10:00 EST
    expect(clampToSendWindow(t, tz, 9, 20)).toEqual(t);
  });
  it("pushes the evening to 9:00 the next morning", () => {
    expect(clampToSendWindow(new Date("2026-11-04T03:00:00Z"), tz, 9, 20).toISOString()).toBe("2026-11-04T14:00:00.000Z");
  });
  it("pushes the small hours to 9:00 the same morning", () => {
    expect(clampToSendWindow(new Date("2026-11-03T09:30:00Z"), tz, 9, 20).toISOString()).toBe("2026-11-03T14:00:00.000Z");
  });
  it("treats 20:00 as closed", () => {
    expect(isWithinSendWindow(new Date("2026-11-04T01:00:00Z"), tz, 9, 20)).toBe(false);
    expect(isWithinSendWindow(new Date("2026-11-04T00:59:00Z"), tz, 9, 20)).toBe(true);
  });
});

describe("opt-out detection", () => {
  it.each(["STOP", "stop", "Arrêt", "ARRET", "arrêtez", "unsubscribe", "Désabonner", "ne me contactez plus", "Please don't text me", "remove me from your list", "retirez-moi de votre liste", "stop texting me"])(
    "catches %s",
    (text) => expect(isOptOut(text)).toBe(true)
  );
  it.each(["Oui, c'est pour environ 700 pieds carrés", "I can stop by tomorrow", "Le soir ça marche, après 18h", "Combien ça coûte?", "Arrêtez-vous sur Beaubien?"])(
    "leaves %s alone",
    (text) => expect(isOptOut(text)).toBe(false)
  );
});

describe("templates (used only when Iris runs the cadence herself)", () => {
  it("first touch introduces Iris as a virtual assistant, in both languages, with no price", () => {
    expect(firstTouchText("fr", "Marie")).toContain("l'assistante virtuelle de Pedro");
    expect(firstTouchText("en", "John")).toContain("virtual assistant");
    for (const text of [firstTouchText("fr"), firstTouchText("en")]) expect(text).not.toMatch(/\$|\d+\s?\/\s?pi/);
  });
  it("has all four follow-ups and none after, never a price or a free-visit claim", () => {
    for (const step of [1, 2, 3, 4]) {
      for (const lang of ["fr", "en"] as const) expect(followupText(step, lang, "Marie")).not.toMatch(/\$|gratuit|free/i);
    }
    expect(followupText(5, "fr")).toBeNull();
  });
});

describe("owner alerts", () => {
  it("gives Pedro everything: name, full address, phone, size, availability and notes", () => {
    const text = formatAlert("looseNight", { ...FULL, service: "sablage", woodType: "chêne", availabilityNotes: "après 18h", otherNotes: "Chien dans la maison" }, "fr");
    expect(text).toContain("🌙 LOOSE – SOIR: Marie Tremblay");
    expect(text).toContain("📍 1456 rue Beaubien Est, Rosemont, H2G 1K7");
    expect(text).toContain("📞 514-555-0100");
    expect(text).toContain("~700 pi² · sablage · chêne");
    expect(text).toContain("Disponible: soir · après 18h");
    expect(text).toContain("📝 Chien dans la maison");
    expect(text).toContain("Photos: non");
  });
  it("labels daytime windows and speaks English when asked", () => {
    const text = formatAlert("looseDay", { ...FULL, visitWindow: "morning", visitType: "day" }, "en");
    expect(text).toContain("🟡 LOOSE – DAY");
    expect(text).toContain("Available: morning");
  });
  it("marks a missing fact with ? instead of inventing one", () => {
    expect(formatAlert("needsPedro", { fullName: "Anna Rossi" }, "fr", { reason: "Dégât d'eau" })).toBe("🔴 NEEDS PEDRO: Anna Rossi\nDégât d'eau");
    expect(formatAlert("looseDay", { fullName: "Luc" }, "fr")).toContain("📍 ?");
  });
  it("groups the digest by neighbourhood and is silent when nothing is open", () => {
    expect(formatDigest([], "fr")).toBeNull();
    const text = formatDigest(
      [
        { info: { ...FULL, city: "Verdun", visitWindow: "morning" }, column: "looseDay" },
        { info: { ...FULL, fullName: "Luc", city: "Rosemont" }, column: "looseNight" },
        { info: { ...FULL, fullName: "Ana", city: "Verdun" }, column: "looseNight" },
      ],
      "en"
    )!;
    expect(text.indexOf("Rosemont")).toBeLessThan(text.indexOf("Verdun"));
    expect(text.match(/\nVerdun/g)).toHaveLength(1);
    expect(text).toContain("Estimates to schedule (3)");
  });
});

describe("prompt", () => {
  const base = { info: {}, column: null, nowLocal: "Tuesday, November 3, 2026 at 10:00 AM", language: "fr" as const, thread: [] as ThreadText[] };
  it("gives no numbers by default and states only the approved line when one exists", () => {
    expect(buildSystemPrompt({ ...base, config: config() })).toContain("Give NO numbers");
    const priced = buildSystemPrompt({ ...base, config: config({ approvedPricingLine: "À partir de 3,50 $/pi²" }) });
    expect(priced).toContain('"À partir de 3,50 $/pi²"');
    expect(priced).not.toContain("Give NO numbers");
  });
  it("shows the automation's texts so Iris knows what the lead is answering, and does not re-introduce herself", () => {
    const text = buildSystemPrompt({
      ...base,
      config: config(),
      thread: [
        { from: "us", text: "Hi Abderr, this is Pedro from Planchers MatAma. I saw your request for floor restoration and the offer for up to $500 off." },
        { from: "us", text: "My virtual assistant Iris will ask a few quick questions. To start: roughly how many square feet or rooms is it?" },
      ],
    });
    expect(text).toContain("roughly how many square feet or rooms is it?");
    expect(text).toMatch(/Do not introduce yourself again/);
  });
  it("won't confirm the terms of the automation's $500 offer", () => {
    expect(buildSystemPrompt({ ...base, config: config() })).toMatch(/You do not know its terms/);
  });
  it("lists what is still missing and what is known, and asks availability then address", () => {
    const text = buildSystemPrompt({ ...base, config: config(), info: { fullName: "Marie Tremblay" } });
    expect(text).toContain("- fullName: Marie Tremblay");
    expect(text).toContain("postal code");
    expect(text.indexOf("morning, afternoon or evening")).toBeLessThan(text.indexOf("The address for the visit"));
  });
  it("admits being an AI and never claims to be Pedro", () => {
    const text = buildSystemPrompt({ ...base, config: config() });
    expect(text).toMatch(/say yes, honestly/);
    expect(text).toMatch(/or to be Pedro/);
  });
});

type Script = Array<{ stop: "tool_use" | "end_turn"; content: any[] }>;
const tool = (name: string, input: object = {}) => ({ type: "tool_use", id: `t-${Math.random()}`, name, input });
const say = (text: string) => ({ type: "text", text });

function harness(opts: { script?: Script; now?: string; teammate?: boolean; isaFails?: boolean; cfg?: Record<string, unknown>; thread?: ThreadText[] } = {}) {
  const store = createMemoryStore();
  const calls: Record<string, any[]> = { move: [], tags: [], notes: [], isaNotes: [], order: [], alerts: [], chat: [] };
  const script = [...(opts.script ?? [])];
  const deps: HsDeps = {
    config: config(opts.cfg),
    store,
    now: () => new Date(opts.now ?? "2026-11-03T15:00:00Z"),
    chat: vi.fn(async (system: string, messages: ChatMessage[]) => {
      calls.chat.push({ system, messages });
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return { content: next.content, stop_reason: next.stop } as unknown as Anthropic.Message;
    }),
    loadHistory: async () => [],
    recentTexts: async () => [...(opts.thread ?? [])],
    appendHistory: async () => {},
    ghl: {
      moveToColumn: async (_l, stageId) => void (calls.move.push(stageId), calls.order.push("move")),
      addTags: async (_l, tags) => void calls.tags.push(...tags),
      writeNote: async (_l, body) => void calls.notes.push(body),
      writeIsaNotes: async (_l, text) => {
        if (opts.isaFails) throw new Error("GHL down");
        calls.isaNotes.push(text);
        calls.order.push("isa");
      },
      currentStageId: async () => null,
    },
    alertOwner: async (text) => void calls.alerts.push(text),
    teammateIsTexting: async () => opts.teammate === true,
  };
  return { deps, store, calls };
}

async function seed(h: ReturnType<typeof harness>, info: LeadInfo = {}, extra: Partial<HsLead> = {}): Promise<HsLead> {
  const lead: Omit<HsLead, "enrolledAt"> = {
    clientId: "matama-floors", contactId: "c1", opportunityId: "o1", status: "active", columnKey: null, info,
    followupStep: 0, nextFollowupAt: null, lastInboundSeenAt: null, lastOutboundAt: null, resolutionReason: null, ...extra,
  };
  await h.store.insertLead(lead);
  return (await h.store.getLead("matama-floors", "c1"))!;
}

describe("handleInbound", () => {
  it("passes the real thread to the model so a reply to the automation makes sense", async () => {
    const h = harness({
      thread: [
        { from: "us", text: "My virtual assistant Iris will ask a few quick questions so I can prepare for the estimate. To start: roughly how many square feet or rooms is it?" },
        { from: "lead", text: "885 ft2" },
      ],
      script: [{ stop: "end_turn", content: [say("Perfect, thanks! Are mornings, afternoons, or evenings better for Pedro's visit?")] }],
    });
    await handleInbound(h.deps, await seed(h, { fullName: "Abderr Kahil", language: "en" }), "885 ft2");
    const system: string = h.calls.chat[0].system;
    expect(system).toContain("roughly how many square feet or rooms is it?");
    expect(system.match(/885 ft2/g) ?? []).toHaveLength(0);
    expect(h.store.outbox[0].body).toContain("mornings, afternoons, or evenings");
  });

  it("refuses to book until everything required is collected, then books", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("update_lead_info", { size: "885 ft2", visitWindow: "evening" }), tool("move_to_column")] },
        { stop: "end_turn", content: [say("Parfait! Quelle est l'adresse de la visite?")] },
      ],
    });
    await handleInbound(h.deps, await seed(h, { fullName: "Marie Tremblay", phone: "514-555-0100" }), "885 pi2, plutôt le soir");
    expect(h.calls.move).toEqual([]);
    expect(h.calls.alerts).toEqual([]);
    const refusal = (h.calls.chat[1].messages.at(-1)!.content as any[]).find((b) => typeof b.content === "string" && b.content.startsWith("NOT moved"));
    expect(refusal.content).toContain("street address");
    expect((await h.store.getLead("matama-floors", "c1"))!.columnKey).toBeNull();
  });

  it("files an evening lead in Loose Night, writes the note, alerts Pedro with the address and stops there", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("update_lead_info", { street: "1456 rue Beaubien Est", city: "Rosemont", postalCode: "H2G 1K7", availabilityNotes: "après 18h" }), tool("move_to_column")] },
        { stop: "end_turn", content: [say("C'est noté, en soirée. Pedro vous contactera pour confirmer l'heure.")] },
      ],
    });
    const lead = await seed(h, { fullName: "Marie Tremblay", phone: "514-555-0100", language: "fr", size: "700 pi²", visitWindow: "evening", visitType: "night" });
    await handleInbound(h.deps, lead, "1456 rue Beaubien Est, Rosemont, H2G 1K7. Après 18h");
    expect(h.calls.move).toEqual(["S-night"]);
    expect(h.calls.notes[0]).toContain("Column: looseNight");
    expect(h.calls.notes[0]).toContain("après 18h");
    expect(h.calls.alerts[0]).toContain("🌙 LOOSE – SOIR");
    expect(h.calls.alerts[0]).toContain("1456 rue Beaubien Est, Rosemont, H2G 1K7");
    // The GHL workflow that texts Pedro fires on the move and reads this field, so the field must be written first.
    expect(h.calls.order).toEqual(["isa", "move"]);
    expect(h.calls.isaNotes[0]).toBe(
      "LOOSE SOIR: Marie Tremblay\nAdresse: 1456 rue Beaubien Est, Rosemont, H2G 1K7\nTél: 514-555-0100\nTravaux: ~700 pi²\nDisponible: soir · après 18h\nPhotos: non",
    );
    expect(h.calls.isaNotes[0]).not.toMatch(/\p{Extended_Pictographic}/u);
    const stored = (await h.store.getLead("matama-floors", "c1"))!;
    expect(stored.columnKey).toBe("looseNight");
    expect(h.store.outbox.at(-1)!.kind).toBe("reply");
  });

  it("leaves the card where it is when the ISA Notes cannot be saved, so no Loose card sits unannounced", async () => {
    const h = harness({
      isaFails: true,
      script: [
        { stop: "tool_use", content: [tool("update_lead_info", { street: "1 rue X", city: "Verdun", postalCode: "H4G 1A1", visitWindow: "morning" }), tool("move_to_column")] },
        { stop: "end_turn", content: [say("Pedro vous contactera pour confirmer.")] },
      ],
    });
    await handleInbound(h.deps, await seed(h, { fullName: "Luc", phone: "514-555-0101", size: "500 pi²" }), "1 rue X, Verdun, H4G 1A1, le matin");
    expect(h.calls.move).toEqual([]);
    expect((await h.store.getLead("matama-floors", "c1"))!.columnKey).toBeNull();
  });

  it("files morning and afternoon as Loose Day, keeping any exact time the lead named in the notes", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("update_lead_info", { visitWindow: "afternoon", availabilityNotes: "mardi 18 novembre vers 15h" }), tool("move_to_column")] },
        { stop: "end_turn", content: [say("Parfait, Pedro vous contactera pour confirmer.")] },
      ],
    });
    await handleInbound(h.deps, await seed(h, { ...FULL, visitWindow: undefined, visitType: undefined }), "mardi le 18 vers 15h");
    expect(h.calls.move).toEqual(["S-day"]);
    expect(h.calls.notes[0]).toContain("afternoon — mardi 18 novembre vers 15h");
    expect(h.calls.alerts[0]).toContain("🟡 LOOSE – JOUR");
    expect(h.calls.tags).toEqual([]);
  });

  it("never moves a lead out of an appointment column", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("update_lead_info", { visitWindow: "morning" }), tool("move_to_column")] },
        { stop: "end_turn", content: [say("Pedro va vous recontacter.")] },
      ],
    });
    await handleInbound(h.deps, await seed(h, FULL, { columnKey: "looseNight" }), "en fait plutôt le matin");
    expect(h.calls.move).toEqual([]);
  });

  it("handles STOP without asking the model, tags DND and sends one confirmation", async () => {
    const h = harness();
    const lead = await seed(h, { language: "fr" });
    await h.store.enqueue({ clientId: "matama-floors", contactId: "c1", body: "follow-up", kind: "followup", sendAfter: new Date("2026-11-03T18:00:00Z") });
    await handleInbound(h.deps, lead, "ARRÊT");
    expect(h.deps.chat).not.toHaveBeenCalled();
    expect(h.calls.tags).toEqual(["DND"]);
    expect((await h.store.getLead("matama-floors", "c1"))!.status).toBe("opted_out");
    expect(h.store.outbox.find((r) => r.kind === "followup")!.status).toBe("cancelled");
    const ack = h.store.outbox.filter((r) => r.kind === "optout_ack");
    expect(ack).toHaveLength(1);
    expect(ack[0].body).toMatch(/ne vous contacterons plus/);
  });

  it("honours an opt-out the model recognises in other words", async () => {
    const h = harness({ script: [{ stop: "tool_use", content: [tool("record_opt_out")] }] });
    await handleInbound(h.deps, await seed(h, { language: "en" }), "I've already hired someone, leave me be");
    expect(h.calls.tags).toEqual(["DND"]);
    expect(h.store.outbox.filter((r) => r.kind === "reply")).toHaveLength(0);
    expect(h.store.outbox.find((r) => r.kind === "optout_ack")!.body).toMatch(/won't contact you again/);
  });

  it("hands off to the owner, then stays quiet but relays later replies", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("flag_needs_pedro", { reason: "Dégât d'eau, veut parler à Pedro aujourd'hui" })] },
        { stop: "end_turn", content: [say("Je préviens Pedro, il vous appellera.")] },
      ],
    });
    const lead = await seed(h, { fullName: "Anna Rossi", city: "St-Léonard" });
    await handleInbound(h.deps, lead, "J'ai un dégât d'eau, je veux parler à Pedro");
    expect(h.calls.tags).toContain("Needs Pedro");
    expect(h.calls.alerts[0]).toContain("🔴 NEEDS PEDRO: Anna Rossi");
    // The "Needs Pedro" tag triggers a GHL workflow too, so the field is filled before the tag lands.
    expect(h.calls.isaNotes[0]).toContain("À RAPPELER: Anna Rossi");
    expect(h.calls.isaNotes[0]).toContain("Raison: Dégât d'eau");
    expect((await h.store.getLead("matama-floors", "c1"))!.status).toBe("needs_pedro");

    await handleInbound(h.deps, (await h.store.getLead("matama-floors", "c1"))!, "Vous pouvez venir demain?");
    expect(h.deps.chat).toHaveBeenCalledTimes(2);
    expect(h.calls.alerts[1]).toContain("replied after the hand-off");
    expect(h.store.outbox.filter((r) => r.kind === "reply")).toHaveLength(1);
  });

  it("closes a photo-only price request with the right tag", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("route_lead", { outcome: "photo_quote" })] },
        { stop: "end_turn", content: [say("Pas de souci, bonne journée!")] },
      ],
    });
    await handleInbound(h.deps, await seed(h), "Juste un prix par texto svp");
    expect(h.calls.tags).toEqual(["Photo Quote Request"]);
    expect((await h.store.getLead("matama-floors", "c1"))!.status).toBe("closed");
  });

  it("stays out of a conversation a teammate is having", async () => {
    const h = harness({ teammate: true });
    await handleInbound(h.deps, await seed(h), "Bonjour Pedro");
    expect(h.deps.chat).not.toHaveBeenCalled();
    expect(h.store.outbox).toHaveLength(0);
  });

  it("holds an evening reply until the morning", async () => {
    const h = harness({ now: "2026-11-04T03:00:00Z", script: [{ stop: "end_turn", content: [say("Bonsoir! Combien de pièces?")] }] });
    await handleInbound(h.deps, await seed(h), "Bonsoir");
    expect(h.store.outbox[0].sendAfter.toISOString()).toBe("2026-11-04T14:00:00.000Z");
  });

  it("cancels a pending follow-up the moment the lead replies", async () => {
    const h = harness({ script: [{ stop: "end_turn", content: [say("Bonjour!")] }] });
    const lead = await seed(h, {}, { nextFollowupAt: new Date("2026-11-03T18:00:00Z") });
    await h.store.enqueue({ clientId: "matama-floors", contactId: "c1", body: "nudge", kind: "followup", sendAfter: new Date("2026-11-03T18:00:00Z") });
    await handleInbound(h.deps, lead, "Salut");
    expect(h.store.outbox.find((r) => r.kind === "followup")!.status).toBe("cancelled");
    expect((await h.store.getLead("matama-floors", "c1"))!.nextFollowupAt).toBeNull();
  });

  it("alerts a person instead of sending a canned line when the model produces nothing", async () => {
    const h = harness({ script: [{ stop: "end_turn", content: [] }] });
    await handleInbound(h.deps, await seed(h, { fullName: "Luc" }), "Allo?");
    expect(h.store.outbox).toHaveLength(0);
    expect(h.calls.alerts[0]).toContain("Needs a person");
  });
});

describe("enrolment", () => {
  const lead = { clientId: "matama-floors", contactId: "c9", opportunityId: "o9", columnKey: null, info: { fullName: "Marie Tremblay", language: "fr" as const }, lastInboundSeenAt: new Date("2026-11-04T23:40:00Z") };

  it("by default sends nothing: the GHL automation texts first and Iris waits for the reply", async () => {
    const h = harness();
    expect(await enrollLead(h.deps, lead)).toBe(true);
    expect(await enrollLead(h.deps, lead)).toBe(false);
    expect(h.store.outbox).toHaveLength(0);
    const stored = (await h.store.getLead("matama-floors", "c9"))!;
    expect(stored.nextFollowupAt).toBeNull();
    expect(stored.lastInboundSeenAt).toEqual(new Date("2026-11-04T23:40:00Z"));
  });

  it("texts first in French and starts the follow-up clock only when both outreach switches are on", async () => {
    const h = harness({ cfg: { outreach: { firstTouch: true, followups: true } } });
    await enrollLead(h.deps, { ...lead, columnKey: "day1" });
    expect(h.store.outbox).toHaveLength(1);
    expect(h.store.outbox[0].kind).toBe("first_touch");
    expect(h.store.outbox[0].body).toContain("Bonjour Marie!");
    const stored = (await h.store.getLead("matama-floors", "c9"))!;
    expect(stored.nextFollowupAt!.getTime()).toBeGreaterThanOrEqual(h.store.outbox[0].sendAfter.getTime() + 3 * 3_600_000);
  });

  it("starts the 3-hour clock from the morning send when the lead arrives overnight", async () => {
    const h = harness({ now: "2026-11-04T07:00:00Z", cfg: { outreach: { firstTouch: true, followups: true } } });
    await enrollLead(h.deps, { ...lead, contactId: "c10", columnKey: "day1", info: { language: "en" } });
    const firstSend = h.store.outbox[0].sendAfter;
    expect(firstSend.toISOString()).toBe("2026-11-04T14:00:00.000Z");
    expect((await h.store.getLead("matama-floors", "c10"))!.nextFollowupAt!.getTime()).toBe(firstSend.getTime() + 3 * 3_600_000);
  });
});

describe("follow-ups (only when Iris runs the cadence)", () => {
  const cfg = { outreach: { firstTouch: true, followups: true } };

  it("walks Day 1 -> Day 2 -> Day 3, then tags long-term nurture and stops sending", async () => {
    const h = harness({ cfg });
    let lead = await seed(h, { fullName: "Marie Tremblay", language: "fr" }, { columnKey: "day1" });
    const columnsSeen: string[] = [];
    for (let step = 1; step <= 4; step++) {
      await runFollowup(h.deps, lead);
      lead = (await h.store.getLead("matama-floors", "c1"))!;
      columnsSeen.push(lead.columnKey!);
    }
    expect(columnsSeen).toEqual(["day1", "day1", "day2", "day3"]);
    expect(h.calls.move).toEqual(["S-d2", "S-d3"]);
    expect(h.store.outbox.filter((r) => r.kind === "followup")).toHaveLength(4);
    expect(h.calls.tags).toEqual(["Long-term Nurture"]);
    expect(lead.status).toBe("idle");
    expect(lead.nextFollowupAt).toBeNull();
    await runFollowup(h.deps, lead);
    expect(h.store.outbox.filter((r) => r.kind === "followup")).toHaveLength(4);
  });

  it("puts the second follow-up on the next morning, not three hours after the first", async () => {
    const h = harness({ now: "2026-11-03T19:00:00Z", cfg });
    await runFollowup(h.deps, await seed(h, { language: "fr" }, { columnKey: "day1" }));
    expect((await h.store.getLead("matama-floors", "c1"))!.nextFollowupAt!.toISOString()).toBe("2026-11-04T14:30:00.000Z");
  });
});

describe("decideEnrollment", () => {
  const cfg = config();
  const opp = { id: "o1", status: "open", createdAt: "2026-11-05T14:00:00Z" };
  const contact = { firstName: "Marie", lastName: "Tremblay", phone: "+15145550100", tags: [] };

  it("enrolls a fresh lead with the contact's details prefilled", () => {
    const d = decideEnrollment(opp, { ...contact, address1: "123 rue Beaubien", city: "Rosemont", postalCode: "H2G 1K7" }, cfg);
    expect(d).toMatchObject({ enroll: true, info: { fullName: "Marie Tremblay", phone: "+15145550100", street: "123 rue Beaubien", language: "fr" } });
  });
  it("never enrolls backlog created before go-live", () => {
    expect(decideEnrollment({ ...opp, createdAt: "2026-10-20T00:00:00Z" }, contact, cfg)).toMatchObject({ enroll: false, terminal: true });
  });
  it("skips leads with no phone, a do-not-contact tag or flag, or a closed opportunity", () => {
    expect(decideEnrollment(opp, { ...contact, phone: "" }, cfg)).toMatchObject({ enroll: false });
    expect(decideEnrollment(opp, { ...contact, tags: ["DND"] }, cfg)).toMatchObject({ enroll: false });
    expect(decideEnrollment(opp, { ...contact, dnd: true }, cfg)).toMatchObject({ enroll: false });
    expect(decideEnrollment(opp, { ...contact, tags: ["Needs Pedro"] }, cfg)).toMatchObject({ enroll: false });
    expect(decideEnrollment({ ...opp, status: "lost" }, contact, cfg)).toMatchObject({ enroll: false });
  });
  it("reads an English hint from the contact's tags", () => {
    expect(decideEnrollment(opp, { ...contact, tags: ["english", "replied"] }, cfg)).toMatchObject({ enroll: true, info: { language: "en" } });
  });
});

describe("reply style", () => {
  it("flattens paragraphs, drops dashes and strips emoji the lead did not use", () => {
    expect(tidyReply("Parfait, c'est noté — Pedro vous contactera. 😊\n\nEnvoyez 2-3 photos!", "Ok merci")).toBe("Parfait, c'est noté, Pedro vous contactera. Envoyez 2-3 photos!");
  });

  it("keeps a single emoji when the lead used one first", () => {
    expect(tidyReply("Super! 😊 À bientôt 😊", "Merci 🙏")).toBe("Super! 😊 À bientôt");
  });

  it("counts sentences and flags long replies", () => {
    expect(sentenceCount("Parfait! Plutôt le matin, l'après-midi ou le soir?")).toBe(2);
    expect(isTooLong("Parfait, merci! Plutôt le matin, l'après-midi ou le soir?")).toBe(false);
    expect(isTooLong("Un. Deux. Trois. Quatre.")).toBe(true);
    expect(isTooLong("a".repeat(240))).toBe(true);
  });

  it("asks the model once to shorten a long reply and sends the shorter one", async () => {
    const long = "Merci beaucoup pour toutes ces informations, c'est vraiment très apprécié de ma part. Pedro aimerait vous rencontrer pour évaluer vos planchers en détail. Pourriez-vous me dire si vous êtes plutôt disponible le matin, l'après-midi ou le soir pour la visite?";
    const h = harness({
      script: [
        { stop: "end_turn", content: [say(long)] },
        { stop: "end_turn", content: [say("Parfait, merci! Plutôt le matin, l'après-midi ou le soir?")] },
      ],
    });
    await handleInbound(h.deps, await seed(h, { fullName: "Marie", phone: "514-555-0100" }), "700 pi2");
    expect(h.deps.chat).toHaveBeenCalledTimes(2);
    expect(h.store.outbox.at(-1)!.body).toBe("Parfait, merci! Plutôt le matin, l'après-midi ou le soir?");
  });

  it("still sends the tidied original when the shortening call fails", async () => {
    const long = "Un. Deux. Trois. Quatre.";
    const h = harness({ script: [{ stop: "end_turn", content: [say(long)] }] });
    await handleInbound(h.deps, await seed(h, { fullName: "Marie" }), "700 pi2");
    expect(h.store.outbox.at(-1)!.body).toBe(long);
  });
});

describe("closed leads that text back", () => {
  it("answers a thank-you but keeps the lead closed, and does not tag twice", async () => {
    const h = harness({
      script: [
        { stop: "tool_use", content: [tool("route_lead", { outcome: "out_of_area" })] },
        { stop: "end_turn", content: [say("Désolée, on couvre juste Montréal.")] },
        { stop: "end_turn", content: [say("Avec plaisir!")] },
      ],
    });
    const lead = await seed(h, { fullName: "Priya", language: "en" });
    await handleInbound(h.deps, lead, "900 sq ft in Toronto");
    await handleInbound(h.deps, (await h.store.getLead("matama-floors", "c1"))!, "thanks anyway");
    expect(h.calls.tags).toEqual(["Out of Area"]);
    expect((await h.store.getLead("matama-floors", "c1"))!.status).toBe("closed");
    expect(h.store.outbox.filter((r) => r.kind === "reply")).toHaveLength(2);
  });
});
