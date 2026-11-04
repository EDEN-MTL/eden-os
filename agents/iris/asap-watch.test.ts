import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/db", () => ({ query: vi.fn(async () => []) }));
vi.mock("../../shared/claude", () => ({ ask: vi.fn() }));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn() }));
vi.mock("../../shared/ghl", () => ({
  getContact: vi.fn(),
  getContactAppointments: vi.fn(),
  getConversationMessages: vi.fn(),
  getConversations: vi.fn(),
  getCustomFieldDefs: vi.fn(),
  getGhlConfig: vi.fn(),
  listOpportunitiesInStage: vi.fn(),
  listPipelines: vi.fn(),
}));
vi.mock("../scout", () => ({ refreshLead: vi.fn() }));
vi.mock("../scout/intake", () => ({ buildKeyToId: vi.fn(), readField: vi.fn() }));
vi.mock("./index", () => ({ loadIrisConfig: vi.fn(), loadClientBranding: vi.fn() }));
vi.mock("./human-touch", () => ({ checkHumanTouch: vi.fn(), DEFAULT_HUMAN_HANDS_OFF_DAYS: 7 }));
vi.mock("./dial-pending", () => ({ holdForTextReply: vi.fn() }));
vi.mock("./notes", () => ({ appendNoteToContact: vi.fn() }));
vi.mock("./scripts", () => ({ extractFirstName: (n: string) => String(n).split(" ")[0] }));
vi.mock("../../webhooks/vapi-webhook", () => ({ sendIrisText: vi.fn() }));

import {
  asapTextProblem,
  buildAsapThread,
  cleanComposedText,
  composeAsapText,
  composerInput,
  decideAsapText,
  formatAsapWatchPost,
  isAsapTimeline,
  knownAndMissing,
  whereWeAre,
  type AsapLeadContext,
  type AsapWatchConfig,
} from "./asap-watch";
import type { ReviewEvent } from "./lead-review";

const TZ = "America/St_Johns";
// Thursday 2026-11-05 at 11:00 NST: inside text hours
const NOW = new Date("2026-11-05T14:30:00.000Z");
const H = 3_600_000;
const CFG: AsapWatchConfig = { enabled: true, skipStages: [], minHoursBetweenTexts: 24, maxTexts: 6, maxDays: 14, sendFromHour: 10, sendToHour: 19 };

const ctx = (over: Partial<AsapLeadContext> = {}): AsapLeadContext => ({
  contactId: "RwdLazeKKlJ92rebaZAg",
  name: "Maame S. Afriyie",
  firstName: "Maame",
  stageName: "DAY 3 - AM FOLLOW UP",
  tags: ["buyer lead"],
  dnd: false,
  hasPhone: true,
  createdAt: NOW.getTime() - 3 * 24 * H,
  intent: "buyer",
  budget: "$299K-$600K",
  timeline: "ASAP",
  propertyInterest: null,
  bedrooms: null,
  financing: null,
  workingWithRealtor: false,
  notes: "",
  events: [],
  calls: [],
  irisQueue: null,
  hasUpcomingAppointment: false,
  watchTexts: [],
  ...over,
});
const ev = (hoursAgo: number, over: Partial<ReviewEvent>): ReviewEvent => ({ at: NOW.getTime() - hoursAgo * H, actor: "app", kind: "sms", direction: "out", text: "hi", ...over });

describe("isAsapTimeline", () => {
  it.each(["ASAP", "asap", "As soon as possible", "immediately", "right away"])("%s is ASAP", (t) => expect(isAsapTimeline(t)).toBe(true));
  it.each(["3-6 months", "4+ months", "", null, undefined, "next spring"])("%s is not", (t) => expect(isAsapTimeline(t as string)).toBe(false));
});

