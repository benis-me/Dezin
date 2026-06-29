# shadcn/ui

> Category: Modern & Minimal

## 1. Visual Theme & Atmosphere

The default modern component aesthetic: zinc neutrals, a near-black/near-white
"primary", subtle borders and small radii. Calm, copy-paste-able, unopinionated.

## 2. Color Palette & Roles

- Light: --bg #ffffff, --surface #fafafa, --fg #09090b, --muted #71717a, --border #e4e4e7, --accent #18181b
- Dark: --bg #09090b, --surface #131316, --fg #fafafa, --muted #a1a1aa, --border #27272a, --accent #fafafa
- Primary (`--accent`) is the foreground color — high-contrast, neutral.

## 3. Typography Rules

A clean sans (Geist/Inter); mono for code. Body 14px / 1.5; headings 16–30px. Two weights; tabular-nums.

## 4. Component Stylings

Buttons: solid --accent primary, or outline (1px border) / ghost; radius 8px (`--radius .5rem`).
Cards: 1px border, no shadow. Inputs: 1px border, focus ring. Badges: pill, small.

## 5. Layout Principles

4px grid; container max 1120px; restrained spacing. Radius sm 6 / md 8 / lg 12px.

## 6. Depth & Elevation

Flat; borders carry structure. Popovers/dialogs get one soft shadow + a ring.

## 7. Do's and Don'ts

Do: neutral zinc, a single high-contrast primary, small radii. Don't: colored accents by default, gradients, shadow-heavy cards.

## 8. Responsive Behavior

Breakpoints 640 / 768 / 1024px; stack under 640; targets ≥24px.

## 9. Agent Prompt Guide

light bg #fff / fg #09090b / accent #18181b / border #e4e4e7. Example: "A settings form: zinc neutrals, near-black primary button, bordered cards, small radii."
