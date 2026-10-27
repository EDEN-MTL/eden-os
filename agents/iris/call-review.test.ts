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

describe("reviewCall — a promised transfer that never happened", () => {
  const angelaLines = [
    u("Hello?"),
    b("Hi, this is Iris with 3 Percent East Coast. Am I speaking with Angela?"),
    u("Yes."),
    b("Right. Got it. You're just selling for now. That makes sense. Sounds good. I'll connect you with 1 of our seller agents now. They'll be able to walk you through the next steps."),
  ];

  it("Angela Marie, Oct 14: told she'd be connected, hung up in silence, no transfer", () => {
    const r = reviewCall({ ...base, endedReason: "customer-ended-call", durationSeconds: 125, lines: angelaLines });
    expect(r.verdict).toBe("attention");
    expect(r.flags.some((f) => /told the lead she’d connect them with an agent, but no transfer happened.*customer-ended-call/.test(f))).toBe(true);
  });

  it("is fine when the transfer actually connected", () => {
    const r = reviewCall({ ...base, endedReason: "assistant-forwarded-call", transferSucceeded: true, lines: angelaLines });
    expect(r.flags.some((f) => /no transfer happened/.test(f))).toBe(false);
  });

  it("is fine when the lead said no and Iris booked a time instead", () => {
    const r = reviewCall({
      ...base,
      lines: [
        u("Hello?"),
        b("Hi, this is Iris with 3 Percent East Coast. Am I speaking with Angela?"),
        b("Sounds good. I'll connect you with one of our seller agents now. Is that okay?"),
        u("Not right now."),
        b("No problem. What day and time works?"),
        u("Tomorrow at 10."),
        b("You're all set for tomorrow at 10 AM. An agent will call you then."),
      ],
    });
    expect(r.flags.some((f) => /no transfer happened/.test(f))).toBe(false);
  });
});

describe("reviewCall — calls that went right", () => {
  it("Stella Max Clements and Alyson Simms, Oct 14: real people said hello and Iris never spoke", () => {
    const r = reviewCall({ ...base, endedReason: "customer-ended-call", durationSeconds: 23, expectedOpener: OPENER, lines: [u("Hello? Hello? Hello? Hello?")] });
    expect(r.verdict).toBe("attention");
    expect(r.flags[0]).toMatch(/Someone spoke.*Iris never said a word/);
  });

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

describe("shouldAlertTeam / formatCallAlert — Mark is told, he doesn't go looking", () => {
  it("alerts when a person was reached, when something is flagged, or for a lead someone asked Iris to call; not for a routine voicemail", async () => {
    const { shouldAlertTeam } = await import("./call-review");
    expect(shouldAlertTeam({ reachedPerson: true, flagged: false, watched: false })).toBe(true);
    expect(shouldAlertTeam({ reachedPerson: false, flagged: true, watched: false })).toBe(true);
    expect(shouldAlertTeam({ reachedPerson: false, flagged: false, watched: true })).toBe(true);
    expect(shouldAlertTeam({ reachedPerson: false, flagged: false, watched: false })).toBe(false);
  });

  it("writes a short message: who, when, outcome, what happens next, and the review only when it found something", async () => {
    const { formatCallAlert } = await import("./call-review");
    const clean = formatCallAlert({
      who: "Koren Pye",
      whenLocal: "Thursday, October 15 at 10:00 AM",
      outcome: "📵 Voicemail greeting, no message left — will retry",
      duration: "11s",
      review: reviewCall({ ...base, machineOnly: true, lines: [u("Please leave a message after the tone.")] }),
      nextStep: "Iris calls again Friday, October 16 at 10:00 AM",
    });
    expect(clean).toBe(
      "📞 *Koren Pye* — Thursday, October 15 at 10:00 AM (11s)\n📵 Voicemail greeting, no message left — will retry\nNext: Iris calls again Friday, October 16 at 10:00 AM"
    );
    const flagged = formatCallAlert({
      who: "Angela Marie",
      whenLocal: "x",
      outcome: "💬 Answered (no transfer)",
      duration: "2m 5s",
      review: reviewCall({ ...base, endedReason: "customer-ended-call", lines: [u("Hello?"), b("I'll connect you with one of our agents now.")] }),
      nextStep: "nothing scheduled",
    });
    expect(flagged).toContain("⚠️ *Needs a look:*");
  });
});

describe("reviewCall — a figure said the wrong way (Noeleen Gray, 2026-10-18)", () => {
  it("flags the exact line from the real call: digits split by the voice, and 'euro'", () => {
    const r = reviewCall({ ...base, lines: [u("Yes."), b("Timeline of 1 to 4 months, budget around 2 9 9 2 5 euro dollars, and you're Sorry.")] });
    expect(r.verdict).toBe("attention");
    expect(r.flags.some((f) => /figure the wrong way/.test(f))).toBe(true);
  });

  it("flags a long run of digits, a $ on a figure, or another currency", () => {
    for (const text of ["Budget around 299000 dollars.", "Around $299 thousand.", "Around 300 euros.", "About £250,000."]) {
      const r = reviewCall({ ...base, lines: [u("Yes."), b(text)] });
      expect(r.flags.some((f) => /figure the wrong way/.test(f)), text).toBe(true);
    }
  });

  it("does not flag amounts in words, street numbers, bedrooms or times", () => {
    const r = reviewCall({
      ...base,
      lines: [u("Yes."), b("Budget around two hundred ninety-nine thousand to six hundred thousand dollars, 3 bedrooms, 2.5 bathrooms, 142 Hussey Drive, Friday at 2 PM.")],
    });
    expect(r.flags.some((f) => /figure the wrong way/.test(f))).toBe(false);
  });
});

describe("reviewCall: an answered call where nothing was transcribed", () => {
  const base = { lines: [], durationSeconds: 22, machineOnly: false } as const;
  it("flags a call the person answered and then hung up on silence (Soyemi Damilola, 2026-10-20)", () => {
    const r = reviewCall({ ...base, endedReason: "customer-ended-call" });
    expect(r.verdict).toBe("attention");
    expect(r.flags[0]).toMatch(/nothing was transcribed and Iris never spoke/);
    expect(reviewCall({ ...base, durationSeconds: 30, endedReason: "silence-timed-out" }).verdict).toBe("attention");
  });
  it("does not flag a call nobody answered, a very short blip, or a voicemail", () => {
    expect(reviewCall({ ...base, endedReason: "customer-did-not-answer" }).verdict).toBe("ok");
    expect(reviewCall({ ...base, durationSeconds: 3, endedReason: "customer-ended-call" }).verdict).toBe("ok");
    expect(reviewCall({ ...base, machineOnly: true, endedReason: "customer-ended-call" }).verdict).toBe("ok");
  });
});

