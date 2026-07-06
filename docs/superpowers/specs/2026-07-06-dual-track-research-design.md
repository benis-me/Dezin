# Dual-track Research (product + visual) with a moodboard canvas

Status: approved (brainstorm) — ready for an implementation plan
Date: 2026-07-06

## Problem

Dezin's Research phase is strong on **product** discovery (competitive / audience /
domain) but thin on **visual** direction, and it sometimes grounds the report in
wrong or non-authoritative data. We want Research to run **two tracks in parallel** —
the existing product track and a new **visual** track that collects real design
inspiration from professional design sites onto a **moodboard canvas** — and to feed
**both** tracks to the build agent as its knowledge base. We also want the product
track's sourcing to be more authoritative.

## Decisions (from brainstorming)

- **Visual collection = best-effort real + search fallback.** Hit the named sites
  (Dribbble/Behance/Awwwards/Mobbin/Pinterest) where reachable; where a site blocks
  bots, fall back to general web/image search for comparable **real** product UI.
  Download only what's accessible, attribute the source, and record what was reached
  vs. blocked. (Sites like Mobbin/Pinterest are largely login-walled.)
- **Two Research sub-tabs only: Product + Visual.** The Visual tab is the
  **interactive** moodboard (reuse the existing canvas editor). **No** separate
  read-only "Overview" tab (dropped in brainstorming) — so **no read-only canvas
  mode is needed**.
- **Source authority = prompt-hardening + soft signals.** Strong prompt discipline
  (prefer primary/authoritative, cite every claim, label unknowns as assumptions) +
  a per-source `authority` tag + a junk-domain blocklist dropped at parse time. No
  hard allowlist, no separate verification agent pass.

## Non-goals / YAGNI

- No read-only canvas mode, no "Overview" tab.
- No hard source allowlist, no second verification-agent pass.
- No new scraping infrastructure — the visual agent uses the same web tools + curl
  the product agent already uses; it downloads what it can and records the rest as
  cited links.
- Product track's `.research/` layout is **unchanged** (additive only), so nothing
  that reads it today breaks.

## Architecture

### `.research/` layout (additive)

```
.research/
├── brief.md, research.md, sources.json, assets/, directions/, chosen   # product (UNCHANGED)
└── visual/
    ├── visual.md            # curated visual report (palette/type/layout/motion + reached-vs-blocked note)
    ├── sources.json         # per-image provenance (url, platform, designer?, takeaways, assets, reached)
    └── assets/              # downloaded real screenshots (kebab-case, never hotlinked)
```

New path helpers in `packages/research/src/convention.ts`:
`visualDir`, `visualReportPath`, `visualSourcesPath`, `visualAssetsDir`.

### Parallel tracks (`apps/daemon/src/research-phase.ts`)

`runResearchPhase` fans out **two** `spawnResearch` calls with `Promise.all`:

- **Product** — `buildResearchPrompt` (hardened, see Source authority) → `.research/`.
- **Visual** — new `buildVisualResearchPrompt` → `.research/visual/`.

Both share the abort signal + timeout. `ResearchPhaseResult` gains a `visualProduced`
flag. Activities are tagged with a `track: "product" | "visual"` field so the two
lanes stream independently; `onActivity` and the SSE `research-activity` event carry
`track`. The overall phase still resolves once both settle (a failed visual track is
soft — the product report still proceeds).

The idempotency guard (`researchExists`) stays for the product track; a parallel
`visualResearchExists` guard skips the visual track when `.research/visual/visual.md`
already exists.

### Visual track prompt (`packages/research/src/prompts.ts`)

`buildVisualResearchPrompt({ brief, designSystemName, platforms })`:
- Search the named platforms where reachable; where blocked, fall back to
  web/image search for comparable **real** product UI (not marketing pages).
- Download accessible images to `visual/assets/` (never hotlink); verify each is
  genuine UI/design and DELETE stock/portraits/logos/decorative.
- Record `visual/sources.json`: `{ id, platform, url, designer?, takeaways[], assets[], reached: boolean }`.
- Write `visual/visual.md`: a curated read on palette / type / layout / motion /
  texture direction, ending with a short "reached vs. blocked" note so the build
  agent knows coverage.

### Moodboard population (`apps/daemon/src/visual-research-moodboard.ts` — new)

After the visual track, a **direct synthesizer** (not the moodboard agent — it can't
add found images today) creates/updates a per-project **"Visual research"** moodboard:
- Copy each `visual/assets/*` into the moodboard's asset store (`store.addMoodboardAsset`),
  create an `image` node per asset laid out in a tidy grid (labeled `section` nodes
  group by platform/theme), each node's `data` carrying `{ sourceUrl, designer, platform }`.
- Idempotent per project (one "Visual research" board; re-runs replace its nodes).
- Reuses the existing store tables (`moodboards`, `moodboard_nodes`, `moodboard_assets`)
  and on-disk asset paths; no schema change.