describe("decideAsapText", () => {
  it("texts a watched lead nobody has texted lately", () => {
    expect(decideAsapText(ctx({ events: [ev(80, { actor: "automation" }), ev(60, { actor: "iris_call", kind: "call", reached: false, text: "" })] }), CFG, NOW, TZ)).toEqual({ send: true });
  });

  it("leaves do-not-contact, no-phone and already-booked leads alone", () => {
    expect(decideAsapText(ctx({ dnd: true }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "do not contact" });
    expect(decideAsapText(ctx({ tags: ["do not call"] }), CFG, NOW, TZ)).toMatchObject({ send: false });
    expect(decideAsapText(ctx({ hasPhone: false }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "no phone number" });
    expect(decideAsapText(ctx({ hasUpcomingAppointment: true }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "already has an appointment booked" });
  });

  it("stays quiet outside text hours", () => {
    expect(decideAsapText(ctx(), CFG, new Date("2026-11-05T11:00:00.000Z"), TZ)).toMatchObject({ send: false, reason: "outside text hours" }); // 7:30am
    expect(decideAsapText(ctx(), CFG, new Date("2026-11-06T00:30:00.000Z"), TZ)).toMatchObject({ send: false, reason: "outside text hours" }); // 9pm
  });

  it("does not nudge a lead who texted last: that is an answer to write", () => {
    const out = decideAsapText(ctx({ events: [ev(5, { actor: "lead", direction: "in", text: "can you call me tomorrow" })] }), CFG, NOW, TZ);
    expect(out).toMatchObject({ send: false, needsPerson: true });
  });

  it("stays out when a teammate has been in touch this week", () => {
    expect(decideAsapText(ctx({ events: [ev(48, { actor: "human" })] }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "a teammate has been in touch" });
  });

  it("spaces Iris's texts a day apart and gives a call room", () => {
    expect(decideAsapText(ctx({ events: [ev(6, { actor: "app" })] }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "Iris texted them within the last day" });
    expect(decideAsapText(ctx({ events: [ev(2, { actor: "iris_call", kind: "call", reached: false, text: "" })] }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "Iris just called them" });
    expect(decideAsapText(ctx({ irisQueue: { status: "pending", callAfter: NOW.getTime() + 3 * H } }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "a call is lined up shortly" });
    expect(decideAsapText(ctx({ irisQueue: { status: "placed", callAfter: null } }), CFG, NOW, TZ)).toMatchObject({ send: false, reason: "a call is in progress" });
    // a call lined up tomorrow doesn't stop a text today
    expect(decideAsapText(ctx({ irisQueue: { status: "pending", callAfter: NOW.getTime() + 30 * H } }), CFG, NOW, TZ)).toEqual({ send: true });
  });

  it("gives up after the cap or two weeks and hands the lead to a person", () => {
    const sent = (daysAgo: number) => ({ sentAt: NOW.getTime() - daysAgo * 24 * H, text: "x" });
    expect(decideAsapText(ctx({ watchTexts: [1, 2, 3, 4, 5, 6].map(sent) }), CFG, NOW, TZ)).toMatchObject({ send: false, needsPerson: true });
    expect(decideAsapText(ctx({ watchTexts: [sent(15)] }), CFG, NOW, TZ)).toMatchObject({ send: false, needsPerson: true });
    expect(decideAsapText(ctx({ watchTexts: [sent(3)] }), CFG, NOW, TZ)).toEqual({ send: true });
  });
});

describe("what the model is shown", () => {
  const maame = ctx({
    events: [
      ev(80, { actor: "automation", text: "Hey Maame! Saw you submitted a form" }),
      ev(76, { actor: "iris_call", kind: "call", reached: true, text: "" }),
      ev(70, { actor: "iris_call", kind: "call", reached: false, text: "" }),
      ev(46, { actor: "app", text: "Hi Maame, it's Iris. What time works best for me to try again?" }),
    ],
    calls: [
      { at: NOW.getTime() - 76 * H, reached: true, transcript: "User: Can we do this later in the day?\nAI: Would 4:30 work?\nUser: Yes." },
      { at: NOW.getTime() - 70 * H, reached: false, transcript: "User: Your call has been forwarded to voice mail." },
    ],
  });

  it("lays the thread out oldest first with what was said on the call she answered", () => {
    const thread = buildAsapThread(maame, TZ);
    expect(thread.indexOf("AUTOMATED TEXT")).toBeLessThan(thread.indexOf("Iris CALL, they answered"));
    expect(thread).toContain("Can we do this later in the day?");
    expect(thread).toContain("Iris CALL, no answer (went to voicemail)");
    expect(thread).toContain("IRIS sms: Hi Maame, it's Iris.");
  });

  it("says where the follow-up stands", () => {
    const lines = whereWeAre(maame, NOW, TZ);
    expect(lines).toContain("Stage: DAY 3 - AM FOLLOW UP");
    expect(lines).toContain("Iris has called 2 times; they picked up 1");
    expect(lines.some((l) => /Iris has texted 1 time/.test(l))).toBe(true);
  });

  it("separates what we know from what is missing, and does not ask for what the lead told us", () => {
    const { known, missing } = knownAndMissing(ctx({ timeline: "ASAP", budget: "$450k", propertyInterest: "Townhouse", notes: "area: Paradise" }));
    expect(known).toContain("Budget: $450k");
    expect(known).toContain("Property type: Townhouse");
    expect(missing).not.toContain("area");
    expect(missing).toContain("bedrooms");
  });

  it("includes the thread, what is known and what is missing in the composer input", () => {
    const input = composerInput(maame, NOW, TZ);
    expect(input).toContain("Lead: Maame S. Afriyie (first name: Maame)");
    expect(input).toContain("Still missing:");
    expect(input).toContain("Can we do this later in the day?");
  });
});

describe("checks on the written text", () => {
  const lead = { contactId: "RwdLazeKKlJ92rebaZAg", firstName: "Maame" };
  it("accepts a short, single-question text", () => {
    expect(asapTextProblem("Hi Maame, I know mornings are busy for you. Would 4:30 tomorrow work for a quick call with one of our agents?", lead)).toBeNull();
  });
  it.each([
    ["RwdLazeKKlJ92rebaZAg", "id"],
    ["Hi Maame, would 4:30 work? Or maybe 5? Or 6?", "two questions"],
    ["Hi Maame, can we talk? Reply STOP to opt out", "opt-out line"],
    ["Hi Maame 😊 can we talk tomorrow?", "emoji"],
    ["Hi Maame,\nwould tomorrow work?", "newline"],
    ["Hi Maame, see https://example.com for homes", "link"],
    ["x".repeat(330), "length"],
    ["", "empty"],
  ])("rejects %j (%s)", (text) => expect(asapTextProblem(text, lead)).not.toBeNull());

  it("turns SKIP and blanks into no text, and strips wrapping quotes", () => {
    expect(cleanComposedText("SKIP")).toBeNull();
    expect(cleanComposedText("  ")).toBeNull();
    expect(cleanComposedText("\"Hi Maame, quick check-in. Does tomorrow at 4:30 still work?\"")).toBe("Hi Maame, quick check-in. Does tomorrow at 4:30 still work?");
  });
});

describe("formatAsapWatchPost", () => {
  it("lists who was texted and who needs a person, and is silent when nothing happened", () => {
    expect(formatAsapWatchPost({ watched: 3, entries: [{ contactId: "a", name: "Ann", stageName: "Replied", decision: { send: false, reason: "Iris texted them within the last day" } }] })).toBeNull();
    const post = formatAsapWatchPost({
      watched: 3,
      entries: [
        { contactId: "a", name: "Ann", stageName: "Day 3", decision: { send: true }, text: "Hi Ann, still keen?", outcome: "delivered" },
        { contactId: "b", name: "Bo", stageName: "Replied", decision: { send: false, reason: "they texted last and are waiting on an answer", needsPerson: true } },
      ],
    })!;
    expect(post).toContain("Texted 1:");
    expect(post).toContain("*Ann* (Day 3): “Hi Ann, still keen?”");
    expect(post).toContain("Needs a person:");
    expect(post).toContain("*Bo* (Replied): they texted last");
  });
});

describe("composeAsapText", () => {
  const lead = ctx();
  it("returns the model's text when it passes the checks", async () => {
    const out = await composeAsapText(lead, NOW, TZ, async () => "Hi Maame, I know mornings are busy. Would tomorrow at 4:30 work for a quick call?");
    expect(out).toEqual({ text: "Hi Maame, I know mornings are busy. Would tomorrow at 4:30 work for a quick call?" });
  });

  it("tells the model what was wrong and uses its second try", async () => {
    const generate = vi.fn().mockResolvedValueOnce("Hi Maame, can we talk? Or text? Or email?").mockResolvedValueOnce("Hi Maame, would tomorrow at 4:30 work for a quick call?");
    const out = await composeAsapText(lead, NOW, TZ, generate);
    expect(out).toEqual({ text: "Hi Maame, would tomorrow at 4:30 work for a quick call?" });
    expect(generate.mock.calls[1][1]).toContain("asks more than one question");
  });

  it("gives up, with the reason, when both tries fail; and sends nothing when the model says SKIP or is down", async () => {
    expect(await composeAsapText(lead, NOW, TZ, async () => "Hi?? Really??")).toMatchObject({ text: null, reason: expect.stringContaining("rejected") });
    expect(await composeAsapText(lead, NOW, TZ, async () => "SKIP")).toMatchObject({ text: null });
    expect(await composeAsapText(lead, NOW, TZ, async () => { throw new Error("overloaded"); })).toMatchObject({ text: null, reason: expect.stringContaining("overloaded") });
  });
});
