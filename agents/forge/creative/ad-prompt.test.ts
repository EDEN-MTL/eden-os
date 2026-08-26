import { describe, expect, it } from "vitest";
import { buildAdPrompt, buildFileName, lintAdCopy, TextSlot } from "./ad-prompt";

const slots: TextSlot[] = [
  { name: "hook", copy: "You already paid for 2,000 leads. Nobody called them back.",
    design: "Instrument Serif 400 font, cream #F5F3EC, sentence case, left aligned" },
  { name: "subline", copy: "Eden works the leads sitting dead in your CRM, starting day one.",
    design: "Manrope 400 font, #F5F3EC at 64%, left aligned" },
];

describe("lintAdCopy", () => {
  /**
   * Em dashes are banned outright by the method. Checked rather than trusted,
   * because they are exactly what a model reaches for when writing ad copy.
   */
  it("rejects em and en dashes", () => {
    expect(lintAdCopy([{ ...slots[0], copy: "You paid for the leads — nobody called" }]))
      .toContain('"hook" contains an em or en dash');
    expect(lintAdCopy([{ ...slots[0], copy: "Leads – unworked" }]).length).toBeGreaterThan(0);
  });

  it("requires exactly one hook", () => {
    expect(lintAdCopy([slots[1]])).toContain("expected exactly 1 hook, found 0");
    expect(lintAdCopy([slots[0], { ...slots[0] }])).toContain("expected exactly 1 hook, found 2");
  });

  it("allows at most one subline but any number of tertiary slots", () => {
    expect(lintAdCopy([slots[0], slots[1], { ...slots[1], name: "subline-2" }]))
      .toContain("max 1 subline, found 2");
    const withPills = [slots[0],
      { name: "pill-1", copy: "14 days", design: "mono" },
      { name: "pill-2", copy: "No new spend", design: "mono" }];
    expect(lintAdCopy(withPills)).toEqual([]);
  });

  it("catches empty copy", () => {
    expect(lintAdCopy([{ ...slots[0], copy: "   " }])).toContain('"hook" is empty');
  });

  it("passes clean copy", () => {
    expect(lintAdCopy(slots)).toEqual([]);
  });
});

describe("buildAdPrompt", () => {
  const spec = {
    formatName: "Dead CRM receipt",
    composition: "Hook at top 12%. Product screenshot centred at 55% height.",
    textSlots: slots,
    design: "Background #0A0B08 warm near-black.",
    photography: "Looks shot on a phone, handheld, grainy.",
    fileName: "7_4x5_Eden_DeadCrmOwner_AlreadyPaid_Receipt",
  };

  it("writes the method's sections in order", () => {
    const p = buildAdPrompt(spec);
    const order = ["Task:", "Composition:", "Text:", "Design:", "Photography direction:", "Constraints:", "File name:"];
    let last = -1;
    for (const s of order) {
      const i = p.indexOf(s);
      expect(i, `${s} present`).toBeGreaterThan(-1);
      expect(i, `${s} in order`).toBeGreaterThan(last);
      last = i;
    }
  });

  it("puts the file name last and exactly once", () => {
    const p = buildAdPrompt(spec);
    expect(p.match(/File name:/g)).toHaveLength(1);
    expect(p.trim().endsWith(spec.fileName)).toBe(true);
  });

  it("omits the photography section entirely for graphic-centric ads", () => {
    const p = buildAdPrompt({ ...spec, photography: undefined });
    expect(p).not.toContain("Photography direction");
  });

  it("names every text slot so copy lands in the right place", () => {
    const p = buildAdPrompt(spec);
    expect(p).toContain('- hook: "');
    expect(p).toContain('- subline: "');
  });

  /** The lint is enforced at build time, not left as advice. */
  it("refuses to build a prompt from copy that breaks the rules", () => {
    expect(() => buildAdPrompt({ ...spec,
      textSlots: [{ ...slots[0], copy: "Paid for leads — never called" }] }))
      .toThrow(/em or en dash/);
  });

  it("constrains stray text, which is how these models add their own words", () => {
    // Case-insensitive: the sentence was recapitalised when the leakage
    // constraint was strengthened, and the assertion should track the rule
    // rather than the exact casing.
    expect(buildAdPrompt(spec)).toMatch(/no other words, letters or numbers/i);
  });
});

describe("buildFileName", () => {
  it("follows [ID]_[aspect]_[Product]_[Persona]_[Angle]_[Format]", () => {
    expect(buildFileName({ id: 7, product: "Eden", persona: "dead crm owner",
      angle: "already paid", format: "receipt" }))
      .toBe("7_4x5_Eden_DeadCrmOwner_AlreadyPaid_Receipt");
  });

  it("appends an offer only when there is one", () => {
    expect(buildFileName({ id: 2, product: "Eden", persona: "a", angle: "b", format: "c", offer: "WELCOME20" }))
      .toBe("2_4x5_Eden_A_B_C_WELCOME20");
  });
});

describe("instruction leakage", () => {
  const spec = {
    formatName: "Search result",
    composition: "Top 22%: a search field. Middle 34%: a result card.",
    textSlots: [{ name: "hook", copy: "One slot open in your market.",
                  design: "Manrope 400 font, #F5F3EC at 64%" }],
    design: "Background #0A0B08.",
    fileName: "9_4x5_Eden_Scaler_Scarcity_SearchResult",
  };

  /**
   * A real batch produced an ad with "Manrope 400, #F5F3EC 64%" and "34%"
   * rendered as visible text: the model read the styling spec and the position
   * percentages as copy. The prompt now says outright that they are not.
   */
  it("tells the model that percentages, hex codes and font names are not content", () => {
    const p = buildAdPrompt(spec);
    expect(p).toMatch(/percentages, hex codes/);
    expect(p).toMatch(/never draw them/);
    expect(p).toMatch(/Render ONLY the quoted copy/);
  });

  it("phrases styling as an instruction about a slot, not as a line of copy", () => {
    expect(buildAdPrompt(spec)).toContain("SET the hook slot in:");
  });
});
