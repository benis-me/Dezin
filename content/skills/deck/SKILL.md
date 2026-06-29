---
name: Slide deck
description: A 16:9 presentation deck — one idea per slide, big type, safe margins.
mode: deck
craft: [typography, typography-hierarchy, color, anti-ai-slop]
triggers: [deck, slides, presentation, pitch, keynote]
designSystem: true
---

# Slide deck

Build a self-contained `index.html` deck of 16:9 slides that reads from across a room.

## Frame

- Each slide is a `1280×720` (or `1920×1080`) section; scale-to-fit to the viewport.
- Keyboard nav (←/→), a slide counter, and a print stylesheet (one slide per page).
- Safe margins: keep content within ~8% of every edge.

## Per slide

- **One idea.** A slide is a headline + at most one supporting element (a stat, a chart, a quote, an image).
- Display type is large (48–96px) with tight tracking (−0.02em); body never below 24px.
- Alternate slide rhythm: a dense slide, then a breathing one. Section dividers reset attention.
- Real content only — no "Lorem", no invented metrics. Pull figures from the brief.

## Craft

One accent, used to mark the single most important thing per slide. Borders/whitespace
over boxes and shadows. Paste the design system's `:root` verbatim; everything via var().
