import { describe, expect, it } from "vitest";
import { isNoOrParkedStage, isSoftDecline, notesSayDeclined, notNowQuote, plainDeclineQuote } from "./decline";

/** Geoff Harris, 2026-11-22: "Not interested anymore" was only a "maybe" to the model, so nobody was closed. */
describe("plainDeclineQuote: a message that is only a plain, permanent no", () => {
  it.each([
    "Not interested anymore",
    "not interested",
    "Not interested.",
    "I'm not interested",
    "No longer interested",
    "No more interested", // Veronica Dawson-Amoah, 2026-11-12
    "We are no longer interested, thanks",
    "No thanks, not interested",
    "Not interested thank you!",
    "I am no longer looking",
    "not looking anymore",
  ])("%s is a clear stop, quoted as the lead wrote it", (text) => {
    expect(plainDeclineQuote(text)).toBe(text.trim());
  });

  it.each([
    "Not interested right now", // temporary: a maybe
    "Not interested yet",
    "Not interested in condos",
    "I'm not interested in a call", // might only be a no-calls
    "Not interested in selling, I want to buy",
    "Not at this time. When I'm ready to pursue house hunting, I'll let you know",
    "I'm not looking", // bare: could be a correction
    "Still interested, not looking for a call though",
    "Are you not interested anymore?",
    "",
  ])("%s is left to the model (a maybe)", (text) => {
    expect(plainDeclineQuote(text)).toBeNull();
  });
});

describe("isSoftDecline: a polite not-now that asks for nothing", () => {
  it("catches Michelle Smith Funk's text", () => {
    expect(isSoftDecline("Not at this time. When I'm ready to pursue house hunting, I'll let you know")).toBe(true);
  });
  it("counts a plain no as one too", () => expect(isSoftDecline("Not interested anymore")).toBe(true));
  it("does not treat a reply that asks something as a no", () => {
    expect(isSoftDecline("Not right now, can you call me tomorrow at 5?")).toBe(false);
    expect(isSoftDecline("I'm not ready to buy yet, what are mortgage rates?")).toBe(false);
  });
  it("leaves a long message alone", () => expect(isSoftDecline(`Not right now. ${"We are looking at a few things and will see. ".repeat(6)}`)).toBe(false));
});

describe("notes and stages", () => {
  it("reads a declined-contact note", () => {
    expect(notesSayDeclined("Lead declined to be connected at this time. Said they will reach out when ready.")).toBe(true);
    expect(notesSayDeclined("Buyer | 6+ months | declined pre-approval | $300K")).toBe(false);
  });
  it("knows the columns that already mean no or not ready", () => {
    for (const s of ["Not Qualified/Not Interested", "Not Ready - [Endless Loop]", "Long Term Nurturing"]) expect(isNoOrParkedStage(s)).toBe(true);
    for (const s of ["Replied", "DAY 1 - AM FOLLOWUP", "Live Transferred"]) expect(isNoOrParkedStage(s)).toBe(false);
  });
});

describe("notNowQuote: not right now, which goes to Not Ready for Ember", () => {
  it.each(["Not interested right now", "Not at this time. When I'm ready to pursue house hunting, I'll let you know", "maybe later", "Not this year", "I'm not ready yet", "Not right now, thanks"])("%s", (t) => {
    expect(notNowQuote(t)).toBe(t.trim());
  });
  it.each([
    "Not interested anymore", // permanent
    "Not right now, stop texting me",
    "Not right now and don't call me",
    "No thanks", // could be forever
    "Not right now, can you call me tomorrow?",
    "Not right now, what are rates?",
    "Never",
    "",
  ])("%s is not a not-now", (t) => expect(notNowQuote(t)).toBeNull());
});
