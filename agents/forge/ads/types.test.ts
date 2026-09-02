import { describe, expect, it } from "vitest";
import { validateRule } from "./types";

function rule(overrides: Partial<{ id: string; scope: any; operator: any; action: any }> = {}) {
  return {
    id: "cpl_cap",
    scope: "ad" as const,
    operator: "gt" as const,
    action: { type: "pause" },
    ...overrides,
  };
}

describe("validateRule", () => {
  it("does not throw for a valid rule", () => {
    expect(() => validateRule(rule())).not.toThrow();
  });

  it("rejects an invalid scope", () => {
    expect(() => validateRule(rule({ scope: "account" }))).toThrow(/invalid scope/);
  });

  it("rejects an invalid operator", () => {
    expect(() => validateRule(rule({ operator: "==" }))).toThrow(/invalid operator/);
  });

  it("rejects a rule with no action", () => {
    expect(() => validateRule(rule({ action: undefined }))).toThrow(/must include a 'type'/);
  });

  it("rejects an action whose type isn't a string", () => {
    expect(() => validateRule(rule({ action: { type: 123 } }))).toThrow(/must include a 'type'/);
  });

  it("includes the rule id in the error so a bad config is identifiable", () => {
    expect(() => validateRule(rule({ id: "bad_rule_7", scope: "account" }))).toThrow(/bad_rule_7/);
  });

  it("checks scope before operator, so a rule invalid on both surfaces the scope error first", () => {
    expect(() => validateRule(rule({ scope: "account", operator: "==" }))).toThrow(/invalid scope/);
  });
});
