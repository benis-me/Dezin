---
name: Marketing email
description: A 600px HTML email — table layout, inline styles, client-safe.
mode: prototype
craft: [typography, color, anti-ai-slop]
triggers: [email, newsletter, campaign, broadcast]
designSystem: true
---

# Marketing email

A single `index.html` email that survives real clients (Gmail, Outlook, Apple Mail).

## Constraints (email is not the web)

- **Table-based layout**, max width **600px**, centered. No flexbox/grid for structure.
- **Inline styles** on elements (clients strip `<head>` styles); keep a `<style>` only for progressive enhancement.
- Web-safe font stack with graceful fallback; system fonts are fine here.
- Bulletproof buttons (a styled `<a>` in a table cell), not `<button>`. Alt text on every image; assume images are blocked.

## Content

- One clear message and one primary CTA above the fold. A short preheader line.
- Real copy with a point of view; no filler, no invented stats. A plain footer with an unsubscribe affordance.

## Craft

Pull colors from the design system tokens (inlined as hex, since var() is unreliable in email).
One accent on the CTA. Generous padding; single column on narrow widths.
