import { describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../../shared/claude", () => claude);
vi.mock("../../shared/ghl", () => ({ getConversationMessages: vi.fn(), getConversations: vi.fn() }));

import { TEXT_SIGNAL_CASES } from "./corrections";
import { classifyInboundText } from "./text-signals";

// Thursday 2026-11-06 10:00 in St. John's (UTC−3:30), so "6 pm" is hours away.
const NOW = new Date("2026-11-06T13:30:00.000Z");
const TIMEZONE = "America/St_Johns";

describe("corrections ledger — real messages Iris misread", () => {
  it("has unique ids and every case names what a correct reading is", () => {
    const ids = TEXT_SIGNAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of TEXT_SIGNAL_CASES) {
      expect(c.expect.length).toBeGreaterThan(0);
      expect(c.message.trim()).not.toBe("");
      expect(c.why.trim()).not.toBe("");
    }
  });

  for (const c of TEXT_SIGNAL_CASES) {
    it(`${c.id}: a correct model answer is read as ${c.expect.join(" or ")}`, async () => {
      claude.ask.mockResolvedValue(c.modelOutput);
      const signal = await classifyInboundText(c.message, NOW, TIMEZONE, c.precedingOutbound ?? null);
      expect(c.expect).toContain(signal.type);
    });

    if (c.inPrompt) {
      it(`${c.id}: the classifier prompt still teaches this exact message`, async () => {
        claude.ask.mockResolvedValue('{"type": "none"}');
        await classifyInboundText(c.message, NOW, TIMEZONE, c.precedingOutbound ?? null);
        expect(String(claude.ask.mock.calls.at(-1)?.[0])).toContain(c.message);
      });
    }
  }

  it("never lets a stop through on a quote that is not in the message (the guard behind every opt-out case above)", async () => {
    for (const c of TEXT_SIGNAL_CASES.filter((x) => x.expect.length === 1 && x.expect[0] === "opt_out")) {
      claude.ask.mockResolvedValue('{"type": "opt_out", "certainty": "clear", "quote": "a sentence the lead never wrote"}');
      expect((await classifyInboundText(c.message, NOW, TIMEZONE)).type).toBe("unsure_stop");
    }
  });
});
