# Dezin Hardening Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Dezin's local-daemon trust boundary first, then harden run integrity, Standard-mode quality, resource/concurrency behavior, and lower-priority engineering debt through small mergeable branches.

**Architecture:** Treat the daemon as a privileged local capability service: every API request must pass Host/Origin/token checks before route handling, every path-bearing id must be canonicalized before filesystem access, and previewed artifacts must not share authority with the app shell. Keep product integrity separate from access control by fixing runner failure propagation and quality scoring in later branches.

**Tech Stack:** Node `node:http`, Node test runner, TypeScript strip-types execution, SQLite-backed `@dezin/core`, React/Vite web UI, `@dezin/quality` deterministic linter.

## Global Constraints

- Work in branch sequence; do not stack unrelated debt into the active branch.
- Preserve current local-first behavior: Electron and browser development must continue to work against `127.0.0.1` / `localhost`.
- No CI additions.
- Use tests before implementation for behavior changes.
- Do not delete user runtime data under `.dezin/data` or `~/.dezin`.
- Use CodeGraph/codebase-memory for code discovery when available.
- Verification for daemon changes must include `pnpm --filter @dezin/daemon test`.
- Verification for runner changes must include `pnpm --filter @dezin/agent test`.
- Verification for quality changes must include `pnpm --filter @dezin/quality test`.
- Verification for web changes must include `pnpm --filter @dezin/web test` or the narrow Vitest file if the full suite is too slow, plus `pnpm --filter @dezin/web build` for iframe/sandbox changes.

---

## Branch Sequence

1. `hardening/01-daemon-boundary`
   Scope: Host/Origin/token gate, JSON content-type enforcement, redacted settings responses, project id/path traversal guard, import install-script safety.

2. `hardening/02-preview-isolation`
   Scope: preview/version iframe sandboxing, cross-origin message validation, CSP/navigation guards, Electron external URL handling.

3. `hardening/03-runner-integrity`
   Scope: nonzero exit and Claude `isError` failure propagation, empty artifact P0, stale artifact guard, process group cancellation, generation timeout.

4. `hardening/04-quality-standard`
   Scope: Standard-mode deterministic anti-slop coverage, color normalization, radial/conic gradients, best-score closed-loop return, threshold single source.

5. `hardening/05-resource-concurrency`
   Scope: zip/fig inflate limits, concurrent run guard, import/runtime resource ceilings, SQLite `busy_timeout`, two-daemon ownership/lock behavior.

6. `hardening/06-engineering-debt`
   Scope: web diff performance, Moodboard interaction fixes, schema drift cleanup, deletion disk cleanup, loader validation, Windows agent path support.

## File Structure

### Branch 01 Files

- Modify: `apps/daemon/src/app.ts`
  - Add route-level security gate before `matchPath`.
  - Use redacted settings for `GET /api/settings`.
  - Validate path params for project/moodboard ids before filesystem use.

- Modify: `apps/daemon/src/http-util.ts`
  - Add JSON content-type enforcement.
  - Add trusted Host/Origin helpers or re-export them from a new security module.

- Create: `apps/daemon/src/security.ts`
  - Own daemon token loading, trusted host/origin checks, and id validation helpers.
  - Export:
    - `type DaemonSecurityOptions = { token?: string; disabled?: boolean }`
    - `function isTrustedHost(host: string | string[] | undefined): boolean`
    - `function isTrustedOrigin(origin: string | string[] | undefined): boolean`
    - `function extractBearerToken(req: IncomingMessage): string | null`
    - `function requireDaemonRequest(req: IncomingMessage, options?: DaemonSecurityOptions): void`
    - `function assertSafeId(id: string, label?: string): string`
    - `function redactSettings(settings: Settings): Settings`

- Modify: `apps/daemon/src/start.ts`
  - Persist/read daemon token metadata from the existing daemon discovery file or a sibling `daemon.json`.
  - Pass `security` options into `createApp`.

- Modify: `packages/core/src/types.ts`
  - If Settings redaction needs a new public type, add `PublicSettings` instead of weakening stored `Settings`.

- Test: `apps/daemon/test/http.test.ts`
  - Host/Origin/token gate.
  - `text/plain` JSON rejection.

