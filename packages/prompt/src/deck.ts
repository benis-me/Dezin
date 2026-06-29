/**
 * The verbatim slide-deck scaffold, injected when the active skill's mode is
 * "deck". A fixed 1920×1080 stage that scale-to-fits any viewport, keyboard nav,
 * a slide counter, and a print stylesheet that emits one slide per page.
 */

export const DECK_FRAMEWORK = `## Deck framework (use this skeleton)

Build the deck on this exact scaffold — one \`<section class="slide">\` per slide.
The stage is a fixed 1920×1080 canvas scaled to fit any viewport. Paste the design
system tokens into \`:root\` and bind all color/type to them.

Rules: one idea per slide; body text never below 24px; keep content inside the ~8%
safe margins; alternate a dense slide with a breathing one; real content only.

\`\`\`html
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
\`\`\``;
