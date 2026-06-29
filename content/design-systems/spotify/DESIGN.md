# Spotify

> Category: Media & Entertainment

## 1. Visual Theme & Atmosphere

Dark-native, bold, kinetic. A near-black #121212 stage where album art is the
colour and one vivid green is the only chrome. Heavy display weights, full-pill
buttons, and edge-to-edge artwork. Energetic and music-forward — the UI gets out
of the way so the cover grid sings.

## 2. Color Palette & Roles

- Background surfaces: --bg #121212, --surface #181818, --surface-2 #282828
- Text & content: --fg #ffffff, --fg-2 #b3b3b3, --muted #7a7a7a
- Brand & accent: --accent #1ed760 (Spotify green) on --accent-fg #0a0a0a (dark text on green)
- Border & divider: --border #2a2a2a, --border-strong #3e3e3e

Budget: black + grey 90%, green 4–8% (Play button, "Now Playing" bar, progress
fill). Album art supplies all other colour — never tint the chrome to match it.

## 3. Typography Rules

Spotify Mix / Circular — a geometric sans with confident heavy weights. Display
32–56px / 700–900 / -0.02em; section titles 24px / 700; body 14–16px / 400; meta
13px / 400 in --fg-2. Bold is the brand voice. Track titles 400 white, artists
--fg-2.

## 4. Component Stylings

Buttons: --accent green, fully pill (--radius-pill), black text, scale-up on hover;
secondary = transparent + 1px --border-strong. Cards: --surface, --radius, hover →
--surface-2 with a floating Play FAB. Rows: hover tint --surface-2, green equaliser
on the active track. Progress/scrub bars: green fill on grey track.

## 5. Layout Principles

8px grid; container max 1280px; persistent left nav + bottom now-playing bar.
Responsive cover grids (2–6 up). Radius 8 / 16px for cards, full pill for controls.
Dense but never cramped.

## 6. Depth & Elevation

Layer by surface lightness (#121212 → #181818 → #282828), not borders. Soft drop
shadow on the now-playing bar and context menus only (0 8px 24px rgba(0,0,0,0.5)).

## 7. Do's and Don'ts

Do: black stage, one green signal, heavy display type, full-pill controls, art-led
colour. Don't: light-mode-first, pure #000 backgrounds, a second accent hue, green
text on green, thin display weights, fake play counts.

## 8. Responsive Behavior

Breakpoints 640 / 1024px; collapse left nav under 1024; bottom bar stays pinned;
cover grid drops to 2-up under 640; touch targets ≥44px.

## 9. Agent Prompt Guide

Quick colors: bg #121212 / fg #ffffff / accent #1ed760 / border #2a2a2a. Example:
"A dark playlist page, edge-to-edge cover art, heavy display title, full-pill green
Play button with black text, grey track rows, green equaliser on the active song."
