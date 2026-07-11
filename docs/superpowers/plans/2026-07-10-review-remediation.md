# Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every non-deferred finding from the 2026-07-10 review while preserving Dezin's local-first workflows and proving each behavior with automated tests.

**Architecture:** Add narrow ownership boundaries instead of extending the existing large handlers: scoped extension principals, an Electron daemon supervisor, an exactly-once `RunExecution`, a Standard Run transaction, a daemon `RuntimeSupervisor`, preview leases, bounded journals, and explicit UI resource/capability state. Perform behavior fixes first and mechanical file extraction afterward so refactoring cannot hide behavioral regressions.

**Tech Stack:** Node.js 22.13+, TypeScript, `node:test`, SQLite, React 19, Vitest, Vite, Chrome MV3, Electron 43.1.0, pnpm 11.9.

## Global Constraints

- Do not change local credential persistence, daemon discovery-file permissions, global daemon-token authority, arbitrary agent-command configuration, or child-process environment filtering; the user deferred that finding.
- Do not change symbolic-link handling for imports or static serving; the user deferred that finding.
- Every production behavior change starts with a focused failing test, and the implementer must record the expected RED failure and GREEN command output.
- Do not combine behavior changes with mechanical file moves in one commit.
- Preserve Electron, browser development, Standard, Prototype, Moodboard, Visual Research, and Sharingan workflows.
- Electron must be pinned to `^43.1.0` or a later stable 43.x patch that passes the audit gate.
- Extension pair codes expire after five minutes and are single-use; extension credentials may call only `POST /api/capture` and `POST /api/analyze-image`.
- Run terminal transitions are idempotent and limited to `pending|running -> succeeded|failed|cancelled`.
- Standard Runs never reset, clean, add, or commit the user's active checkout.
- Preview retention is at most four idle processes with a 60-second idle TTL.
- In-memory Run journals retain at most 2,000 events or 2 MiB; agent stderr retains at most 1 MiB; structured stdout hard-fails above 32 MiB.
- Export limits are 10,000 files, 64 MiB per file, and 512 MiB total uncompressed data.
- At 390 CSS pixels the application must have no document-level horizontal overflow.
- Root tests must include Node packages, daemon, desktop, extension, Leafer, and Web suites and must terminate with no owned Vite/npm process.
- No task is complete until its task reviewer reports both specification compliance and code quality approval.

## File Structure

- `apps/daemon/src/extension-auth.ts`: pairing codes, scoped principals, and extension credential authorization.
- `apps/desktop/daemon-supervisor.js`: single-child lifecycle, readiness, restart, and shutdown.
- `apps/daemon/src/run-execution.ts`: exactly-once Run terminalization and cleanup.
- `apps/daemon/src/standard-run-transaction.ts`: isolated Standard Run worktree and guarded promotion.
- `apps/daemon/src/runtime-supervisor.ts`: project/variant/Run ownership and scoped cleanup.
- `apps/daemon/src/preview-lease.ts`: ready-only preview acquisition, TTL/LRU, and process-group teardown.
- `apps/daemon/src/bounded-buffer.ts`: byte-aware event/text buffers used by daemon subsystems.
- `packages/agent/src/bounded-text-buffer.ts`: bounded agent output capture.
- `apps/web/src/lib/async-resource.ts`: retained-data resource state and mutation version helpers.
- `apps/web/src/lib/keyboard.ts`: IME and shortcut-reservation helpers.
- `apps/web/src/hooks/useMediaQuery.ts`: responsive layout state.
- `apps/web/src/screens/workspace-transcript.tsx`, `workspace-versions.ts`, `workspace-markup.ts`: mechanically extracted Workspace domains.
- `apps/daemon/src/run-policy.ts`, `sharingan-region-runner.ts`: mechanically extracted Run domains.
- `packages/core/src/store-schema.ts`, `store-codecs.ts`: mechanically extracted schema/migrations and row mappings.
- `scripts/check-bundle-size.mjs`: manifest and gzip budget enforcement.
- `.github/workflows/ci.yml`: reproducible typecheck, test, build, audit, coverage, budget, and leak gates.

---

### Task 1: Chrome Extension Pairing and Scoped Authorization

