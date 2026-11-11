import { describe, expect, it } from "vitest";
import { buildTransferResumeText, isaNotesFromCall, isTransferResumeRow, transferResumeExpired, whenPhrase } from "./transfer-resume";

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
