---
name: Pricing page
description: A pricing section with 3–4 tiers, exactly one recommended.
mode: prototype
craft: [typography, color, anti-ai-slop, laws-of-ux]
triggers: [pricing, plans, tiers, subscription, upgrade]
designSystem: true
---

# Pricing page

Build a single `index.html` pricing surface that makes the decision easy.

## Structure

- **3–4 tiers** (Hick's Law / choice overload). Mark **exactly one** "Recommended" — distinguished by more than color (a border in --accent, a subtle lift, a label).
- Each tier: name, price (tabular-nums), a one-line who-it's-for, and a short, scannable feature list — group features into ≤5 chunks (Miller).
- One primary CTA per tier; the recommended tier's CTA is the loudest element.
- Optional: a monthly/annual toggle, and a comparison row only if it earns its space.

## Craft

- Prices use `tabular-nums`; align them. Real numbers or a clearly-labelled placeholder — never invented "save 90%".
- One accent across the whole section, concentrated on the recommended tier. Cards use 1px borders, not shadows; no rounded-card-with-left-border.
- Cover the empty/loading state if prices load dynamically.