**Files:**
- Create: `apps/daemon/src/extension-auth.ts`
- Modify: `apps/daemon/src/security.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `packages/core/src/store.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/screens/SettingsScreen.tsx`
- Create: `apps/extension/dezin-client.js`
- Modify: `apps/extension/background.js`
- Modify: `apps/extension/popup.js`
- Modify: `apps/extension/popup.html`
- Modify: `apps/extension/manifest.json`
- Test: `apps/daemon/test/http.test.ts`
- Test: `packages/core/test/store.test.ts`
- Test: `apps/web/src/screens/screens.test.tsx`
- Create: `apps/extension/test/dezin-client.test.ts`

**Interfaces:**
- Produces: `ExtensionPairingService.createCode()`, `exchange(code, extensionId)`, `authorize(token, scope, extensionId)`, `revoke(tokenId)`.
- Produces: `Store.createExtensionCredential`, `listExtensionCredentials`, `touchExtensionCredential`, and `revokeExtensionCredential`; only token hashes cross this boundary.
- Produces extension scopes `capture:write` and `image:analyze`.

- [ ] **Step 1: Write failing authorization and persistence tests**

Add a table-driven daemon test with these rows:

```ts
const cases = [
  ["capture:write", "POST", "/api/capture", 200],
  ["capture:write", "POST", "/api/analyze-image", 403],
  ["image:analyze", "POST", "/api/analyze-image", 200],
  ["image:analyze", "POST", "/api/capture", 403],
  ["capture:write", "GET", "/api/settings", 403],
] as const;
```

Cover code expiry, single-use races, extension-origin binding, revocation, wrong scope, malformed credentials, and continued full access for the daemon token. In Store tests, assert only the SHA-256 token hash is persisted and migration works on an existing database.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @dezin/daemon test && pnpm --filter @dezin/core test`

Expected: FAIL because pairing routes, credential persistence, and scoped principals do not exist.

- [ ] **Step 3: Implement the daemon and Store boundary**

Use these public shapes:

```ts
export type ExtensionScope = "capture:write" | "image:analyze";
export type RequestPrincipal =
  | { kind: "daemon" }
  | { kind: "extension"; credentialId: string; extensionId: string; scopes: ExtensionScope[] };

export interface ExtensionPairingService {
  createCode(): { code: string; expiresAt: number };
  exchange(code: string, extensionId: string): { token: string; credential: ExtensionCredential };
  authorize(token: string, required: ExtensionScope, extensionId: string): RequestPrincipal;
  revoke(id: string): boolean;
}
```

Add authenticated create/list/revoke routes and the local-host, `chrome-extension:` pair exchange route. Compare token hashes with `timingSafeEqual`; consume the code before returning a credential.

- [ ] **Step 4: Add the Settings and extension flow with failing UI/client tests**

Tests must prove the popup stores credentials in `chrome.storage.local`, attaches `Authorization: Bearer`, clears a rejected credential on `401`, and never stores a token in sync storage. Settings tests must prove code generation, expiration display, revocation, and retryable errors.

- [ ] **Step 5: Implement the extension client and Settings controls**

`dezin-client.js` exposes `pair`, `capture`, `analyze`, and `forget`; URL remains in sync storage while credentials remain local. Update MV3 background to module mode and make popup state explicit: unpaired, pairing, paired, error.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
pnpm --filter @dezin/core test
pnpm --filter @dezin/daemon test
pnpm --filter @dezin/web test
node --experimental-strip-types --no-warnings --test 'apps/extension/test/*.test.ts'
pnpm typecheck
```

Commit: `feat: pair extension with scoped daemon access`

---

### Task 2: Electron Single-Daemon Lifecycle and Security Upgrade

**Files:**
- Create: `apps/desktop/daemon-supervisor.js`
- Modify: `apps/desktop/main.js`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/test/daemon-supervisor.test.ts`
- Modify: `apps/desktop/test/navigation-policy.test.ts`

**Interfaces:**
- Produces: `createDaemonSupervisor({ spawnDaemon, readPortFile, now, schedule, killProcessGroup })`.
- Consumes: one supervisor instance for the Electron application lifetime.

