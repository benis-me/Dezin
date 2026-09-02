# Moodboard Project Agent Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let design-project Agents reference Moodboards and receive budgeted board context plus usable asset paths during runs.

**Architecture:** The web app adds Moodboard references to the existing composer attachment flow and sends them as structured `RunInput.moodboardRefs`. The daemon resolves those refs at run start and appends an agent-only context block to the message passed to both Standard and Prototype generation paths, while keeping the stored user message compact.

**Tech Stack:** React, TypeScript, Vitest, Dezin daemon HTTP handlers, `@dezin/core` Store, existing Moodboard store tables.

## Global Constraints

- Use existing Dezin composer, DropdownMenu, chip, Button, IconButton, and compact UI conventions.
- Do not copy Moodboard assets into the project by default.
- Do not inject a full raw canvas dump; pass a budgeted context.
- Do not crash a run because a referenced Moodboard was deleted.
- Write failing tests before production code.

---

### Task 1: Web Composer Moodboard References

**Files:**
- Modify: `apps/web/src/components/AttachMenu.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Modify: `apps/web/src/test/fake-api.ts`
- Test: `apps/web/src/screens/workspace.test.tsx`

**Interfaces:**
- Consumes: `ApiClient.listMoodboards(): Promise<Moodboard[]>`
- Produces: `RunInput.moodboardRefs?: Array<{ id: string; name?: string }>`
- Produces: `AttachMenu` prop `onReferenceMoodboard?: (board: Moodboard) => void`

- [ ] **Step 1: Write the failing web test**

Add a test to `apps/web/src/screens/workspace.test.tsx` that renders an existing project, stubs `listMoodboards` with one active board, opens `Add files and context`, chooses `Reference a moodboard`, selects the board, sends a prompt, and asserts `streamRun` was called with:

```ts
expect.objectContaining({
  moodboardRefs: [{ id: "mood-1", name: "Warm references" }],
})
```

Also assert the chip text `Warm references` is visible before send and gone after send.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dezin/web test -- workspace.test.tsx`

Expected: FAIL because `AttachMenu` has no Moodboard submenu and `RunInput` has no `moodboardRefs`.

- [ ] **Step 3: Implement minimal web code**

Add the `moodboardRefs` type to `RunInput`. Extend `AttachMenu` to load active Moodboards when `onReferenceMoodboard` is present and render a `Reference a moodboard` submenu under `Designs`. Add `moodboardRefs` state to `WorkspaceScreen`, render removable chips above the textarea, include the refs in `api.streamRun`, and clear them after send.

- [ ] **Step 4: Run web test to verify it passes**

Run: `pnpm --filter @dezin/web test -- workspace.test.tsx`

Expected: PASS.

---

### Task 2: Daemon Moodboard Context Injection

**Files:**
- Create: `apps/daemon/src/project-moodboard-context.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Test: `apps/daemon/test/runs.test.ts` or `apps/daemon/test/http.test.ts`

**Interfaces:**
- Consumes: `RunBody.moodboardRefs?: Array<{ id?: unknown; name?: unknown }>`
- Produces: `buildProjectMoodboardContext(input): { promptBlock: string; labels: string[] }`

- [ ] **Step 1: Write the failing daemon test**

Create a run test that seeds a Moodboard with one note node and one image asset file, calls `/api/run` with `moodboardRefs: [{ id: board.id, name: board.name }]`, and asserts the fake runner received a message containing:

```text
Referenced Moodboards
Warm references
note
Asset files
```

Also assert the asset file path appears in the message.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dezin/daemon test -- runs.test.ts`

Expected: FAIL because run bodies ignore Moodboard refs.

- [ ] **Step 3: Implement context builder**

Create `project-moodboard-context.ts`. It should:

```ts
export interface ProjectMoodboardRef {
  id: string;
  name?: string;
}

export function normalizeProjectMoodboardRefs(value: unknown): ProjectMoodboardRef[] {
  // return at most 3 valid refs with non-empty ids
}
```

and a builder that reads `store.getMoodboard`, `store.listMoodboardNodes`, `store.listMoodboardAssets`, and `store.listMoodboardMessages`; ranks/budgets content; and formats local asset paths with the same `{asset.id}{extForMime(asset.mimeType)}` convention used by `moodboard-handler.ts`.

- [ ] **Step 4: Wire `handleRun`**

In `run-handler.ts`, normalize `body.moodboardRefs`, build `moodboardContext`, store the compact visible prompt, and pass an augmented `agentBrief` to `runTurnWithRetry`, `generateArtifact`, and visual conversation user content.

- [ ] **Step 5: Run daemon test to verify it passes**

Run: `pnpm --filter @dezin/daemon test -- runs.test.ts`

Expected: PASS.

---

### Task 3: Integration Verification

**Files:**
- Modify only if required by test failures.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @dezin/web test -- workspace.test.tsx
pnpm --filter @dezin/daemon test -- runs.test.ts http.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: `TYPECHECK: PASS`.

- [ ] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors and only files related to Moodboard project Agent references changed.
