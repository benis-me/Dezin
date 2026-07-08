# Sharingan Render Map Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Sharingan from DOM-outline reconstruction toward render-first reproduction by capturing a browser render map and using measured source-vs-result fidelity findings to drive bounded Standard repair rounds.

**Architecture:** Add a deterministic render-map artifact to each captured page, surface it through the Sharingan context and probe CLI, and extend Visual QA so Sharingan clones compare the generated desktop render against the captured source render map. Repair prompts treat source-fidelity findings as local measured patches, not an invitation to redesign.

**Tech Stack:** TypeScript, Node test runner, Puppeteer, Vite/React Standard projects, existing Dezin QualityFinding loop.

## Global Constraints

- Keep changes scoped to Sharingan capture, probe/context, Visual QA, and repair prompt behavior.
- Keep Sharingan clones faithful to captured source artifacts; do not introduce source-code copying as the generation path.
- TDD: write failing tests before implementation.
- Use existing `QualityFinding` shape and Standard repair loop; avoid new persistence schema migrations.

---

### Task 1: Persist Source Render Map

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts`
- Modify: `apps/daemon/src/sharingan-capture.ts`
- Test: `apps/daemon/test/sharingan-capture.test.ts`
- Test: `apps/daemon/test/sharingan-ensure.test.ts`

**Interfaces:**
- Produces: `RenderMap`, `RenderMapElement`, `SharinganSession.readRenderMap(maxNodes?: number): Promise<RenderMap>`
- Produces: `CapturedPage.renderMap: string`

- [ ] Add failing tests asserting `captureCurrentPage` writes `render-map.json` with viewport, document, element boxes, and computed styles.
- [ ] Add failing tests asserting fake capture sessions include `readRenderMap`, so non-Chrome Sharingan tests catch the new contract.
- [ ] Implement `readRenderMap` in `SharinganSession` using browser `getBoundingClientRect()` and `getComputedStyle()`.
- [ ] Write `render-map.json` during `captureCurrentPage`, include it in `CapturedPage`, and persist it in `pages.json`.
- [ ] Run focused Sharingan capture/ensure tests.

### Task 2: Expose Render Map To Builder And Reviewer

**Files:**
- Modify: `apps/daemon/src/sharingan-context.ts`
- Modify: `apps/daemon/src/sharingan-probe-cli.ts`
- Modify: `apps/daemon/src/sharingan-capture.ts`
- Test: `apps/daemon/test/sharingan-context.test.ts`
- Test: `apps/daemon/test/sharingan-probe.test.ts`
- Test: `apps/daemon/test/sharingan-capture.test.ts`

**Interfaces:**
- Produces: `sharinganReviewReference(...).renderMapPath?: string`
- Produces: `node .sharingan/probe.mjs render-map [render-map.json]`

- [ ] Add failing tests asserting the Sharingan prompt tells agents to use `render-map.json` before freeform DOM interpretation.
- [ ] Add failing tests asserting `sharinganReviewReference` returns an absolute `renderMapPath`.
- [ ] Add or update probe CLI tests for `render-map`.
- [ ] Implement context wording and probe CLI support.
- [ ] Run focused context/probe/capture tests.

### Task 3: Generate Deterministic Source Fidelity Findings

**Files:**
- Modify: `apps/daemon/src/visual-qa.ts`
- Test: `apps/daemon/test/visual-qa.test.ts`

**Interfaces:**
- Produces: `sourceFidelityFindings(source, generated): QualityFinding[]`

- [ ] Add failing unit tests for missing source text, mismatched image-slot count, and large box deltas.
- [ ] Implement bounded render-map loading and comparison.
- [ ] Include source-fidelity findings in `auditVisualArtifact` only when a Sharingan reference has a render map.
- [ ] Run focused Visual QA tests.

### Task 4: Constrain Sharingan Repair Prompts

**Files:**
- Modify: `apps/daemon/src/run-handler.ts`
- Test: `apps/daemon/test/sharingan-run.test.ts` or a new focused run-handler prompt test if needed.

**Interfaces:**
- Consumes: `QualityFinding.id` prefix `visual-source-`

- [ ] Add failing test asserting repair prompt for `visual-source-*` findings says to make measured local patches and avoid full redesign.
- [ ] Implement the prompt guard in `standardRepairPrompt`.
- [ ] Run focused run-handler/Sharingan tests.

### Task 5: Verification

**Files:**
- Existing tests only.

- [ ] Run `pnpm --filter @dezin/daemon test -- sharingan-capture`.
- [ ] Run `pnpm --filter @dezin/daemon test -- sharingan-context`.
- [ ] Run `pnpm --filter @dezin/daemon test -- sharingan-probe`.
- [ ] Run `pnpm --filter @dezin/daemon test -- visual-qa`.
- [ ] Run broader daemon test subset if focused checks pass.