- [ ] **Step 1: Write failing supervisor tests**

Tests assert concurrent `ensureStarted()` calls spawn once, a stale portfile with a different PID is ignored, window recreation reuses the child, unexpected exit schedules one bounded restart, `stop()` cancels restart and kills the process group, and load retry stops after one retry.

- [ ] **Step 2: Verify RED**

Run: `node --experimental-strip-types --no-warnings --test 'apps/desktop/test/*.test.ts'`

Expected: FAIL because `daemon-supervisor.js` does not exist.

- [ ] **Step 3: Implement and integrate the supervisor**

Use an idempotent API:

```js
const supervisor = createDaemonSupervisor(options);
await supervisor.ensureStarted();
await supervisor.stop();
supervisor.state(); // "idle" | "starting" | "ready" | "backoff" | "stopping"
```

Move spawn/readiness/restart out of `createWindow()`. Set `sandbox: true`, preserve `contextIsolation: true`, and keep preload IPC limited to existing allowlisted handlers. On app quit, set the stopping state before killing the child.

- [ ] **Step 4: Upgrade Electron and verify the audit delta**

Run: `pnpm --filter dezin-desktop add -D electron@^43.1.0`

Then run: `pnpm audit --prod --audit-level high`

Expected: no high-severity Electron advisory remains.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
node --experimental-strip-types --no-warnings --test 'apps/desktop/test/*.test.ts'
pnpm --filter @dezin/web build
pnpm audit --prod --audit-level high
```

Commit: `fix: supervise one desktop daemon process`

---

### Task 3: Exactly-Once Run Lifecycle

**Files:**
- Create: `apps/daemon/src/run-execution.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/run-manager.ts`
- Modify: `packages/core/src/store.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/daemon/test/run-manager.test.ts`
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Produces: `Store.terminalizeRun(id, status, patch): { changed: boolean; run: Run }`.
- Produces: `RunExecution.settle(status, patch)` and `RunExecution.dispose()`.

- [ ] **Step 1: Add the lifecycle RED matrix**

Cover a registry throw before `createRun`, a research throw after `createRun`, broker creation/subscription failure, cancellation racing success, direction/question early return, and a retry immediately after every failure. Assert one terminal DB transition, one terminal event, a closed stream, and a released start key.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @dezin/daemon test`

Expected: FAIL with a Run remaining `running` or a second request receiving `409`.

- [ ] **Step 3: Implement conditional Store terminalization**

The SQL update must contain:

```sql
WHERE id = ? AND status IN ('pending', 'running')
```

Return `changed: false` for an already terminal Run and never replace its first terminal status.

- [ ] **Step 4: Wrap every fallible post-record operation**

Instantiate one `RunExecution` immediately after the durable row is created. Move research, broker/SSE registration, Sharingan preparation, Standard setup, agent execution, quality review, and persistence under one outer `try/catch/finally`. Delete `startingRuns` in the outermost `finally`, including errors before row creation.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
pnpm --filter @dezin/core test
pnpm --filter @dezin/daemon test
pnpm typecheck
```

Commit: `fix: terminalize every accepted run exactly once`

---

### Task 4: Runtime Ownership, Deletion, and Shutdown

**Files:**
- Create: `apps/daemon/src/runtime-supervisor.ts`
- Modify: `apps/daemon/src/run-manager.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/variants-handler.ts`
- Modify: `apps/daemon/src/start.ts`
- Modify: `apps/daemon/src/project-runtime.ts`
- Modify: `apps/daemon/src/sharingan-handler.ts`
- Test: `apps/daemon/test/http.test.ts`
- Test: `apps/daemon/test/variants.test.ts`
- Test: `apps/daemon/test/sharingan-shutdown.test.ts`
- Create: `apps/daemon/test/runtime-supervisor.test.ts`

**Interfaces:**
- Produces: `registerRun`, `cancelRuns(scope)`, `waitForRuns(scope)`, `releaseProject`, `releaseVariant`, `cancelAll`, and `shutdown`.

- [ ] **Step 1: Write failing ownership and cleanup tests**

Use a blocked real runner. Delete its project and assert abort is observed before `204`, no subsequent write occurs, and `.runs`, `worktrees`, `version-worktrees`, project files, sessions, and runtime entries are absent. Repeat for a targeted variant. Test shutdown waits for active Runs and children before closing Store.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @dezin/daemon test`

