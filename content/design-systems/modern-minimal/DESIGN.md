# modern-minimal

> Category: Modern & Minimal

## 1. Visual Theme & Atmosphere

Quiet, precise, engineered. The product-tool aesthetic of Linear and Vercel:
near-monochrome surfaces, a single decisive accent, and structure carried by
hairline borders and whitespace rather than shadow or color. Nothing decorative
earns its place unless it clarifies.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #fafafa, --surface-2 #f4f4f5
- Text & content: --fg #111111, --fg-2 #52525b, --muted #71717a
- Brand & accent: --accent #2563eb on --accent-fg #ffffff
- Status: --success #16a34a, --warn #b45309, --danger #dc2626
- Border & divider: --border #e4e4e7, --border-strong #d4d4d8

Budget: neutrals 70–90% of pixels, accent 5–10% (≤2 visible uses/screen).

## 3. Typography Rules

Geist for display/body, JetBrains Mono for numerics. Hierarchy via weight + scale
+ tracking, not size alone. Display 48–64px / 590 / -0.02em; H1 32px; body 15px / 400;
eyebrow ALL-CAPS 12px / 0.08em. Max two typefaces. Never justify. Tabular numerics.

## 4. Component Stylings

Buttons: --radius, transparent border; primary = --accent bg, ghost = hover --surface-2.
Cards: --surface bg, 1px solid --border, no shadow. Inputs: 1px border, focus → --accent.
Badges: pill, 11px, --surface-2.

## 5. Layout Principles

4px spacing grid; container max 1120px; alternate one tight section with one
breathing section. Radius scale only: 6 / 8 / 12 / 999px.

## 6. Depth & Elevation

Borders, not shadows. Reserve shadow exclusively for true overlays (dropdowns,
modals, popovers). Everything in the page plane is flat.

## 7. Do's and Don'ts

Do: accent ≤2×/screen, tabular-nums, tight display tracking. Don't: gradients,
glows, decorative blobs, box-shadow cards, weight >590, a second accent.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; touch targets ≥24px; collapse multi-column under 640.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #111 / accent #2563eb / border #e4e4e7. Example: "A pricing
page, the middle plan outlined in --accent, tabular-nums prices, no shadows."
