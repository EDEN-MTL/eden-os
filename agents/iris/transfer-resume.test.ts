import { describe, expect, it } from "vitest";
import { buildTransferResumeText, callSummaryFromCall, hungUpAtTransferAsk, isaNotesFromCall, isTransferResumeRow, transferResumeExpired, whenPhrase } from "./transfer-resume";

describe("isaNotesFromCall", () => {
  const call = (notes: string) => ({ role: "tool_calls", toolCalls: [{ function: { name: "save_isa_notes", arguments: JSON.stringify({ notes }) } }] });

  it("reads Iris's own note from the call that dropped (Michelle Smith Funk, 2026-11-11)", () => {
    const message = { messages: [{ role: "user", message: "Okay." }, call("Buyer | $500K | Paradise, Mount Pearl")] };
    expect(isaNotesFromCall(message)).toBe("Buyer | $500K | Paradise, Mount Pearl");
  });

  it("uses the last note when she saved more than one", () => {
    expect(isaNotesFromCall({ messages: [call("first"), call("corrected")] })).toBe("corrected");
  });

  it("is null when she never saved one, or the arguments can't be read", () => {
    expect(isaNotesFromCall({ messages: [{ role: "user", message: "hi" }] })).toBeNull();
    expect(isaNotesFromCall({ messages: [{ role: "tool_calls", toolCalls: [{ function: { name: "save_isa_notes", arguments: "{oops" } }] }] })).toBeNull();
    expect(isaNotesFromCall({})).toBeNull();
  });
});

/** Jerrick Mendoza, 2026-11-16: qualified, Iris asked "Is that okay?", he hung up ten seconds later. */
describe("hungUpAtTransferAsk", () => {
  const turn = (role: "user" | "bot", message: string) => ({ role, message });
  const qualified = [
    turn("bot", "Hi. This is Iris with 3 percent East Coast."),
    turn("user", "Yeah. Speaking."),
    turn("bot", "And you put down 3 to 6 months as your timeline. Is there a particular month you're aiming for?"),
    turn("user", "None."),
    turn("bot", "And on budget, what number are you really thinking?"),
    turn("bot", "What area are you interested in?"),
    turn("user", "Mount Pearl."),
    turn("bot", "Are you preapproved for a mortgage yet?"),
    turn("user", "Right."),
  ];
  const ask = turn("bot", "Perfect. We'll connect you with 1 of our buyer agents to send over some available home options. Is that okay?");

  it("is true when the lead hung up on the transfer question without answering", () => {
    expect(hungUpAtTransferAsk({ messages: [...qualified, ask] }, "customer-ended-call")).toBe(true);
    expect(hungUpAtTransferAsk({ artifact: { messages: [...qualified, ask] } }, "customer-ended-call")).toBe(true);
  });

  it("is true when she had said she was connecting them and they were gone", () => {
    expect(hungUpAtTransferAsk({ messages: [...qualified, turn("bot", "Great, I'm connecting you now.")] }, "customer-ended-call")).toBe(true);
  });

  it("is false when the lead answered, whatever they said (a callback request is handled elsewhere)", () => {
    expect(hungUpAtTransferAsk({ messages: [...qualified, ask, turn("user", "Can you call me later?")] }, "customer-ended-call")).toBe(false);
  });

  it("is false when her last line was not the transfer ask, e.g. she said goodbye after a no", () => {
    expect(hungUpAtTransferAsk({ messages: [...qualified, ask, turn("user", "No thanks."), turn("bot", "No problem, have a great day!")] }, "customer-ended-call")).toBe(false);
  });

  // Daniel Eiriz, 2026-11-17: the greeting itself says "we can get you connected with someone who can send over some
  // listings". He said hello three times and hung up; Slack said he "was qualified and hung up when Iris asked to connect".
  it("is false when the only mention of connecting is in the greeting (Daniel Eiriz)", () => {
    const daniel = [
      turn("user", "Hello?"),
      turn("bot", "Hi. This is Iris with 3 percent East Coast. Am I speaking with Daniel?"),
      turn("user", "Yeah. That's right."),
      turn("bot", "How are you doing today?"),
      turn("user", "Good good."),
      turn("bot", "Awesome. We'd love to get some options over to you. I'm just going to confirm a few details from what you submitted, and then we can get you connected with someone who can send over some listings. So I see you're looking to buy still the case?"),
    ];
    expect(hungUpAtTransferAsk({ messages: daniel }, "customer-ended-call")).toBe(false);
  });

  it("is false when she asked only one or two qualifying questions before the ask", () => {
    const early = [turn("bot", "Hi, am I speaking with Pat?"), turn("user", "Yes."), turn("bot", "What is your budget?"), turn("user", "Around 400."), turn("bot", "And the timeline?"), turn("user", "Soon.")];
    expect(hungUpAtTransferAsk({ messages: [...early, ask] }, "customer-ended-call")).toBe(false);
  });

  it("is false for a call that never got as far as qualifying, and for any other end reason", () => {
    expect(hungUpAtTransferAsk({ messages: [turn("bot", "Hi, am I speaking with Jerrick?"), turn("user", "Yes."), ask] }, "customer-ended-call")).toBe(false);
    expect(hungUpAtTransferAsk({ messages: [...qualified, ask] }, "customer-did-not-answer")).toBe(false);
    expect(hungUpAtTransferAsk({ messages: [...qualified, ask] }, "assistant-ended-call")).toBe(false);
    expect(hungUpAtTransferAsk({}, "customer-ended-call")).toBe(false);
  });
});