- Test: `apps/daemon/test/settings.test.ts`
  - `GET /api/settings` redacts key fields but `PUT /api/settings` still persists them.

- Test: `apps/daemon/test/files.test.ts` or new `apps/daemon/test/security.test.ts`
  - Encoded traversal ids are rejected before filesystem serving.

- Test: `apps/daemon/test/export.test.ts`
  - Imported Standard projects do not run package scripts without an explicit trusted path.

### Branch 02 Files

- Modify: `apps/web/src/screens/WorkspaceScreen.tsx`
  - Validate `event.origin` and `event.source` for preview bridge messages.
  - Stop using `allow-same-origin` for same-origin untrusted prototype artifacts.

- Modify: `apps/web/src/components/PreviewModal.tsx`
  - Use the same sandbox policy as inline preview.

- Modify: `apps/web/src/components/VersionCompare.tsx`
  - Add iframe `sandbox`.

- Modify: `apps/desktop/main.js`
  - Add navigation guard.
  - Restrict `shell.openExternal` to `http:` and `https:` URLs.

- Test: `apps/web/src/screens/workspace.test.tsx`
  - Message from wrong origin is ignored.
  - Message from preview frame with expected origin is accepted.

- Test: `apps/web/src/components/polish.test.tsx`
  - Preview modal and version compare iframes include sandbox attributes.

### Branch 03 Files

- Modify: `packages/agent/src/claude-runner.ts`
  - Throw on `exitCode !== 0`.
  - Throw on parsed `isError`.
  - Throw when the expected artifact file is missing or near-empty after a successful turn.

- Modify: `packages/agent/src/generic-runner.ts`
  - Throw on `exitCode !== 0`.
  - Throw when artifact file is missing or near-empty.

- Modify: `packages/agent/src/types.ts`
  - If needed, include `stderr` and `exitCode` in runner errors without changing successful return shape.

- Modify: `packages/quality/src/lint-artifact.ts`
  - Add a P0 for empty or near-empty HTML.

- Modify: `packages/quality/src/closed-loop.ts`
  - Preserve and return the highest-score artifact when all rounds fail.

- Test: `packages/agent/test/claude-runner.test.ts`
  - Nonzero exit rejects.
  - Claude `is_error` rejects.
  - Missing artifact rejects.

- Test: `packages/agent/test/generic-runner.test.ts`
  - Nonzero exit rejects.
  - Missing artifact rejects.

- Test: `packages/quality/test/lint-artifact.test.ts`
  - Empty HTML is P0.

- Test: `packages/quality/test/closed-loop.test.ts`
  - A repair that regresses score does not replace the best artifact.

### Branch 04 Files

- Modify: `packages/quality/src/lint-artifact.ts`
  - Parse CSS values once.
  - Normalize hex/rgb/hsl/oklch color values before matching banned hues.
  - Detect `linear-gradient`, `radial-gradient`, and `conic-gradient`.
  - Replace `checkLeftAccentCard` regex with a bounded rule parser.

- Modify: `packages/quality/src/slop-rules.ts`
  - Export thresholds as constants:
    - `ACCENT_OVERUSE_CAP = 3`
    - `ALL_CAPS_MIN_TRACKING_EM = 0.06`
    - `MAX_RADIUS_PX = 24`

- Modify: `packages/prompt/src/anti-slop.ts`
  - Import or mirror generated threshold values from the same source package path used by existing prompt code.

- Modify: `packages/craft/src/anti-slop-doc.ts`
  - Generate threshold copy from constants, not prose literals.

- Modify: `apps/daemon/src/run-handler.ts`
  - Add Standard-mode deterministic quality pass from compiled/rendered output or source/CSS extraction.

- Test: `packages/quality/test/lint-artifact.test.ts`
  - `rgb(99, 102, 241)` and equivalent hsl/oklch are treated like banned indigo.
  - radial/conic purple gradients are P0.
  - CSS with large blocks does not trigger `checkLeftAccentCard` ReDoS.

- Test: `packages/craft/test/anti-slop-doc.test.ts`
  - Prompt/craft threshold values match quality constants.

