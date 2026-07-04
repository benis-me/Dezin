---
name: Dashboard
description: A data dashboard with real states (loading, empty, error, populated, edge).
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [dashboard, admin, analytics, metrics, console, control panel]
designSystem: true
---

# Dashboard

A dashboard is judged on its information hierarchy and its states, not its happy path.
Research what the operator needs to decide, structure it, then build every state.

## Research

- Who reads this and the one decision or action it exists to support. A dashboard with no
  decision behind it becomes a wall of charts.
- The real metrics for this domain — names, units, typical ranges, and which two or three
  actually matter. Study real tools in this space for what they surface first.
- The realistic data shape: cardinality, update cadence, and the edge cases (zero,
  negative, very large, very long labels) the design must survive.

## Structure

- Lead with the two or three figures that drive the decision; demote the rest — not every
  metric deserves a card.
- Group controls and panels into at most five clusters (Miller); surface one primary
  action. Borders define panels; align every figure right with `tabular-nums`. Let
  neutrals carry the grid and concentrate the accent on what matters most.

## Cover every state

The real work of a dashboard. For each data surface, design all five:

- **Loading** — skeleton for 300ms–2s, a labelled spinner beyond that.
- **Empty** — say what it is and how to fill it; never a blank panel.
- **Error** — what happened, why, and the recovery path; preserve input.
- **Populated** — the real thing, with realistic sample values from research.
- **Edge** — very long labels, huge counts, zero/negative values.

## The distinctive move

The one view or interaction that makes an operator trust this over a spreadsheet — a
genuinely useful default, a smart comparison, a detail only someone who runs this system
would want. Use real metric labels and realistic values from research.
