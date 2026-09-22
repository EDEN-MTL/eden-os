import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/claude", () => ({ chatWithTools: vi.fn(), attachmentToBlock: vi.fn() }));
vi.mock("../../shared/slack", () => ({ sendMessage: vi.fn(async () => ({})), getUserRealName: vi.fn(async () => null) }));
vi.mock("../../shared/conversation-memory", () => ({
  loadHistory: vi.fn(async () => []),
  appendHistory: vi.fn(async () => {}),
}));
vi.mock("../../shared/agent-notes", () => ({ loadNotes: vi.fn(async () => []), saveNote: vi.fn(async () => {}) }));

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

const ghl = vi.hoisted(() => ({
  getGhlConfig: vi.fn(),
  getLocationTimezone: vi.fn(),
  listContactsPaginated: vi.fn(),
}));
vi.mock("../../shared/ghl", () => ghl);

const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: readFileSyncMock };
});

import { chatWithTools } from "../../shared/claude";
import { irisAgent } from "./index";

function toolUseBlock(id: string, name: string, input: any) {
  return { type: "tool_use" as const, id, name, input };
}
function endTurn(text: string) {
  return { content: [{ type: "text" as const, text, citations: null }], stop_reason: "end_turn" } as any;
}
function asyncGeneratorOf<T>(items: T[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

const CLIENT_CONFIG = JSON.stringify({
  iris: {
    qualificationQuestions: ["q1"],
    writeFields: {},
    outreachCadence: { attemptsPerDay: 2, days: 4, recheckBeforeEachAttempt: true },
    transferNumbers: { buyer: "+15551110000" },
    callbacks: { notesFieldKey: "contact.isa_notes" },
    timezone: "America/St_Johns",
  },
  scout: { calendars: { buyer: "cal-1", seller: "cal-2" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  readFileSyncMock.mockReturnValue(CLIENT_CONFIG);
});

describe("IrisAgent.getSystemPrompt sender recognition", () => {
  it("names the sender as a known coworker when a real name resolved", () => {
    const prompt = irisAgent.getSystemPrompt({ senderName: "Mark" });
    expect(prompt).toContain("You are currently talking to Mark");
    expect(prompt).not.toMatch(/don't have a confirmed name/);
  });

  it("works for any resolved name, not just Jacob or Mark", () => {
    const prompt = irisAgent.getSystemPrompt({ senderName: "Priya" });
    expect(prompt).toContain("You are currently talking to Priya");
  });

  it("does not invent a name when the lookup failed (null)", () => {
    const prompt = irisAgent.getSystemPrompt({ senderName: null });
    expect(prompt).toMatch(/don't have a confirmed name/);
    expect(prompt).not.toMatch(/You are currently talking to/);
  });

  it("does not invent a name when called with no context at all", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).toMatch(/don't have a confirmed name/);
  });
});

describe("IrisAgent.getSystemPrompt brand-voice scoping", () => {
  it("never opens with the lead-facing brand introduction", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).not.toMatch(/^You are IRIS, the virtual assistant for/);
    expect(prompt).not.toMatch(/You are IRIS, a warm, professional/);
  });

  it("explicitly scopes the brand name to lead calls/texts, not Slack", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).toMatch(/never to Slack/i);
    expect(prompt).toMatch(/a live call, or a GHL\s+text thread/i);
  });

  it("only mentions the client name once, as background rather than a recurring role description", () => {
    const prompt = irisAgent.getSystemPrompt();
    const mentions = prompt.match(/3 Percent East Coast/g) || [];
    expect(mentions.length).toBe(1);
  });
});

/**
 * Real gap found live 2026-09-23: this prompt was written 2026-09-01, the
 * very first day of the Vapi integration, and still said calling "isn't
 * wired up yet" — false for over a week by the time Mark caught it asking
 * a real question Iris couldn't answer. Guards against silently going
 * stale again the same way.
 */
describe("IrisAgent.getSystemPrompt reflects that calling is actually live", () => {
  it("says plainly that calling is live, never that it's not wired up yet", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).not.toMatch(/isn't wired up yet/i);
    expect(prompt).not.toMatch(/aren't actually placing/i);
    expect(prompt).toMatch(/live/i);
  });

  it("tells Iris she has real tools and must use them for factual lead/pipeline questions, never guess", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).toMatch(/iris_lookup_lead/);
    expect(prompt).toMatch(/iris_pipeline_stats/);
    expect(prompt).toMatch(/never guess|rather than guessing/i);
  });
});

/**
 * Real gap found live 2026-09-23: Mark asked Iris (the Slack bot) what
 * time a real call attempt happened, and she had no tool to answer with —
 * only the universal save_note every agent gets for free. These cover the
 * two new tools that actually fix that.
 */
describe("Iris Slack tools — iris_lookup_lead", () => {
  it("resolves a name to a contact, then reports the real last-call time in the client's own local timezone", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    ghl.listContactsPaginated.mockReturnValue(asyncGeneratorOf([{ id: "contact-1", firstName: "Catherine", lastName: "Nonsense" }]));
    db.query.mockImplementation((sql: string) => {
      if (sql.includes("iris_pending_calls")) {
        return Promise.resolve([
          { status: "pending", resolution_reason: "not answered — retrying", is_explicit_callback: false, call_after: new Date("2026-09-23T14:00:00.000Z"), attempts_made: 2 },
        ]);
      }
      return Promise.resolve([{ status: "ended", ended_reason: "voicemail", created_at: new Date("2026-09-22T16:30:00.000Z"), ended_at: new Date("2026-09-22T16:30:20.000Z") }]);
    });

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_lookup_lead", { nameOrPhone: "Catherine" })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Last called Catherine on Tuesday at 2:00 PM local — voicemail."));

    const reply = await irisAgent.generateReply("k1", "what time was the last call to Catherine");

    expect(reply).toContain("Catherine");
    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.found).toBe(true);
    expect(toolResult.lastCallOutcome).toBe("voicemail");
    // 2026-09-22T16:30:00.000Z is 2:00 PM in America/St_Johns (UTC-2:30) —
    // confirms formatLocal actually ran against the real local timezone
    // returned by getLocationTimezone, not left as raw UTC.
    expect(toolResult.lastCallAttempt).toContain("2:00 PM");
  });

  it("reports found: false when no matching contact exists, rather than inventing one", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.listContactsPaginated.mockReturnValue(asyncGeneratorOf([]));

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_lookup_lead", { nameOrPhone: "Nobody Real" })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Couldn't find that lead."));

    await irisAgent.generateReply("k2", "what about Nobody Real");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toEqual({ found: false, searchedFor: "Nobody Real" });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("Iris Slack tools — iris_pipeline_stats", () => {
  it("returns real counts by status plus the opted-out-via-text and likely-exhausted heuristics", async () => {
    db.query
      .mockResolvedValueOnce([{ status: "pending", count: "5" }, { status: "placed", count: "3" }])
      .mockResolvedValueOnce([{ count: "2" }])
      .mockResolvedValueOnce([{ count: "1" }]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_pipeline_stats", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("5 pending, 3 placed."));

    await irisAgent.generateReply("k3", "how's the queue looking");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.byStatus).toEqual({ pending: 5, placed: 3 });
    expect(toolResult.optedOutViaText).toBe(2);
    expect(toolResult.likelyExhaustedNoAnswer).toBe(1);
  });
});