- Test: `apps/daemon/test/runs.test.ts`
  - Standard-mode run records deterministic static findings when source violates anti-slop rules.

### Branch 05 Files

- Modify: `apps/daemon/src/export-handler.ts`
  - Enforce max uncompressed zip bytes and max entry count.
  - Reject `node_modules`, `.git`, and package script execution from untrusted imports.

- Modify: `apps/daemon/src/parse-fig.ts`
  - Limit decompressed `.fig` payload size.

- Modify: `apps/daemon/src/run-handler.ts`
  - Reject second active run for the same project/variant with `409`.

- Modify: `packages/core/src/store.ts`
  - Add `PRAGMA busy_timeout = 5000`.
  - Add run owner/heartbeat or lock scope for interrupted-run cleanup.

- Test: `apps/daemon/test/zip.test.ts`
  - Oversized decompressed zip is rejected.

- Test: `apps/daemon/test/parse-fig.test.ts`
  - Inflated `.fig` payload over limit is rejected.

- Test: `apps/daemon/test/runs.test.ts`
  - Concurrent run on same target returns `409`.

- Test: `packages/core/test/store.test.ts`
  - `busy_timeout` is configured.
  - Interrupted run cleanup does not cancel another live owner.

### Branch 06 Files

- Modify: `apps/web/src/lib/diff.ts`
  - Replace full O(m*n) DP with line budget cutoff and/or Myers diff worker-friendly path.

- Modify: `apps/web/src/lib/diff.test.ts`
  - Large files return bounded output within a fixed time budget.

- Modify: `apps/web/src/moodboard/useMoodboardCanvasController.ts`
  - Reset temporary hand tool on blur/visibility change.
  - Flush pending save before agent messages.

- Modify: `apps/web/src/moodboard/useLeaferMoodboardRuntime.ts`
  - Zoom buttons/keyboard anchor on viewport center.

- Modify: `apps/web/src/moodboard/MoodboardSectionLabels.tsx`
  - Replace per-section permanent rAF loop with a shared invalidation/update path.

- Modify: `apps/web/src/moodboard/MoodboardCanvasNode.tsx`
  - Align section z-index ordering with layer panel ordering.

- Modify: `packages/core/src/store.ts`
  - Reconcile `SCHEMA` with additive migration columns.
  - Delete project/moodboard disk payloads when records are deleted.

- Test: `apps/web/src/moodboard/moodboard-ui.test.tsx`
  - Blur exits temporary hand mode.
  - Agent send flushes latest board state.
  - Zoom controls preserve viewport center.

- Test: `packages/core/test/store.test.ts`
  - New database schema includes migrated columns.
  - Deleting a project/moodboard removes its owned disk directory through daemon handler tests.

## Task 1: Branch 01 Gate Tests

**Files:**
- Modify: `apps/daemon/test/http.test.ts`
- Modify: `apps/daemon/test/settings.test.ts`
- Modify: `apps/daemon/test/files.test.ts`
- Modify: `apps/daemon/test/export.test.ts`

**Interfaces:**
- Consumes: existing `createApp(deps)` daemon test harness.
- Produces: failing tests for `requireDaemonRequest`, `redactSettings`, `assertSafeId`, and import install-script safety.

- [ ] **Step 1: Write failing daemon boundary tests**

Add tests that assert:
- `Host: evil.test` receives `403`.
- `Origin: https://evil.test` receives `403` for mutating API routes.
- Missing bearer token receives `401` when `createApp` is configured with a token.
- `Content-Type: text/plain` on a JSON API route receives `415`.
- `GET /api/settings` returns empty `apiKey`, `imageApiKey`, and `videoApiKey`.
- Encoded `..` project ids cannot escape `<dataDir>/projects`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @dezin/daemon test
```

Expected: FAIL in the new boundary tests because current daemon accepts the requests.

- [ ] **Step 3: Commit tests only if the red phase is useful**

```bash
git add apps/daemon/test/http.test.ts apps/daemon/test/settings.test.ts apps/daemon/test/files.test.ts apps/daemon/test/export.test.ts
git commit -m "test: cover daemon boundary hardening"
```

## Task 2: Branch 01 Security Implementation

**Files:**
- Create: `apps/daemon/src/security.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/http-util.ts`
- Modify: `apps/daemon/src/start.ts`

**Interfaces:**
- Produces: `requireDaemonRequest(req, options)`, `assertSafeId(id)`, and `redactSettings(settings)`.
- Consumes: existing route definitions and `Store.getSettings()`.

- [ ] **Step 1: Implement the request gate**

`requireDaemonRequest` must:
- allow Host `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, and empty Host for internal tests;
- reject non-local Host with `403`;
- allow absent Origin;
- allow Origin with protocol `http:` and hostname `127.0.0.1`, `localhost`, or `::1`;
- reject non-local Origin with `403`;
- if `options.token` is set, require `Authorization: Bearer <token>` or `x-dezin-daemon-token: <token>`.