Expected: FAIL because deletion and shutdown currently leave owned resources.

- [ ] **Step 3: Implement explicit ownership**

Use scope metadata:

```ts
type RuntimeScope = { projectId: string; variantId?: string; runId?: string };
type RegisteredRun = RuntimeScope & { controller: AbortController; settled: Promise<void> };
```

Deletion order is reject new work, abort, await settlement, stop scoped resources, remove daemon-owned paths/logs, then delete database rows. Shutdown performs `cancelAll()` and bounded waiting before closing the server and Store.

- [ ] **Step 4: Verify test teardown owns all dev resources**

Update daemon test harnesses to construct and close a `RuntimeSupervisor`; do not add a test-only global kill that production does not call.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm --filter @dezin/daemon test`

Commit: `fix: clean daemon resources by runtime scope`

---

### Task 5: Transactional Standard Run Worktrees

**Files:**
- Create: `apps/daemon/src/standard-run-transaction.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/project-runtime.ts`
- Modify: `apps/daemon/src/variant-workspaces.ts`
- Test: `apps/daemon/test/project-runtime.test.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/daemon/test/variants.test.ts`

**Interfaces:**
- Produces: `beginStandardRunTransaction(deps, input): StandardRunTransaction`.

```ts
interface StandardRunTransaction {
  readonly dir: string;
  readonly sourceHead: string;
  commit(message: string): Promise<string>;
  restoreBest(commit: string): Promise<void>;
  publish(): Promise<string>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}
```

- [ ] **Step 1: Replace destructive-behavior tests with transaction RED tests**

Fixtures include tracked edits and untracked files. Assert dirty start returns `409` without byte or HEAD changes; runner throw and abort preserve the source; success promotes only agent changes; a concurrent user edit causes a safe conflict and preserves a recovery branch; disposal removes the temporary worktree.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @dezin/daemon test`

Expected: FAIL because the active project root is currently used and cleaned.

- [ ] **Step 3: Implement the isolated transaction**

Create `dezin/run/<runId>` from the selected variant SHA. Run agent, preview, lint, screenshots, restore, and commits only in `transaction.dir`. Publish only when the expected variant SHA still matches; use an explicit ref update or fast-forward and never `git add -A`, `reset --hard`, or `clean -fd` in the active checkout.

- [ ] **Step 4: Remove destructive failure cleanup and verify GREEN**

Run:

```bash
pnpm --filter @dezin/daemon test
pnpm typecheck
```

Commit: `fix: isolate standard runs in transactional worktrees`

---

### Task 6: Preview Lease Manager and Ready-Only URLs

**Files:**
- Create: `apps/daemon/src/preview-lease.ts`
- Modify: `apps/daemon/src/project-runtime.ts`
- Modify: `apps/daemon/src/versions-handler.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/runtime-supervisor.ts`
- Test: `apps/daemon/test/project-runtime.test.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/daemon/test/variants.test.ts`

**Interfaces:**
- Produces: `acquire`, `renew`, `release`, `stopScope`, `stopAll`, and `activeCount`.

```ts
interface PreviewLease {
  leaseId: string;
  url: string;
  expiresAt: number;
  release(): Promise<void>;
}
```

- [ ] **Step 1: Write failing lease tests**

