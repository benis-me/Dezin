# Raycast

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

A dark, fast command-launcher feel: near-black surfaces, a confident coral accent,
crisp rows and a single focused input. Built for keyboard speed.

## 2. Color Palette & Roles

- Surfaces: --bg #131316, --surface #1c1c20, --surface-2 #26262c
- Text: --fg #f2f2f4, --fg-2 #b8b8c0, --muted #8a8a94
- Accent: --accent #ff6363 on --accent-fg #1a0d0d
- Border: --border #2e2e36, --border-strong #40404a

## 3. Typography Rules

UI sans; mono for shortcuts. Body 14px; section headers small-caps at 0.08em. Two weights.

## 4. Component Stylings

A prominent search input; result rows with an icon + label + a kbd hint on the right.
Selected row = --surface-2 fill. Buttons: ghost or --accent primary, radius 8px.

## 5. Layout Principles

List-first; 8px grid; comfortable row height (~40px). Radius 6 / 8 / 12px.

## 6. Depth & Elevation

The launcher floats over a dimmed backdrop with one soft shadow; rows are flat.

## 7. Do's and Don'ts

Do: keyboard hints, dense rows, one coral accent. Don't: heavy chrome, multiple accents, pure-black, decorative motion.

## 8. Responsive Behavior

Primarily a fixed launcher width (~640px); stack to full-width under 640. Targets ≥24px.

## 9. Agent Prompt Guide

bg #131316 / fg #f2f2f4 / accent #ff6363 / border #2e2e36. Example: "A command palette with icon rows, ⌘K hints, coral selection."
