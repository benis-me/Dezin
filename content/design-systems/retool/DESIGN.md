# Retool

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Dense, utilitarian, restrained. The internal-tools aesthetic: tight grey surfaces,
compact rows, and one muted blue for action. Information density is the point —
tables, forms, and inspectors packed efficiently without feeling chaotic. Calm,
professional, function-first; the chrome never competes with the data.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #f6f7f8, --surface-2 #edeff2
- Text & content: --fg #1b1f24, --fg-2 #4a4f57, --muted #6b7280
- Brand & accent: --accent #3c64e4 (muted electric blue) on --accent-fg #ffffff
- Border & divider: --border #e2e5e9, --border-strong #ccd0d6

Budget: white + cool grey 90–94%, blue 4–7% (primary button, selected row, focus
ring, links). One accent only — internal tools earn trust by being quiet.

## 3. Typography Rules

Inter for everything; Roboto Mono for IDs, queries, and cell values. Compact.
Display 24–32px / 600 / -0.01em; H1 20px / 600; body 13–14px / 1.45 / 400; labels
12px / 500; table cells 13px / 400. Tabular-nums in data columns. Two weights, tight
line-height — vertical space is precious.

## 4. Component Stylings

Buttons: --accent primary (small, radius 5px), --surface-2 secondary, ghost for
toolbar actions. Tables: 1px --border rows, --surface header, hover tint --surface-2,
selected row → blue left-border + faint tint. Inputs: --surface-2, 1px border,
focus → blue ring; compact 28–32px height. Inspector panels: 1px --border, labelled
field rows. Tabs and toolbars: hairline dividers, dense.

## 5. Layout Principles

4px grid; container max 1320px (wide for grids); resizable panels — left nav,
canvas, right inspector. Radius 3 / 5 / 8px (tight, technical). Rows ~32px; minimal
padding; hairline dividers separate every region.

## 6. Depth & Elevation

Flat. Layer by surface tint (#fff → #f6f7f8 → #edeff2) and 1px borders, not shadow.
Shadow only for dropdowns, modals, and the command bar (0 4px 16px rgba(27,31,36,0.12)).

## 7. Do's and Don'ts

Do: dense rows, one muted blue, tabular numerics, hairline dividers, compact controls.
Don't: roomy marketing whitespace, big radii, multiple accents, decorative shadows,
oversized type, fake row counts, neon. Keep it restrained.

## 8. Responsive Behavior

Breakpoints 768 / 1024 / 1320px; collapse the inspector under 1024 and the left nav
under 768; tables scroll horizontally before wrapping; touch targets ≥32px.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #1b1f24 / accent #3c64e4 / border #e2e5e9. Example: "A
dense internal admin: compact data table with 13px tabular cells, hairline row
dividers, selected row with a blue left-border, a small blue 'Run query' button, a
right inspector panel of labelled fields."