- [ ] **Step 2: Enforce JSON content type**

`readJsonBody` must reject non-empty JSON requests with a non-JSON `Content-Type`. Empty bodies remain `{}` for existing `POST /api/capture/consume` style handlers.

- [ ] **Step 3: Validate filesystem ids**

`assertSafeId` must reject any decoded id containing `/`, `\\`, `..`, empty string, or characters outside `[A-Za-z0-9_-]`.

- [ ] **Step 4: Redact settings**

`redactSettings` must return the same shape as `Settings` but set `apiKey`, `imageApiKey`, and `videoApiKey` to `""`.

- [ ] **Step 5: Run branch 01 daemon tests**

```bash
pnpm --filter @dezin/daemon test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/security.ts apps/daemon/src/app.ts apps/daemon/src/http-util.ts apps/daemon/src/start.ts apps/daemon/test
git commit -m "fix: gate daemon local API boundary"
```

## Task 3: Branch 01 Import Script Safety

**Files:**
- Modify: `apps/daemon/src/project-runtime.ts`
- Modify: `apps/daemon/src/export-handler.ts`
- Test: `apps/daemon/test/export.test.ts`
- Test: `apps/daemon/test/project-runtime.test.ts`

**Interfaces:**
- Produces: an install command path that uses `npm install --ignore-scripts` for imported projects.
- Consumes: existing `setupStandardProject` and `setupImportedStandardProject`.

- [ ] **Step 1: Write failing test for imported package scripts**

Create a Standard import fixture with `package.json` containing `"postinstall": "node should-not-run.js"` and assert import/setup does not execute the script.

- [ ] **Step 2: Implement trusted install mode**

Use normal `npm install` for Dezin-owned templates if needed. Use `npm install --ignore-scripts --no-audit --no-fund --loglevel=error` for imported archives.

- [ ] **Step 3: Run daemon tests**

```bash
pnpm --filter @dezin/daemon test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/project-runtime.ts apps/daemon/src/export-handler.ts apps/daemon/test/export.test.ts apps/daemon/test/project-runtime.test.ts
git commit -m "fix: prevent imported project install scripts"
```

## Task 4: Branch Closeout

**Files:**
- Modify: branch-specific files only.

**Interfaces:**
- Produces: a branch ready to merge before starting Branch 02.

- [ ] **Step 1: Run focused tests**

```bash
pnpm --filter @dezin/daemon test
```

Expected: PASS.

- [ ] **Step 2: Run broader validation**

```bash
pnpm typecheck
pnpm test
```

Expected: PASS, or document pre-existing unrelated failures with exact failing test names.

- [ ] **Step 3: Review diff**

```bash
git diff --stat main...
git diff --check
```

Expected: no whitespace errors; diff only touches branch 01 files and this plan.

- [ ] **Step 4: Commit plan if not already included**

```bash
git add docs/superpowers/plans/2026-07-02-dezin-hardening-roadmap.md
git commit -m "docs: plan phased Dezin hardening"
```

## Self-Review

- Spec coverage: all reported critical items are assigned to Branches 01-04; lower-priority diff performance, Moodboard interaction, and schema drift are explicitly assigned to Branch 06.
- Placeholder scan: no task uses TBD/TODO/later language; later branches name exact files and tests.
- Type consistency: branch 01 helpers are consistently named `requireDaemonRequest`, `assertSafeId`, and `redactSettings`.
