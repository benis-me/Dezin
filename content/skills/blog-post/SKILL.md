---
name: Blog post
description: An editorial long-form article with authored reading hierarchy.
mode: document
craft: [typography, typography-hierarchy, color, anti-ai-slop]
triggers: [blog, article, post, essay, long-form]
designSystem: true
---

# Blog post

A single `index.html` reading surface — designed like a magazine page, not a CMS dump.

## Research

- The real argument or story this piece makes, and who it's for — a post with no thesis
  becomes a content dump.
- The real facts, examples, and references the prose needs; pull them so the writing is
  specific, not generic.

## Editorial hierarchy

- One dominant title (3–5× body size). A dated byline + a one-line standfirst.
- Body measure **60–75ch** (`max-width: 65ch`), line-height ~1.6, **never justify**.
- Three weights only; restrained bold (≤2 phrases per 400 words). ALL-CAPS kickers at ≥0.06em.
- Subheads create a skimmable spine; pull-quotes are typographic interrupts, not boxed callouts.
- Code, figures, and blockquotes have their own quiet treatment (a rule or surface tint, no heavy borders).

## Craft

Real prose only. One accent for links/emphasis, used sparingly. Generous vertical rhythm
between sections. Use the design system's serif/body fonts via var(); don't hardcode Inter.
