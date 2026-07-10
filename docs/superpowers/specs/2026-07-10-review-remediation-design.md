# Review Remediation Design

**Date:** 2026-07-10

**Status:** Approved for implementation. The user approved extension pairing and instructed the remaining review findings to be completed without further design prompts.

## Scope

This remediation closes every actionable finding from the 2026-07-10 code and product review except the two items the user explicitly deferred:

1. Local credential storage, daemon-token file permissions, broad daemon-token authority, agent-command registration, and environment narrowing.
2. Symbolic-link containment for imports and static file serving.

The deferred items must not be partially changed as a side effect of this work. Existing security gates remain in place.

## Delivery order

1. Extension authentication and Electron security/lifecycle.
2. Run and Standard-workspace data integrity.
3. Runtime ownership, cleanup, limits, and cancellation.
4. UI state truth, responsive behavior, and accessibility.
5. Architecture extraction, tests, CI, performance budgets, and documentation.

Each phase must be independently testable and committed. Production behavior changes follow red-green-refactor TDD.

## 1. Extension pairing

### User flow

- Dezin Settings contains an Extension Pairing section.
- An authenticated Dezin client requests a six-digit, single-use code.
- The code expires after five minutes.
- The extension popup accepts the daemon URL and pairing code.
- A successful exchange returns a random extension credential. The extension stores it in `chrome.storage.local`, never `chrome.storage.sync`.
- Capture and analysis requests send the credential in `Authorization: Bearer`.
- Settings lists paired extension credentials by creation date and last-used date and can revoke them.

### Daemon authorization model

- The standard daemon token continues to authorize all routes.
- An extension credential authorizes only `POST /api/capture` and `POST /api/analyze-image`.
- Pair-code creation/list/revocation requires the standard daemon token.
- Pair-code exchange is the only unauthenticated extension route. It still requires a trusted local Host, a valid unexpired code, and a `chrome-extension:` Origin.
- Pair codes are stored only as hashes in memory. Issued credentials are stored only as SHA-256 hashes in SQLite.
- Codes are single-use even when two exchange requests race.
- Revoked, expired, malformed, and wrong-scope credentials receive `401` or `403` without leaking which credential exists.

### Data model

Add an `extension_credentials` table with `id`, `token_hash`, `label`, `created_at`, `last_used_at`, and `revoked_at`. Pair codes remain process-local because they are short-lived.

## 2. Electron upgrade and daemon ownership

- Upgrade Electron to a release that is not affected by the four audited high-severity advisories and refresh the lockfile.
- One Electron application process owns at most one daemon child, regardless of how many windows are created or recreated on macOS.
- `createWindow()` never spawns a daemon directly. An idempotent `ensureDaemon()` owns spawn, readiness, crash state, and restart.
- A daemon that exits unexpectedly is restarted with bounded exponential backoff while the app is alive. Only one restart timer may exist.
- Window load failures expose a retry path instead of leaving a blank hidden window.
- Application shutdown terminates the daemon process group and cancels any pending restart.
- Desktop lifecycle logic lives in a testable CommonJS module; Electron integration stays thin.

## 3. Exactly-once Run lifecycle

Every accepted Run request has exactly one durable terminal result.

- Acquire the per-target start lock before setup.
- Create the Run record once.
- Move all fallible work after record creation inside one outer lifecycle guard, including broker setup, SSE setup, research, registry lookup, Sharingan preparation, Standard setup, agent execution, quality review, and persistence.
- On success, transition `running -> completed` once.
- On cancellation, transition `running -> cancelled` once.
- On any other exception, transition `running -> failed` once and persist a safe error event.
- Release the start lock and runtime registration in `finally`, even when failure happens before agent execution.
- A terminal transition is idempotent so secondary cleanup failures cannot overwrite the first terminal state.
- A failed start never leaves the target permanently returning `409`.

The lifecycle coordinator must be extracted from the large route handler behind a small `RunExecution` interface.

## 4. Standard workspace transaction

- A Standard Run never executes in the user's active project checkout.
- Each Run gets a detached Git worktree under the daemon-owned worktree directory, based on the selected variant commit.
- Agent work, linting, preview, screenshots, and retries occur in that Run worktree.
- Success commits inside the Run worktree, then promotes the commit to the selected variant using a fast-forward or explicit ref update guarded by the expected base SHA.
- If the selected variant moved concurrently, promotion fails without overwriting either side.
- Failure or cancellation removes only the Run worktree. It never calls `git add -A`, `reset --hard`, or `clean -fd` in the user's active checkout.
- Existing user changes, including untracked files, remain byte-for-byte unchanged after success, failure, and cancellation.

## 5. Runtime supervisor and resource limits

Introduce a daemon-owned `RuntimeSupervisor` keyed by project, variant, Run, and preview lease.

### Ownership and cleanup

- Project deletion first rejects new work, cancels active Runs/setup/Sharingan work, stops owned process groups, releases previews, removes Run logs and daemon-owned worktrees, then removes disk and database records.
- Variant deletion performs the equivalent variant-scoped cleanup.
- Daemon shutdown calls `cancelAll()` and awaits bounded cleanup before closing the store.
- Setup and Sharingan maps delete terminal entries; no project-shared browser profile is reused across projects.

