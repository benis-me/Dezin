---
name: Frontend design
description: A single self-contained HTML page artifact built from the active design system.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage]
triggers: [web page, landing, prototype, single page, marketing, website]
designSystem: true
---

# Frontend design

Build one self-contained `index.html` that renders a single, polished page.

## Workflow

1. Read the active design system. Paste its `:root` token block verbatim into a
   `<style>` and reference everything with `var()` — never write raw hex outside `:root`.
2. State the system in one line before building: the palette, type scale, and
   spacing you'll use.
3. Compose with intent. Avoid the Hero → Features → Pricing → FAQ → CTA template;
   vary at least one section.
4. Use real copy. No lorem ipsum, no invented metrics, no placeholder feature lists.
5. Structure with borders and whitespace, not shadows. Reserve shadow for true overlays.
6. One accent, at most twice per screen. One decisive flourish, nothing else decorative.

## Before you ship

Run the 5-dimension self-check: posture matches the brief, one clear focal point,
typography and spacing are exact, every word is specific to this brief, restraint
holds. Fix anything weak, then write the file.
