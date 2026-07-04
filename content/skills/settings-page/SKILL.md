---
name: Settings page
description: A product settings UI — sectioned nav, real forms, toggles, and honest save states.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [settings, preferences, account settings, configuration, profile settings]
designSystem: true
---

# Settings page

Build a single `index.html` settings surface that reads as real product chrome — the
boring-on-purpose screen that has to be trustworthy.

## Research

- Which settings this product actually has, and how users group them mentally — study
  comparable products so the section nav matches expectations.
- The destructive and high-stakes actions that need extra friction: delete account,
  revoke tokens, change billing.

## Layout

- A left **section nav** — at most 5 groups (Miller): Profile, Account, Notifications,
  Billing, Security. The active section is marked by more than color.
- The right panel holds one section's form at a time. A persistent header shows where
  you are; the page never reflows when you switch sections.

## Forms

- Labels above fields, helper text below, errors inline next to the field. Group related
  fields into small fieldsets — don't pour 15 inputs into one column.
- One primary action per section ("Save changes"), a quiet secondary ("Cancel"). Real
  field names and real placeholder values, never "Field 1" / "your-name-here".

## Toggles & save semantics

- Toggles read their state without relying on color; a label says what "on" does.
- Decide the save model and be consistent: instant-apply toggles, or an explicit Save
  for the whole section. Don't mix silently.

## Cover the states

- **Idle** — saved, nothing pending.
- **Dirty** — edited; the Save button enables, "unsaved changes" is signalled.
- **Saving** — button shows progress and disables; input is preserved.
- **Saved** — a brief confirmation, then back to idle.
- **Error** — what failed and how to retry; never discard what the user typed.

## Craft

Borders separate sections and rows; no shadow cards. One accent on the primary action and
focus rings. Put destructive actions (delete account, revoke tokens) in a clearly separated
zone that requires confirmation. Every control keyboard-operable with a visible focus ring; one `<h1>`.
