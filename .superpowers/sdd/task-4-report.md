# Task 4 Report: Runtime Ownership, Deletion, and Shutdown

## Status

Implemented and verified on base `de4d0525` in `.worktrees/all-review-fixes`.

## Implementation

- Added a production `RuntimeSupervisor` with explicit `projectId` / `variantId` / `runId` ownership, scoped registration, rejection, cancellation, settlement waiting, project release, variant release, global cancellation, and bounded shutdown.
- Registered real broker Runs before the first post-record await. Supervisor settlement now includes the broker JSONL write queue and rejects late events once `finishRun` starts.
- Project deletion now blocks the scope, aborts and awaits Runs, releases setup/dev and Sharingan resources, removes project Run logs plus daemon worktrees/version-worktrees/project files, then deletes Store rows.
- Variant deletion performs the same sequence only for the targeted variant and preserves the project root, other variants, and their Run resources.
- Project runtime release kills tracked setup/dev children and removes runtime-map entries. Sharingan project release closes the scoped session/listeners/timer and removes its capture entry.
- Daemon signal shutdown awaits bounded supervisor cleanup before closing the HTTP server and Store.
- HTTP and variant harnesses now create and close the same production supervisor used by the daemon.

## RED evidence

- `runtime-supervisor.test.ts`: initially failed with `ERR_MODULE_NOT_FOUND` because `runtime-supervisor.ts` did not exist.
- Scoped variant release initially failed because `RuntimeScopeUnavailableError` / `releaseVariant` were absent; resource cleanup then failed with `resourcesReleased === false`.
- Project release initially failed with `TypeError: supervisor.releaseProject is not a function`.
- Bounded shutdown initially timed out at the test's 500 ms guard because shutdown awaited a never-settling Run indefinitely.
- Real project deletion initially returned without aborting the blocked runner: `the active Run observes abort before DELETE resolves` (`false !== true`).
- Targeted Standard variant regression-sensitivity check failed when the supervisor call was temporarily bypassed: `the targeted Run observes abort before DELETE resolves` (`false !== true`). Restoring the production route made it green.
- Broker self-review test initially persisted both `before-finish` and `after-finish`; `finishRun` now closes event admission synchronously and settles after the accepted JSONL queue flushes.
- Actual daemon subprocess tests initially failed to write the port file. Captured stderr identified `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from a TypeScript parameter property under `--experimental-strip-types`; replacing it with the repository's explicit constructor-assignment pattern fixed production startup.

## GREEN evidence

- Production Node runner, focused Task 4 surface:
  - `node --experimental-strip-types --experimental-sqlite --no-warnings --test test/http.test.ts test/variants.test.ts test/runtime-supervisor.test.ts test/run-manager.test.ts test/sharingan-shutdown.test.ts`
  - **57 passed, 0 failed**, exited normally.
- Runtime children/hooks: `project-runtime.test.ts` — **8 passed**.
- Exactly-once lifecycle and real cancellation focus: `runs.test.ts` filtered to lifecycle/real-cancel — **7 passed**.
- Actual daemon start and lock/SIGTERM focus: `runs.test.ts` filtered to daemon-start tests — **2 passed**.
- Core Store suite: `pnpm --filter @dezin/core test` — **24 passed**.
- `pnpm typecheck` — **TYPECHECK: PASS**.
- `git diff --check` — pass.

The daemon wildcard was intentionally not used because the task brief calls out the known unrelated preview/Sharingan wildcard hang; all Task 4 suites were run directly without `--test-force-exit` and exited normally.

## Self-review

- Deletion ordering matches the design: reject -> abort -> await broker/Run settlement -> release scoped runtime resources -> remove owned paths/logs -> delete Store rows.
- Other-project and other-variant resources are explicitly retained in supervisor tests.
- Existing `RunExecution` exactly-once settlement remains the terminal-state authority; the supervisor only owns abort and cleanup lifetime.
- No PreviewLease manager, Standard Run transaction, Sharingan signal/profile redesign, resource-budget work, token/env changes, or symlink changes were introduced.
- The design hook's three `broken-image` findings in `app.ts` are false positives: the flagged lines are comments describing public routes that allow HTML `<img src>` requests, not image elements or placeholder sources.

## Concerns

- None within Task 4 scope. Preview leases/process-group policy, transactional Standard Run worktrees, Sharingan abort/profile isolation, and resource bounds remain assigned to Tasks 5-8.

---

## Formal review follow-up

Implemented the requested deletion-race fixes on top of `c7ded1b8`:

- Added synchronous scoped-operation admission/ownership for setup, imported setup, dev servers, variant/version worktrees, version handlers, cover handlers, Sharingan routes, and post-success Standard/Prototype cover captures.
- Added project-runtime generation invalidation plus retained retired generations, so replacement and release await older setup/dev operations before cleanup completes.
- Added Sharingan generation/release state and synchronously retained capture/open/continue/focus/idle-close operations. Late browser opens close without capturing, and project release awaits every retained operation.
- Reworked shutdown around one absolute deadline spanning Runs, scoped operations, resource hooks, HTTP close, and stuck connections. HTTP admission closes immediately; `closeAllConnections()` forces stuck SSE teardown; Store close is in `finally`.
- Removed real detached version worktrees through `git worktree remove --force` followed by prune before raw path deletion.
- Added AbortSignal-aware Puppeteer cover capture and conservative project-scoped ownership for prototype variant transitions.
- Updated `withRunServer` to use and close the same production supervisor supplied to `createApp`.

### Follow-up RED evidence

- In-flight setup deletion: `deletion aborts tracked setup work` failed (`false !== true`).
- Delayed Sharingan open deletion: `DELETE waits for the synchronously retained open promise` failed (`false !== true`).
- End-to-end shutdown test initially failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created `daemon-shutdown.ts` boundary.
- Real Git fixture retained the removed detached version worktree as `prunable gitdir file points to non-existent location`.

### Follow-up GREEN evidence

- `pnpm typecheck` — **TYPECHECK: PASS**.
- Shutdown/supervisor/Sharingan focused files — **12 passed, 0 failed**.
- Setup + delayed-open HTTP regressions — **2 passed, 0 failed**.
- Project-runtime generation regression — **1 passed, 0 failed**.
- Standard + Prototype cover ownership regressions — **2 passed, 0 failed**.
- Real Git version worktree + targeted deletion regressions — **2 passed, 0 failed**.
- Final capture-cover/Sharingan plus deletion-race focus after self-review fixes — **7 passed, 0 failed**.
- `git diff --check` — pass.

The full daemon wildcard was also attempted. Every result emitted before interruption was passing, including the new deletion/shutdown/worktree/cover tests and the long Run suite through direction-picking coverage. Per coordination instruction it was stopped after exceeding the allowed broad-suite window; its non-zero exit was SIGINT, not an assertion failure. Focused Task 4 commands above all exited normally.

### Follow-up self-review

- Closed the review's detached Sharingan continue, idle-close, delayed-open, version-preview, manual-cover, retired-runtime-generation, real cover-abort, and prototype source-variant activation gaps.
- The three Impeccable `broken-image` findings remain classified as false positives: the flagged source is route code/comments describing HTML image requests, not rendered image elements or placeholder sources.

---

## Final ownership-closure recovery

Recovered the uncommitted final review round on base `e04b3bb0` and closed the six remaining formal findings without changing the excluded Preview TTL/LRU, Standard transaction, Sharingan profile policy, resource-budget, token/env, or symlink topics.

### Implementation

- Made operation matching exact for variant and Run scopes. Every variant mutation now admits its concrete `variantId`; Prototype activation rolls the project root back when same-variant deletion cancels an in-flight switch, returns `409`, and does not leave a stale active snapshot. Variant preview ownership now includes the actual async file read, not only directory resolution.
- Registered reference uploads before body consumption and passed the operation signal into the abortable JSON reader, preventing partial uploads from blocking deletion or recreating `.refs` after `204`.
- Registered project-import requests under a daemon-level operation before reading the archive body, then synchronously transferred the post-row continuation into the real project scope. Shutdown now aborts partial import bodies; an abort that wins after row creation rolls the import back through `releaseProject`.
- Passed cancellation through import file loops and Git clone/branch subprocesses. Project release recomputes imported Run ids only after all tracked project operations settle, so late logs, bundles, version worktrees, and project files are removed.
- Replaced async-iterator body collection with a signal-aware collector that removes request and signal listeners on every completion path and destroys a canceled request. All tracked variant, reference, and Sharingan body readers receive their operation signal.
- Made Sharingan status a non-allocating peek and returned `404` for missing projects. Established browser sessions now use atomic claim-before-close ownership across release, capture, continue, probe-idle, and late-open paths.

### Recovery RED evidence

- `shutdown aborts a partial import body before it can create a late project` failed with a persisted `Late import` project after supervisor shutdown completed ahead of the half-sent request.
- `variant deletion rolls back an in-flight Prototype activation` failed with HTTP `500`; the Store still selected the main variant while the project root contained the deleted target's HTML.

### Recovery GREEN and final verification

- The two new reverse-order race regressions: **2 passed, 0 failed**.
- Final Task 4 focused files (`http`, `variants`, `runtime-supervisor`, `run-manager`, `sharingan-shutdown`, `export`, `sharingan-continue`, `sharingan-handler`): **81 passed, 0 failed**, exited normally.
- `project-runtime.test.ts`: **9 passed, 0 failed**.
- `runs.test.ts` filtered to exactly-once lifecycle, real cancellation, and daemon-start/lock regressions: **9 passed, 0 failed**.
- `pnpm --filter @dezin/core test`: **24 passed, 0 failed**.
- `pnpm typecheck`: **TYPECHECK: PASS**.
- `git diff --check`: pass.

The daemon wildcard was intentionally not run, per the recovery brief. A read-only reviewer independently observed the pre-existing isolated `sharingan-run.test.ts` fixture mismatch (its RecordingRunner writes `src/App.jsx` while current region validation requires `src/sharingan-regions/<id>.jsx`); none of this recovery's changed focused tests failed.

### Recovery self-review

- Verified both race orders for variant deletion versus Prototype activation: delete-first rejects admission; activation-first aborts, rolls back, then permits scoped deletion without touching unrelated project operations.
- Verified shutdown owns import upload time before a project id exists, and project deletion owns every mutation after row creation.
- Verified Sharingan status polling cannot recreate registry state during or after release, and non-idempotent fake sessions close exactly once under capture/continue release races.
- No wildcard daemon run, force-exit workaround, global test-only process kill, or out-of-scope lifecycle policy was added.
