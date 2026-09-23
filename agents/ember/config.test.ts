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
  it("is disabled and passes send validation", () => {
    const c = loadEmberConfig("eden-sub-account-one");
    expect(c).not.toBeNull();
    expect(c!.enabled).toBe(false);
    expect(validateForSending(c!)).toEqual([]);
  });

  it("has no ember block on the real client yet", () => {
    expect(loadEmberConfig("3-percent-east-coast")).toBeNull();
  });
});
