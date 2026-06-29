---
name: Portfolio
description: A work portfolio — project grid plus a case-study layout.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage]
triggers: [portfolio, work, case study, projects, showcase]
designSystem: true
---

# Portfolio

A single `index.html` portfolio: a short intro, a project grid, and one expandable case study.

## Structure

- A tight intro: who you are + what you do, one line, with a memorable type move.
- A responsive **project grid** (2–3 columns desktop, 1 on mobile). Each card: a framed thumbnail, title, role, year — bordered, no drop shadow.
- One project opens a **case study**: problem → approach → outcome, with real artifacts and figures.
- Cover the empty state ("no projects yet") and image loading (a neutral placeholder frame, never a broken box).

## Craft

Let the work be the color; keep chrome neutral with one accent for links/hover. Generous gutters,
consistent aspect ratios. Real project names and outcomes only. Images via a `.ph` placeholder if absent.
