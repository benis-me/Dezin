---
name: Resume
description: A one-page CV with editorial hierarchy, print-ready.
mode: document
craft: [typography, typography-hierarchy, color]
triggers: [resume, cv, curriculum vitae]
designSystem: true
---

# Resume

A single `index.html` one-page resume that reads in ten seconds and prints clean.

## Research

- What this person is applying for and what that reader scans for first — a resume is
  targeted, not generic. Lead with what matters to that role.
- The real, specific outcomes and numbers behind their work; a resume of vague
  responsibilities reads like everyone else's.

## Structure

- A clear header: name (the dominant element), one-line role/summary, contact + links.
- Sections (Experience, Projects, Skills, Education) with consistent entry shape: role · org · dates (tabular-nums, right-aligned), then 1–3 tight bullets of outcomes.
- Lead bullets with impact and real numbers from the brief — never invented metrics.
- Fits one page; a print stylesheet (A4/Letter, sane margins, no clipped content).

## Craft

Restraint above all: one accent (a rule, the name, or section labels), one typeface pair,
generous whitespace. Hierarchy via scale + weight + spacing, not color. Measure ≤ ~90ch in two
columns or ~75ch single. Use the design system fonts via var().
