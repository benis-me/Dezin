# Revolut

> Category: Fintech & SaaS

## 1. Visual Theme & Atmosphere

Clean, modern, global fintech. Crisp white surfaces, deep near-black ink, and one
electric blue that reads as "digital money." Rounded cards, confident numerals, and
a calm, premium restraint — trustworthy without looking like a bank. Precise,
international, slightly futuristic.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #f6f7f9, --surface-2 #eceef2
- Text & content: --fg #04060f (deep ink), --fg-2 #3a3f4a, --muted #6b7280
- Brand & accent: --accent #1361ff (electric blue) on --accent-fg #ffffff
- Border & divider: --border #e4e7ec, --border-strong #cdd2da

Budget: white + cool neutrals 88–92%, electric blue 5–9% (primary CTA, active tab,
balance emphasis, chart line). Black ink for amounts, blue for action.

## 3. Typography Rules

Aeonik (geometric grotesque), Inter as fallback. Crisp and even. Display 36–56px /
600 / -0.02em; H1 28px / 600; body 15–16px / 1.5 / 400; labels 13px / 500. Tabular
lining numerals for balances and amounts — currency always tabular, large, in --fg.

## 4. Component Stylings

Buttons: --accent primary (radius 12px, no gradient), --surface-2 secondary, full
pill for chips. Cards: white, 1px --border, --radius-lg, soft shadow on the balance
card only. Inputs: --surface-2 fill, 1px border, focus → blue ring. Money rows:
1px divider, amount right-aligned tabular. Charts: single blue line on a faint grid.

## 5. Layout Principles

8px grid; container max 1200px; card-based dashboard rhythm with rounded tiles.
Radius 8 / 12 / 18px. Roomy padding inside cards; clear section headers; generous
whitespace around primary numbers.

## 6. Depth & Elevation

Mostly flat; one soft elevation shadow on the headline balance/payment card and on
menus (0 8px 24px rgba(4,6,15,0.08)). Layering by surface tint elsewhere.

## 7. Do's and Don'ts

Do: white-dominant, deep ink, one electric blue, tabular amounts, rounded tiles.
Don't: bank-navy gradients, neon mesh backgrounds, multiple accents, invented
balances, drop-shadow on every card, thin numerals for money.

## 8. Responsive Behavior

Breakpoints 640 / 960 / 1200px; single-column card stack under 640; sticky bottom
action bar on mobile; touch targets ≥44px.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #04060f / accent #1361ff / border #e4e7ec. Example: "A
banking dashboard on white, rounded balance card with a soft shadow, large tabular
amount in deep ink, electric-blue 'Send' button, single-line spending chart."
