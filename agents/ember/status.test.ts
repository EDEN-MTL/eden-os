import { describe, expect, it, vi } from "vitest";
vi.mock("../../shared/claude", () => ({ ask: vi.fn() }));

import { classifyLeadStatus, evidenceIsReal } from "./status";
import { HistoryMessage } from "./history";

const lead = (body: string, at = "2026-09-01T00:00:00Z"): HistoryMessage => ({ direction: "inbound", channel: "sms", body, at });
const us = (body: string, at = "2026-08-31T00:00:00Z"): HistoryMessage => ({ direction: "outbound", channel: "sms", body, at });
const never = vi.fn(async () => {
  throw new Error("model should not be called");
});
const modelSays = (json: object) => vi.fn(async () => JSON.stringify(json));

describe("Mark's 'Do NOT move to Not Interested' examples keep nurturing — no model call", () => {
  it.each([
    "We're probably going to wait until next year.",
    "I'm not ready yet.",
    "We're still thinking about it.",
    "Things are a little busy right now.",
    "I'll let you know when we're ready.",
  ])("%s", async (body) => {
    expect((await classifyLeadStatus([us("Still looking?"), lead(body)], never)).verdict).toBe("keep_nurturing");
    expect(never).not.toHaveBeenCalled();
  });

  it("no response to follow-ups", async () => {
    expect((await classifyLeadStatus([us("Still looking?"), us("Checking in!")], never)).verdict).toBe("keep_nurturing");
  });
});

describe("Mark's 'Move to Not Interested' examples", () => {
  it("'Please stop contacting me. I'm not interested anymore.' — by rule, as a stop request", async () => {
    const d = await classifyLeadStatus([lead("Please stop contacting me. I'm not interested anymore.")], never);
    expect(d).toMatchObject({ verdict: "not_interested", category: "asked_to_stop", by: "rule" });
  });

  it("'I decided to work with another agent.' — by rule (a strong trigger)", async () => {
    const d = await classifyLeadStatus([lead("I decided to work with another agent.")], never);
    expect(d).toMatchObject({ verdict: "not_interested", category: "other_agent", by: "rule" });
  });

  it.each([
    ["I already bought a house last month.", "already_bought"],
    ["We're no longer looking to buy.", "no_longer_looking"],
    ["We've already sold our property.", "already_sold"],
  ])("'%s' — model confirms, quoting them", async (body, category) => {
    const ask = modelSays({ verdict: "not_interested", category, evidence: body });
    expect(await classifyLeadStatus([lead(body)], ask)).toEqual({ verdict: "not_interested", category, evidence: body, by: "ai" });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("guardrails", () => {
  it("a hedged agent mention goes to the model instead of moving by rule", async () => {
    const ask = modelSays({ verdict: "keep_nurturing", reason: "only considering it" });
    expect((await classifyLeadStatus([lead("we might go with another agent, not sure")], ask)).verdict).toBe("keep_nurturing");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("an agent mention followed by renewed interest isn't moved by rule", async () => {
    const ask = modelSays({ verdict: "keep_nurturing", reason: "looking again" });
    const thread = [lead("we're working with another agent", "2026-03-01T00:00:00Z"), lead("that didn't work out, still looking!", "2026-06-01T00:00:00Z")];
    expect((await classifyLeadStatus(thread, ask)).verdict).toBe("keep_nurturing");
  });

  it("no verifiable quote = not clear evidence = keep nurturing", async () => {
    const ask = modelSays({ verdict: "not_interested", category: "already_bought", evidence: "we bought a condo downtown" });
    expect((await classifyLeadStatus([lead("we bought some furniture lol, still looking")], ask)).verdict).toBe("keep_nurturing");
  });

  it("a quote from OUR message doesn't count", () => {
    expect(evidenceIsReal("not interested", [us("Not interested anymore? No worries!"), lead("hi")])).toBe(false);
    expect(evidenceIsReal("Not interested anymore", [lead("Honestly, not interested anymore.")])).toBe(true);
  });

  it("model failure on a possible clear no is 'unsure' — never a move, never a text", async () => {
    const d = await classifyLeadStatus([lead("we bought last month")], vi.fn(async () => { throw new Error("no key"); }));
    expect(d.verdict).toBe("unsure");
  });

  it("an unknown category from the model is kept as other_clear", async () => {
    const ask = modelSays({ verdict: "not_interested", category: "moved_abroad", evidence: "we moved to Alberta for good" });
    expect(await classifyLeadStatus([lead("we moved to Alberta for good, no longer need help")], ask)).toMatchObject({ category: "other_clear" });
  });
});