### Knowledge base — both tracks feed the build (`packages/research/src/io.ts`)

`buildResearchContext` is extended to prepend, in order:
1. product `research.md` + product `assets/` paths (as today),
2. visual `visual.md` + visual `assets/` paths (the agent reads the real screenshots
   as source material — same mechanism the product assets use),
3. the chosen direction (as today).

`summarizeResearch` gains `visual: { produced, assets, sources }` so the transcript
card + Research UI can show the visual track's counts.

### Research UI (`apps/web/src/screens/ResearchViews.tsx`, `WorkspaceScreen.tsx`)

- `ResearchPanel` gets an internal sub-tab bar: **Product · Visual**.
  - **Product** — the current panel (report, sources, directions).
  - **Visual** — the **interactive** "Visual research" moodboard (reuse
    `MoodboardCanvas`) + the visual `sources.json` list (platform + designer +
    reached/blocked). The user can rearrange/curate.
- `research-handler.ts` (`GET /api/projects/:id/research`) returns the visual section
  (report, sources, the visual moodboard id) alongside the product `ResearchDetail`.
- The live `ResearchCard` (transcript) splits activities into two lanes by `track`,
  and its done-summary shows both product and visual counts.

### Source authority (`packages/research/src/sources.ts` + product prompt)

- `ResearchSource` gains `authority?: "primary" | "secondary" | "unknown"`.
- `normalizeSource` drops sources whose host is on a small **junk-domain blocklist**
  (SEO farms / content mills / known AI-listicle hosts), defaulting `authority` to
  `"unknown"` when absent.
- Product prompt hardening: prefer PRIMARY/authoritative sources (official docs, the
  product itself, reputable publications, first-party data); distrust SEO farms /
  AI-listicles / unsourced stats; **every report claim cites a `sources.json` id**;
  label the genuinely-unknown as an **assumption** (strengthen `NEVER_INVENT`).

## Component boundaries (each testable in isolation)

| Unit | File | Pure? | Test |
|------|------|-------|------|
| visual paths | `convention.ts` | yes | node:test |
| visual prompt | `prompts.ts` `buildVisualResearchPrompt` | yes | node:test (asserts platforms, download+attribute+verify, reached/blocked) |
| visual io | `io.ts` read/list/`buildResearchContext` | yes | node:test |
| source authority | `sources.ts` normalize+blocklist+authority | yes | node:test |
| parallel spawn | `research-phase.ts` | glue | daemon test w/ fake spawns + `track` tagging |
| moodboard synth | `visual-research-moodboard.ts` | mostly pure over store | node:test w/ `:memory:` store |
| research-handler visual | `research-handler.ts` | glue | daemon HTTP test |
| Research sub-tabs | `ResearchViews.tsx` | component | vitest (Product/Visual tabs, moodboard mounts, sources list) |
| SSE track lanes | run-handler + ResearchCard | glue | daemon SSE test + vitest (two lanes) |

## Implementation slices (order)

1. **Convention + io + sources (pure, TDD).** `.research/visual/` paths; `authority`
   field + junk blocklist in `normalizeSource`; `buildResearchContext` includes the
   visual report/assets; `readVisualReport`/`listVisualAssets`/visual sources.
2. **Prompts (pure, TDD).** `buildVisualResearchPrompt`; harden `buildResearchPrompt`
   (authority + citation + assumption discipline).
3. **Parallel spawn (daemon).** `runResearchPhase` fans out product + visual; `track`
   tagging through `onActivity` + SSE; `visualProduced`/`summarizeResearch.visual`.
4. **Moodboard synthesizer (daemon, TDD w/ `:memory:` store).** Build/refresh the
   "Visual research" board from `visual/assets` + `visual/sources.json`.
5. **Research-handler + wiring (daemon).** Serve the visual section; ensure both
   tracks reach the build brief.
6. **Web UI (vitest).** Research sub-tabs (Product · Visual); Visual = moodboard +
   visual sources; ResearchCard two-lane live activities.

Each slice: red→green→refactor, `bash scripts/test-all.sh` + `cd apps/web && npm test`
+ `bash scripts/typecheck.sh` green, one commit, version bump (per project convention).
Verify the visual track + moodboard against a **real** research run before shipping
(headless can't fully exercise it — spot-check in `npm run dev`).

## Risks

- **Site blocking / licensing.** Best-effort + fallback is the mitigation; the track
  records reached-vs-blocked so a sparse moodboard is explained, not silent. Downloaded
  imagery is reference-only (local, attributed).
- **Cost.** Two parallel agent tracks ≈ 2× research tokens. Research is opt-in; visual
  can be independently gated by a setting if needed (future).
- **Moodboard collisions.** One dedicated "Visual research" board per project, refreshed
  in place, so re-runs don't pile up boards.
