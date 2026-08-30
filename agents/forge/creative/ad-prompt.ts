/**
 * Builds image-generation prompts the way the Madvera image-ad method does.
 *
 * The older buildStructuredPrompt wrapped a one-line brief in some photography
 * direction and sent it as text. That produced competent, generic, stock-looking
 * ads, and three specific things were missing:
 *
 *   1. NO REFERENCE IMAGES. The method is explicit that describing a scene from
 *      scratch yields generic output, and that every photo-centric ad must be
 *      built on a real photograph so the model copies actual lighting, grain and
 *      imperfection rather than inventing a glossy approximation.
 *   2. NO BRAND TYPOGRAPHY. Image models cannot load font files, but they will
 *      follow a font shown to them. Attaching a rendered type sheet and naming
 *      the font is what gets a brand's real letterforms instead of a default sans.
 *   3. NO STRUCTURE. Sections in a fixed order, positions given as percentages,
 *      and the product never described (the reference carries its appearance;
 *      describing it makes the model redraw and distort it).
 *
 * Prompts are written as a description of the FINAL image, never as an edit of a
 * previous attempt: each generation is stateless, so "don't do X again" language
 * refers to something the model cannot see and just adds noise.
 */

export interface TextSlot {
  /** Identifiable slot name, e.g. "hook", "subline-top", "pill-1". */
  name: string;
  copy: string;
  /** How it should be set: font, colour, case, alignment, legibility treatment. */
  design: string;
}

export interface ReferenceImage {
  data: Buffer;
  mimeType: string;
  /**
   * What the model should do with it. A type sheet must be marked font-only or
   * the model will paste the sheet into the ad.
   */
  role: "product" | "scene" | "font" | "style";
  note?: string;
}

export interface AdPromptSpec {
  /** 2-4 word format name, e.g. "Dead CRM receipt". */
  formatName: string;
  /** Blocks and where they sit, positioned by percentage. */
  composition: string;
  textSlots: TextSlot[];
  /** Background, palette, hierarchy, spacing — the design decisions. */
  design: string;
  /** Only for photo-centric ads. Omitted entirely for graphic-centric ones. */
  photography?: string;
  aspectRatio?: string;
  /** [ID]_[aspect]_[Product]_[Persona]_[Angle]_[Format] */
  fileName: string;
}

/** Copy rules that are non-negotiable in the method, checked rather than trusted. */
export function lintAdCopy(slots: TextSlot[]): string[] {
  const problems: string[] = [];
  const hooks = slots.filter((s) => s.name === "hook");
  const sublines = slots.filter((s) => s.name.startsWith("subline"));

  if (hooks.length !== 1) problems.push(`expected exactly 1 hook, found ${hooks.length}`);
  if (sublines.length > 1) problems.push(`max 1 subline, found ${sublines.length}`);

  for (const s of slots) {
    // Em dashes are banned outright in ad copy by the method.
    if (/[—–]/.test(s.copy)) problems.push(`"${s.name}" contains an em or en dash`);
    if (!s.copy.trim()) problems.push(`"${s.name}" is empty`);
  }
  return problems;
}

export function buildAdPrompt(spec: AdPromptSpec): string {
  const problems = lintAdCopy(spec.textSlots);
  if (problems.length) {
    throw new Error(`Ad copy breaks the method's hard rules: ${problems.join("; ")}`);
  }

  const ratio = spec.aspectRatio || "4:5";
  const text = spec.textSlots
    .map((s) => `- ${s.name}: "${s.copy}"`)
    .join("\n");
  /*
   * Styling is described as an instruction ABOUT a slot, never as a line that
   * could be read as content. A batch run produced an ad with "Manrope 400,
   * #F5F3EC 64%" and "34%" rendered into the image as visible text: the model
   * had read the design spec and the position percentages as copy. Naming the
   * slot first and prefixing with SET makes the grammar unambiguous.
   */
  const design = spec.textSlots
    .map((s) => `- SET the ${s.name} slot in: ${s.design}`)
    .join("\n");

  return [
    `Task: Create 1 2K, ${ratio} static image ad.`,
    ``,
    `Composition: ${spec.composition}`,
    ``,
    `Text:`,
    text,
    `Typography references are attached.`,
    ``,
    `Design: ${spec.design}`,
    design,
    ...(spec.photography ? [``, `Photography direction: ${spec.photography}`] : []),
    ``,
    `Constraints: exactly one image. No logos, no watermarks, no URLs.`,
    `Render ONLY the quoted copy from the Text section. The percentages, hex codes,`,
    `font names and slot names elsewhere in this brief are layout instructions for`,
    `you, not content: never draw them. No other words, letters or numbers anywhere`,
    `in the frame. Natural undistorted proportions.`,
    ``,
    `File name: ${spec.fileName}`,
  ].join("\n");
}

/** [ID]_[aspect]_[Product]_[Persona]_[Angle]_[Format] */
export function buildFileName(parts: {
  id: number; aspect?: string; product: string; persona: string; angle: string; format: string; offer?: string;
}): string {
  const camel = (s: string) =>
    s.trim().split(/[\s_-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return [
    String(parts.id), parts.aspect || "4x5",
    camel(parts.product), camel(parts.persona), camel(parts.angle), camel(parts.format),
    ...(parts.offer ? [parts.offer] : []),
  ].join("_");
}