Cover a process that never listens, early exit, concurrent acquire single-flight, explicit release, 60-second TTL, LRU eviction after four idle processes, version-worktree removal, process-group SIGTERM/SIGKILL, and `stopAll()` leaving `activeCount === 0`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @dezin/daemon test`

Expected: FAIL because readiness timeout currently returns an unready URL and leases do not exist.

- [ ] **Step 3: Implement leases and update consumers**

Resolve `acquire()` only after an HTTP readiness probe succeeds. On timeout or exit, reject and kill the process group. Version-preview responses include a lease id, and every QA/cover temporary consumer uses `try/finally` release.

- [ ] **Step 4: Prove the root hang reproduction is gone**

Run daemon tests and inspect for children:

```bash
pnpm --filter @dezin/daemon test
pgrep -fal 'npm run dev -- --port|vite.*--port' | grep '/all-review-fixes/' && exit 1 || true
```

- [ ] **Step 5: Commit**

Commit: `fix: lease and reap preview processes`

---

### Task 7: Bounded Journals, Agent Output, and Export Work

**Files:**
- Create: `apps/daemon/src/bounded-buffer.ts`
- Modify: `apps/daemon/src/run-manager.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/export-handler.ts`
- Modify: `apps/daemon/src/zip.ts`
- Create: `packages/agent/src/bounded-text-buffer.ts`
- Modify: `packages/agent/src/claude-runner.ts`
- Modify: `packages/agent/src/providers/cli.ts`
- Test: `apps/daemon/test/run-manager.test.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/daemon/test/export.test.ts`
- Test: `packages/agent/test/claude-runner.test.ts`
- Test: `packages/agent/test/providers-cli.test.ts`

**Interfaces:**
- Produces bounded event/text buffers with byte counts and one stable truncation marker.
- Produces an `ExportBudget` shared by source, refs, variants, versions, Run logs, and Git bundle.

- [ ] **Step 1: Add failing limit tests**

Generate 10,000 Run events, oversized stderr/stdout, a 64 MiB-plus file, more than 10,000 export entries, a combined 512 MiB-plus export, and an aborted request. Assert bounded memory/file size, preserved terminal event/sequence, killed overflowing agent process, `413` before headers, and no temporary export artifact.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @dezin/agent test
pnpm --filter @dezin/daemon test
```

Expected: FAIL because all affected buffers and export aggregation are unbounded.

- [ ] **Step 3: Implement byte-aware buffers and incremental research persistence**

The Run ring enforces 2,000 events and 2 MiB. Stderr uses a 1 MiB tail. Structured stdout terminates at 32 MiB with `AGENT_OUTPUT_LIMIT`. Research activity clamps text, batches at 250 ms, appends JSONL, and force-flushes before terminal events.

- [ ] **Step 4: Implement shared export budgets and cancellation**

Stat and budget entries before writing headers. Check the request abort signal between reads and while creating Git bundles; kill the subprocess group and delete temporary files on abort. Replace aggregate `Buffer.concat` ZIP creation with an async streaming ZIP writer so source data, compressed entries, and the final archive are never all resident at once.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
pnpm --filter @dezin/agent test
pnpm --filter @dezin/daemon test
pnpm typecheck
```

Commit: `fix: bound run output and export resources`

---

### Task 8: Sharingan Cancellation, Isolation, and Determinism

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts`
- Modify: `apps/daemon/src/sharingan-browser.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/test/fake-api.ts`
- Modify: `apps/web/src/components/SharinganTab.tsx`
- Test: `apps/daemon/test/sharingan-ensure.test.ts`
- Test: `apps/daemon/test/sharingan-handler.test.ts`
- Test: `apps/daemon/test/sharingan-shutdown.test.ts`
- Test: `apps/daemon/test/runs.test.ts`
- Test: `apps/web/src/components/SharinganTab.test.tsx`

**Interfaces:**
- Produces: `ensureCaptured(id, dataDir, options: { signal?: AbortSignal; maxWaitMs?: number })`.
- Produces: `releaseSharinganProject(id)` and `POST /api/sharingan/:id/cancel`.

- [ ] **Step 1: Add failing backend cancellation/isolation tests**

Abort during polling and assert completion within one poll interval, not 300 seconds. Assert different projects receive different profile directories, release clears status/session/steps, large step streams stay bounded, and reversed subagent completion still produces source-plan region order.

- [ ] **Step 2: Verify backend RED**

Run: `pnpm --filter @dezin/daemon test`

Expected: FAIL because `ensureCaptured` ignores Run cancellation and state is shared/unbounded.

- [ ] **Step 3: Implement abort propagation and project release**

Use project profile paths, an abortable wait, a bounded step ring, and one release function called by cancel, project deletion, and shutdown. Pass the Run controller signal into `ensureCaptured`. Fix flaky tests to key calls by region id instead of completion index.

