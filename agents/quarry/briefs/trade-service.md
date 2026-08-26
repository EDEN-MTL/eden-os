# Trade & Service

Picture framers, cobblers, locksmiths, plumbers, upholsterers, knife
sharpeners, small engine repair. Businesses whose credibility comes from
having done the thing ten thousand times, not from looking expensive.

## Palette

| Role | Hex | Use |
|---|---|---|
| Ink | `#14161A` | Body text, footer ground. Never pure `#000`. |
| Galvanized | `#EEF0F1` | Page ground. Cool, faintly metallic — not cream. |
| Blueprint | `#1E4E7A` | Headings, rules, the dimension-line motif. |
| Brass | `#B08A3E` | Accents, icon strokes, hover states. |
| Graphite | `#5A6470` | Secondary text, captions, metadata. |
| Signal | `#C6301F` | The CTA button, and nothing else on the page. |

Signal appears exactly once per screen. The moment a second element wears
it, the button stops reading as the one thing to press.

## Type

- **Display:** Saira Condensed, 600–700 weight, tight tracking. Condensed
  because trade signage is condensed — painted on a van door, stencilled on
  a shop window, it has to fit a narrow space.
- **Body:** IBM Plex Sans, 400/500. Technical without being cold, and its
  numerals are unambiguous, which matters on a page that is mostly hours,
  phone numbers, and prices.
- Headings in sentence case, not Title Case. A tradesperson writes
  "What we fix", not "What We Fix".

## Signature element: the shop drawing

Every section header sits on a hairline Blueprint rule that extends the full
content width, terminated at each end by a short vertical tick — a dimension
line off a technical drawing. Section numbers run in Brass at 12px in the
left margin: `01`, `02`, `03`.

Services are a spec list, not cards: name on the left, plain-language detail
on the right, hairline rule between rows. A framer's list reads
"Conservation mounting — acid-free, reversible, for anything you'd be upset
to lose." Not "Quality Service."

**No stock photography of smiling workers.** If the business has real photos
from Google, use them at full bleed and let them be imperfect. If it has
none, the page carries no photography at all — the drawing motif and the
type do the work. An empty hero beats a stock hero.

## Avoid

Three looks that a generic prompt drifts toward. None of them belongs here
unless the brief above is explicitly overridden:

1. Cream ground, terracotta accent, large light-weight serif.
2. Near-black page, one neon accent, glassmorphic cards.
3. Broadsheet editorial — hairline boxes, tiny all-caps labels, giant
   centred display serif.

Also avoid: gradient buttons, drop shadows on anything, rounded corners
above 4px, and the word "solutions".

## Content rules

- The phone number is the loudest non-heading element on the page and is a
  `tel:` link on mobile.
- Hours and address go above the fold. For this category, "are they open and
  where are they" is the entire reason a visitor arrived.
- Years in business, if the Google data implies it, gets stated plainly:
  "Fixing shoes on Monkland since 1978."
- **Quebec:** the site needs French. Under the Charter of the French
  language, commercial content for a Quebec business must be available in
  French and French must be at least as prominent as any other language.
  Build FR as the default with an EN toggle, not the reverse — and if only
  one language is generated, generate French.
