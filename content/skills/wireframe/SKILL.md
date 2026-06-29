---
name: Wireframe
description: A low-fidelity, grayscale wireframe of a layout — structure and hierarchy before visual design.
mode: prototype
craft: [typography-hierarchy, state-coverage, laws-of-ux]
triggers: [wireframe, lo-fi, low fidelity, mockup, layout, blocking, skeleton]
designSystem: false
---

# Wireframe

Build one self-contained `index.html` that renders a **low-fidelity wireframe** — the job is structure, hierarchy, and flow, not finished visuals. Think the blocking pass a designer does before color and type.

## Workflow

1. Read the brief and decide the page's sections and their order. Hierarchy first.
2. Render in **grayscale only**: a near-white canvas, mid-gray boxes for content blocks, darker gray for primary actions. No brand color, no imagery — use neutral placeholder rectangles with a subtle diagonal hatch for media, and gray bars for text runs.
3. Label regions plainly where it helps (`Header`, `Hero`, `Feature grid`, `CTA`) in a small monospace caption, so the intent reads at a glance.
4. Keep type to one or two weights of a system sans; real copy is optional — short representative labels are fine, but never lorem-filler paragraphs.

## Rules

- **Grayscale palette only.** Background near-white, boxes in 2–3 grays, one darker gray for the primary action. No accent color.
- **Boxes over polish.** Rounded rectangles, hairline borders, generous spacing. No shadows, no gradients, no decoration.
- **Show structure, not chrome.** Placeholder rectangles (with a faint hatch) stand in for images/media; gray bars stand in for text.
- **Real hierarchy.** One `<h1>`, clear section rhythm, an obvious primary action. The wireframe should make the layout decision legible.
- Respect `prefers-reduced-motion`; semantic HTML; responsive (single column under 768px).
- This is intentionally unfinished-looking — resist the urge to make it pretty. Fidelity comes later.
