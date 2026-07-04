---
name: Motion landing
description: An awwwards-grade animated landing — multi-act narrative, GSAP scroll motion, a WebGL shader hero. Expressive but disciplined.
mode: prototype
craft: [typography, color, anti-ai-slop, animation-discipline, accessibility-baseline, laws-of-ux]
triggers: [awwwards, animated landing, motion, gsap, shader, webgl, scrollytelling, immersive, creative landing]
libraries: [css, waapi, motion, gsap, remotion, webgl, three, ogl]
designSystem: true
---

# Motion landing

Build a single immersive landing page that could be Site of the Day on awwwards:
oversized type, deep negative space, a real WebGL shader moment, and motion that
*choreographs* the scroll — not decoration sprinkled on a template. Every animation
must earn its place by directing attention or revealing structure.

This is the one skill where expressiveness is the brief. But expressive ≠ sloppy:
the discipline below is what separates an award winner from an AI demo.

## Research

- The brand's story and the single feeling this page should leave — motion serves that
  feeling, not the reverse. Study award-winning sites in this space for what earns the
  motion.
- Real content for each act: the actual headline, the real product moment worth
  rendering large. Choreography with nothing to say is decoration.

## Output shape

Honor the Dezin output mode above everything else:

- Prototype mode: build ONE self-contained `index.html`. Inline CSS in `<style>`
  and JS in `<script>`. Load libraries from a CDN only when the motion idea needs
  them:

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
```

- Standard mode: build inside the Vite + React project. Use the scaffolded GSAP
  dependency for timeline/scroll work. Install `motion` only for React-specific
  layout/presence/gesture motion. Install Remotion only if the user explicitly asks
  for a video/timeline renderable composition, not for a normal web landing page.

Use system/brand fonts or one real web font source. No library is mandatory just
because the skill is animation-focused.

## Narrative structure (5–7 acts, not a skeleton)

Compose a story, each act a full-bleed section with its own motion idea:

1. **Hero** — a live WebGL shader canvas behind a giant headline; the headline
   animates in by line/word on load (clip-path or y-translate + opacity stagger).
2. **Manifesto / statement** — one oversized sentence, words revealing on scroll.
3. **Showcase / features** — horizontal-scroll or pinned panels driven by ScrollTrigger.
4. **Proof** — counters that tick up when in view, or a marquee of logos/words.
5. **Detail** — one product element rendered large with parallax layers.
6. **CTA** — a magnetic button + a closing shader echo.
7. **Footer** — calm, generous, with a fine bottom line.

Vary rhythm: alternate a dense act with a breathing one. Never Hero→Features→
Pricing→FAQ→CTA in flat order.

## The WebGL shader hero (the centerpiece)

Render a fullscreen `<canvas>` with a custom GLSL fragment shader — raw WebGL is
enough, no library needed. A flowing field is ideal: animated value-noise or
domain-warped gradients in the BRAND's accent + background colors (read them from
CSS vars / the design-system tokens, do not invent neon). Aim for slow, organic
movement (`u_time`), subtle film grain, and a soft vignette. Keep it tasteful and
low-chroma — this is atmosphere, not a rave.

Requirements:
- Cap the DPR at ~1.5 and pause the `requestAnimationFrame` loop when the hero is
  scrolled out of view (IntersectionObserver) — performance is part of the craft.
- Provide a `<canvas>` fallback: if WebGL is unavailable, show a flat brand-colored
  hero (no broken black box).

## Motion system (GSAP)

- Register `ScrollTrigger`. One coherent easing language (e.g. a custom
  `power3.out` / `expo.out`), consistent durations (0.6–1.2s).
- Reveal on scroll: `gsap.from('[data-reveal]', { y: 40, opacity: 0, stagger: .08 })`
  wired to ScrollTrigger, played once.
- At least one *pinned* or *scrubbed* section (horizontal panels, or a sticky act
  whose contents transform as you scroll through it).
- Magnetic CTA: the button nudges toward the cursor (pointermove), springs back.
- A marquee that loops seamlessly (duplicated track, `xPercent` tween).
- Subtle parallax: background layers move slower than foreground on scroll.

## NON-NEGOTIABLE discipline

- **prefers-reduced-motion**: wrap ALL motion in
  `if (!matchMedia('(prefers-reduced-motion: reduce)').matches) { … }`, and freeze
  the shader to a single static frame. Content must be fully visible and usable with
  motion off — never leave elements stuck at `opacity:0`.
- **Fail-safe visibility (critical)**: an intro built on `gsap.from(...)` applies the
  hidden start state immediately, so if the rAF ticker never advances — a tab that
  loads in the background, GSAP failing to load, a JS error — the hero stays invisible.
  Guarantee recovery: the no-JS / pre-animation state must be readable on its own, and
  add a hard fallback that force-reveals the hero if the intro hasn't run, e.g.
  `setTimeout(() => document.documentElement.classList.add('intro-done'), 1200)` with
  CSS that shows the headline once `intro-done` is set (or `gsap.set(end)` in the
  timeout). Never ship a hero that depends on an animation frame to be legible.
- **Type does the work**: hierarchy from scale + weight + tracking, two typefaces max,
  tight display tracking, never justify, real copy with a point of view.
- **Color**: the brand tokens are authoritative. One accent. The shader uses brand
  hues — no AI indigo (#6366f1-family), no rainbow, no purple→blue "trust" gradient
  as a CSS background (the shader is the only gradient, and it lives on canvas).
- **No slop**: no emoji as icons (inline monoline SVG with currentColor), no
  glow-everything, no shadow-stacked cards, no fake metrics. Borders over shadows.
- **Accessible**: semantic landmarks, focus-visible states, alt text, ≥44px targets,
  sufficient contrast on text over the shader (add a scrim if needed).

The win condition: muted it on `prefers-reduced-motion` it is a clean, confident,
editorial page; with motion on it feels alive and intentional — and it still passes
the anti-slop lint.
