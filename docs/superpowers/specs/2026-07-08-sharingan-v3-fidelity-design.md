# Sharingan v3 — 1:1 Fidelity Design

## Why

A real clone of `https://app.tapnow.ai/home` (project `ae4c29e5-…`) came out worse than the v1 hallucination, scored 0/100 but marked DONE. Forensics (systematic debugging) found v2 succeeded at login + capture (real logged-in content, 848 nodes, 57 assets, a monochrome dark palette) but three downstream failures compounded:

- **The capture is structurally lossy.** `dom.json` is a FLAT node list (no hierarchy); `styles.json` is a top-N token summary. The builder re-infers structure from boxes + a screenshot and re-designs → structure + style drift (used AI-default indigo/purple against a monochrome source).
- **The prompt tells the agent to re-design.** `buildSharinganContext` says *"a RECONSTRUCTION of structure and design language — NOT a byte-for-byte copy… brand assets as swappable placeholders."*
- **The anti-slop lint fights faithful cloning.** The objective gate that drives repair flagged `external-image` (placehold.co — the exact thing v2 told the agent to use), `ai-default-indigo`, `numbered-section-markers` (the source *has* them). The agent, obeying the lint's "use a local asset" fix, stripped the placeholder images → empty slots → on a dark theme, black voids → the Sharingan critic flagged them P0 → the loop couldn't clear the contradiction (images flagged if present, invisible if absent) → gave up at score 0.

**Decision (user):** the goal is **1:1 还原** of structure, styling, AND imagery — the most important thing. This deliberately overrides the original "reconstruction, never byte-rip, brand assets as placeholders" guardrail. The first-run authorized-use affirmation already records the user's consent to clone.

## Scope

Four workstreams on `feat/sharingan-v3`.

### A. Fidelity overhaul (1:1) — daemon

**A1. Nested-tree capture.** Add a NEW `SharinganSession.readDomTree(maxNodes = 1500): DomTreeNode[]` (`sharingan-browser.ts`) returning the DOM as a **tree** — `DomTreeNode` = the existing node fields (`tag, role, classes, text, box`) plus `children: DomTreeNode[]` and a fuller per-node computed-style subset: the existing 12 fields plus `width, height, border, borderColor, backgroundImage, gridTemplateColumns, gridTemplateRows, opacity, textAlign, lineHeight, letterSpacing`. `maxNodes` (1500) is a total-node budget across the whole tree. `captureCurrentPage` uses `readDomTree()` for `dom.json` (still minified). **The existing flat `readDom` is left unchanged** — the login-wall precheck (`textLength`), `looksLikeLoginWall`/`detectLoginWall`, and the probe `read-dom` endpoint keep using it, so there is no ripple to login detection. The builder mirrors the real skeleton instead of guessing from boxes.

**A2. Cache real images.** New `SharinganSession.downloadAssets(assets, outDir)`: for each image asset, fetch bytes via `page.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())))` — the authenticated `page` inherits login cookies, so auth-gated images (e.g. `files.tapnow.media/api/…`) download too. Write to `<projectDir>/public/_assets/<sha1(url).slice(0,12)>.<ext>` (dedup by hash; `ext` from content-type or URL). Skip video *files* (heavy) but keep `poster` images. `captureCurrentPage` calls it and rewrites each `assets.json` entry with a `local: "/_assets/<file>"` field (or `local: null` on failure). Best-effort — a failed download never fails the capture. Vite serves `public/` at web root, so the built app references `/_assets/<file>` directly.

**A3. Reproduce, not reinterpret.** Rewrite `buildSharinganContext.promptBlock`: replace the "RECONSTRUCTION … NOT a byte-for-byte copy … placeholders" framing with a faithful-reproduction directive — mirror the captured DOM tree (`dom.json` is now nested); match the source's spacing, typography, and **exact palette from `styles.json`** (do NOT substitute default AI colors); use the **cached real images** via each asset's `local` path in `assets.json` and fill EVERY image slot; treat the desktop screenshot as the visual source of truth. Keep the page-budget + probe-endpoint guidance.

