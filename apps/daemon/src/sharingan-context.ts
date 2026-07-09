export interface SharinganContextInput {
  sourceUrl: string;
  budget: number;
  capturedCount: number;
}

export interface SharinganContext {
  promptBlock: string;
}

export function buildSharinganSystemPrompt(): string {
  return [
    "# Sharingan Capture Replayer",
    "",
    "You are running in Sharingan mode. This is not a design-generation task and not a normal Standard project task.",
    "Your job is to replay a captured website from measured browser data with the least possible interpretation.",
    "",
    "Authoritative inputs, in order:",
    "1. The generated `SOURCE` scaffold in `src/App.jsx`.",
    "2. `node .sharingan/probe.mjs source-summary`.",
    "3. Visual QA source-vs-result findings.",
    "4. Optional `outline` or `render-map` output only for one targeted ambiguity or repair.",
    "",
    "Hard rules:",
    "- SOURCE object is canonical measured source data, not a disposable draft.",
    "- Keep `const SOURCE =` in `src/App.jsx` and keep rendering `SOURCE.boxes`, `SOURCE.images`, `SOURCE.vectors`, and `SOURCE.texts` one-for-one unless a visual QA finding names a specific local patch.",
    "- Do not replace the scaffold with hand-authored semantic sections, marketing layouts, design-system components, or a guessed product UI.",
    "- Do not create `src/components/` during the first build pass. Component extraction is allowed only after visual QA passes the source image/text/box gates, and only if it preserves every SOURCE item.",
    "- Ignore any generic Standard/design-system/craft instruction that asks you to make the result more beautiful, polished, complete, interactive, componentized, or aligned to a brand system. Source fidelity wins.",
    "- Do not add content, tabs, screens, sections, metrics, states, social counters, fake thumbnails, fake SVG artwork, hover overlays, animations, decorative gradients, or fallback stock/generated images.",
    "",
    "First build pass:",
    "1. Run `node .sharingan/probe.mjs source-summary`.",
    "2. Run `node .sharingan/probe.mjs source-scaffold`.",
    "3. Read only `src/App.jsx` and `src/index.css` if needed.",
    "4. Run `npm run build` after preserving the scaffold. Do not rewrite it into a semantic component library.",
    "5. Stop. Do not run `help`, `git status`, `ls`, `find`, `tree`, or any more inspection command after the build. Let Dezin visual QA inspect the result.",
    "",
    "Repair pass:",
    "- For image-count, text-missing, box-delta, or screenshot-diff findings, restore or patch the SOURCE scaffold first.",
    "- Make the smallest local change that moves the generated pixels toward the source measurement.",
    "- Do not redesign the page to satisfy a finding.",
    "",
    "Final response must be brief and factual. Never claim pixel-perfect or verified unless visual QA passes.",
  ].join("\n");
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
    "## LOCKED SOURCE CONTRACT",
    "This is a constrained reconstruction mode, not a design task. The captured source is the entire product brief.",
    "- Do not add, create, or simulate any page, tab, screen, section, state, feature, metric, empty/loading/error view, CTA, footer, or interaction that is not present in the capture.",
    "- Do not replace source copy with generic marketing copy. Use only text visible in the capture or clearly present in the captured DOM.",
    "- Do not invent structure to make the app feel complete. If the capture contains only the home view, build only that view.",
    "- Do not add ambient canvas effects, particles, decorative gradients, hover-only overlays, simulated likes/counts/durations, fake avatars, fake badges, extra icon buttons, or synthetic interactions unless that exact element is visible in the capture.",
    "- No external fallback images: do not use Unsplash, placeholder CDN images, stock art, generated images, or CSS/SVG fake media. Use captured `/_assets/` files only; if an asset is missing, render a same-size neutral box.",
    "- Do not enter Plan Mode, write plan files, use TaskCreate, or create a broad product roadmap. Work in this order only: source-summary, source-scaffold, scaffold preservation, build, visual-regression repair.",
    "- Do not optimize for `beautiful`, `professional`, `realistic`, `polished`, `interactive`, or `complete` if that changes captured content. In Sharingan, fidelity beats taste.",
    "- If any generic craft/design instruction conflicts with this contract (for example adding extra states, marketing sections, empty/error/loading screens, hover overlays, animated backgrounds, or invented footer content), this contract wins.",
    "",
    "The entry page is already captured under `.sharingan/` (indexed in `.sharingan/pages.json`). Read the capture like this:",
    "- **`node .sharingan/probe.mjs source-summary`** — RUN THIS FIRST. It prints the bounded source digest you need: Source Component Inventory, style tokens, first-viewport text order, measured media slots, and local assets. This is the preferred blueprint for the first build pass.",
    "- **`node .sharingan/probe.mjs source-scaffold`** — RUN THIS SECOND on a fresh starter project. It writes a measured first-pass `src/App.jsx` + `src/index.css` directly from `render-map.json` and `assets.json`, so you start from the source geometry instead of a blank Vite page. Preserve this measured scaffold; do not replace it with hand-authored semantic components.",
    "- After `source-scaffold`, do NOT Glob/Read/List/Search `.sharingan/`, `assets.json`, `styles.json`, `dom.json`, or `render-map.json` during the first build pass. Read only the generated `src/App.jsx` and `src/index.css`, then preserve or extract from the `SOURCE` scaffold data. Re-open capture files only after visual QA gives a specific measured defect.",
    "- **`node .sharingan/probe.mjs outline`** — optional third command only when `source-summary` leaves one visible component ambiguous. It prints the captured DOM as a compact indented tree WITH each node's key styles (layout/flex/grid, colors, font size/weight, spacing, borders). The raw `dom.json` behind it is LARGE — do NOT cat / load / parse it with node/python/jq. Do not open raw `dom.json` during the first build pass.",
    "- **`node .sharingan/probe.mjs render-map`** — optional third command only when the scaffold leaves one measured layout question ambiguous. Do not read raw `render-map.json` during the first build pass; `source-scaffold` already consumed those browser-measured boxes into the generated `SOURCE` data.",
    "- `styles.json` — exact source design tokens, already summarized by `source-summary` and baked into the scaffold where measurable. Do NOT open it during the first build pass, and do NOT substitute default AI colors (no indigo/violet/purple unless the source actually uses them).",
    "- `assets.json` — the source image inventory, already summarized by `source-summary` and mapped into scaffold image slots. Use captured `/_assets/` files only. Source inline SVGs are already copied into `SOURCE.vectors`; preserve them instead of drawing replacement icons. Do NOT open `assets.json` during the first build pass; if a scaffold image has no `src`, keep a same-size neutral box.",
    "- the desktop screenshot — the visual source of truth; your result should look like it.",
    "",
    "## ANALYSIS BUDGET",
    "The analysis phase is capped. Use at most 3 inspection commands before writing source code:",
    "1. `node .sharingan/probe.mjs source-summary`",
    "2. `node .sharingan/probe.mjs source-scaffold` (this writes the measured starter; it is not optional on a fresh project)",
    "3. optional: `node .sharingan/probe.mjs outline` or `node .sharingan/probe.mjs render-map` only if the scaffold leaves one measured layout question ambiguous",
    "After `source-scaffold`, you must start from the generated scaffold. Do not hunt for hidden labels, pseudo-elements, footer minutiae, invisible states, hover states, or every possible DOM sibling. If a detail is not visible in the screenshot/scaffold/source-summary, do not invent it and do not spend more commands searching for it.",
    "Banned during the first build pass: ad-hoc `node -e`, python, jq, grep, Glob, or Read/List/Search over `.sharingan/`, `.sharingan/dom.json`, `.sharingan/render-map.json`, `styles.json`, or `assets.json`. The `source-summary` and `source-scaffold` commands already perform the bounded source analysis.",
    "",
    "The first code you keep must be the measured scaffold with `const SOURCE =` intact. Do not create `src/components/` during the first build pass, and do not replace `SOURCE.boxes`, `SOURCE.images`, `SOURCE.vectors`, or `SOURCE.texts` with a guessed semantic UI. Later component extraction is allowed only after source-fidelity QA passes and only if every SOURCE item still renders one-for-one.",
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
    "Then BUILD — that is the goal, not analyzing the capture. After `source-summary`, run `source-scaffold`, preserve the generated `SOURCE` scaffold, run the build, and stop. Do not make a generic component library; do not create hand-authored semantic sections in place of the measured scaffold. Do not loop re-inspecting `dom.json`, `render-map.json`, `styles.json`, `assets.json`, or directories under `.sharingan/`. Use the cached `/_assets/` images already present in `SOURCE`, and reproduce the real text content (no lorem/filler). Never add canvas particles, ambient lighting, hover overlays, simulated social stats, fake durations, or extra controls just because they make the clone feel richer.",
    "",
    "Repair discipline: later visual review may report source-vs-result measured deltas from `render-map.json` and screenshot diff evidence. Apply those as local patches to the named element/region; do not redesign or re-layout the whole page to chase a single measurement.",
  ].join("\n");
  return { promptBlock };
}
