export interface SharinganContextInput {
  projectId: string;
  sourceUrl: string;
  origin: string;
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
  const { projectId, sourceUrl, origin, budget, capturedCount } = input;
  const base = `${origin.replace(/\/+$/, "")}/api/sharingan/${projectId}`;
  const promptBlock = [
    "## Sharingan — Reproduce from Capture (1:1)",
    `You are reproducing the website ${sourceUrl} as a high-fidelity Standard (Vite + React) project. The goal is a FAITHFUL 1:1 reproduction of the ORIGINAL — match its structure, layout, spacing, typography, and colors as closely as you can. This is authorized cloning; do not redesign it in your own taste.`,
    "",
    "The entry page is already captured under `.sharingan/` and indexed in `.sharingan/pages.json`. Read these directly:",
    "- `dom.json` — the captured DOM as a NESTED TREE (parent/child hierarchy) with per-node computed styles (display/flex/grid/size/padding/margin/font/color/border/etc.). MIRROR this structure and these styles — it is your blueprint. Do not invent a different layout.",
    "- `styles.json` — the source's exact design tokens (colors, fonts, radii, shadows). Use THESE colors and fonts verbatim. Do NOT substitute default AI colors (no indigo/violet/purple unless the source actually uses them).",
    "- `assets.json` — the image inventory. Each entry has a `local` path (e.g. `/_assets/ab12cd34ef56.png`) — the REAL source image already downloaded into this project's `public/` folder. Reference every image by its `local` path (they resolve at the web root). Fill EVERY image slot the source has; an entry without a `local` path failed to download — use a neutral sized placeholder box for just those.",
    "- the desktop screenshot — the visual source of truth; your result should look like it.",
    "",
    "You may drive the live browser to explore + capture additional key pages via these local endpoints (send `x-dezin-daemon-token: $DEZIN_DAEMON_TOKEN`):",
    `- Navigate: POST ${base}/navigate  {"url":"..."}`,
    `- Inspect: GET ${base}/read-dom , GET ${base}/computed-styles , GET ${base}/links`,
    `- Interact: POST ${base}/click {"selector":"..."} , POST ${base}/scroll {"y":1200}`,
    `- Capture into the bundle: POST ${base}/capture  (optionally {"url":"..."})`,
    "",
    `Page budget: capture at most ${budget} pages total (captured so far: ${capturedCount}). Pick the highest-value pages; stay same-origin. A /capture returning {"skipped":"budget"} means stop capturing.`,
    "",
    "Then build the project to match the capture as closely as possible: mirror the `dom.json` tree, apply the `styles.json` palette exactly, and use the cached `/_assets/` images. Reproduce the real text content from the capture (do not fall back to lorem/filler).",
  ].join("\n");
  return { promptBlock };
}
