---
name: Status page
description: A service status page — current status, per-component uptime, and an incident history timeline.
mode: prototype
craft: [typography, color, anti-ai-slop, state-coverage, laws-of-ux]
triggers: [status page, uptime, incidents, service status, system status, outage]
designSystem: true
---

# Status page

Build a single `index.html` status page that answers "is it down?" in the first second
and tells the honest story underneath.

## Current status, up top

- One unambiguous summary banner: **All systems operational**, **Degraded
  performance**, or **Major outage** — conveyed by an icon and the word, not color alone
  (color is the accent, not the message). Show "as of" with a tabular-nums timestamp.

## Components

- List each real service (API, Dashboard, Webhooks, Auth) with its own status pill.
- Beside each, a 90-day **uptime bar** — one cell per day, degraded/down days marked by
  shape or fill, not hue only — and the uptime % in `tabular-nums`.
- Order by what users feel first (Pareto): the API a customer depends on outranks an
  internal admin tool.

## Incident history

- A reverse-chronological timeline. Each incident: title, severity, start/resolve
  timestamps, affected components, and updates posted in order — **Investigating →
  Identified → Monitoring → Resolved**, newest first within the incident.
- Real, specific postmortem copy — "Elevated error rates on the EU API from a bad
  deploy; rolled back at 14:20 UTC" — never "We experienced some issues".

## Cover the states

- **All clear** — the calm happy path; don't manufacture drama.
- **Active incident** — the banner escalates, the affected component flips, a live
  incident pins to the top.
- **Scheduled maintenance** — a future-dated, clearly-labelled window.

## Craft

Borders and hairline dividers, no shadow cards. Neutrals carry the page so a real outage
color actually reads. Status must survive a grayscale/colorblind check. One `<h1>`,
incidents under `<h2>`; the timeline spine is a single quiet rule, not a gradient.