### Preview lease

- A preview server is represented by a lease with owner key, process group, URL, readiness state, last-used time, reference count, and expiry timer.
- `ensureDevServer` resolves only after an HTTP readiness probe succeeds; timeout rejects and kills the process group.
- Version previews acquire/release leases. A maximum of four idle preview processes is retained, with a 60-second idle TTL and LRU eviction.
- Test teardown and daemon shutdown release every lease and leave no Vite/npm child process.

### Bounded data

- In-memory Run events retain at most 2,000 events or 2 MiB, whichever is reached first.
- Agent stdout and stderr retain at most 1 MiB per stream while preserving a truncation marker.
- Research activity is appended to JSONL incrementally; snapshots no longer rewrite a growing array on every event.
- Export rejects more than 10,000 files, any single file over 64 MiB, or total uncompressed payload over 512 MiB, and observes request cancellation.
- Full exports stream ZIP output instead of collecting every source file in one aggregate buffer.

## 6. Sharingan cancellation and determinism

- The Run abort signal is passed through `ensureCaptured` and every wait/poll operation.
- Cancellation closes the project session immediately and cannot wait for the 300-second capture timeout.
- Session, status, and capture state are project-scoped and removed after terminal cleanup.
- Region-build aggregation preserves input-region order rather than completion order.
- The UI renders `status.error`, distinguishes cancel from failure, and provides retry.

## 7. UI resource truth

Shared async-resource semantics are `idle | loading | refreshing | ready | error`, with retained last-good data during refresh.

- Home project loading displays a retryable error, never an empty-state lie.
- Settings optimistic updates retain a previous snapshot and roll back failed writes while showing the server error.
- Stop remains pending until the daemon acknowledges cancellation. It does not abort SSE or display “Stopped” on a failed request.
- Moodboard persistence exposes `flush()`; unmount, navigation, and agent-send await the latest pending board save.
- Moodboard creation is transactional from the UI perspective: prompt/input remains available after any failed create/upload/save step.
- List refresh keeps existing rows visible and marks them refreshing.
- Background preview-update events refresh data without forcing a tab change.
- Pure reference input enables Design even when prompt text is empty.
- Visual Research passes explicit read-only capabilities so authoring controls are absent, not wired to no-op callbacks.

## 8. Responsive, routing, and accessibility

- `/settings` renders Settings on direct load and refresh.
- At 390 CSS pixels, the shell becomes a compact top/bottom navigation layout with no fixed 176-pixel sidebar and no 520-pixel content minimum.
- Primary actions and settings controls remain visible without horizontal page scrolling.
- Clickable project cards use semantic links/buttons and support Enter/Space with a visible focus state.
- Research tabs implement the ARIA tabs keyboard pattern.
- Moodboard only intercepts Tab when focus is inside the canvas interaction surface; normal form traversal remains native.
- Enter handlers ignore `KeyboardEvent.isComposing` so IME composition is never submitted.
- Sharingan entry is a visible labeled action, not a hidden heading double-click.

## 9. Architecture and performance gates

- Extract Run lifecycle/orchestration from `run-handler.ts`.
- Extract workspace Run controls, preview synchronization, and resource reducers from `WorkspaceScreen.tsx` into focused hooks/modules.
- Extract SQLite schema/migrations and row mappers from `packages/core/src/store.ts` without changing the public `Store` API.
- Route screens are loaded with `React.lazy` and a shared error/loading boundary.
- Vite manual chunking separates React/runtime, editor/canvas, Markdown/agent output, and route screens.
- CI runs typecheck, every Node package test, Web Vitest, Leafer tests, Web build, `pnpm audit --prod`, and leak detection.
- Root `pnpm test` includes Vite/Web and Leafer suites and exits with no child servers.
- Typecheck includes `@dezin/leafer-react`.
- Coverage thresholds begin at the repository's measured baseline and cannot decrease; critical security/lifecycle modules require direct tests.
- Build budgets fail when an initial JS chunk exceeds 500 KiB minified or 180 KiB gzip; lazy canvas/editor chunks may be larger but must not load on Home or Settings.
- ROADMAP and model/provider documentation are updated to match implemented fanout and current behavior.

## Acceptance matrix

The final branch is acceptable only when all of the following are freshly verified:

- Extension pair, use, revoke, expiry, race, and wrong-scope integration tests pass.
- Electron lifecycle unit tests pass and `pnpm audit --prod` reports no high-severity Electron advisory.
- Reproductions for pre-research throw and research throw both end in durable `failed` Runs and allow an immediate retry.
- Dirty Standard checkout fixtures are unchanged across success, failure, and cancel.
- Project/variant deletion and shutdown leave no owned processes, logs, worktrees, sessions, or leases.
- Stop, rollback, flush, Home error, Sharingan error/cancel, pure-ref, read-only, deep-link, IME, keyboard, and narrow-layout tests pass.
- Root tests terminate; typecheck, all tests, Web build, audit, and CI-equivalent commands pass.
- No implementation touches the two deferred security topics.
