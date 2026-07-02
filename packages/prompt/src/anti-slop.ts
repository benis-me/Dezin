/**
 * The anti-AI-slop prompt layer, GENERATED from @dezin/quality's slop-rules so the
 * prompt and the linter can never drift — the rule lists are a literal import. The
 * linter blocks these at P0; the prompt tells the agent the same rules up front so
 * it never produces them in the first place.
 */

import { slopRules } from "../../quality/src/index.ts";

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
3. Emoji as feature/heading icons (${emoji} …). Use a 1.6–1.8px monoline SVG with currentColor.
4. Overused fonts hardcoded on display text (Inter, Roboto, Arial, system-ui). Use
   var(--font-display).
5. A rounded card with a colored left-border accent — the canonical "AI dashboard tile".
6. Invented metrics ("10× faster", "99.9% uptime"). Use a real number or a labelled placeholder.
7. Filler copy (lorem ipsum, "feature one/two/three"). Write real words.

Dezin taste, also enforced:
- Borders over shadows. Reserve box-shadow for true overlays (dropdowns, modals); in-page
  cards use a 1px hairline border, never a shadow.
- Neutral grayscale carries 80–90% of the surface; --accent appears at most ${slopRules.ACCENT_OVERUSE_CAP} times per screen.
- ALL-CAPS text always gets ≥${slopRules.ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing. No gradient-clipped text. Keep
  border-radius on the brand's radius scale.

Add soul the right way: ~80% proven patterns + ~20% one distinctive move (a type choice,
a proportion, one memorable micro-interaction, one product-specific detail). If an
outsider can identify the product from a screenshot, you have soul; if not, it's a template.`;
}
