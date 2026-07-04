---
name: Docs page
description: A documentation page with sidebar nav, anchored sections, and code.
mode: document
craft: [typography, typography-hierarchy, color, accessibility-baseline]
triggers: [docs, documentation, reference, guide, api docs]
designSystem: true
---

# Docs page

A single `index.html` docs layout: a left nav, a readable content column, and an optional on-this-page rail.

## Research

- What the reader is actually trying to do, and the real concepts and terms this doc must
  cover — organize the nav around their tasks, not the product's internal structure.
- One or two reference docs in this space worth matching for clarity and scannability.

## Layout

- Three zones: sidebar (sections), content (max ~72ch), and an optional right "On this page" anchor list.
- Every heading has a stable `id` and is linkable; the nav highlights the current section.
- Code blocks: monospace, a quiet surface tint, a copy affordance; never let code overflow silently — scroll it.
- Collapse the sidebar to a top menu under ~768px.

## Craft

- Clear heading hierarchy (don't skip levels; one h1). Visible `:focus-visible` rings; keyboard-navigable nav; 4.5:1 contrast.
- One accent for the active nav item and inline links. Borders/dividers define regions, not shadows.
- Real content — document something specific from the brief, not placeholder "Section one".
