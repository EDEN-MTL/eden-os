import { describe, expect, it } from "vitest";
import { CALL_LOG_CHANNEL } from "./channels";

describe("call-log channel", () => {
  it("is addressed by Slack channel ID, so renaming the channel can't silence Iris's posts (Oct 15 rename)", () => {
    expect(CALL_LOG_CHANNEL).toMatch(/^C[A-Z0-9]{8,}$/);
    expect(CALL_LOG_CHANNEL).not.toContain("iris-call-logs");
  });
});
