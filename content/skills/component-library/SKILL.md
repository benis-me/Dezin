---
name: Component library
description: A documented UI component gallery — buttons, inputs, cards, every state, with live examples and snippets.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [component library, component gallery, ui kit, storybook, components, showcase]
designSystem: true
---

# Component library

Build a single `index.html` that documents a UI kit: each component shown **live**,
in all its states, beside a copyable snippet. Honor the active design system — this
page is the proof the system is real.

## Research

- The components this product actually needs and how they'll be used — a kit that
  documents components no one uses is dead weight. Prioritize by real usage.
- How mature component libraries in this space document states, props, and usage;
  borrow their clarity.

## Structure

- A left rail listing component **groups** — at most 5 (Miller): Actions, Inputs,
  Containers, Feedback, Navigation. The rail tracks the section in view.
- One section per component. Each section has: a one-line "what it's for", a live
  example surface, the state matrix, and the markup that produced it.
- Render the snippet in a `<pre>` from the *same* CSS the demo uses — never paste a
  screenshot or a snippet that's drifted from the live element.

## Show every state

A component library is judged on states, not the default. For each interactive
component render all of them, side by side and labelled:

- **Buttons** — default, hover, focus-visible, active, disabled, loading.
- **Inputs** — empty/placeholder, focused, filled, error (+message), disabled, read-only.
- **Cards/containers** — populated, and the empty state they wrap.
- **Feedback** — toast/alert in each severity, plus a skeleton for loading.

## Craft

- Borders define the demo surfaces and the snippet panels; no drop-shadow tiles, no
  rounded card with a colored left border.
- One accent, reserved for the primary action and focus rings. Neutrals carry the page.
- Real labels and copy — "Save changes", "Email address", a real error like
  "That code has expired" — never "Button" / "Lorem" / "Input here".
- Every control is keyboard-operable with a visible focus ring; toggles and
  disclosures expose state to assistive tech. One `<h1>`, sections under `<h2>`.
