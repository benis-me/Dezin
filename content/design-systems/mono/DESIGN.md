# Mono

> Category: Modern & Minimal

## 1. Visual Theme & Atmosphere

Strict grayscale. Zero chroma anywhere — the design lives entirely in type, weight,
spacing, and the single line. The most disciplined possible look.

## 2. Color Palette & Roles

- Light: --bg #ffffff, --surface #f7f7f7, --fg #111111, --muted #767676, --border #e5e5e5, --accent #111111
- Dark: --bg #0c0c0c, --surface #161616, --fg #f2f2f2, --muted #9a9a9a, --border #262626, --accent #f2f2f2
- No hue, ever. "Accent" is just maximum-contrast ink.

## 3. Typography Rules

One sans + one mono. Hierarchy is pure scale + weight (Read/Emphasize/Announce).
Display tight (−0.02em); ALL-CAPS at 0.08em; measure 60–72ch. Tabular-nums.

## 4. Component Stylings

Buttons: solid ink or 1px-bordered; radius 6px. Cards: 1px border, no shadow.
Inputs: bottom-rule or 1px box. Everything reads as printed ink on paper.

## 5. Layout Principles

8px grid; container max 960px; whitespace is the primary tool. Radius 4 / 6 / 8px.

## 6. Depth & Elevation

Entirely flat in-plane. A single faint shadow only on overlays.

## 7. Do's and Don'ts

Do: grayscale, weight/scale hierarchy, generous space. Don't: any color, gradients, shadows on cards, more than two weights of emphasis.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; single column under 640; targets ≥24px.

## 9. Agent Prompt Guide

light bg #fff / fg #111 / accent #111 / border #e5e5e5. Example: "A grayscale article index: ink headings, hairline rules, no color, weight-only hierarchy."
