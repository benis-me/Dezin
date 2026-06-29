# figma

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Bright, approachable, canvas-first. The Figma tool aesthetic: a clean white
workspace, generous neutral grays, and a single confident blue for action. The
famous multicolor identity (red/purple/green/orange) exists but is rationed — it
punctuates, it never decorates. Friendly, not flashy; precise, not cold.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #f5f5f5, --surface-2 #ebebeb
- Text & content: --fg #1e1e1e, --fg-2 #4d4d4d, --muted #8c8c8c
- Brand & accent: --accent #0d99ff on --accent-fg #ffffff
- Identity pops (≤1/screen): #f24e1e red, #a259ff purple, #0fa958 green, #ff7262 coral
- Status: --success #0fa958, --warn #ff7262, --danger #f24e1e
- Border & divider: --border #e6e6e6, --border-strong #d4d4d4

Budget: neutrals 80–90%, Figma blue 5–10%, identity pops ≤3% (one accent moment).

## 3. Typography Rules

Inter throughout — the actual Figma UI face. Hierarchy via weight + scale. Display
40–56px / 600 / -0.02em; H1 28px / 600; body 14–15px / 400; labels 11px / 500.
JetBrains Mono for code/numeric. Two typefaces max. Never justify.

## 4. Component Stylings

Buttons: --radius (6px), primary = --accent bg, secondary = --surface-2, ghost on
hover. Cards: --surface, 1px --border, no shadow (the canvas is flat). Inputs:
1px border, focus ring → --accent. Pills/badges: --surface-2, 11px. Larger panels
use --radius-lg (13px), echoing Figma's rounded property panels.

## 5. Layout Principles

4px grid; container max 1200px; panel-and-canvas rhythm — dense control rails
beside open working space. Radius scale: 4 / 6 / 13 / 999px.

## 6. Depth & Elevation

Flat in-plane; shadow only for true floating UI (menus, popovers, the right-click
menu). Selection/active states use the blue ring, not elevation.

## 7. Do's and Don'ts

Do: one blue for action, identity colors as rare punctuation, rounded panels.
Don't: rainbow gradients, more than one identity pop per screen, shadow cards,
emoji, ALL-CAPS body.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; touch targets ≥24px; collapse side panels under 768.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #1e1e1e / accent #0d99ff / border #e6e6e6. Example:
"A plugin-style settings panel, blue primary action, one purple #a259ff status
pill, rounded 13px cards, no shadows."
