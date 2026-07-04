---
name: Onboarding flow
description: A multi-step welcome flow — a stepper, real progress, one focused action per step.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [onboarding, welcome flow, setup wizard, getting started, walkthrough, stepper]
designSystem: true
---

# Onboarding flow

Build a single `index.html` that walks a new user from zero to first value in a few
focused steps — a stepper, honest progress, and one decision at a time.

## Research

- The real "first value" for this product — the single outcome a new user must reach to
  understand why it matters. The flow exists to get them there, nothing more.
- The genuinely required steps versus the optional ones; study comparable onboarding to
  cut everything that can wait.

## Structure

- **3–5 steps**, no more (Hick / cognitive load). A stepper shows where you are and how
  many remain — current step marked by more than color, completed steps checked.
- Each step does exactly one job: name your workspace, invite a teammate, connect a
  source. Defer everything optional; don't pour a settings page into step two.
- Progress is real. The bar reflects steps actually completed — never a fake crawl to
  90% that stalls.

## One action per step

- A short heading, one line of why-this-matters, the single input or choice, then the
  primary button. Keep secondary paths quiet.
- Offer an honest **Skip** only where the step truly is optional; don't disguise a
  required step as skippable.

## Navigation & persistence

- **Back** never loses entered data; **Continue** validates the current step before
  advancing. A returning user resumes where they left off, not from step one.

## Cover the states

- **Empty/initial** — the focused step, nothing entered yet.
- **Invalid** — inline validation on Continue; the message says how to fix it.
- **Saving** — advancing persists; the button shows progress and preserves input.
- **Complete** — a real "you're set up" screen with one clear next action into the
  product — not a confetti dead-end.

## Craft

Borders over shadows; one accent on the primary action, the active step, and focus
rings. Real copy with a point of view — "Name your workspace" beats "Welcome aboard!".
Wrap any step transition in `prefers-reduced-motion`; content stays usable with motion
off. Keyboard-operable throughout, visible focus, one `<h1>` per screen.
