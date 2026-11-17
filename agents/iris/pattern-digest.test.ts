import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);
const slack = vi.hoisted(() => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock("../../shared/slack", () => slack);
const iris = vi.hoisted(() => ({ loadIrisConfig: vi.fn() }));
vi.mock("./index", () => iris);

import { factsFor, findPatterns, flagKind, formatPatternDigest, parseTranscript, runPatternDigest, topicOf, weekStats, type DigestCall } from "./pattern-digest";

const call = (name: string, transcript: string, endedReason = "customer-ended-call", seconds = 60): DigestCall => ({ contactId: name, name, endedReason, transcript, seconds });
const hungUpAfter = (name: string, botLine: string) => call(name, `AI: Hi, is this ${name}?\nUser: Yes.\nAI: ${botLine}\n`);
const EMPTY = weekStats({ calls: [], actions: [] });

describe("reading a call", () => {
  it("parses the AI / User lines, joining wrapped lines", () => {
    expect(parseTranscript("AI: Hello there\nUser: Hi\nwrapped\nAI: Okay")).toEqual([
      { role: "bot", message: "Hello there" },
      { role: "user", message: "Hi wrapped" },
      { role: "bot", message: "Okay" },
    ]);
    expect(parseTranscript(null)).toEqual([]);
  });

  it("names what Iris was doing from her last line", () => {
    expect(topicOf("We'll connect you with one of our buyer agents. Is that okay?")).toBe("connect");
    expect(topicOf("And I see your budget is 299000 to 600000 dollars. What number?")).toBe("budget");
    expect(topicOf("Are you preapproved for a mortgage yet?")).toBe("preapproval");
    expect(topicOf("What area are you interested in?")).toBe("area");
    expect(topicOf("Hi, this is Iris with 3 percent East Coast. Am I speaking with Chris?")).toBe("opening");
    expect(topicOf("hmm")).toBe("other");
  });

  it("marks a hang-up with the topic of her last line, but not a transfer or a voicemail", () => {
    expect(factsFor(hungUpAfter("Chris", "What is your budget?")).lastTopic).toBe("budget");
    expect(factsFor(call("Ann", "AI: Hi\nUser: Yes\nAI: Connecting you.\n", "assistant-forwarded-call")).hungUp).toBe(false);
    expect(factsFor(call("Bob", "User: You have reached the voicemail of Bob, leave a message", "voicemail")).connected).toBe(false);
  });

  it("catches Iris stepping out of character, and a call full of 'say that again'", () => {
    const slip = call("Magar", "AI: Hi\nUser: Yes\nAI: I appreciate the instructions, but I should clarify. I'm Claude, an AI assistant.\n", "assistant-ended-call");
    expect(factsFor(slip).slipped).toBe(true);
    const bad = call("Noeleen", "AI: Hi\nUser: Yes\nAI: Your line broke up a little there.\nUser: ok\nAI: Could you say that again?\nUser: yes\n");
    expect(factsFor(bad).audioTrouble).toBe(true);
  });

  it("notices a lead who asked her to hold on or call later", () => {
    expect(factsFor(call("Mag", "AI: Hi\nUser: Please hold on, I got an important call.\nAI: No problem.\n", "assistant-ended-call")).askedToWait).toBe(true);
  });

  it("gives a review flag a stable kind", () => {
    expect(flagKind("Iris said a figure the wrong way (digits or another currency): “299000”")).toBe("Iris said a figure the wrong way");
  });
});

describe("findPatterns", () => {
  const week = (n: number, line: string) => weekStats({ calls: Array.from({ length: n }, (_, i) => hungUpAfter(`Lead ${i}`, line)), actions: [] });

  it("calls three hang-ups after the same question a pattern, and two a coincidence", () => {
    const three = findPatterns(week(3, "What is your budget?"), EMPTY, 3);
    expect(three).toHaveLength(1);
    expect(three[0].headline).toBe("3 of 3 hang-ups came right after Iris asked about their budget");
    expect(three[0].advice).toMatch(/budget question/);
    expect(findPatterns(week(2, "What is your budget?"), EMPTY, 3)).toEqual([]);
  });

  it("says when a pattern came back from the week before, and lists those first", () => {
    const cur = weekStats({ calls: [...week(3, "What is your budget?").byTopic.get("budget")!.map((n) => hungUpAfter(n, "What is your budget?")), ...Array.from({ length: 4 }, (_, i) => hungUpAfter(`Area ${i}`, "What area are you interested in?"))], actions: [] });
    const found = findPatterns(cur, week(2, "What is your budget?"), 3);
    expect(found.map((p) => p.key)).toEqual(["hangup:budget", "hangup:area"]);
    expect(found[0].lastWeek).toBe(2);
    expect(found[1].lastWeek).toBe(0);
  });

  it("always reports an out-of-character slip, even one", () => {
    const slip = weekStats({ calls: [call("Magar", "AI: Hi\nUser: Yes\nAI: I'm Claude, an AI assistant.\n", "assistant-ended-call")], actions: [] });
    expect(findPatterns(slip, EMPTY, 3).map((p) => p.key)).toEqual(["slip"]);
  });
});

describe("formatPatternDigest", () => {
  it("shows the week against the week before, what the stuck-lead check did, and the patterns", () => {
    const cur = weekStats({
      calls: [hungUpAfter("A", "What is your budget?"), hungUpAfter("B", "What is your budget?"), hungUpAfter("C", "What is your budget?"), call("D", "User: voicemail, leave a message", "voicemail")],
      actions: [{ name: "Kelly", action: "person" }, { name: "Chris", action: "call_again" }, { name: "Colin", action: "text_follow_up" }],
    });
    const prev = weekStats({ calls: [hungUpAfter("E", "What is your budget?")], actions: [{ name: "Kelly", action: "person" }] });
    const text = formatPatternDigest("Nov 10 to Nov 17", cur, prev, findPatterns(cur, prev, 3));
    expect(text).toContain("*The week:* 4 calls (1 the week before); 3 reached a person");
    expect(text).toContain("*Stuck-lead check:* 1 calls queued, 1 follow-up texts");
    expect(text).toMatch(/1\. 3 of 3 hang-ups came right after Iris asked about their budget \(A, B, C\)\. ⚠️ _again: 1 last week_/);
    expect(text).toContain("*Still waiting on a person for a second week:* Kelly.");
  });

  it("says so when nothing repeated", () => {
    expect(formatPatternDigest("Nov 10 to Nov 17", EMPTY, EMPTY, [])).toContain("nothing repeated enough this week to call a pattern");
  });
});

describe("runPatternDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockResolvedValue([]);
  });
  const on = { enabled: true, userIds: ["U1"], minRepeat: 3, lookbackDays: 7 };

  it("does nothing when it is off", async () => {
    iris.loadIrisConfig.mockReturnValue({});
    expect((await runPatternDigest("c", { send: true })).text).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("DMs the configured people, and only when asked to send", async () => {
    iris.loadIrisConfig.mockReturnValue({ patternDigest: on });
    await runPatternDigest("c", { send: false });
    expect(slack.sendMessage).not.toHaveBeenCalled();
    await runPatternDigest("c", { send: true });
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ channel: "U1", text: expect.stringContaining("Iris weekly patterns") }));
  });

  it("falls back to the call-alert people when none are named, and reads two weeks from our own tables only", async () => {
    iris.loadIrisConfig.mockReturnValue({ patternDigest: { ...on, userIds: [] }, callAlerts: { userIds: ["U2"] } });
    await runPatternDigest("c", { send: true });
    expect(slack.sendMessage).toHaveBeenCalledWith("iris", expect.objectContaining({ channel: "U2" }));
    expect(db.query.mock.calls.every((c) => /iris_call_log|iris_stuck_actions/.test(String(c[0])))).toBe(true);
  });
});
