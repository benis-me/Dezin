/**
 * Shared HTML fixtures for the quality-kernel tests.
 */

/** A clean, Linear/Vercel-flavored artifact that should produce ZERO findings. */
export const CLEAN_ARTIFACT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg: #ffffff;
    --fg: #111111;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --font-display: "Geist", system-ui, sans-serif;
    --tracking-caps: 0.08em;
    --radius: 10px;
  }
  body { background: var(--bg); color: var(--fg); font-family: var(--font-display); }
  h1 { font-family: var(--font-display); letter-spacing: -0.02em; }
  .card { border: 1px solid var(--border); border-radius: var(--radius); }
  .eyebrow { text-transform: uppercase; letter-spacing: var(--tracking-caps); font-size: 12px; color: var(--muted); }
  .cta { color: var(--accent); }
</style>
</head>
<body>
  <section data-od-id="hero">
    <p class="eyebrow">Changelog</p>
    <h1>Ship design, not slop</h1>
    <p>Real copy describing the product in plain language.</p>
    <a class="cta" href="#start">Start building</a>
  </section>
  <section data-od-id="features">
    <div class="card"><h3>Token-aware</h3><p>It honours your design system.</p></div>
  </section>
</body>
</html>`;

/** A maximally sloppy artifact tripping many P0 rules at once. */
export const SLOPPY_ARTIFACT = `<!doctype html>
<html lang="en">
<head>
<style>
  body { background: linear-gradient(135deg, #6366f1, #a855f7); }
  h1 { font-family: Inter, sans-serif; }
  .hero { background: #4f46e5; }
  .tile { border-left: 4px solid #4f46e5; border-radius: 8px; }
</style>
</head>
<body>
  <section>
    <h1>✨ The future of work 🚀</h1>
    <p>10× faster than the competition. 99.9% uptime.</p>
    <p>lorem ipsum dolor sit amet.</p>
  </section>
</body>
</html>`;
