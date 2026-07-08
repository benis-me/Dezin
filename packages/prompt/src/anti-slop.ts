/**
 * The anti-AI-slop prompt layer, GENERATED from @dezin/quality's slop-rules so the
 * prompt and the linter can never drift — the rule lists are a literal import. The
 * linter blocks these at P0; the prompt tells the agent the same rules up front so
 * it never produces them in the first place.
 */

import {
  slopRules,
  AA_NORMAL_CONTRAST,
  AA_LARGE_CONTRAST,
  MIN_LINE_HEIGHT_RATIO,
  MAX_LINE_LENGTH_CH,
  MIN_BODY_FONT_PX,
  MIN_TYPE_SCALE_RATIO,
  TRACKING_FLOOR_EM,
} from "../../quality/src/index.ts";

export function renderAntiSlopContract(): string {
  const indigo = slopRules.AI_DEFAULT_INDIGO.join(", ");
  const emoji = slopRules.SLOP_EMOJI.slice(0, 8).join(" ");

  return `## Anti-AI-slop contract (enforced)

These are the tells that make a design read as machine-generated. They are checked
by a linter after you write the file; producing one is a regression, not a style
choice. Avoid all of them:

1. Default Tailwind indigo as an accent — exactly ${indigo}. Use the active design
   system's --accent. Indigo is the #1 AI tell.
2. Two-stop "trust" gradients (purple→blue, blue→cyan, indigo→pink). A flat surface
   plus intentional type beats this every time.
3. Emoji as feature/heading icons (${emoji} …), or hand-drawn/invented icon SVG. Use icons from a
   real set (e.g. \`lucide-react\`) with currentColor — never emoji, and NEVER hand-author an icon's
   \`<svg>\`/\`<path>\` geometry (single-file mode has no bundler: inline a VERBATIM copy from a real
   set instead of inventing paths).
4. Overused fonts hardcoded on display text (Inter, Roboto, Arial, system-ui). Use
   var(--font-display).
5. A rounded card with a colored left-border accent — the canonical "AI dashboard tile".
6. Invented metrics ("10× faster", "99.9% uptime"). Use a real number or a labelled placeholder.
7. Filler copy (lorem ipsum, "feature one/two/three"). Write real words.

Dezin taste, also enforced:
- Borders over shadows. Reserve box-shadow for true overlays (dropdowns, modals); in-page
  cards use a 1px hairline border, never a shadow.
- Neutral grayscale carries 80–90% of the surface; --accent appears at most ${slopRules.ACCENT_OVERUSE_CAP} times per screen.
- Palette discipline. Unless a brand design system OR the chosen direction NAMES a specific accent
  hue, bind --accent to a NEAR-NEUTRAL (near-black on light, near-white on dark) — never a default
  saturated blue/indigo/violet/teal — and never ship a saturated FILLED button/CTA. Declaring your
  invented blue as \`--accent\` does not make it intentional. If the brief or the chosen direction
  says "monochrome" / "near-monochrome", that is a HARD constraint: the accent is a whisper, the
  neutrals do the work.
- ALL-CAPS text always gets ≥${slopRules.ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing. No gradient-clipped text. Keep
  border-radius on the brand's radius scale.

## Rendered-quality bar — a headless browser checks the RESULT; hit these first pass

Cheaper to get right up front than to be corrected after render:
- **Contrast.** Body ≥ ${AA_NORMAL_CONTRAST}:1, large/bold ≥ ${AA_LARGE_CONTRAST}:1 vs the ACTUAL background. Muted-gray-on-tint is the #1 miss — verify muted/placeholder text clears ${AA_NORMAL_CONTRAST}:1.
- **Readability.** line-height ≥ ${MIN_LINE_HEIGHT_RATIO} on running text; body measure ≤ ${MAX_LINE_LENGTH_CH}ch (max-width); body ≥ ${MIN_BODY_FONT_PX}px; display tracking no tighter than ${TRACKING_FLOOR_EM}em. Give heading levels a real step (≥${MIN_TYPE_SCALE_RATIO}×).
- **Components.** No nested cards (a box inside a box — flatten to one surface); no rounded icon-tile stacked above every heading (icon inline); no chromatic neon glow on dark.
- **Colour.** No violet/purple DISPLAY text; no warm cream/sand page background (use a true off-white or a brand tint). Keep fonts, colours, radii ON the token scale — off-scale reads as drift.
- **Rhythm.** Vary vertical spacing on a scale (16 / 24 / 40 / 64), don't repeat one value everywhere.
- **Copy.** No marketing clichés (elevate / seamless / unleash / supercharge / world-class), no repeated "X. No Y." cadence, don't over-reach for em-dashes.
- **Motion.** Exponential ease-out; never bounce/elastic curves; all motion behind \`prefers-reduced-motion\`.

Add soul the right way: ~80% proven patterns + ~20% one distinctive move (a type choice,
a proportion, one memorable micro-interaction, one product-specific detail). If an
outsider can identify the product from a screenshot, you have soul; if not, it's a template.`;
}
