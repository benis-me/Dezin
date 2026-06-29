# PostHog

> Category: Developer Tools

## 1. Visual Theme & Atmosphere

Playful, high-contrast, hand-built. A warm cream canvas, hard black hairlines, and
a punchy orange-red signal — a dev tool with personality (hedgehogs and all).
Framed cards with crisp 1px black borders and offset shadows, bright accents used
boldly. Technical but never sterile; fun without losing the data.

## 2. Color Palette & Roles

- Background surfaces: --bg #eeefe9 (cream), --surface #ffffff, --surface-2 #f3f4ee
- Text & content: --fg #151515, --fg-2 #2d2d2d, --muted #5f5f57
- Brand & accent: --accent #f54e00 (PostHog red-orange) on --accent-fg #ffffff
- Secondary signals: blue #1d4aff, yellow #f9bd2b (charts, tags — sparingly)
- Border & divider: --border #d6d7cd, --border-strong #1d1d1d (the signature black hairline)

Budget: cream + white 80–88%, ink black for frames/text, orange 5–9% (primary CTA,
active nav), blue/yellow only inside charts and tags.

## 3. Typography Rules

MatterSQ / Matter — a sturdy grotesque with character. Display 36–60px / 700 /
-0.02em; H1 28px / 700; body 15–16px / 1.5 / 400; labels 13px / 600. IBM Plex Mono
for code, query snippets, and metric values. Confident, slightly chunky headings.

## 4. Component Stylings

Buttons: --accent orange primary, or white + 1px --border-strong (black) with a 2–3px
offset hard shadow; radius 8px. Cards: white on cream, 1px black border, hard offset
shadow (4px 4px 0 var(--border-strong)) on featured tiles. Inputs: 1px black border,
focus → orange ring. Tabs: underline in black; active label bold. Code: mono on cream.

## 5. Layout Principles

8px grid; container max 1200px; framed, modular blocks with visible structure. Radius
4 / 8 / 12px. Borders define regions, not whitespace alone. Charts sit in bordered
panels; sidebars are full-height with black dividers.

## 6. Depth & Elevation

Depth via hard offset shadows (no blur) in --border-strong on featured cards and
buttons — the "sticker" look. Menus/popovers get one soft shadow. Flat elsewhere.

## 7. Do's and Don'ts

Do: cream canvas, black hairline frames, hard offset shadows, one bold orange,
playful but legible. Don't: soft pastel gradients, blurry drop-shadows everywhere,
swap the orange for indigo, more than three signal hues at once, fake funnel numbers.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; collapse the full-height sidebar under 1024; framed panels
stack single-column under 640; keep black borders crisp; touch targets ≥44px.

## 9. Agent Prompt Guide

Quick colors: bg #eeefe9 / fg #151515 / accent #f54e00 / border-strong #1d1d1d.
Example: "A product-analytics dashboard on cream, white framed cards with black 1px
borders and 4px hard offset shadows, orange 'Create insight' button, a bordered funnel
chart, mono metric numbers."
