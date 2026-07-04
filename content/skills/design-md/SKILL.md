---
name: Design system (DESIGN.md)
description: Author a 9-section DESIGN.md brand contract plus a tokens.css.
mode: design-system
craft: [typography, color]
triggers: [design system, brand guidelines, DESIGN.md, tokens, theme]
designSystem: false
---

# Design system (DESIGN.md)

Produce two files: a `DESIGN.md` brand contract and a `tokens.css`.

## Research

- The brand's positioning, personality, and the feeling it should evoke — a design
  system encodes a point of view, not defaults. Study any references or brand given;
  otherwise infer a coherent stance from the brief and commit to it.
- The visual language of the space it competes in — what to align with and what to
  deliberately diverge from, so the system has an identity.

## DESIGN.md — nine sections

1. Visual Theme & Atmosphere
2. Color Palette & Roles (hex, grouped by role)
3. Typography Rules (font + hierarchy table + principles)
4. Component Stylings (buttons, cards, inputs, badges with exact CSS)
5. Layout Principles (spacing grid, container, radius scale)
6. Depth & Elevation (borders first; shadow only for overlays)
7. Do's and Don'ts
8. Responsive Behavior
9. Agent Prompt Guide (quick colors + copy-paste component prompts)

## tokens.css

Declare the A1-identity tokens (`--bg`, `--fg`, `--accent`, `--font-display`), a
4px spacing scale, and a small radius scale. Keep neutrals at 70–90% of the
palette and a single accent at 5–10%. Ban pure black/white in dark themes (use
`#0f0f0f` / `#fafafa`). Avoid Tailwind indigo as the accent.
