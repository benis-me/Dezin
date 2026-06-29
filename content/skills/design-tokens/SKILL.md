---
name: Design tokens
description: A design-tokens reference — color ramps, type scale, spacing, radius and elevation as swatches and specimens.
mode: prototype
craft: [typography, typography-hierarchy, color, anti-ai-slop]
triggers: [design tokens, tokens, style guide, color ramp, type scale, swatches, specimen]
designSystem: true
---

# Design tokens

Build a single `index.html` that renders the active design system's tokens as
**visual specimens** — not a table of hex codes. Read the real CSS variables; never
invent values the system doesn't define.

## Color

- Show each role (`--bg`, `--fg`, `--muted`, `--accent`, `--border`) as a swatch with
  its name, hex, and the CSS var. Group by role, not by hue.
- For any ramp (50→900), lay the steps in one row so the progression reads at a glance.
- Print the text-on-surface **contrast ratio** beside each pairing and flag anything
  under 4.5:1. Keep neutrals at 70–90% of the palette; the single accent at 5–10%.

## Type scale

- One specimen row per step (display → caption): the rendered line, then `size /
  line-height / weight / tracking` in a mono caption. Use real words, not "Aa Aa".
- Make the hierarchy visible — the jump between steps should be obvious from scale and
  weight alone. Two typefaces at most.

## Spacing, radius, elevation

- **Spacing** — render each step of the 4px scale as a bar of that width with its token.
- **Radius** — a small chip per radius value so the corners are actually visible.
- **Elevation** — borders first. Show the border tiers; reserve any shadow token for
  overlays only, and say so. No glow, no shadow-stacked cards on this page.

## Craft

Each specimen carries its copyable token name in a mono caption — the page doubles as a
lookup. Neutral chrome, one `<h1>`, sections under `<h2>`, generous whitespace between
groups. Real token names from the system; if a token is missing, mark it, don't fabricate one.
