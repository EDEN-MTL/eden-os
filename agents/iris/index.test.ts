import { describe, expect, it } from "vitest";
import { irisAgent } from "./index";

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
    expect(prompt).toMatch(/live call once Vapi is wired up, or a GHL\s+text thread/i);
  });

  it("only mentions the client name once, as background rather than a recurring role description", () => {
    const prompt = irisAgent.getSystemPrompt();
    const mentions = prompt.match(/3 Percent East Coast/g) || [];
    expect(mentions.length).toBe(1);
  });
});
