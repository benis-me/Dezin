# Design fidelity, Research, Sharingan, and version evidence remediation

**Goal:** Turn the current best-effort design/reproduction workflow into an evidence-backed quality gate without touching roadmap work.

**Architecture:** Add small, deep Modules at the existing seams: a Research bundle validator, a reusable full-page browser capture frame, strict visual-review parsing, and a history-preserving version restore operation. Keep `handleRun` as the orchestrator but stop it from inferring readiness from file existence or treating unassessed quality as success.

**Tech stack:** TypeScript, Node test runner, Vitest/Testing Library, Puppeteer, Git worktrees, pnpm.

## Task 1: Make Research a validated build input

**Files:**
- Modify: `packages/research/src/io.ts`
- Modify: `packages/research/src/convention.ts`
- Modify: `packages/research/src/index.ts`
- Modify: `apps/daemon/src/research-phase.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Test: `packages/research/test/io.test.ts`
- Test: `apps/daemon/test/research-phase.test.ts`
- Test: `apps/daemon/test/runs.test.ts`

1. Add RED tests for incomplete reports/sources/assets, fewer than two meaningful directions, unsafe or missing `directionSlug`, and explicit Research failure continuing into Build.
2. Add a validator that returns concrete issues for product, visual, and direction artifacts; validate local asset references and require 2–3 meaningful directions.
3. Make the real Research runner return bundle completeness and reasons after its retries.
4. Reject invalid chosen-direction slugs before checkpointing and never write an invalid `chosen` file.
5. Stop explicit/automatic Research runs before Build when the bundle is incomplete; keep the failure recoverable and visible.
6. Run focused package/daemon tests, then refactor names and error messages while green.

## Task 2: Capture the actual full Sharingan surface

**Files:**
- Add: `apps/daemon/src/full-page-capture.ts`
- Modify: `apps/daemon/src/sharingan-browser.ts`
- Modify: `apps/daemon/src/sharingan-capture.ts`
- Modify: `apps/daemon/src/visual-qa.ts`
- Test: `apps/daemon/test/sharingan-browser.test.ts`
- Test: `apps/daemon/test/sharingan-capture.test.ts`
- Test: `apps/daemon/test/visual-qa.test.ts`

1. Add a RED browser test for an app shell whose real content scrolls inside an `overflow:auto` region; assert the screenshot includes the tail and inline styles are restored.
2. Implement a reusable capture frame that temporarily expands dominant inner vertical scrollers, captures, and restores in `finally`.
3. Use the same capture frame for source screenshots and generated-artifact QA screenshots.
4. Select the review reference by manifest `sourceUrl`, not array position; reject paths that escape the project.
5. Add a RED equal-luminance/different-hue regression test and make screenshot diff measure per-channel visual change without cancellation.
6. Run focused browser/capture/visual-QA tests.

## Task 3: Make visual assessment and pass semantics honest

**Files:**
- Modify: `apps/daemon/src/visual-qa.ts`
- Modify: `apps/daemon/src/run-policy.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Test: `apps/daemon/test/visual-qa.test.ts`
- Test: `apps/daemon/test/run-handler-prompt.test.ts`
- Test: `apps/daemon/test/runs.test.ts`

1. Add RED tests showing malformed non-empty critic findings must not produce `visual-reviewed`, unresolved P1 must not pass, and explicit brief/direction drift is not scored as a clean 100.
2. Strictly validate critic JSON; retry malformed output and only mark a genuinely parsed clean/valid review.
3. Treat explicit brief/chosen-direction contradiction as a required P1 while preserving subjective taste as advisory P2.
4. Make unresolved P0/P1 and QA infrastructure failures fail the quality gate in both Standard and Prototype flows.
5. Keep publication recovery semantics intact, but expose unresolved/unassessed status honestly in Run metadata and UI copy.
6. Run focused policy/run tests.

## Task 4: Preserve history and identity when restoring versions

**Files:**
- Modify: `apps/daemon/src/variant-workspaces.ts`
- Modify: `apps/daemon/src/versions-handler.ts`
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Test: daemon version/variant tests
- Test: `apps/web/src/screens/workspace.test.tsx`

1. Add RED tests for dirty trees, tracked/untracked residue, cross-branch restore, branch HEAD preservation, and correct Standard preview reload.
2. Replace `git reset --hard` with an exact target-tree application followed by a new restore commit, preserving prior history.
3. Reject dirty restores before mutation and return the new commit identity.
4. Reload Standard through its dev-server lease; Prototype keeps the static preview path.
5. Derive/display Current from the restored head identity and make restore target/impact explicit.
6. Run daemon and web-focused tests.

## Task 5: Make version evidence immutable and viewers target-safe

**Files:**
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: version/static handlers as needed
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Modify: `apps/web/src/components/VersionCompare.tsx` as needed
- Test: daemon run/version tests
- Test: `apps/web/src/screens/workspace.test.tsx`

1. Add RED tests proving a historical run keeps its own screenshot after later runs and that historical runtime-error Fix cannot mutate the current branch.
2. Copy QA screenshots to run-scoped immutable storage and persist run-specific URLs/hashes.
3. Disable direct repair while viewing history; require restore/fork as the explicit new baseline.
4. Stop presenting transformed Vite HTML as the Standard historical file tree; use commit-scoped list/read or clearly disable that pane.
5. Align Compare/Diff labels with their actual targets and surface per-pane load failures.
6. Run focused viewer/version tests.

## Task 6: Verify the complete quality story

1. Run all changed package, daemon, and web tests.
2. Run root typecheck/lint/build checks in proportion to repository support.
3. Exercise a live inner-scroll capture and inspect the PNG dimensions/content.
4. Exercise Research failure, valid direction selection, invalid direction rejection, version restore, and historical preview against the real daemon/UI where feasible.
5. Review the final diff for roadmap changes, generated artifacts, credentials, and unrelated user files; none may be included.
