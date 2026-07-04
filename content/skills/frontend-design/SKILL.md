---
name: Frontend design
description: A single self-contained HTML page artifact built from the active design system.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage]
triggers: [web page, landing, prototype, single page, marketing, website]
designSystem: true
---

# Frontend design

The general skill for a single polished page when no more specific skill fits. Work in
phases: research what the page must accomplish, structure it, then build one
self-contained `index.html`.

## Research

- What this page is for, who it's for, and the one action or belief it should produce. A
  page with no job becomes decoration.
- Real products in this space — how they solve the same problem, what to borrow, what
  reads as generic. Collect concrete references.
- The real content: the actual copy, facts, and numbers this page needs. A page built on
  invented filler reads as a template no matter how it's styled.

## Structure

- Compose the sections the goal actually needs, in the order that makes the argument —
  not a fixed template. Give the page one clear focal point and a deliberate reading path.
- Paste the active design system's `:root` token block verbatim into a `<style>` and
  reference everything with `var()`. State the palette, type scale, and spacing you'll use
  before building.

## The distinctive move

Name the one decisive, page-specific decision that makes this real — a real screenshot, a
real interaction, one bold type or layout choice, a detail only someone close to the
subject would add. One flourish, not many. If you can't name it, the brief is
underspecified: commit to the most likely intent rather than hedging.

## Before you ship

Self-check: posture matches the brief, one clear focal point, typography and spacing are
exact, every word is specific to this brief, restraint holds. Cover the loading / empty /
error states of any data surface. Fix anything weak, then write the file.