- [ ] **Step 4: Add failing Sharingan UI tests and implement explicit states**

Tests assert `status.error` and non-abort SSE failures render `role="alert"`, Cancel waits for daemon ACK/status, cancelled and failed states are distinct, and Retry is available. Implement `cancelSharingan` in the real/fake API clients and never swallow a non-abort error.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
pnpm --filter @dezin/daemon test
pnpm --filter @dezin/web test
pnpm typecheck
```

Commit: `fix: cancel and isolate sharingan sessions`

---

### Task 9: UI Async State and Data Truth

**Files:**
- Create: `apps/web/src/lib/async-resource.ts`
- Modify: `apps/web/src/moodboard/useMoodboardBoard.ts`
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Modify: `apps/web/src/screens/SettingsScreen.tsx`
- Modify: `apps/web/src/screens/HomeScreen.tsx`
- Modify: `apps/web/src/screens/MoodboardsScreen.tsx`
- Modify: `apps/daemon/src/moodboard-handler.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/moodboard/useMoodboardBoard.test.tsx`
- Test: `apps/web/src/screens/workspace.test.tsx`
- Test: `apps/web/src/screens/screens.test.tsx`
- Create: `apps/daemon/test/moodboard-start.test.ts`

**Interfaces:**
- Produces resource states `idle | loading | refreshing | ready | error` with retained data.
- Produces `flushPendingNodes({ applyResult, notify })`.
- Produces atomic `POST /api/moodboards/start` with compensating cleanup.

- [ ] **Step 1: Add failing Moodboard persistence tests**

With fake timers, mutate nodes and unmount before 350 ms; assert one save with the latest nodes and original board id. Switch board ids before flush and assert each pending save targets its own board. Assert atomic Moodboard start removes the database row/files on upload, node-save, message, or generation failure while preserving UI prompt/inputs for retry.

- [ ] **Step 2: Add failing Stop, Settings, Home, and refresh tests**

Assert cancel rejection keeps SSE alive and does not show Stopped; ACK shows Stopping until `run-cancelled`. Assert Settings write failure rolls back only that mutation's keys and out-of-order responses cannot overwrite newer edits. Assert first Home load failure displays an alert/Retry, background failure retains cards, pure refs enable Design, Moodboard refresh retains rows, and preview/run events do not force the active Workspace tab.

- [ ] **Step 3: Verify RED**

Run:

```bash
pnpm --filter @dezin/web test
pnpm --filter @dezin/daemon test
```

Expected: FAIL in each newly described state transition.

- [ ] **Step 4: Implement shared resource and mutation semantics**

Use a per-key mutation version and before snapshot:

```ts
type ResourceState<T> =
  | { status: "idle" | "loading"; data: null; error: null }
  | { status: "refreshing" | "ready"; data: T; error: null }
  | { status: "error"; data: T | null; error: Error };
```

Flush pending Moodboard saves on unmount/navigation/send without setting state after unmount. Do not abort Run SSE until cancel is acknowledged and terminalized. Keep last-good list data during refresh. Remove unsolicited `setTab("Preview")` calls.

- [ ] **Step 5: Implement atomic Moodboard start and retry preservation**

The daemon executes create/assets/nodes/message/generation as a saga and deletes owned records/files on any exception. The Web clears prompt/images only after the complete response succeeds.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
pnpm --filter @dezin/daemon test
pnpm --filter @dezin/web test
pnpm typecheck
```

Commit: `fix: keep ui resource state truthful`

---

### Task 10: UI Capabilities, Keyboard, Responsive Routing, and Lazy Screens

