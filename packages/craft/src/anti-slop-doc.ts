/**
 * Generate the anti-AI-slop craft doc FROM @dezin/quality's slop-rules, so the
 * linter and the prompt-injected doc share one literal source of truth (the
 * "make it a literal import" recommendation from the research). The committed
 * content/craft/anti-ai-slop.md is the output of renderAntiSlopMarkdown(); a drift
 * test fails if they diverge. Regenerate with `pnpm --filter @dezin/craft regen`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_DEFAULT_INDIGO,
  SLOP_EMOJI,
  INVENTED_METRIC_PATTERNS,
  FILLER_PATTERNS,
  EXTERNAL_IMAGE_HOSTS,
  ACCENT_OVERUSE_CAP,
  ALL_CAPS_TRACKING_FLOOR_EM,
} from "../../quality/src/slop-rules.ts";

export function defaultCraftDocPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "craft", "anti-ai-slop.md");
}

export function renderAntiSlopMarkdown(): string {
  const indigo = AI_DEFAULT_INDIGO.map((h) => `\`${h}\``).join(", ");
  const emoji = SLOP_EMOJI.join(" ");
  const hosts = EXTERNAL_IMAGE_HOSTS.map((h) => `\`${h}\``).join(", ");
  const metrics = INVENTED_METRIC_PATTERNS.map((r) => `\`${r.source}\``).join(", ");
  const filler = FILLER_PATTERNS.map((r) => `\`${r.source}\``).join(", ");

  return `# Anti-AI-slop rules

<!-- GENERATED from @dezin/quality slop-rules. Do not edit by hand.
     Regenerate with: pnpm --filter @dezin/craft regen -->

Concrete, checkable rules that separate "designed by a human who ships product"
from "default LLM output." The same rule lists power the \`@dezin/quality\` linter,
so the prompt and the linter never disagree.

## The seven cardinal sins (P0 — must fix)

1. **Default Tailwind indigo as accent** — exactly ${indigo}. The active design
   system provides \`--accent\`; use it. Indigo is the textbook AI tell.
2. **Two-stop "trust" gradient** — purple→blue, blue→cyan, indigo→pink. A flat
   surface and intentional type beats this every time.
3. **Emoji as feature icons** — ${emoji} — inside \`<h*>\`, \`<button>\`, \`<li>\`,
   or \`class*="icon"\`. Use a 1.6–1.8px-stroke monoline SVG with \`currentColor\`.
4. **Sans-serif on display when the brand binds a serif** — h1/h2/h3 must use
   \`var(--font-display)\`, not a hardcoded Inter / Roboto / system-ui.
5. **Rounded card with a colored left-border accent** — the canonical "AI
   dashboard tile". Drop either the radius or the left border.
6. **Invented metrics** — patterns: ${metrics}. Pull a real number or use a
   labelled placeholder.
7. **Filler copy** — patterns: ${filler}. An empty section is a composition
   problem to solve, not words to invent.

## Soft tells (P1 — should fix)

- External placeholder image CDNs: ${hosts}.
- More than 12 raw hex values outside \`:root\` — tokens were not honoured.
- \`var(--accent)\` used more than ${ACCENT_OVERUSE_CAP} times in the rendered body. Dezin caps the
  accent at ${ACCENT_OVERUSE_CAP} visible uses per screen (a deliberately strict cap).
- ALL-CAPS text without ≥${ALL_CAPS_TRACKING_FLOOR_EM}em letter-spacing.

## Dezin taste (enforced)

- **Borders over shadows.** Reserve \`box-shadow\` for true overlays (dropdowns,
  modals, popovers); in-page cards use a 1px hairline border.
- **Neutral grayscale** carries 80–90% of every surface; one accent, ≤${ACCENT_OVERUSE_CAP} uses.
- **No gradient-clipped text** (\`background-clip: text\`) — a stock AI flourish.
- **Radius on the scale.** Keep \`border-radius\` on the brand's radius tokens; no
  oversized non-pill corners.

## Add soul without breaking the rules

Aim for ~80% proven patterns + ~20% one distinctive move: a single bold type or
color decision, product-specific microcopy ("Start tracking" beats "Get
started"), one memorable micro-interaction, one detail only someone who used the
product would add. If an outsider can identify the product from a screenshot,
you have soul; if not, you shipped a template.
`;
}
