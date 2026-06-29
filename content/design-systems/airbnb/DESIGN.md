# Airbnb

> Category: Consumer & Marketplace

## 1. Visual Theme & Atmosphere

Warm, human, hospitable. A clean white canvas, soft neutral greys, and one
confident coral ("Rausch") that signals belonging. Big, friendly photography,
generous rounding, and roomy cards — a consumer marketplace that feels like a
welcome, not a dashboard. Approachable but never cute.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #f7f7f7, --surface-2 #ebebeb
- Text & content: --fg #222222, --fg-2 #484848, --muted #717171
- Brand & accent: --accent #ff385c (Rausch coral) on --accent-fg #ffffff
- Border & divider: --border #dddddd, --border-strong #c2c2c2

Budget: white + warm neutrals 88–93%, coral 4–8% (primary CTA, price emphasis,
active filter, "Superhost" mark). Photography carries the colour; the UI stays quiet.

## 3. Typography Rules

Airbnb Cereal (geometric humanist sans), Circular as fallback. Friendly, slightly
rounded letterforms. Display 32–48px / 600 / -0.01em; H1 26px / 600; body 16px /
1.5 / 400; meta 14px / 500. Two weights — 400 and 600. Prices in 600, never
all-caps headlines.

## 4. Component Stylings

Buttons: --accent primary (coral, radius 8px), or white + 1px --border-strong
secondary; pill toggles for filters. Cards: white, 1px --border, --radius-lg,
hover lifts with one soft shadow and a faint border-strong. Inputs: 1px border,
focus → --accent ring. Search bar: pill, segmented, shadow on focus.

## 5. Layout Principles

8px grid; container max 1120px; responsive card grids (2–4 up) with even gutters.
Generous rounding — radius 8 / 12 / 16px. Sticky filter bar; lots of breathing room
between sections.

## 6. Depth & Elevation

Mostly flat with soft, diffuse shadows on hover cards, the search bar, and menus
(0 6px 16px rgba(0,0,0,0.12)). Rounding does the lifting, not hard edges.

## 7. Do's and Don'ts

Do: white-dominant, generous rounding, one coral accent, real photography, prices
in semibold. Don't: coral floods, hard 90° corners, neon, multiple accent hues,
invented review counts, drop-shadow everything.

## 8. Responsive Behavior

Breakpoints 640 / 950 / 1120px; single-column cards under 640; collapse the search
bar into a tap target on mobile; touch targets ≥44px.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #222222 / accent #ff385c / border #dddddd. Example: "A
stay listing grid on white, rounded photo cards, coral 'Reserve' button, pill
filters, price in semibold, soft hover shadows."
