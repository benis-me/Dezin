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
 * Builds the prompt block that tells the build Agent how to reconstruct a
 * Sharingan-cloned site: read the already-captured `.sharingan/` bundle,
 * optionally drive the live browser-control probe endpoints (Phase 4) to
 * capture a few more key pages within budget, authenticate with the daemon
 * token, and follow the reconstruct-not-rip guardrails. Mirrors the shape
 * of `buildProjectEffectContext` in `project-effect-context.ts`.
 */
export function buildSharinganContext(input: SharinganContextInput): SharinganContext {
  const { projectId, sourceUrl, origin, budget, capturedCount } = input;
  const base = `${origin.replace(/\/+$/, "")}/api/sharingan/${projectId}`;
  const promptBlock = [
    "## Sharingan — Reconstruct from Capture",
    `You are reconstructing the website ${sourceUrl} as a high-fidelity Standard (Vite + React) project. This is a RECONSTRUCTION of structure and design language — NOT a byte-for-byte copy. Treat logos, brand photography, and verbatim marketing copy as swappable placeholders; rebuild layout, components, and design tokens.`,
    "",
    "The entry page is already captured under `.sharingan/` (screenshots, `dom.json` with per-node computed layout, `styles.json`, and `assets.json` — an inventory of the source's images) and indexed in `.sharingan/pages.json` (which also lists the entry page's same-origin links). Read those files directly to understand the site.",
    "",
    "You may drive the live browser to explore + capture additional key pages by calling these local endpoints (send the `x-dezin-daemon-token` header with the `DEZIN_DAEMON_TOKEN` environment variable):",
    `- Navigate: POST ${base}/navigate  body {"url":"..."}`,
    `- Inspect: GET ${base}/read-dom , GET ${base}/computed-styles , GET ${base}/links`,
    `- Interact: POST ${base}/click {"selector":"..."} , POST ${base}/scroll {"y":1200}`,
    `- Capture the current page into the bundle: POST ${base}/capture  (optionally {"url":"..."} to navigate first)`,
    "",
    `Page budget: capture at most ${budget} pages total (captured so far: ${capturedCount}). Pick the highest-value pages (nav destinations, pricing, product, key flows). Stay same-origin. A /capture that returns {"skipped":"budget"} means you're at the cap — stop capturing and build from what you have.`,
    "",
    "For every image slot the source has (see `assets.json` — each entry lists the URL, kind, alt, and rendered size), place a FREE placeholder image sized to match, never the source's brand asset: use `https://picsum.photos/seed/<word>/<w>/<h>`, `https://placehold.co/<w>x<h>`, or an Unsplash source URL keyed to the content, and write a sensible `alt`. Do not leave image slots empty and do not hotlink the source's images.",
    "Match the source: reproduce its layout structure, component hierarchy, image-slot placement, type scale, and color palette from the captured `dom.json`/`styles.json`/screenshots — this is a faithful reconstruction, not a redesign.",
    "",
    "Then build the project from the captured bundle: reproduce the structure, layout, and design tokens; use placeholder assets/copy for brand-owned content.",
  ].join("\n");
  return { promptBlock };
}
