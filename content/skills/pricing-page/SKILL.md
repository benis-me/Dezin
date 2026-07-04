---
name: Pricing page
description: A pricing section with 3–4 tiers, exactly one recommended.
mode: prototype
craft: [typography, color, anti-ai-slop, laws-of-ux]
triggers: [pricing, plans, tiers, subscription, upgrade]
designSystem: true
---

# Pricing page

A pricing surface makes a decision easy. Research the real plans and the buyer's doubt,
structure the choice, then build it.

## Research

- The product's real tiers, prices, and what actually gates each one. Use them verbatim
  if the brief has them; otherwise study comparable products to propose a credible shape
  and label the assumptions.
- The buyer's hesitation at this price point — what they need to believe to upgrade — and
  answer it on the page.
- How competitors anchor and frame their recommended tier; borrow the framing that fits.

## Structure

- **3–4 tiers** (Hick's Law). Mark **exactly one** "Recommended", distinguished by more
  than color — a border in `--accent`, a subtle lift, a label.
- Each tier: name, price (`tabular-nums`), a one-line who-it's-for, and a scannable
  feature list grouped into ≤5 chunks (Miller).
- One primary CTA per tier; the recommended tier's CTA is the loudest element. Add a
  monthly/annual toggle or a comparison row only if it earns its space.

## The distinctive move

The one element that removes the real doubt at this price — a concrete outcome, an honest
"who should NOT buy this", a worked usage example, a guarantee. That candor is what makes
a pricing page feel trustworthy rather than templated.

## Craft

- Prices use `tabular-nums`; align them. Concentrate the single accent on the recommended
  tier. Cover the empty/loading state if prices load dynamically.
