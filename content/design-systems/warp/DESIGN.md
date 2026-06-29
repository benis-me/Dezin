# Warp

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

A modern terminal: very dark blue-black surfaces, a vivid teal accent, blocks of
output framed as cards. Sleek and futuristic but legible.

## 2. Color Palette & Roles

- Surfaces: --bg #0c0c12, --surface #15151f, --surface-2 #1e1e2a
- Text: --fg #e4e4ef, --fg-2 #b0b0c2, --muted #82828f
- Accent: --accent #00c8d4 on --accent-fg #04181a
- Border: --border #26263200; use #262632, --border-strong #383848

## 3. Typography Rules

Mono-forward: a strong monospace for commands/output, a UI sans for chrome. Body 13–14px.

## 4. Component Stylings

Command "blocks": a framed --surface card per command + output, 1px border, radius 8px.
Inputs: bordered, focus → --accent. Buttons: ghost or --accent.

## 5. Layout Principles

Stacked blocks; 8px grid; generous block padding. Radius 6 / 8 / 10px.

## 6. Depth & Elevation

Mostly flat; blocks separated by borders + spacing. One soft glow on the active block at most.

## 7. Do's and Don'ts

Do: mono output, teal accent, framed blocks. Don't: pure-black, rainbow ANSI everywhere, heavy shadows, light mode.

## 8. Responsive Behavior

Breakpoints 768 / 1100px; blocks stay full-width; targets ≥24px.

## 9. Agent Prompt Guide

bg #0c0c12 / fg #e4e4ef / accent #00c8d4 / border #262632. Example: "A terminal session: framed command blocks, mono output, teal prompt."
