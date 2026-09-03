import { afterEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ askWithImage: vi.fn(), chat: vi.fn(), ask: vi.fn() }));
vi.mock("../../shared/claude", () => claude);
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../shared/db", () => db);

import { PostgresImageStore, scoreSiteAppearance } from "./screenshot";

afterEach(() => vi.clearAllMocks());

describe("PostgresImageStore", () => {
  it("refuses to construct without a public base url", () => {
    // An MMS attachment must be an absolute public URL. A relative path sends
    // as a text-only message with no image AND no error from GHL, so failing
    // loudly at construction is the only place this can be caught.
    expect(() => new PostgresImageStore("")).toThrow(/PUBLIC_BASE_URL/);
  });

  it("returns an absolute url and strips a trailing slash", async () => {
    db.query.mockResolvedValue([{ id: "42" }]);
    const store = new PostgresImageStore("https://eden-os.onrender.com/");
    const url = await store.put({ bytes: Buffer.from("x"), leadId: 7, kind: "preview" });
    expect(url).toBe("https://eden-os.onrender.com/api/quarry/images/42.png");
  });

  it("records the byte size alongside the bytes", async () => {
    db.query.mockResolvedValue([{ id: "1" }]);
    const store = new PostgresImageStore("https://x.dev");
    const bytes = Buffer.alloc(2048);
    await store.put({ bytes, leadId: null, kind: "prospect_site" });
    expect(db.query.mock.calls[0][1]).toContain(2048);
  });
});

describe("scoreSiteAppearance", () => {
  const shot = Buffer.from("png");

  it("parses a bare JSON answer", async () => {
    claude.askWithImage.mockResolvedValue('{"score": 8, "reasoning": "Table layout, clip art"}');
    expect(await scoreSiteAppearance(shot)).toEqual({ score: 8, reasoning: "Table layout, clip art" });
  });

  it("parses JSON wrapped in prose or a code fence", async () => {
    claude.askWithImage.mockResolvedValue('Here is my read:\n```json\n{"score": 3, "reasoning": "Current"}\n```');
    expect(await scoreSiteAppearance(shot)).toEqual({ score: 3, reasoning: "Current" });
  });

  it("returns null instead of throwing when the answer is unparseable", async () => {
    // A parse failure must not disqualify a lead — it falls back to the
    // technical triage rather than being dropped.
    claude.askWithImage.mockResolvedValue("I can't score this image.");
    expect(await scoreSiteAppearance(shot)).toBeNull();
  });

  it("rejects a score outside 1-10 rather than trusting it", async () => {
    claude.askWithImage.mockResolvedValue('{"score": 47, "reasoning": "very old"}');
    expect(await scoreSiteAppearance(shot)).toBeNull();
    claude.askWithImage.mockResolvedValue('{"score": 0, "reasoning": "fine"}');
    expect(await scoreSiteAppearance(shot)).toBeNull();
  });

  it("rounds a fractional score", async () => {
    claude.askWithImage.mockResolvedValue('{"score": 6.6, "reasoning": "dated"}');
    expect((await scoreSiteAppearance(shot))?.score).toBe(7);
  });
});
