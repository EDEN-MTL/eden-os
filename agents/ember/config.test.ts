import { describe, expect, it } from "vitest";
import { loadEmberConfig, renderTemplate, validateForSending } from "./config";
import { config } from "./test-fixtures";

describe("validateForSending", () => {
  it("accepts the fixture config", () => {
    expect(validateForSending(config())).toEqual([]);
  });

  it("requires CASL basics on email: unsubscribe link, mailing address, sender", () => {
    const c = config();
    c.outreach.email = { enabled: true, fromAddress: "", physicalAddress: "", templates: [{ subject: "s", html: "hi" }] };
    const problems = validateForSending(c);
    expect(problems).toEqual(
      expect.arrayContaining([
        "email.fromAddress unset",
        "email.physicalAddress unset",
        "email.templates[0] has no {{unsubscribeUrl}}",
        "email.templates[0] has no {{physicalAddress}}",
      ])
    );
  });

  it("refuses to send SMS without a pinned sending number (Mark, 2026-10-08)", () => {
    const c = config();
    delete c.outreach.sms.fromNumber;
    expect(validateForSending(c)).toEqual([expect.stringContaining("sms.fromNumber unset")]);
    c.outreach.sms.fromNumber = "709-701-3598";
    expect(validateForSending(c)).toEqual([expect.stringContaining("not E.164")]);
  });

  it("rejects a config with no channel enabled", () => {
    const c = config();
    c.outreach.sms.enabled = false;
    expect(validateForSending(c)).toContain("neither sms nor email is enabled");
  });
});

describe("renderTemplate", () => {
  it("leaves unknown placeholders visible rather than printing undefined", () => {
    expect(renderTemplate("Hi {{firstName}} {{typo}}", { firstName: "Jo" })).toBe("Hi Jo {{typo}}");
  });
});

describe("the real test-account config", () => {
  // Guards against a config edit that typechecks (it's JSON) but would make
  // every send refuse, or worse, ship a text with no opt-out.
  it("passes send validation (it's switched on for live tests — see enabledNote)", () => {
    const c = loadEmberConfig("eden-sub-account-one");
    expect(c).not.toBeNull();
    expect(validateForSending(c!)).toEqual([]);
  });

  it("every script fits in ONE text (160 chars) for a typical name — 2-segment texts bill double", () => {
    const c = loadEmberConfig("eden-sub-account-one")!;
    for (const [kind, list] of Object.entries(c.outreach.sms.scripts)) {
      list.forEach((t, i) => {
        const rendered = t.replace("{{firstName}}", "Jennifer").replace("{{senderName}}", c.outreach.senderName);
        expect(rendered.length, `${kind}[${i}]: ${rendered.length} chars`).toBeLessThanOrEqual(160);
      });
    }
  });

  it("sends from the test account's own number", () => {
    expect(loadEmberConfig("eden-sub-account-one")!.outreach.sms.fromNumber).toBe("+17098001784");
  });

  it("has no ember block on the real client yet", () => {
    expect(loadEmberConfig("3-percent-east-coast")).toBeNull();
  });
});
