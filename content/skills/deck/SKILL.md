---
name: Slide deck
description: A 16:9 presentation deck — one idea per slide, big type, safe margins.
mode: deck
craft: [typography, typography-hierarchy, color, anti-ai-slop]
triggers: [deck, slides, presentation, pitch, keynote]
designSystem: true
---

# Slide deck

A deck is an argument delivered one idea at a time, readable from across a room. Research
the narrative, structure the sequence, then build slides that breathe.

## Research

- The audience and the single decision or takeaway the deck exists to produce. A pitch
  deck, a conference talk, and an internal review need different arcs.
- The real content — figures, quotes, examples — for each beat. A deck with invented
  numbers dies under one informed question; pull real ones from the brief or research.
- The narrative spine: the 8–15 beats that carry the argument, and where it needs a
  breath or a section reset.

## Structure

- Each slide is a `1280×720` (or `1920×1080`) section, scaled to fit; keyboard nav
  (←/→), a slide counter, and a print stylesheet (one slide per page).
- **One idea per slide** — a headline plus at most one supporting element (a stat, a
  chart, a quote, an image). Safe margins: content within ~8% of every edge.
- Alternate rhythm: a dense slide, then a breathing one; section dividers reset attention.

## The distinctive move

The one slide people remember — a single number rendered huge, an unexpected comparison,
one image that lands the point. Build the deck around it. Display type is large
(48–96px, tight tracking); body never below 24px.

## Build — the scaffold

Build on this exact skeleton — one `<section class="slide">` per slide on a fixed
1920×1080 stage scaled to fit any viewport, with keyboard nav (←/→/space), a slide
counter, and a print stylesheet (one slide per page). Paste the design-system tokens
into `:root` and bind every color/type value to them. One idea per slide; body text
never below 24px; keep content inside the ~8% safe margins; alternate a dense slide
with a breathing one; real content only.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { /* paste the design system tokens here */ }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: var(--surface, #0b0b0e); overflow: hidden; }
  #stage { position: absolute; top: 50%; left: 50%; width: 1920px; height: 1080px;
    transform-origin: center center; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
  .slide { position: absolute; inset: 0; display: none; flex-direction: column;
    justify-content: center; padding: 8% 9%; }            /* safe margins */
  .slide.active { display: flex; }
  .slide h1 { font-family: var(--font-display); font-size: 96px; letter-spacing: -0.02em; line-height: 1.05; }
  .slide p, .slide li { font-size: 28px; line-height: 1.5; }   /* never below 24px */
  #counter { position: absolute; bottom: 32px; right: 40px; font: 20px/1 var(--font-mono, monospace); color: var(--muted); }
  @media print {
    @page { size: 1920px 1080px landscape; margin: 0; }
    html, body, #stage { width: 1920px; height: 1080px; transform: none !important; overflow: visible; }
    .slide { display: flex !important; position: relative; page-break-after: always; }
    #counter { display: none; }
  }
</style>
</head>
<body>
  <div id="stage">
    <section class="slide active"><h1>One idea per slide</h1></section>
    <section class="slide"><h1>Next slide</h1></section>
    <div id="counter">1 / 2</div>
  </div>
  <script>
    const slides = [...document.querySelectorAll('.slide')];
    const counter = document.getElementById('counter');
    const stage = document.getElementById('stage');
    let i = 0;
    function show(n){ i = Math.max(0, Math.min(slides.length-1, n)); slides.forEach((s,k)=>s.classList.toggle('active', k===i)); counter.textContent = (i+1)+' / '+slides.length; }
    function fit(){ const s = Math.min(innerWidth/1920, innerHeight/1080); stage.style.transform = 'translate(-50%,-50%) scale('+s+')'; }
    addEventListener('keydown', e => { if(e.key==='ArrowRight'||e.key===' ') show(i+1); if(e.key==='ArrowLeft') show(i-1); });
    addEventListener('resize', fit); fit(); show(0);
  </script>
</body>
</html>
```