describe("callSummaryFromCall", () => {
  it("uses Vapi's summary when Iris saved no note, without its trailing full stop", () => {
    expect(callSummaryFromCall({ summary: "Jerrick wants a 1-story home in Mount Pearl, budget $200,000-$350,000." })).toBe("Jerrick wants a 1-story home in Mount Pearl, budget $200,000-$350,000");
    expect(callSummaryFromCall({ analysis: { summary: "Buyer, Paradise." } })).toBe("Buyer, Paradise");
  });

  it("is null when there is none", () => {
    expect(callSummaryFromCall({})).toBeNull();
    expect(callSummaryFromCall({ summary: "  " })).toBeNull();
  });
});

describe("buildTransferResumeText variations", () => {
  it("gives the same lead the same text, and different leads different wording", () => {
    const texts = new Set(["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"].map((id) => buildTransferResumeText("Jerrick Mendoza", "3 Percent East Coast", id)));
    expect(texts.size).toBeGreaterThan(1);
    expect(buildTransferResumeText("Jerrick Mendoza", "3 Percent East Coast", "NumG4qP0k9cksuJmCCYr")).toBe(buildTransferResumeText("Jerrick Mendoza", "3 Percent East Coast", "NumG4qP0k9cksuJmCCYr"));
  });

  it.each(["a1", "b2", "c3", "d4", "e5", "f6"])("every variation names the lead and Iris, asks if they are still good to be connected, and has no 'Reply STOP' (%s)", (id) => {
    const text = buildTransferResumeText("Jerrick Mendoza", "3 Percent East Coast", id);
    expect(text).toMatch(/^Hi Jerrick, it's Iris from 3 Percent East Coast\./);
    expect(text).toMatch(/connected|talk with them/);
    expect(text).not.toMatch(/STOP/);
  });
});

describe("buildTransferResumeText", () => {
  it("asks whether they hung up or still want to be connected, with no 'Reply STOP' line", () => {
    const text = buildTransferResumeText("Michelle Smith Funk", "3 Percent East Coast");
    expect(text).toBe("Hi Michelle, it's Iris from 3 Percent East Coast. It looks like our call got cut off while I was connecting you with one of our agents. Did you hang up, or would you still like to be connected?");
    expect(text).not.toMatch(/STOP/);
  });
});

describe("whenPhrase / transferResumeExpired", () => {
  const at = "2026-11-11T13:34:00.000Z";
  it("says 'a few minutes ago' for the normal quick retry, and never for a retry that had to wait", () => {
    expect(whenPhrase(at, new Date("2026-11-11T13:38:00.000Z"))).toBe("a few minutes ago");
    expect(whenPhrase(at, new Date("2026-11-11T15:00:00.000Z"))).toBe("earlier");
    expect(whenPhrase(at, new Date("2026-11-13T15:00:00.000Z"))).toBe("the other day");
  });

  it("stops picking up where they left off after two days", () => {
    expect(transferResumeExpired(at, new Date("2026-11-13T13:00:00.000Z"))).toBe(false);
    expect(transferResumeExpired(at, new Date("2026-11-13T14:00:00.000Z"))).toBe(true);
  });
});

describe("isTransferResumeRow", () => {
  it("needs both the source and the saved state, so a callback the lead asked for later is an ordinary one", () => {
    expect(isTransferResumeRow({ source: "transfer-resume", lead: { transferResume: { count: 1 } } })).toBe(true);
    expect(isTransferResumeRow({ source: "transfer-resume", lead: { name: "x" } })).toBe(false);
    expect(isTransferResumeRow({ source: "ember", lead: { transferResume: { count: 1 } } })).toBe(false);
  });
});
