# Moodboard Agent Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give project Agents a stable, per-run, read-on-demand Moodboard snapshot bundle instead of stuffing full board contents into the prompt.

**Architecture:** Each run resolves live `boardId` references at run start, writes immutable JSON snapshot files under `.runs/<runId>/moodboards/`, and passes only a short manifest path plus compact summary to the Agent. Historical runs remain reproducible while new runs reread the latest board state.

**Tech Stack:** Node 22, TypeScript strip-types runtime, node:test, existing Dezin Store, existing JSONL run logs, existing full project zip export/import.

## Global Constraints

- Preserve live reference semantics: each new run snapshots the current board by `boardId`.
- Preserve historical reproducibility: each run owns an immutable `.runs/<runId>/moodboards/` snapshot.
- Do not place bundles in project source directories or Standard git worktrees.
- Do not inline image/video binary data in prompts; store JSON metadata and copy local asset files into the run snapshot.
- Use TDD: write the failing test before production code.
- Keep UI unchanged for this slice.

---

### Task 1: Per-Run Moodboard Snapshot Bundle

**Files:**
- Modify: `apps/daemon/src/project-moodboard-context.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Test: `apps/daemon/test/runs.test.ts`

**Interfaces:**
- Produces: `buildProjectMoodboardContext(input: { store; dataDir; runId; refs; request }): ProjectMoodboardContext`
- Produces: `ProjectMoodboardContext` with `promptBlock`, `labels`, and `bundleRoot`
- Consumes: existing Store APIs `getMoodboard`, `listMoodboardNodes`, `listMoodboardAssets`, `listMoodboardMessages`

- [x] **Step 1: Write the failing test**

Add a daemon test that starts a run with `moodboardRefs`, then asserts:
- `.runs/<runId>/moodboards/manifest.json` exists
- `boards/<boardId>/nodes.json`, `assets.json`, `messages.json`, and `asset-files.json` contain the board snapshot
- the Agent message contains the `manifest.json` path
- the Agent message does not include raw long note content that should only live in the bundle

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dezin/daemon test -- runs.test.ts`
Expected: FAIL because no `manifest.json` bundle exists.

- [x] **Step 3: Write minimal implementation**

Change `buildProjectMoodboardContext` to accept `runId`, write the bundle under `join(dataDir, ".runs", runId, "moodboards")`, copy referenced asset files into the bundle, and return a prompt block pointing to the manifest path. The prompt block should include only compact summary text and read-on-demand instructions.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dezin/daemon test -- runs.test.ts`
Expected: PASS.

### Task 2: Full Export/Import Includes Run Bundle Directories

**Files:**
- Modify: `apps/daemon/src/export-handler.ts`
- Test: `apps/daemon/test/export.test.ts` or existing export/import test file containing full project tests

**Interfaces:**
- Consumes: run bundle files written under `.runs/<runId>/moodboards/`
- Produces: zip entries under `runs/<runId>/...`
- Produces: imported files restored under `.runs/<newRunId>/...`

- [x] **Step 1: Write the failing test**

Extend the full import/export v2 test to create a run bundle under `.runs/<runId>/moodboards/manifest.json`, export full zip, import it, and assert the imported run has `.runs/<newRunId>/moodboards/manifest.json`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dezin/daemon test -- export.test.ts runs.test.ts`
Expected: FAIL because only `runs/<runId>.jsonl` is currently migrated.

- [x] **Step 3: Write minimal implementation**

Change full export to walk `.runs/<runId>/` directories in addition to `.runs/<runId>.jsonl`. Change import to map `runs/<oldRunId>/...` entries to `.runs/<newRunId>/...`, while still rewriting JSONL ids for `runs/<oldRunId>.jsonl`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dezin/daemon test -- export.test.ts runs.test.ts`
Expected: PASS.

### Task 3: Verification and Commit

**Files:**
- Modify as changed by Tasks 1-2.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: committed branch with clean working tree.

- [x] **Step 1: Run focused tests**

Run:
`pnpm --filter @dezin/daemon test -- runs.test.ts`
`pnpm --filter @dezin/web test -- workspace.test.tsx`

- [x] **Step 2: Run project checks**

Run:
`pnpm typecheck`
`git diff --check`

- [x] **Step 3: Commit**

Run:
`git add docs/superpowers/plans/2026-07-02-moodboard-agent-bundle.md apps/daemon/src/project-moodboard-context.ts apps/daemon/src/run-handler.ts apps/daemon/src/export-handler.ts apps/daemon/test/*.test.ts`
`git commit -m "feat: let agents inspect moodboard snapshots"`

## Self-Review

- Spec coverage: live board references are resolved at run start; immutable run snapshots are written; prompt stays short; full export/import carries snapshots.
- Placeholder scan: no placeholder steps; every task has paths and verification commands.
- Type consistency: `ProjectMoodboardContext.bundleRoot` and `buildProjectMoodboardContext(...runId...)` are the only new daemon interfaces.
