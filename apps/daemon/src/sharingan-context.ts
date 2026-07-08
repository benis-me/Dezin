export interface SharinganContextInput {
  sourceUrl: string;
  budget: number;
  capturedCount: number;
}

export interface SharinganContext {
  promptBlock: string;
}

/**
 * Builds the prompt block that tells the build Agent how to faithfully
 * reproduce a Sharingan-cloned site 1:1: read the already-captured
 * `.sharingan/` bundle (nested `dom.json` tree, exact `styles.json`
 * palette, `assets.json` with cached `/_assets/` local images), optionally
 * drive the live browser-control probe endpoints (Phase 4) to capture a few
 * more key pages within budget, authenticate with the daemon token, and
 * mirror the capture rather than redesign it. Mirrors the shape of
 * `buildProjectEffectContext` in `project-effect-context.ts`.
 */
export function buildSharinganContext(input: SharinganContextInput): SharinganContext {
  const { sourceUrl, budget, capturedCount } = input;
  const promptBlock = [
    "## Sharingan — Reproduce from Capture (1:1)",
    `You are reproducing the website ${sourceUrl} as a high-fidelity Standard (Vite + React) project. The goal is a FAITHFUL 1:1 reproduction of the ORIGINAL — match its structure, layout, spacing, typography, and colors as closely as you can. This is authorized cloning; do not redesign it in your own taste.`,
    "",
    "The entry page is already captured under `.sharingan/` (indexed in `.sharingan/pages.json`). Read the capture like this:",
    "- **`node .sharingan/probe.mjs outline`** — RUN THIS FIRST. It prints the captured DOM as a compact indented tree WITH each node's key styles (layout/flex/grid, colors, font size/weight, spacing, borders). This is your BLUEPRINT — mirror its structure and styles; do not invent a different layout. The raw `dom.json` behind it is LARGE — do NOT cat / load / parse it with node/python/jq. Open `dom.json` only to check ONE specific node's exact style when the outline isn't enough; never read the whole file, and never loop over it.",
    "- **`node .sharingan/probe.mjs render-map`** — read this right after outline. It summarizes `render-map.json`: the browser-measured viewport, document size, element bounding boxes, and computed visual styles. Treat these measurements as the layout constraints for a source-vs-result visual regression loop.",
    "- `styles.json` — the source's exact design tokens (colors, fonts, radii, shadows). Use THESE colors and fonts verbatim. Do NOT substitute default AI colors (no indigo/violet/purple unless the source actually uses them).",
    "- `assets.json` — the image inventory. Each entry has a `local` path (e.g. `/_assets/ab12cd34ef56.png`) — the REAL source image already downloaded into this project's `public/` folder. Reference every image by its `local` path (they resolve at the web root). Fill EVERY image slot the source has; an entry without a `local` path failed to download — use a neutral sized placeholder box for just those.",
    "- the desktop screenshot — the visual source of truth; your result should look like it.",
    "",
    "To explore + capture MORE key pages, use the ready-made `dezin-probe` CLI — do NOT hand-write curl/fetch/python; it handles the daemon token + auth for you. Run `node .sharingan/probe.mjs help` for the list:",
    "- `node .sharingan/probe.mjs navigate <url>` — open a URL in the live capture browser",
    "- `node .sharingan/probe.mjs read-dom` | `styles` | `links` — inspect the current page",
    "- `node .sharingan/probe.mjs click <selector>` | `scroll <y>` — interact",
    "- `node .sharingan/probe.mjs capture [url]` — capture the current (or given) page into the bundle",
    "- `node .sharingan/probe.mjs outline [dom.json]` — a condensed tree of a captured page",
    "- `node .sharingan/probe.mjs render-map [render-map.json]` — compact measured layout rows from a captured page",
    "",
    `Page budget: capture at most ${budget} pages total (captured so far: ${capturedCount}). Pick the highest-value pages; stay same-origin. A capture returning {"skipped":"budget"} means stop. Capturing the same URL again just UPDATES it, so don't re-capture a page you already have.`,
    "",
    "Then BUILD — that is the goal, not analyzing the capture. After a brief look at `outline`, `render-map`, and `styles.json`, START WRITING `src/App.jsx` and its components right away; do not loop re-inspecting `dom.json`. Mirror the outline's tree, apply the `styles.json` palette exactly, use the cached `/_assets/` images, and reproduce the real text content (no lorem/filler).",
    "",
    "Repair discipline: later visual review may report source-vs-result measured deltas from `render-map.json` and screenshot diff evidence. Apply those as local patches to the named element/region; do not redesign or re-layout the whole page to chase a single measurement.",
  ].join("\n");
  return { promptBlock };
}