**Files:**
- Create: `apps/web/src/lib/keyboard.ts`
- Create: `apps/web/src/hooks/useMediaQuery.ts`
- Modify: `apps/web/src/components/ui/segmented.tsx`
- Modify: `apps/web/src/components/Shell.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/screens/ResearchViews.tsx`
- Modify: `apps/web/src/screens/HomeScreen.tsx`
- Modify: `apps/web/src/screens/MoodboardsScreen.tsx`
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Modify: `apps/web/src/moodboard/MoodboardAgentPanel.tsx`
- Modify: `apps/web/src/moodboard/canvas-utils.ts`
- Modify: `apps/web/src/moodboard/useMoodboardCanvasController.ts`
- Modify: `apps/web/src/moodboard/MoodboardCanvas.tsx`
- Modify: `apps/web/src/screens/VisualResearchBoard.tsx`
- Test: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/App.lazy.test.tsx`
- Test: `apps/web/src/components/ui/ui.test.tsx`
- Test: `apps/web/src/screens/research-views.test.tsx`
- Test: `apps/web/src/screens/moodboard-ui.test.tsx`
- Test: `apps/web/src/screens/workspace.test.tsx`
- Test: `apps/web/src/screens/screens.test.tsx`

**Interfaces:**
- Produces `isImeComposing(event)`, reserved-shortcut target detection, ARIA roving tabs, `useMediaQuery`, and `MoodboardCapabilities`.

```ts
export type MoodboardCapabilities = {
  panZoom: boolean;
  select: boolean;
  mutate: boolean;
  upload: boolean;
  generate: boolean;
};

export const MOODBOARD_REVIEW_CAPABILITIES = {
  panZoom: true,
  select: false,
  mutate: false,
  upload: false,
  generate: false,
} satisfies MoodboardCapabilities;
```

- [ ] **Step 1: Write failing keyboard and capability tests**

Assert IME Enter never submits, ARIA tabs support ArrowLeft/Right/Home/End and roving tab index, canvas shortcuts ignore inputs/buttons/links/interactive roles, review mode invokes no mutation callbacks and hides authoring UI, while fit/pan/zoom remain available.

- [ ] **Step 2: Write failing routing/responsive/semantic-card tests**

Direct `/settings` must render Settings. At mocked 390 px, Shell reports mobile layout, has no resizable separator/fixed sidebar, and exposes main actions. Project/Moodboard cards must be reachable and activated by keyboard with visible focus. Sharingan must have a visible labeled entry. Lazy import tests prove Home does not load Workspace/Settings/canvas route chunks before navigation.

- [ ] **Step 3: Verify RED**

Run: `pnpm --filter @dezin/web test`

Expected: FAIL for missing primitives, capabilities, settings rendering, mobile layout, semantics, and lazy route boundaries.

- [ ] **Step 4: Implement primitives and capability gates**

Gate mutation entry points, paste/delete/undo/nudge/drop/double-click, toolbars, panels, context menus, and editable labels. Remove no-op authoring callbacks from Visual Research. Use shared Tabs for Research.

- [ ] **Step 5: Implement mobile Shell, route-driven Settings, semantic cards, and lazy screens**

Home stays eager. Lazy-load Workspace, Moodboards, Moodboard detail, Design Systems, Design System detail, Effects, Effect detail, Settings, and Onboarding behind one `RouteLoading`/error boundary. Settings open/close navigates to/from `/settings` instead of separate hidden state.

- [ ] **Step 6: Verify GREEN, build, and browser-check 390 px**

Run:

```bash
pnpm --filter @dezin/web test
pnpm --filter @dezin/web build
pnpm typecheck
```

Then start the local app and verify at 390×844 that `document.documentElement.scrollWidth <= window.innerWidth`, settings controls and primary actions are visible, and keyboard focus reaches cards/tabs.

Commit: `fix: make navigation responsive and accessible`

---

### Task 11: Mechanical Architecture Extraction

**Files:**
- Create: `apps/daemon/src/run-policy.ts`
- Create: `apps/daemon/src/sharingan-region-runner.ts`
- Modify: `apps/daemon/src/run-handler.ts`
- Create: `apps/web/src/screens/workspace-transcript.tsx`
- Create: `apps/web/src/screens/workspace-versions.ts`
- Create: `apps/web/src/screens/workspace-markup.ts`
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
- Create: `packages/core/src/store-schema.ts`
- Create: `packages/core/src/store-codecs.ts`
- Modify: `packages/core/src/store.ts`
- Test: `apps/daemon/test/run-handler-prompt.test.ts`
- Test: `apps/daemon/test/sharingan-run.test.ts`
- Test: `apps/web/src/screens/workspace.test.tsx`
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Preserves all existing public exports from `run-handler.ts`, `WorkspaceScreen.tsx`, and `Store`.
- New module imports are the only intentional behavior visible to tests.

- [ ] **Step 1: Add failing import-boundary characterization tests**

Import pure policy/region helpers, transcript rendering/version selectors/markup parsers, schema/migration functions, and row codecs from their new module paths. Run existing ordering, migration, fake-clock, cascade, rollback, prompt, and Workspace behavior fixtures unchanged.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @dezin/daemon test
pnpm --filter @dezin/core test
pnpm --filter @dezin/web test
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Move daemon code without changing bodies**

Move Run policy/prompt helpers first, then Sharingan region orchestration. Preserve re-exports so callers remain stable. Do not alter control flow, error strings, defaults, or sequencing in this commit.

- [ ] **Step 4: Move Workspace and Store domains without changing behavior**

Move transcript, version, and markup domains; then schema/migrations and codecs. Keep `Store` as the public facade and preserve transaction/order/cascade semantics.

- [ ] **Step 5: Verify GREEN and commit each domain separately**

Run the full targeted commands after each move, plus `pnpm typecheck`. Use commits:

```text
refactor: extract run policy and region orchestration
refactor: extract workspace presentation domains
refactor: extract store schema and codecs
```

---

### Task 12: Full Test, CI, Coverage, Bundle, Audit, and Documentation Gates

**Files:**
- Modify: `scripts/test-all.sh`
- Modify: `scripts/typecheck.sh`
- Modify: `package.json`
- Modify: workspace `package.json` files that lack test scripts
- Modify: `apps/web/vite.config.ts`
- Create: `scripts/check-bundle-size.mjs`
- Create: `scripts/check-process-leaks.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `ROADMAP.md`
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `apps/extension/README.md`
- Test: `scripts/test-all.test.mjs`
- Test: `scripts/check-bundle-size.test.mjs`
- Test: `scripts/check-process-leaks.test.mjs`

