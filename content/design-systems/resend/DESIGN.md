# Resend

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Stark, near-monochrome developer brand: white surfaces, near-black text and accent,
hairline borders, generous whitespace. Type and structure do all the work.

## 2. Color Palette & Roles

- Surfaces: --bg #ffffff, --surface #fafafa, --surface-2 #f2f2f2
- Text: --fg #161616, --fg-2 #4a4a4a, --muted #8a8a8a
- Accent: --accent #161616 on --accent-fg #ffffff (monochrome — emphasis by weight, not hue)
- Border: --border #e8e8e8, --border-strong #bdbdbd

## 3. Typography Rules

A geometric sans; mono for code. Display 48–72px / 600 / −0.02em; body 16px. Heavy
reliance on scale + weight contrast since there's no color accent.

## 4. Component Stylings

Buttons: solid near-black or white + 1px border; radius 8px. Cards: 1px border, no
shadow. Code: --surface tint, mono. Inputs: 1px border, focus → --fg ring.

## 5. Layout Principles

8px grid; container max 1100px; big vertical rhythm; hairline dividers. Radius 6 / 8px.

## 6. Depth & Elevation

Effectively flat; a single soft shadow only on floating menus/modals.

## 7. Do's and Don'ts

Do: monochrome discipline, big type, whitespace. Don't: add a color accent, gradients, shadows on cards.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; single column under 640; targets ≥24px.

## 9. Agent Prompt Guide

bg #fff / fg #161616 / accent #161616 / border #e8e8e8. Example: "A monochrome API landing: 64px black headline, hairline-bordered code, black CTA."
