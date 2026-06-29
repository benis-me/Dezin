# Vercel

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Stark, geometric, high-contrast black-and-white. Confident emptiness: huge
whitespace, crisp hairlines, a single electric-blue link color. Reads as
infrastructure-grade and fast.

## 2. Color Palette & Roles

- Background surfaces: --bg #ffffff, --surface #fafafa, --surface-2 #f2f2f2
- Text & content: --fg #000000-adjacent #0a0a0a, --muted #666666
- Brand & accent: --accent #0070f3 on --accent-fg #ffffff
- Border & divider: --border #eaeaea, --border-strong #999999

## 3. Typography Rules

Geist (Vercel's own typeface) for everything; Geist Mono for code. Tight,
geometric. Display 56px / 600 / -0.03em; body 16px / 400; mono for metrics.
Heavy reliance on size contrast, sparing weight.

## 4. Component Stylings

Buttons: black fill (--fg) or white with 1px border; radius 6px. Cards: 1px
--border, no shadow. Inputs: 1px border, focus → --accent ring. Code blocks:
--surface bg, mono.

## 5. Layout Principles

8px grid; generous container max 1200px; oversized vertical rhythm. Hairline
dividers between sections. Radius 5 / 8px.

## 6. Depth & Elevation

Effectively flat. A single soft shadow (0 8px 30px rgba(0,0,0,0.08)) only on
floating menus and modals.

## 7. Do's and Don'ts

Do: maximize contrast and whitespace; one accent for links/CTAs. Don't: gradients,
rounded blobs, drop shadows on cards, secondary accent colors.

## 8. Responsive Behavior

Breakpoints 640 / 960 / 1280px; touch targets ≥24px; single column under 640.

## 9. Agent Prompt Guide

Quick colors: bg #fff / fg #0a0a0a / accent #0070f3 / border #eaeaea. Example: "A
docs page: black headings, hairline dividers, one blue inline-link accent, mono code."
