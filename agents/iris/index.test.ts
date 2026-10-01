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
  getContact: vi.fn(),
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
    expect(prompt).toMatch(/iris_call_transcript/);
    expect(prompt).toMatch(/iris_newest_lead/);
    expect(prompt).toMatch(/iris_pipeline_stats/);
    expect(prompt).toMatch(/iris_calls_today/);
    expect(prompt).toMatch(/never guess|rather than guessing/i);
  });
});

/**
 * Real gap found live 2026-09-22: after a real, correct, tool-backed
 * answer about a lead, Mark said "ok great" and Iris repeated the whole
 * breakdown again plus an invented apology about "guessing instead of
 * using the tool" that wasn't true. He said "thanks" next and she did it
 * a SECOND time, nearly verbatim — confirmed via the raw conversation
 * history (agent_conversations) that each of his messages appears exactly
 * once, so this was never a duplicate-delivery bug, purely a model
 * behavior gap.
 */
describe("IrisAgent.getSystemPrompt recognizes conversation-closing messages", () => {
  it("tells Iris a short acknowledgment means the conversation is over, not a new question", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).toMatch(/ok great/i);
    expect(prompt).toMatch(/thanks/i);
    expect(prompt).toMatch(/conversation is over|means the conversation/i);
  });

  it("tells Iris not to invent a self-critical narrative about an earlier turn that was actually correct", () => {
    const prompt = irisAgent.getSystemPrompt();
    expect(prompt).toMatch(/never invent a self-critical/i);
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

/**
 * Real gap found live 2026-10-01 (#iris-call-logs): Mark asked "can you
 * tell what happened here?" and Iris GUESSED from the outcome code,
 * duration, and is_explicit_callback flag ("it looks like something
 * triggered a callback request") instead of reading what was actually
 * said. Asked to "pull out the conversation," she admitted she had no way
 * to — even though the real transcript was sitting in iris_call_log the
 * whole time (webhooks/vapi-webhook.ts's handleEndOfCallReport writes it
 * on every call).
 */
describe("Iris Slack tools — iris_call_transcript", () => {
  it("resolves a name to a contact and returns the real transcript of their most recent call", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    ghl.listContactsPaginated.mockReturnValue(asyncGeneratorOf([{ id: "contact-1", firstName: "Saife", lastName: "Sarwar" }]));
    db.query.mockResolvedValue([
      { transcript: "AI: Hi, this is Iris...\nUser: not interested right now", created_at: new Date("2026-10-01T19:20:03.000Z"), ended_reason: "customer-ended-call" },
    ]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_call_transcript", { nameOrPhone: "Saife" })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("She said she's not interested right now."));

    await irisAgent.generateReply("k9", "can you pull out the conversation here?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.found).toBe(true);
    expect(toolResult.name).toBe("Saife Sarwar");
    expect(toolResult.outcome).toBe("customer-ended-call");
    expect(toolResult.transcript).toContain("not interested right now");
  });

  it("reports found: false for an unmatched contact, rather than inventing a transcript", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.listContactsPaginated.mockReturnValue(asyncGeneratorOf([]));

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_call_transcript", { nameOrPhone: "Nobody Real" })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Couldn't find that lead."));

    await irisAgent.generateReply("k10", "what happened on the call with Nobody Real");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toEqual({ found: false, searchedFor: "Nobody Real" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reports hasCall: false when the contact exists but was never actually called", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.listContactsPaginated.mockReturnValue(asyncGeneratorOf([{ id: "contact-2", firstName: "Brand", lastName: "New" }]));
    db.query.mockResolvedValue([]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_call_transcript", { nameOrPhone: "Brand New" })], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("No calls yet."));

    await irisAgent.generateReply("k11", "what happened on the call with Brand New");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toEqual({ found: true, name: "Brand New", hasCall: false });
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

/**
 * Real gap found live 2026-10-01 (#iris-call-logs): Mark asked "how about
 * the new lead?" then "i mean the new lead that just came in?" and Iris
 * said plainly she had no way to browse the lead list or see who just got
 * added — only a name/phone lookup. iris_pending_calls gets a row the
 * instant Scout's lead.enriched fires, so the newest row IS the newest
 * lead, same ground truth the automatic cadence itself dials from.
 */
describe("Iris Slack tools — iris_newest_lead", () => {
  it("resolves to the most recently captured lead and reports the same depth as iris_lookup_lead", async () => {
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    db.query.mockImplementation((sql: string) => {
      if (sql.includes("iris_pending_calls WHERE client_id = $1 ORDER BY")) {
        return Promise.resolve([
          {
            contact_id: "contact-9",
            lead: { name: "Saife Sarwar", phone: "+17095550199", intent: "buyer" },
            created_at: new Date("2026-10-01T18:00:00.000Z"),
          },
        ]);
      }
      if (sql.includes("iris_pending_calls WHERE client_id = $1 AND contact_id")) {
        return Promise.resolve([
          { status: "pending", resolution_reason: null, is_explicit_callback: false, call_after: new Date("2026-10-02T14:00:00.000Z"), attempts_made: 1 },
        ]);
      }
      return Promise.resolve([]);
    });

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_newest_lead", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("Newest lead is Saife Sarwar, a buyer."));

    await irisAgent.generateReply("k7", "how about the new lead?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toMatchObject({
      found: true,
      name: "Saife Sarwar",
      phone: "+17095550199",
      intent: "buyer",
      currentStatus: "pending",
      attemptsMade: 1,
    });
  });

  it("reports found: false, rather than guessing, when the client has no leads at all yet", async () => {
    db.query.mockResolvedValue([]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_newest_lead", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("No leads yet."));

    await irisAgent.generateReply("k8", "what about the newest lead?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult).toEqual({ found: false });
  });
});

/**
 * Real gap found live 2026-10-01: Mark asked Iris "can you specify those
 * leads you called today?" and she had no tool for it at all — only a
 * single-lead lookup and overall pipeline counts, neither of which lists a
 * day's calls. She correctly said so rather than guessing, but pointed him
 * at #iris-call-logs instead of just answering.
 */
describe("Iris Slack tools — iris_calls_today", () => {
  it("lists every call from today, in order, with real lead names resolved via GHL", async () => {
    ghl.getGhlConfig.mockResolvedValue({ locationId: "loc-1", apiKey: "key-1" });
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    ghl.getContact.mockResolvedValue({ contact: { firstName: "Kaitlyn", lastName: "Sheppard" } });
    db.query.mockResolvedValue([
      {
        contact_id: "contact-1",
        phone: "+17095550100",
        status: "ended",
        ended_reason: "customer-ended-call",
        created_at: new Date("2026-10-01T16:30:00.000Z"),
        triggered_by: "automatic",
      },
    ]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_calls_today", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("1 call today — Kaitlyn Sheppard."));

    await irisAgent.generateReply("k4", "can you specify those leads you called today?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.count).toBe(1);
    expect(toolResult.calls[0]).toMatchObject({
      name: "Kaitlyn Sheppard",
      phone: "+17095550100",
      direction: "outbound",
      outcome: "customer-ended-call",
    });
  });

  it("returns an empty list, without any GHL name lookups, when nothing was called today", async () => {
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    db.query.mockResolvedValue([]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_calls_today", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("No calls today."));

    await irisAgent.generateReply("k5", "any calls today?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.count).toBe(0);
    expect(toolResult.calls).toEqual([]);
    expect(ghl.getContact).not.toHaveBeenCalled();
  });

  it("labels an inbound-answered call distinctly from an outbound one, and never invents a name for an unmatched caller", async () => {
    ghl.getLocationTimezone.mockResolvedValue("America/St_Johns");
    db.query.mockResolvedValue([
      {
        contact_id: null,
        phone: "+17095550199",
        status: "initiated",
        ended_reason: null,
        created_at: new Date("2026-10-01T12:00:00.000Z"),
        triggered_by: "inbound",
      },
    ]);

    vi.mocked(chatWithTools)
      .mockResolvedValueOnce({ content: [toolUseBlock("c1", "iris_calls_today", {})], stop_reason: "tool_use" } as any)
      .mockResolvedValueOnce(endTurn("One inbound call."));

    await irisAgent.generateReply("k6", "any calls today?");

    const secondCallMessages = vi.mocked(chatWithTools).mock.calls[1][1] as any;
    const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
    expect(toolResult.calls[0].direction).toBe("inbound");
    expect(toolResult.calls[0].name).toBe("(unknown name)");
    expect(ghl.getContact).not.toHaveBeenCalled();
  });
});
