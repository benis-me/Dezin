---
name: Dashboard
description: A data dashboard with real states (loading, empty, error, populated, edge).
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [dashboard, admin, analytics, metrics, console, control panel]
designSystem: true
---

# Dashboard

Build a data dashboard as one `index.html`, honoring the active design system.

## Cover every state

A dashboard is judged on its states, not its happy path. For each data surface
include all five:

- **Loading** — skeleton for 300ms–2s, a labelled spinner beyond that.
- **Empty** — say what it is and how to fill it; never a blank panel.
- **Error** — what happened, why, and the recovery path; preserve input.
- **Populated** — the real thing, with realistic sample values.
- **Edge** — very long labels, 10k rows, zero/negative values.

## Layout

- Borders define panels; never box-shadow tiles, and never a rounded card with a
  colored left border.
- Tabular numerics (`tabular-nums`) for every figure; align numbers right.
- Cap the accent at two uses; let neutrals carry the grid.
- Group controls into at most five clusters (Miller); surface one primary action.

Use real metric labels and realistic values — never "10× faster" or "99.9% uptime".
