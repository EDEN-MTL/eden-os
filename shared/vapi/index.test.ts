import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getVapiEnvConfig } from "./index";

const REQUIRED_ENV = {
  VAPI_API_KEY: "test-key",
  VAPI_PHONE_NUMBER_ID: "phone-123",
  VAPI_MODEL_PROVIDER: "openai",
  VAPI_MODEL_NAME: "gpt-4.1-mini",
  VAPI_VOICE_PROVIDER: "11labs",
  VAPI_VOICE_ID: "voice-123",
};

describe("getVapiEnvConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, REQUIRED_ENV);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws listing every missing required var", () => {
    delete process.env.VAPI_API_KEY;
    delete process.env.VAPI_VOICE_ID;
    expect(() => getVapiEnvConfig()).toThrow(/VAPI_API_KEY.*VAPI_VOICE_ID/s);
  });

  it(
    "treats an unset VAPI_SERVER_URL as undefined, not an empty string — " +
      "Vapi's API rejects serverUrl: '' outright ('must be a valid URL')",
    () => {
      delete process.env.VAPI_SERVER_URL;
      expect(getVapiEnvConfig().serverUrl).toBeUndefined();
    }
  );

  it("also treats VAPI_SERVER_URL='' (present but empty, as dotenv leaves it) as undefined", () => {
    process.env.VAPI_SERVER_URL = "";
    expect(getVapiEnvConfig().serverUrl).toBeUndefined();
  });

  it("passes through a real VAPI_SERVER_URL unchanged", () => {
    process.env.VAPI_SERVER_URL = "https://example.com/webhooks/vapi";
    expect(getVapiEnvConfig().serverUrl).toBe("https://example.com/webhooks/vapi");
  });

  it("treats an unset VAPI_WEBHOOK_SECRET as undefined, not required", () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    expect(() => getVapiEnvConfig()).not.toThrow();
    expect(getVapiEnvConfig().webhookSecret).toBeUndefined();
  });

  it("passes through a real VAPI_WEBHOOK_SECRET unchanged", () => {
    process.env.VAPI_WEBHOOK_SECRET = "shh-its-a-secret";
    expect(getVapiEnvConfig().webhookSecret).toBe("shh-its-a-secret");
  });
});
