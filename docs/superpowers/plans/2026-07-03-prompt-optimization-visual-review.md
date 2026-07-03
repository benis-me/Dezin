# Prompt Optimization and Visual Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Design-home prompt optimizer and make Agent visual review visible in both the conversation transcript and Quality panel.

**Architecture:** The daemon exposes a one-shot prompt optimization endpoint that uses the selected Agent/model but cannot edit files. The web client calls it from the Design homepage composer and renders optimization review state locally. Visual Review remains part of the run event stream and quality findings, with extra metadata for screenshot preview and reviewer summary.

**Tech Stack:** Node http daemon, React 19, TypeScript, Vitest/RTL, Node test runner, existing Agent provider one-shot APIs.

## Global Constraints

- Prompt optimizer button appears inside the Design homepage input box, bottom-right, only when text exists.
- Optimizing disables the input and uses the currently selected Agent/model.
- Optimized text replaces the visible prompt immediately; submit uses the optimized text even before accept.
- Reject restores the original prompt; accept keeps the optimized prompt; both return the button to optimize mode.
- Design homepage and Moodboard homepage textareas auto-size with max height and keep the current minimum height.
- Visual Review transcript entries show a small “Visual Review” title, separate collapsible process details from result text.
- Quality → Agent visual review shows a compact screenshot review summary when metadata is available.

---

### Task 1: Prompt Optimize API

**Files:**
- Create: `apps/daemon/src/prompt-optimize.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/test/fake-api.ts`
- Test: `apps/daemon/test/prompt-optimize.test.ts`
- Test: `apps/web/src/lib/api.test.ts`

**Interfaces:**
- Produces: `optimizePrompt(input: PromptOptimizeInput): Promise<string>`
- Produces: `POST /api/prompts/optimize`
- Produces: `ApiClient.optimizePrompt(input): Promise<{ prompt: string }>`

- [ ] Write failing daemon route tests for validation and injected optimizer behavior.
- [ ] Write failing API client test for request shape and response.
- [ ] Implement `prompt-optimize.ts` with prompt construction, one-shot spawn, and output cleanup.
- [ ] Add route and `AppDeps.promptOptimizer`.
- [ ] Add web API method and fake API default.
- [ ] Run focused daemon and web API tests.

### Task 2: Design and Moodboard Homepage Composer UX

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx`
- Modify: `apps/web/src/screens/MoodboardsScreen.tsx`
- Test: `apps/web/src/screens/screens.test.tsx`

**Interfaces:**
- Consumes: `ApiClient.optimizePrompt`
- Produces: Design composer optimize/reject/accept state
- Produces: auto-height textarea classes for Design and Moodboard homepage composers

- [ ] Write failing HomeScreen test for optimize button visibility, loading disabled state, optimized replacement, reject, accept, and Build using optimized text.
- [ ] Write failing MoodboardsScreen test for auto-height/max-height classes.
- [ ] Implement optimizer state and input overlay controls in `HomeScreen`.
- [ ] Update Design and Moodboard homepage textarea classes.
- [ ] Run focused screen tests.

### Task 3: Visual Review Run Events and Metadata

**Files:**
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/visual-qa.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/daemon/test/visual-qa.test.ts`

**Interfaces:**
- Produces: `visual-qa-start` SSE event
- Produces: optional `screenshotPath`, `screenshotUrl`, and `reviewSummary` on visual review findings

- [ ] Write failing run stream test that observes `visual-qa-start` before `visual-qa`.
- [ ] Write failing visual QA parse/metadata test for screenshot summary fields.
- [ ] Emit `visual-qa-start` from the run handler before audit.
- [ ] Add metadata to agent visual findings and screenshot failure findings.
- [ ] Run focused daemon tests.

### Task 4: Visual Review Transcript and Quality Summary

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Test: `apps/web/src/screens/workspace.test.tsx`

**Interfaces:**
- Consumes: `visual-qa-start` and extended `QualityFinding`
- Produces: `Msg.kind === "visual-review"` transcript row
- Produces: Quality lane screenshot review summary card

- [ ] Write failing WorkspaceScreen test for Visual Review titled transcript row with collapsible process details.
- [ ] Write failing WorkspaceScreen test for Agent visual review screenshot summary in Quality.
- [ ] Add message kind, normalization, grouping, and renderer.
- [ ] Render screenshot summary in Agent visual review lane.
- [ ] Run focused workspace tests.

### Task 5: Verification

**Files:**
- No new production files.

- [ ] Run `pnpm --filter @dezin/daemon test`.
- [ ] Run `pnpm --filter @dezin/web test -- screens.test.tsx workspace.test.tsx api.test.ts`.
- [ ] Run `pnpm typecheck`.
- [ ] Review git diff for unrelated churn.
