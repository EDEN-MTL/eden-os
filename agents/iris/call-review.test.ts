import { describe, expect, it } from "vitest";
import { reviewCall } from "./call-review";

const OPENER = "Hi, this is Iris with 3 Percent East Coast. Am I speaking with Amanda?";
const u = (message: string) => ({ role: "user", message });
const b = (message: string) => ({ role: "bot", message });
const base = { endedReason: "assistant-ended-call", durationSeconds: 30, machineOnly: false } as const;

describe("reviewCall — the real failures it exists to catch", () => {
  it("Koren Pye, Oct 13: said 'Goodbye.' into a screener", () => {
    const r = reviewCall({
      ...base,
      machineOnly: true,
      lines: [u("If you record your name and reason for calling, I'll see if this person is available. I'm sorry. This person is not available."), b("Goodbye.")],
    });
    expect(r.verdict).toBe("attention");
    expect(r.flags[0]).toMatch(/spoke into a screener\/voicemail.*Goodbye/);
  });

  it("Koren Pye, Oct 12: read her own instruction aloud and asked a screener if it could hear her", () => {
    const r = reviewCall({
      ...base,
      machineOnly: true,
      lines: [u("Thanks. Please stay on the line."), b("I'll stay silent and wait for a real person to join."), b("Sorry. Can you still hear me okay?")],
    });
    expect(r.flags.some((f) => /own instruction out loud/.test(f))).toBe(true);
    expect(r.flags.some((f) => /spoke into a screener/.test(f))).toBe(true);
  });

  it("Amanda Marie, Oct 13: garbled opener and dodged 'Is this an AI?'", () => {
    const r = reviewCall({
      ...base,
      endedReason: "customer-ended-call",
      durationSeconds: 22,
      expectedOpener: OPENER,
      lines: [
        u("Hello."),
        b("Hi. This is Iris with 3 percent East Coast. I speaking with Amanda?"),
        u("Is this an AI?"),
        b("This is Iris with 3 percent East Coast. How are you doing today?"),
      ],
    });
    expect(r.verdict).toBe("attention");
    expect(r.flags.some((f) => /Opening line wasn’t word for word/.test(f))).toBe(true);
    expect(r.flags.some((f) => /asked if she’s an AI.*didn’t answer/.test(f))).toBe(true);
    expect(r.flags.some((f) => /introduced herself 2 times/.test(f))).toBe(true);
    expect(r.summary).toMatch(/hung up after 22s/);
  });

  it("Angela Marie, Oct 14: a voicemail hang-up with no retry lined up", () => {
    const r = reviewCall({
      ...base,
      machineOnly: true,
      lines: [u("Call has been forwarded to voice mail. The person you're trying to reach is not available.")],
      retryExpected: true,
      retryLinedUp: false,
    });
    expect(r.flags).toContain("No retry is lined up for this lead");
  });
});

describe("reviewCall — calls that went right", () => {
  it("a screener answered with just 'Iris.' is fine", () => {
    const r = reviewCall({ ...base, machineOnly: true, lines: [u("Record your name and reason for calling."), b("Iris."), u("Thanks. Please stay on the line.")] });
    expect(r.verdict).toBe("ok");
    expect(r.summary).toMatch(/Hit a machine; Iris stayed quiet/);
  });

  it("a silent hang-up on a voicemail with a retry lined up is fine", () => {
    const r = reviewCall({ ...base, machineOnly: true, lines: [u("Please leave a message after the tone.")], retryExpected: true, retryLinedUp: true });
    expect(r.verdict).toBe("ok");
  });

  it("an exact opener, a straight AI answer and no repeat intro is fine, even when the transcript formats '%' differently", () => {
    const r = reviewCall({
      ...base,
      expectedOpener: OPENER,
      lines: [
        u("Hello?"),
        b("Hi, this is Iris with 3 percent East Coast. Am I speaking with Amanda?"),
        u("Are you a robot?"),
        b("Yes, I'm an AI assistant with 3 Percent East Coast — I just gather a few details so the right agent can help you."),
      ],
    });
    expect(r.verdict).toBe("ok");
    expect(r.summary).toMatch(/Real conversation/);
  });

  it("does not mistake an ordinary sentence for an AI question", () => {
    const r = reviewCall({ ...base, expectedOpener: OPENER, lines: [u("Hello"), b(OPENER), u("Yes this is Amanda, I am looking to buy a house"), b("Great, what area?")] });
    expect(r.verdict).toBe("ok");
  });

  it("'Iris.' to a screener is not mistaken for a botched opener", () => {
    const r = reviewCall({ ...base, expectedOpener: OPENER, lines: [u("Record your name and reason for calling."), b("Iris."), u("Thanks. Please stay on the line.")] });
    expect(r.flags).toEqual([]);
  });

  it("no one spoke at all is fine", () => {
    expect(reviewCall({ ...base, lines: [] }).verdict).toBe("ok");
  });
});
