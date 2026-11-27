import { describe, expect, it } from "vitest";
import { decideIntroWait, introTextSent, parseFirstCallConfig } from "./intro-text";

const CFG = { waitForIntroText: true, maxWaitMinutes: 20, recheckMinutes: 2, introTextPattern: "AI assistant|IRIS" };
const now = new Date("2026-11-27T15:16:00.000Z");
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("parseFirstCallConfig", () => {
  it("is off unless waitForIntroText is true and a pattern is given", () => {
    expect(parseFirstCallConfig(undefined)).toBeNull();
    expect(parseFirstCallConfig({ introTextPattern: "IRIS" })).toBeNull();
    expect(parseFirstCallConfig({ waitForIntroText: true })).toBeNull();
    expect(parseFirstCallConfig({ waitForIntroText: true, introTextPattern: "(" })).toBeNull();
  });
  it("fills defaults and keeps real numbers", () => {
    expect(parseFirstCallConfig({ waitForIntroText: true, introTextPattern: "IRIS" })).toEqual({ waitForIntroText: true, maxWaitMinutes: 20, recheckMinutes: 2, introTextPattern: "IRIS" });
    expect(parseFirstCallConfig({ waitForIntroText: true, introTextPattern: "IRIS", maxWaitMinutes: 30, recheckMinutes: 3 })).toMatchObject({ maxWaitMinutes: 30, recheckMinutes: 3 });
    expect(parseFirstCallConfig({ waitForIntroText: true, introTextPattern: "IRIS", maxWaitMinutes: -1 })?.maxWaitMinutes).toBe(20);
  });
});

describe("introTextSent", () => {
  it("finds the AI-assistant text among OUR texts, ignoring the lead's and the first hello", () => {
    expect(introTextSent([{ from: "us", text: "Hey Ellen! Do I have the right number here ?" }], CFG.introTextPattern)).toBe(false);
    expect(introTextSent([{ from: "lead", text: "Is this Iris?" }], CFG.introTextPattern)).toBe(false);
    expect(introTextSent([{ from: "us", text: "you'll receive a quick call from our AI assistant, IRIS." }], CFG.introTextPattern)).toBe(true);
  });
});

describe("decideIntroWait", () => {
  it("dials when the text is there", () => {
    expect(decideIntroWait({ introSent: true, waitStartedAt: null, now, config: CFG })).toEqual({ action: "dial" });
  });
  it("starts waiting the first time it is missing, and looks again in recheckMinutes", () => {
    expect(decideIntroWait({ introSent: false, waitStartedAt: null, now, config: CFG })).toEqual({ action: "wait", startedAt: now, recheckAt: new Date(now.getTime() + 120_000) });
  });
  it("keeps waiting inside the cap, counted from the first hold", () => {
    const d = decideIntroWait({ introSent: false, waitStartedAt: minsAgo(19), now, config: CFG });
    expect(d).toMatchObject({ action: "wait", startedAt: minsAgo(19) });
  });
  it("calls anyway once the cap is reached", () => {
    expect(decideIntroWait({ introSent: false, waitStartedAt: minsAgo(20), now, config: CFG })).toEqual({ action: "dial_anyway", waitedMinutes: 20 });
  });
});