**Interfaces:**
- Produces root scripts `test`, `test:coverage`, `typecheck`, `build:check`, and `ci`.

- [ ] **Step 1: Add failing orchestration and budget tests**

Assert the test orchestrator enumerates Node packages, daemon, desktop, extension, Leafer, and Web exactly once; propagates failure; enforces a bounded duration; and leaves no child process. Assert the bundle checker rejects any initial static JS chunk over 500 KiB minified or 180 KiB gzip, or total JS gzip above the measured post-lazy baseline plus 5%. Lazy editor/canvas chunks are reported separately and must not occur in the Home or Settings initial import graph.

- [ ] **Step 2: Verify RED**

Run: `node --test 'scripts/*.test.mjs'`

Expected: FAIL because the orchestration/leak/budget tools do not exist and current root tests omit suites/hang.

- [ ] **Step 3: Implement explicit root scripts and typecheck coverage**

Run workspace test scripts explicitly rather than guessing directories. Add Leafer typecheck. Add Web V8 coverage and Node experimental coverage floors equal to freshly measured baselines; record the exact thresholds in package configuration so regressions fail.

- [ ] **Step 4: Implement bundle and process gates**

Build with a manifest. Check gzip budgets from actual output and enforce lazy boundaries against the final chunk module graph. Each suite owns a process group; timeout or a surviving descendant is killed and reported as a failed gate.

- [ ] **Step 5: Add CI**

Use Node 22.14 and pnpm 11.9 with frozen lockfile. Run typecheck, all tests with coverage, Web build/budget, process leak check, and `pnpm audit --prod --audit-level high`.

- [ ] **Step 6: Update documentation to current behavior**

Move variant fanout and CI to shipped in `ROADMAP.md`; describe model discovery as implemented with live discovery plus seed fallback. Update English/Chinese test instructions and extension pairing/revocation steps.

- [ ] **Step 7: Run fresh final verification and commit**

Run:

```bash
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm --filter @dezin/web build
pnpm build:check
pnpm audit --prod --audit-level high
pnpm run ci
```

Expected: every command exits 0, root tests terminate, and no owned preview process remains.

Commit: `ci: enforce full project quality gates`