**A4. Clone-aware lint.** Add `isSharingan?: boolean` to `LintOptions` (`packages/quality/src/types.ts`) and `VisualQaInput` (`visual-qa.ts`). For clone runs:
- `lintArtifact` skips the taste/anti-slop family: `checkIndigo`, `checkPurpleGradient`, `checkTrustGradient`, `checkExternalImages`, `checkRawHex`, and the numbered-marker / em-dash / design-token rules.
- `auditVisualArtifact`/`collectGeometry` skips `detectComputedFindings` entirely (all color/type/contrast/spacing/component-tell rules — including `low-contrast` and `tiny-text`, since faithfully reproducing an 11px or low-contrast source is 1:1, not a defect).
- **Kept** as the objective gate: the structural/render defects from `findingsFromGeometry` (`visual-blank-page`, `visual-horizontal-overflow`, `visual-below-fold-strip`, `visual-fixed-offscreen`, `visual-text-clipped`), broken-image/console/runtime errors, AND the Sharingan-aware visual critic (v2's `sharinganReference`), which becomes the primary quality signal and drives pixel-match repair.
- `run-handler.ts` threads `isSharingan: project.sharingan` into both `lintArtifact` call sites and `runVisualQa`.

### B. Files-viewer freeze — web

`CodeView` (`WorkspaceScreen.tsx:1248`) calls `highlightToReact(text)` (`highlight-lite.tsx:30`), which tokenizes the whole file synchronously into ~1 React node per token — a ~400KB JSON becomes hundreds of thousands of nodes and freezes the tab. Fix: in `CodeView`, when `text.length` exceeds a threshold (**100_000** chars), render the raw text in a plain `<pre><code>` with NO highlighting (and a small "large file — syntax highlighting off" hint). Small files are unchanged.

### C. Sharingan red entry theme — web

In `HomeScreen.tsx`, when `sharingan === true`:
- The heading text (`<h1 onDoubleClick={toggleSharingan}>`) reads **"Sharingan"** instead of "Start a design".
- The composer container gets a **red Sharingan/写轮眼 treatment**: a red ring/glow (`box-shadow`/`ring` in red) + a subtle animation — a slow-rotating tomoe/ring accent or a soft red pulse — gated behind `prefers-reduced-motion` (no motion when reduced). Reuse the existing animation approach in the codebase (CSS keyframes or the motion lib already in use); no new dependency.
- The description (`<p>` under the heading) changes to a clone-focused line, e.g. *"Paste a URL — Dezin clones its structure, styling, and imagery into an editable project."*
- Exit Sharingan mode by **double-clicking the "Sharingan" heading again** (`toggleSharingan` already toggles both directions).

### D. Hide the Mode tag — web

Remove the Sharingan-branch badges (`HomeScreen.tsx:859-870` — the "Standard" span + "Sharingan ✕" button). In Sharingan mode render NO mode UI there; the red theme + heading signal the mode, and the heading double-click is the exit. The non-Sharingan `FieldSelect` "Mode" is untouched.

## Locked decisions

- Fidelity method: **faithful capture + reproduce** (nested tree + fuller styles + reproduce prompt + critic pixel-match) — not raw-HTML transform.
- Source images: **cache real images locally** into `public/_assets/` (true 1:1; re-hosts brand assets — authorized).
- Clone lint: **all** taste + accessibility rules off (contrast + tiny-text included); keep only structural/render defects + the visual critic.
- Exit Sharingan: double-click the heading (no ✕ badge).

## Non-goals / guardrail shift

- **Guardrail change:** v1/v2 said "reconstruction, never byte-rip, brand assets as placeholders." v3 explicitly shifts to **faithful reproduction including cached real images**, per the user's authorized 1:1 goal. Auth is still user-driven (unchanged); the clone still runs only after the authorized-use affirmation.
- Not doing raw-HTML/CSS transform (chosen against). Not caching video files (posters only). Not touching the non-Sharingan build path (all changes gated on `project.sharingan` / `isSharingan`).
- No new dependencies.

## Testing

- **Nested tree:** Chrome-gated capture of a local fixture with nested elements → `dom.json` root nodes have `children` with the expected tags/text + fuller style fields; total nodes ≤ cap.
- **Image download:** Chrome-gated — fixture serving a couple of images → `downloadAssets` writes files into `public/_assets/`, `assets.json` entries gain a `local` path; a 404 asset → `local: null`, capture still succeeds.
- **Reproduce prompt:** `buildSharinganContext` promptBlock contains the faithful-reproduction wording + `/_assets/` + "match … palette"; no longer contains "NOT a byte-for-byte copy".
- **Clone lint:** `lintArtifact(html, { isSharingan: true })` returns none of `ai-default-indigo`/`external-image`/`raw-hex` for HTML that would trip them without the flag; `{ isSharingan: false }` still flags them. `detectComputedFindings` skipped when `isSharingan` (unit/DI).
- **Files viewer:** unit — `CodeView`/highlight path renders a >100KB string as plain text (no highlight nodes) and a small string highlighted as before (vitest).
- **HomeScreen (C/D):** vitest — double-click toggles the heading to "Sharingan" + applies the red-theme class + hides the mode badges; double-click again exits; `prefers-reduced-motion` disables the animation.
- All daemon tests per-file (full suite hangs on runs/variants); web tests vitest. Local fixtures / DI only — never a real external site.
