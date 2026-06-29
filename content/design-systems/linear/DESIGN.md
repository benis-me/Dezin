# Linear

> Category: Productivity & SaaS

## 1. Visual Theme & Atmosphere

Darkness as the native medium. A focused, keyboard-first tool: deep near-black
surfaces, low-chroma indigo brand light, and razor-sharp 1px borders. Calm,
dense, precise — nothing shouts.

## 2. Color Palette & Roles

- Background surfaces: --bg #0d0e10, --surface #16171a, --surface-2 #1f2023
- Text & content: --fg #e6e7ea, --fg-2 #9a9da3, --muted #6f7177
- Brand & accent: --accent #5e6ad2 on --accent-fg #ffffff
- Border & divider: --border #26272b, --border-strong #34353a

## 3. Typography Rules

Inter-style grotesque for UI; mono for IDs and keyboard hints. Compact. Display
28px / 560 / -0.01em; body 14px / 400; max weight 590 (never 700). Tight line
height; generous letter density.

## 4. Component Stylings

Buttons: subtle --surface-2 fill or --accent for primary; radius 6px. Cards: 1px
--border on --surface, no shadow. Inputs: 1px border, focus → --accent. Kbd: mono
chip with 1px border.

## 5. Layout Principles

8px grid; dense rows; container max 1024px. Hairline dividers everywhere. Radius
4 / 6 / 8px.

## 6. Depth & Elevation

Flat panels. Command menus and popovers float with one soft dark shadow
(0 8px 24px rgba(0,0,0,0.4)).

## 7. Do's and Don'ts

Do: keep it dark, dense, and quiet; one indigo accent. Don't: light-mode-first
designs, weight >590, multiple accents, pure black (#000) backgrounds.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; touch targets ≥24px; collapse the sidebar under 768.

## 9. Agent Prompt Guide

Quick colors: bg #0d0e10 / fg #e6e7ea / accent #5e6ad2 / border #26272b. Example:
"A dark issue list, mono ticket IDs, kbd shortcut hints, indigo primary button."
