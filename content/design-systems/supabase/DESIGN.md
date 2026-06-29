# supabase

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Dark-native developer console. Near-black, layered surfaces under a single
electric green — the Postgres-meets-Vercel look: restrained, technical, dense
with information yet calm. The green is energy, used as the one signal in a field
of neutral graphite. No second hue competes with it.

## 2. Color Palette & Roles

- Background surfaces: --bg #1c1c1c, --surface #232323, --surface-2 #2e2e2e
- Text & content: --fg #ededed, --fg-2 #a0a0a0, --muted #707070
- Brand & accent: --accent #3ecf8e on --accent-fg #1c1c1c (dark text on green)
- Status: --success #3ecf8e, --warn #f59e0b, --danger #f15a5a
- Border & divider: --border #2e2e2e, --border-strong #3e3e3e

Budget: graphite neutrals 85–92%, green 5–10% (CTAs, active state, data-positive).

## 3. Typography Rules

Inter for UI, JetBrains Mono for code, SQL, and numerics (this is a database
product — monospace earns real estate). Display 40–56px / 600 / -0.02em; H1 28px;
body 14–15px / 400; labels 12px / 500. Green never on green; dark text on the
green button for contrast.

## 4. Component Stylings

Buttons: --radius (6px), primary = green bg + dark text, secondary = --surface-2
+ 1px border, ghost on hover. Cards/panels: --surface, 1px --border, no shadow.
Inputs: --surface-2, 1px border, focus ring → green. Code blocks: --bg, mono,
green for keywords/positive values. Badges: pill, --surface-2, 11px.

## 5. Layout Principles

4px grid; container max 1200px; console rhythm — sidebar nav, dense tables, and
roomy empty states. Radius scale: 4 / 6 / 8 / 999px (tight, technical).

## 6. Depth & Elevation

Layer by surface lightness (#1c→#23→#2e), not shadow. Shadow only for menus,
popovers, command palette. Active rows use a green left-border or tint.

## 7. Do's and Don'ts

Do: green as the single signal, dark text on green, mono for data. Don't: a
second accent hue, glows, gradient meshes, pure-black #000, green text on green,
shadow cards.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; collapse the console sidebar under 768; tables become
stacked cards under 640; touch targets ≥24px.

## 9. Agent Prompt Guide

Quick colors: bg #1c1c1c / fg #ededed / accent #3ecf8e / border #2e2e2e. Example:
"A database table dashboard, green primary button with dark text, a mono SQL
snippet block, graphite cards, one green 'Connected' status pill."
