# Sharingan Phase 5 — Run-Handler Build Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Sharingan build work end-to-end: when a project is `sharingan`, `run-handler` runs the entry capture before the build turn, injects the `sharingan-context` prompt block into the Agent brief, skips Research, and lets the Agent probe + reconstruct from the `.sharingan/` bundle.

**Architecture:** A new `ensureCaptured(id, dataDir, url)` in `sharingan-handler.ts` kicks the entry capture (if not already run) and awaits `"captured"` (waiting through a `"login-required"` pause, with a bounded timeout; on error/timeout it resolves so the build proceeds best-effort). `run-handler.ts`, for sharingan projects, awaits it before the build loop, appends `buildSharinganContext(...).promptBlock` (with the daemon's own `origin`) to `agentBrief`, and adds `&& !project.sharingan` to the Research gate.

**Tech Stack:** daemon node:http; the existing `startCapture`/capture registry (Phase 1-4); `buildSharinganContext` (Phase 4); the `FakeRunner` test seam used by `runs.test.ts`.

## Global Constraints

- **Branch:** continue on `feat/sharingan`. This is the FINAL phase — after it lands + the carried Minors are triaged, the feature is mergeable. **NO `Co-Authored-By` trailer. NO version bump on task commits** (bump when the whole feature merges to main).
- **Builds on Phases 1-4:** `startCapture(id, url, dataDir, profileDir, open?)`, the `Capture` registry + `get(id)` + `Phase` union (`idle|capturing|login-required|captured|error|probing`), `SHARINGAN_PAGE_BUDGET`, `buildSharinganContext({ projectId, sourceUrl, origin, budget, capturedCount })`. The probe endpoints + agent token already exist; the Agent will use them DURING the build.
- **`origin` for `buildSharinganContext` MUST be the daemon's own origin** — use `origin` (`= requestOrigin(req)`, run-handler.ts:569), the SAME value passed to `buildProjectEffectContext`. NOT `sourceUrl`.
- **Capture-before-build gating:** the build BLOCKS on the entry capture reaching `"captured"`, waiting through a `login-required` pause (the Phase-3 tab shows the login prompt) up to a bounded timeout. On `"error"` or timeout, PROCEED (do not fail the run) — the Agent can still probe live via the endpoints.
- **Research is skipped** for sharingan projects (the URL brief is not a research topic).
- **Daemon tests:** `node --test` under `apps/daemon/test/`. The full daemon suite has a PRE-EXISTING unrelated hang (`runs.test.ts`/`variants.test.ts`) — run individual files (`node --test <file>`), and put the new run-integration test in its OWN file (`sharingan-run.test.ts`), NOT in `runs.test.ts`.

## File Structure

- `apps/daemon/src/sharingan-handler.ts` — `ensureCaptured` + a `capturedPageCount(id)` reader (both exported).
- `apps/daemon/src/run-handler.ts` — the sharingan capture-before-build block + context injection + the Research-gate `&& !project.sharingan`.
- `apps/daemon/test/sharingan-ensure.test.ts` (new) — `ensureCaptured` unit (DI, no Chrome).
- `apps/daemon/test/sharingan-run.test.ts` (new) — the run-handler integration (FakeRunner; Chrome-gated for the real capture).

---

## Task 1: `ensureCaptured` — kick + await the entry capture (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts` (`ensureCaptured`, `capturedPageCount`)
- Test: `apps/daemon/test/sharingan-ensure.test.ts` (new)

**Interfaces:**
- Consumes: `startCapture` (fire-and-forget), `get(id)`, the `Phase` union.
- Produces: `ensureCaptured(id, dataDir, url, opts?): Promise<Phase>` — returns the terminal phase (`"captured"`/`"error"`, or the current phase on timeout). `capturedPageCount(id): number` — `get(id).pages.length`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-ensure.test.ts` (no Chrome — DI fake session):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptured, capturedPageCount } from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

function fakeThatCaptures(): SharinganSession {
  return {
    navigate: async () => ({ status: 200, finalUrl: "http://x.test/" }),
    readDom: async () => [{ tag: "h1", classes: "", text: "Home", box: { x: 0, y: 0, w: 10, h: 10 } }],
    hasPasswordField: async () => false,
    setViewport: async () => {},
    screenshot: async () => Buffer.from("x"),
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    discoverLinks: async () => [],
    close: async () => {},
  } as unknown as SharinganSession;
}

test("ensureCaptured kicks the capture from idle and resolves 'captured'", async () => {
  const id = "ensure-ok";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens-"));
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  assert.equal(phase, "captured");
  assert.equal(capturedPageCount(id), 1);
});

test("ensureCaptured returns immediately when already captured", async () => {
  const id = "ensure-done";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens2-"));
  await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  const t0 = process.hrtime.bigint();
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(phase, "captured");
  assert.ok(elapsedMs < 40, "second call short-circuits without re-capturing");
});

test("ensureCaptured resolves (does not hang) on a stuck capture past the timeout", async () => {
  const id = "ensure-stuck";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens3-"));
  // Fake whose navigate never resolves → phase stays "capturing"; ensureCaptured must time out, not hang.
  const stuck = { navigate: () => new Promise<never>(() => {}), close: async () => {} } as unknown as SharinganSession;
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 300, pollMs: 50, open: async () => stuck });
  assert.ok(phase !== "captured", "timed out without a successful capture");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-ensure.test.ts`
Expected: FAIL — `ensureCaptured`/`capturedPageCount` not exported.

- [ ] **Step 3: Implement `ensureCaptured` + `capturedPageCount`**

In `apps/daemon/src/sharingan-handler.ts`:

```ts
export function capturedPageCount(id: string): number {
  return get(id).pages.length;
}

export async function ensureCaptured(
  id: string,
  dataDir: string,
  url: string,
  opts: { maxWaitMs?: number; pollMs?: number; open?: (url: string, o: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> } = {},
): Promise<Phase> {
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const pollMs = opts.pollMs ?? 500;
  const c = get(id);
  if (c.phase === "captured") return c.phase;
  // Kick the entry capture if nothing is in flight (idle, or retry after a prior error).
  if (c.phase === "idle" || c.phase === "error") {
    const profileDir = join(dataDir, ".sharingan-profile");
    void startCapture(id, url, dataDir, profileDir, opts.open);
  }
  // Poll until a terminal phase, waiting through "login-required" (the user signs in via the
  // tab + Continue). Time out (don't hang) so the build proceeds best-effort even if login stalls.
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const phase = get(id).phase;
    if (phase === "captured" || phase === "error") return phase;
    if (Date.now() >= deadline) return phase;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-ensure.test.ts`
Expected: PASS (3/3). Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/test/sharingan-ensure.test.ts
git commit -m "feat(sharingan): ensureCaptured — kick + await the entry capture before build"
```

---

## Task 2: run-handler capture-before-build + context + skip Research (daemon)

**Files:**
- Modify: `apps/daemon/src/run-handler.ts` (the sharingan block after Research / before the build loop; the Research gate at ~636)
- Test: `apps/daemon/test/sharingan-run.test.ts` (new)

**Interfaces:**
- Consumes: `ensureCaptured` + `capturedPageCount` (Task 1); `buildSharinganContext` + `SHARINGAN_PAGE_BUDGET` (Phase 4); `project` (`.sharingan`/`.sourceUrl`), `origin` (`= requestOrigin(req)`), `deps.dataDir`, `agentBrief`.
- Produces: for a `sharingan` project, the entry capture runs before the build turn, `agentBrief` gains the sharingan prompt block, and Research is skipped.

**Note to implementer:** READ `run-handler.ts` around the reconnaissance anchors before editing (line numbers approximate): brief/context assembly ~566-594, `origin = requestOrigin(req)` ~569, `project = store.getProject(...)` ~492, the Research gate `if (!alreadyResearched && body.research !== false && (...))` ~636, and the standard-mode build loop start ~794/858. Import `ensureCaptured`, `capturedPageCount` from `./sharingan-handler.ts`, `buildSharinganContext` from `./sharingan-context.ts`, and `SHARINGAN_PAGE_BUDGET` from `./sharingan-browser.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-run.test.ts`. Read `apps/daemon/test/runs.test.ts` first to copy its harness — how it builds `createApp` with a **`FakeRunner`** (the injectable agent runner) + a fake standard-project setup, and how it POSTs `/api/runs` and reads the SSE. The test drives a real (Chrome-gated) entry capture of a local fixture, a FakeRunner that records the `message` (agentBrief) it receives and touches a file to satisfy the "files changed" check, and asserts the wiring:

```ts
// Sketch — fill in from runs.test.ts's harness:
test("a sharingan run captures the site, injects the context, and skips research", { skip: !findChrome() && "no Chrome" }, async () => {
  // fixture http server serving a simple page; sourceUrl = fixture url
  // project = store.createProject({ name, mode:"standard", sharingan:true, sourceUrl: fixture })
  // FakeRunner captures the message it's given + writes a file into projectDir so the run "succeeds"
  // createApp({ store, dataDir, standardProjectSetup: async()=>{}, makeRunner: () => fakeRunner, ... })  // match runs.test.ts's seam names
  // POST /api/runs { projectId, brief: fixtureUrl, research: undefined }  (research NOT forced off by the client)
  // read the run SSE to completion
  assert.ok(existsSync(join(projectDir(dataDir, project.id), ".sharingan", "pages.json")), "entry capture ran before the build");
  assert.match(fakeRunner.lastMessage, /RECONSTRUCT|\/api\/sharingan\/[^/]*\/capture/, "sharingan context injected into the agent brief");
  assert.ok(!existsSync(join(projectDir(dataDir, project.id), "research")), "research was skipped for the sharingan project");
});
```
(The exact FakeRunner seam + createApp options come from `runs.test.ts`. If the run harness is too heavy to reproduce, at minimum assert the two observable outcomes: the `.sharingan/pages.json` bundle exists post-run, and the recorded agent message contains the sharingan context.)

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-run.test.ts`
Expected: FAIL — the agent message has no sharingan context / no `.sharingan` bundle was written by the run.

- [ ] **Step 3: Skip Research for sharingan**

At the Research gate (~636), add `&& !project.sharingan`:
```ts
if (!alreadyResearched && body.research !== false && (body.research === true || settings.researchEnabled || process.env.DEZIN_RESEARCH === "1") && !project.sharingan) {
```

- [ ] **Step 4: Capture-before-build + inject the context**

After the Research phase completes and before the standard-mode build loop (the reconnaissance's "after ~704, before ~794" window — place it where `agentBrief`, `project`, `origin`, `deps.dataDir` are all in scope and it runs once per build, not per repair round), add:
```ts
if (project.sharingan && project.sourceUrl) {
  sse({ type: "status", text: "Capturing the source site…" });
  await ensureCaptured(project.id, deps.dataDir, project.sourceUrl);
  agentBrief = [
    agentBrief,
    buildSharinganContext({
      projectId: project.id,
      sourceUrl: project.sourceUrl,
      origin: origin ?? "",
      budget: SHARINGAN_PAGE_BUDGET,
      capturedCount: capturedPageCount(project.id),
    }).promptBlock,
  ].filter(Boolean).join("\n\n");
}
```
(Match the actual `sse(...)` event-shape the file uses; if `status` isn't a valid type, use an existing progress-event type or drop the `sse` line — it's optional. Ensure this runs BEFORE `turnMessage` is derived from `agentBrief`, so the first build turn sees the injected context.)

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-run.test.ts`
Expected: PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS. Also confirm a NON-sharingan run is unaffected — if `runs.test.ts` weren't hanging it would prove this; instead, reason it through in the report (the new code is gated on `project.sharingan`, and the Research gate only ANDs a new false-for-sharingan term).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/run-handler.ts apps/daemon/test/sharingan-run.test.ts
git commit -m "feat(sharingan): run-handler captures before build, injects context, skips research"
```

---

## Feature complete

After Phase 5, Sharingan works end-to-end: create a clone project (double-click "Start a design" → URL → affirmation) → the workspace opens the Sharingan tab → the build run captures the entry page (login-pausable) → the Agent probes ≤6 key pages via the endpoints and reconstructs a Standard project from the `.sharingan/` bundle → Preview / Visual Review run as usual.

**Before the eventual merge to main** (triage the carried Minors): the `/capture` budget TOCTOU (reserve a slot synchronously); a `closeAllSharinganSessions()` in the daemon `shutdown()` path; and bump the root `package.json` version.
