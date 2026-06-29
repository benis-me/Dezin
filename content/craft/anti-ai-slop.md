# Anti-AI-slop rules

<!-- GENERATED from @dezin/quality slop-rules. Do not edit by hand.
     Regenerate with: pnpm --filter @dezin/craft regen -->

Concrete, checkable rules that separate "designed by a human who ships product"
from "default LLM output." The same rule lists power the `@dezin/quality` linter,
so the prompt and the linter never disagree.

## The seven cardinal sins (P0 — must fix)

1. **Default Tailwind indigo as accent** — exactly `#6366f1`, `#4f46e5`, `#4338ca`, `#3730a3`, `#8b5cf6`, `#7c3aed`, `#a855f7`. The active design
   system provides `--accent`; use it. Indigo is the textbook AI tell.
2. **Two-stop "trust" gradient** — purple→blue, blue→cyan, indigo→pink. A flat
   surface and intentional type beats this every time.
3. **Emoji as feature icons** — ✨ 🚀 🎯 ⚡ 🔥 💡 📈 🎨 🛡️ 🌟 💪 🎉 👋 🙌 ✅ ⭐ 🏆 — inside `<h*>`, `<button>`, `<li>`,
   or `class*="icon"`. Use a 1.6–1.8px-stroke monoline SVG with `currentColor`.
4. **Sans-serif on display when the brand binds a serif** — h1/h2/h3 must use
   `var(--font-display)`, not a hardcoded Inter / Roboto / system-ui.
5. **Rounded card with a colored left-border accent** — the canonical "AI
   dashboard tile". Drop either the radius or the left border.
6. **Invented metrics** — patterns: `\b10×\s+(faster|better|easier)\b`, `\b10x\s+(faster|better|easier)\b`, `\b100×\s+(faster|better)\b`, `\b99\.\d+%\s+uptime\b`, `\bzero[- ]downtime\b`, `\b3×\s+more\s+(productive|efficient)\b`, `\b3x\s+more\s+(productive|efficient)\b`. Pull a real number or use a
   labelled placeholder.
7. **Filler copy** — patterns: `\bfeature\s+(one|two|three|1|2|3)\b`, `\blorem\s+ipsum\b`, `\bdolor\s+sit\s+amet\b`, `\bplaceholder\s+text\b`, `\bsample\s+content\b`. An empty section is a composition
   problem to solve, not words to invent.

## Soft tells (P1 — should fix)

- External placeholder image CDNs: `images.unsplash.com`, `placehold.co`, `placekitten.com`, `via.placeholder.com`, `picsum.photos`, `loremflickr.com`.
- More than 12 raw hex values outside `:root` — tokens were not honoured.
- `var(--accent)` used more than 3 times in the rendered body. Dezin caps the
  accent at 3 visible uses per screen (a deliberately strict cap).
- ALL-CAPS text without ≥0.06em letter-spacing.

## Dezin taste (enforced)

- **Borders over shadows.** Reserve `box-shadow` for true overlays (dropdowns,
  modals, popovers); in-page cards use a 1px hairline border.
- **Neutral grayscale** carries 80–90% of every surface; one accent, ≤3 uses.
- **No gradient-clipped text** (`background-clip: text`) — a stock AI flourish.
- **Radius on the scale.** Keep `border-radius` on the brand's radius tokens; no
  oversized non-pill corners.

## Add soul without breaking the rules

Aim for ~80% proven patterns + ~20% one distinctive move: a single bold type or
color decision, product-specific microcopy ("Start tracking" beats "Get
started"), one memorable micro-interaction, one detail only someone who used the
product would add. If an outsider can identify the product from a screenshot,
you have soul; if not, you shipped a template.
