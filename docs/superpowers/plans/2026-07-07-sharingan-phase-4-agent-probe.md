# Sharingan Phase 4 — Agent-Probe Endpoints & Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the build Agent drive the daemon's headful browser during a Sharingan build — navigate/click/scroll/read a live probe session and capture a bounded set of key pages into the `.sharingan/` bundle — guided by an injected prompt block, authenticating with the daemon token.

**Architecture:** A single lazily-opened, idle-released **probe session** lives on the existing capture registry (reusing `c.session` + `emit`, so the Phase-3 tab shows the Agent's activity). Token-gated browser-control endpoints operate on it. A budget-enforced `/capture` writes each page into the bundle via a new `captureCurrentPage` (extracted from `capturePage`) + a durable `pages.json` manifest. `sharingan-context.ts` builds the Agent prompt block (mirroring `project-effect-context.ts`); the daemon token is injected into the agent subprocess env.

**Tech Stack:** daemon node:http; puppeteer-core `SharinganSession`; `node --test` (Chrome-gated + pure); the `project-effect-context`/`buildAgentEnv`/`releaseDevServer` patterns.

## Global Constraints

- **Branch:** continue on `feat/sharingan`. **NO `Co-Authored-By` trailer. NO version bump** (bump at feature landing).
- **Builds on Phases 1-3:** `SharinganSession` (navigate/screenshot/readDom/styleTokens/discoverLinks/click/scroll/close, `bringToFront`); the capture registry `Capture { phase, steps, pages, session?, listeners, url?, error? }` + `get(id)`/`emit(c, step)`/`startCapture` in `sharingan-handler.ts`; `capturePage`/`CapturedPage` in `sharingan-capture.ts`; routes in `app.ts`; `SHARINGAN_PAGE_BUDGET = 6`.
- **Probe endpoints are token-gated** (`x-dezin-daemon-token`, NOT `publicRead`) — they drive a browser carrying the user's authenticated persistent profile; a `publicRead` route would let any local process navigate it (CSRF/session-exfiltration). The Agent authenticates via `DEZIN_DAEMON_TOKEN`, injected into the agent env (Task 5).
- **Budget:** at most `SHARINGAN_PAGE_BUDGET` (6) pages captured per project; `/capture` refuses beyond it. Enforced daemon-side via `c.pages.length`.
- **Probe session lifecycle:** lazily opened on the first probe call (persistent profile → login persists), reused across calls, **idle-released** after `SHARINGAN_PROBE_IDLE_MS` (mirroring `releaseDevServer`). Only opens when the entry capture is not mid-flight (`phase` not `capturing`/`login-required`).
- **Guardrails (in the context block):** reconstruct, don't rip; brand assets (logos, photography, verbatim copy) are placeholders; stay within the page budget; same-origin only.
- **Daemon tests:** `node --test` under `apps/daemon/test/`; Chrome-gated tests `{ skip: !findChrome() && "no Chrome" }` against LOCAL fixtures; run individual files (`node --test <file>`), never the full suite (pre-existing `runs`/`variants` hang).

## File Structure

- `apps/daemon/src/sharingan-capture.ts` — extract `captureCurrentPage`; `capturePage` uses it; `CapturedPage` gains `links: string[]`; add `writePagesManifest`.
- `apps/daemon/src/sharingan-handler.ts` — probe-session lifecycle (`ensureProbeSession` + idle timer, `probeTimer` on `Capture`); handlers `navigate`/`click`/`scroll`/`readDom`/`computedStyles`/`links`/`capture`.
- `apps/daemon/src/app.ts` — routes for the 7 probe endpoints.
- `apps/daemon/src/sharingan-context.ts` (new) — `buildSharinganContext(...)`.
- `apps/daemon/src/agent-env.ts` — inject `DEZIN_DAEMON_TOKEN`.

---

## Task 1: Extract `captureCurrentPage` + `links` + manifest (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-capture.ts`
- Test: `apps/daemon/test/sharingan-capture.test.ts` (extend)

**Interfaces:**
- Consumes: `SharinganSession` (`setViewport`/`screenshot`/`readDom`/`styleTokens`/`discoverLinks`), `VIEWPORTS`.
- Produces: `captureCurrentPage(session, projectDir, url, onStep): Promise<CapturedPage>` (captures the CURRENT page — no navigate, no login-check); `CapturedPage` gains `links: string[]`; `capturePage` now = navigate + login-check + `captureCurrentPage`; `writePagesManifest(projectDir, sourceUrl, pages): void` writes `<projectDir>/.sharingan/pages.json`.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/test/sharingan-capture.test.ts` (Chrome-gated — reuse the file's fixture pattern):

```ts
test("captureCurrentPage captures the current page without navigating + records links", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><title>T</title><h1>Acme</h1><p>' + "w ".repeat(40) + '</p><a href="/pricing">Pricing</a>'); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-cur-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-cur-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    assert.ok(page.screenshots.desktop, "wrote a desktop screenshot path");
    assert.ok(page.links.some((l) => l.endsWith("/pricing")), "recorded the same-origin link");
    assert.ok(existsSync(join(dir, page.screenshots.desktop)), "the screenshot file exists");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-capture.test.ts`
Expected: FAIL — `captureCurrentPage` not exported / `page.links` undefined.

- [ ] **Step 3: Refactor `capturePage` + add `captureCurrentPage`, `links`, `writePagesManifest`**

In `apps/daemon/src/sharingan-capture.ts`:

- Add `links` to `CapturedPage`:
```ts
export interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string; links: string[] }
```
- Extract the current-page-capture body into `captureCurrentPage` (everything the old `capturePage` did AFTER the login check — the mkdir, per-viewport screenshots, dom.json, styles.json, links, title). It reads the DOM itself for the title:
```ts
export async function captureCurrentPage(session: SharinganSession, projectDir: string, url: string, onStep: (s: CaptureStep) => void): Promise<CapturedPage> {
  const step = (kind: CaptureStep["kind"], text: string) => onStep({ at: Date.now(), kind, text });
  const rel = join(".sharingan", pageDir(url));
  mkdirSync(join(projectDir, rel), { recursive: true });

  const screenshots: Record<string, string> = {};
  for (const v of VIEWPORTS) {
    await session.setViewport(v);
    step("screenshot", `Capturing ${v.label} (${v.width}px)`);
    const shot = await session.screenshot({ fullPage: true });
    const shotRel = join(rel, `shot-${v.label}.png`);
    writeFileSync(join(projectDir, shotRel), shot);
    screenshots[v.label] = shotRel;
  }

  step("dom", "Reading DOM structure");
  const dom = await session.readDom(400);
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));

  step("styles", "Reading computed style tokens");
  const styleRel = join(rel, "styles.json");
  writeFileSync(join(projectDir, styleRel), JSON.stringify(await session.styleTokens(), null, 0));

  step("links", "Discovering same-origin links");
  const links = await session.discoverLinks();

  const title = (dom.find((n) => n.tag === "h1")?.text || url).slice(0, 80);
  step("done", "Capture complete");
  return { url, title, screenshots, dom: domRel, styles: styleRel, links };
}
```
- Rewrite `capturePage` to reuse it (preserving its navigate + login-detection behavior):
```ts
export async function capturePage(session: SharinganSession, projectDir: string, url: string, onStep: (s: CaptureStep) => void): Promise<{ page: CapturedPage | null; loginRequired: boolean }> {
  const step = (kind: CaptureStep["kind"], text: string) => onStep({ at: Date.now(), kind, text });
  step("navigate", `Navigating to ${url}`);
  const nav = await session.navigate(url);
  const dom = await session.readDom(400);
  const hasPasswordField = await session.hasPasswordField();
  const textLength = dom.reduce((a, n) => a + n.text.length, 0);
  if (detectLoginWall({ status: nav.status, finalUrl: nav.finalUrl, hasPasswordField, textLength })) {
    step("login-required", `This page needs a login (${nav.finalUrl}). Sign in, then continue.`);
    return { page: null, loginRequired: true };
  }
  const page = await captureCurrentPage(session, projectDir, url, onStep);
  return { page, loginRequired: false };
}
```
- Add the manifest writer:
```ts
export function writePagesManifest(projectDir: string, sourceUrl: string, pages: CapturedPage[]): void {
  mkdirSync(join(projectDir, ".sharingan"), { recursive: true });
  const manifest = { sourceUrl, pages: pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots, dom: p.dom, styles: p.styles, links: p.links })) };
  writeFileSync(join(projectDir, ".sharingan", "pages.json"), JSON.stringify(manifest, null, 2));
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-capture.test.ts`
Expected: PASS (the new test + the existing `capturePage` tests — its external behavior is unchanged). Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS (note: `CapturedPage` gained `links`; `sharingan-handler.ts` builds no `CapturedPage` literals so it's unaffected, but confirm).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "feat(sharingan): extract captureCurrentPage + record links + pages.json manifest"
```

---

## Task 2: Probe-session lifecycle + `POST /navigate` (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (`navigate` refreshes `this.origin` from the final URL)
- Modify: `apps/daemon/src/sharingan-handler.ts` (`SHARINGAN_PROBE_IDLE_MS`; `Capture.probeTimer`; `ensureProbeSession`; `releaseProbeSession`; `handleSharinganNavigate`)
- Modify: `apps/daemon/src/app.ts` (route `POST /navigate`)
- Test: `apps/daemon/test/sharingan-probe.test.ts` (new)

**Interfaces:**
- Consumes: `SharinganSession.open`/`navigate`/`close`, the capture registry.
- Produces: `ensureProbeSession(id, dataDir, open?): Promise<SharinganSession>` (lazily opens on `c.session` when idle, resets the idle timer, sets `phase="probing"`; throws if the entry capture is mid-flight); `handleSharinganNavigate(req, res, id, dataDir): Promise<void>` → `{ status, finalUrl }`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-probe.test.ts` (Chrome-gated for the real path; also a no-Chrome guard test via DI). Test that navigate lazily opens a session, emits a step, and returns status; and that a mid-capture guard rejects:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";

test("POST /navigate lazily opens a probe session and returns status", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>T</title><h1>Acme</h1>"); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-nav-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/sharingan/${project.id}/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: number; finalUrl: string };
    assert.equal(body.status, 200);
    assert.ok(body.finalUrl.startsWith("http://127.0.0.1"));
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts`
Expected: FAIL — `/navigate` route 404s (`status` not 200).

(`--test-force-exit`: a lazily-opened probe session + its idle timer can keep the loop alive; force-exit ends the run. Also `unref()` the idle timer so it never blocks exit.)

- [ ] **Step 3: Add the probe-session lifecycle**

First, in `apps/daemon/src/sharingan-browser.ts`, make `navigate` refresh `this.origin` from the final URL so `discoverLinks`' same-origin filter tracks the current page (resolving the long-standing "origin frozen at open()" note — the probe navigates freely, so a stale origin would make `/links` return zero after a cross-origin hop). In `navigate`, replace the final `return`:

```ts
    const finalUrl = this.page.url();
    try { this.origin = new URL(finalUrl).origin; } catch { /* keep the prior origin on an unparseable url */ }
    return { status: res?.status() ?? 0, finalUrl };
```

Then, in `apps/daemon/src/sharingan-handler.ts`:
- Add a constant near the top: `const SHARINGAN_PROBE_IDLE_MS = 120_000;`
- Add `probeTimer?: ReturnType<typeof setTimeout>` to the `Capture` interface.
- Add the lifecycle helpers:
```ts
function armProbeIdle(id: string): void {
  const c = get(id);
  if (c.probeTimer) clearTimeout(c.probeTimer);
  c.probeTimer = setTimeout(() => { void releaseProbeSession(id); }, SHARINGAN_PROBE_IDLE_MS);
  c.probeTimer.unref?.();
}

async function releaseProbeSession(id: string): Promise<void> {
  const c = get(id);
  if (c.probeTimer) { clearTimeout(c.probeTimer); c.probeTimer = undefined; }
  if (c.phase !== "probing") return;
  const s = c.session; c.session = undefined; c.phase = "captured";
  if (s) await s.close().catch(() => {});
}

export async function ensureProbeSession(
  id: string,
  dataDir: string,
  open: (url: string, opts: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> = SharinganSession.open,
): Promise<SharinganSession> {
  const c = get(id);
  if (c.phase === "capturing" || c.phase === "login-required") throw new Error("capture in progress");
  if (!c.session) {
    const profileDir = join(dataDir, ".sharingan-profile");
    c.session = await open(c.url ?? "about:blank", { userDataDir: profileDir, headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1" });
    c.phase = "probing";
  }
  armProbeIdle(id);
  return c.session;
}
```
(Add `"probing"` to the `Phase` union.)

- [ ] **Step 4: Add the navigate handler + route**

Handler in `sharingan-handler.ts`:
```ts
export async function handleSharinganNavigate(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "a valid http(s) url is required" }); return; }
  try {
    const session = await ensureProbeSession(id, dataDir);
    const c = get(id);
    emit(c, { at: Date.now(), kind: "navigate", text: `Agent navigating to ${url}` });
    const nav = await session.navigate(url);
    sendJson(res, 200, nav);
  } catch (err) {
    sendJson(res, 409, { error: err instanceof Error ? err.message : "navigate failed" });
  }
}
```
Route in `app.ts` (import the handler):
```ts
  {
    method: "POST",
    pattern: "/api/sharingan/:id/navigate",
    handler: (req, res, p, deps) => handleSharinganNavigate(req, res, p.id!, deps.dataDir),
  },
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts`
Expected: PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-probe.test.ts
git commit -m "feat(sharingan): lazy probe session (idle-released) + POST /navigate"
```

---

## Task 3: Granular probe endpoints — click/scroll/read-dom/computed-styles/links (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts` (5 handlers)
- Modify: `apps/daemon/src/app.ts` (5 routes)
- Test: `apps/daemon/test/sharingan-probe.test.ts` (extend)

**Interfaces:**
- Consumes: `ensureProbeSession` (Task 2); `SharinganSession.click`/`scroll`/`readDom`/`styleTokens`/`discoverLinks`.
- Produces: `handleSharinganReadDom`/`handleSharinganComputedStyles`/`handleSharinganLinks` (GET → JSON) and `handleSharinganClick`/`handleSharinganScroll` (POST → `{ok:true}`), each operating on the live probe session + emitting a step + resetting idle.

- [ ] **Step 1: Write the failing test**

Extend `sharingan-probe.test.ts` — after a `/navigate`, exercise `/links` and `/read-dom` and `/click`:

```ts
test("probe read + interact endpoints operate on the live session", { skip: !findChrome() && "no Chrome" }, async () => {
  // ... same setup: fixture serves <h1>Acme</h1><a href="/pricing">Pricing</a><button id="b">Go</button>, start app ...
  // POST /navigate {url}
  await fetch(`${base}/api/sharingan/${id}/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
  const links = (await (await fetch(`${base}/api/sharingan/${id}/links`)).json()) as string[];
  assert.ok(links.some((l) => l.endsWith("/pricing")));
  const dom = (await (await fetch(`${base}/api/sharingan/${id}/read-dom`)).json()) as { tag: string }[];
  assert.ok(dom.some((n) => n.tag === "h1"));
  const click = await fetch(`${base}/api/sharingan/${id}/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selector: "#b" }) });
  assert.equal(click.status, 200);
  // teardown ...
});
```
(Build the full test body from Task 2's harness; serve HTML with an `#b` button + a `/pricing` link.)

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts`
Expected: FAIL — the new routes 404.

- [ ] **Step 3: Add the 5 handlers**

In `sharingan-handler.ts` (each does `ensureProbeSession` → operate → `emit` → respond; a helper reduces repetition):

```ts
async function withProbe<T>(id: string, dataDir: string, kind: CaptureStep["kind"], text: string, fn: (s: SharinganSession) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const s = await ensureProbeSession(id, dataDir);
    emit(get(id), { at: Date.now(), kind, text });
    return { ok: true, value: await fn(s) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "probe failed" };
  }
}

export async function handleSharinganReadDom(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "dom", "Agent reading DOM", (s) => s.readDom(400));
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}
export async function handleSharinganComputedStyles(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "styles", "Agent reading styles", (s) => s.styleTokens());
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}
export async function handleSharinganLinks(res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const r = await withProbe(id, dataDir, "links", "Agent listing links", (s) => s.discoverLinks());
  r.ok ? sendJson(res, 200, r.value) : sendJson(res, 409, { error: r.error });
}
export async function handleSharinganClick(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { selector?: string };
  const selector = typeof body.selector === "string" ? body.selector : "";
  if (!selector) { sendJson(res, 400, { error: "selector required" }); return; }
  const r = await withProbe(id, dataDir, "navigate", `Agent clicking ${selector}`, (s) => s.click(selector));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}
export async function handleSharinganScroll(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { y?: number };
  const y = typeof body.y === "number" ? body.y : 0;
  const r = await withProbe(id, dataDir, "navigate", `Agent scrolling to ${y}`, (s) => s.scroll(y));
  r.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: r.error });
}
```

- [ ] **Step 4: Add the 5 routes**

In `app.ts` (import the handlers):
```ts
  { method: "GET",  pattern: "/api/sharingan/:id/read-dom",        handler: (_req, res, p, deps) => handleSharinganReadDom(res, p.id!, deps.dataDir) },
  { method: "GET",  pattern: "/api/sharingan/:id/computed-styles", handler: (_req, res, p, deps) => handleSharinganComputedStyles(res, p.id!, deps.dataDir) },
  { method: "GET",  pattern: "/api/sharingan/:id/links",           handler: (_req, res, p, deps) => handleSharinganLinks(res, p.id!, deps.dataDir) },
  { method: "POST", pattern: "/api/sharingan/:id/click",           handler: (req, res, p, deps) => handleSharinganClick(req, res, p.id!, deps.dataDir) },
  { method: "POST", pattern: "/api/sharingan/:id/scroll",          handler: (req, res, p, deps) => handleSharinganScroll(req, res, p.id!, deps.dataDir) },
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts`
Expected: PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-probe.test.ts
git commit -m "feat(sharingan): granular probe endpoints (read-dom/computed-styles/links/click/scroll)"
```

---

## Task 4: `POST /capture` — budget-enforced bundle write + manifest (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts` (`handleSharinganCapture`; entry `startCapture` + `continueCapture` also write the manifest)
- Modify: `apps/daemon/src/app.ts` (route `POST /capture`)
- Test: `apps/daemon/test/sharingan-probe.test.ts` (extend) + `apps/daemon/test/sharingan-shot.test.ts` if the manifest needs a unit

**Interfaces:**
- Consumes: `ensureProbeSession`; `captureCurrentPage` + `writePagesManifest` (Task 1); `SHARINGAN_PAGE_BUDGET`.
- Produces: `handleSharinganCapture(req, res, id, dataDir)` — captures the CURRENT probe-session page into the bundle (or navigates to `body.url` first), enforces the budget (`c.pages.length >= SHARINGAN_PAGE_BUDGET` → 200 `{ skipped: "budget" }`), pushes to `c.pages`, writes `pages.json`, returns the `CapturedPage`. `startCapture`/`continueCapture` call `writePagesManifest` after a successful page.

- [ ] **Step 1: Write the failing test**

Extend `sharingan-probe.test.ts`:

```ts
test("POST /capture writes the page into the bundle + pages.json, and refuses beyond budget", { skip: !findChrome() && "no Chrome" }, async () => {
  // ... setup: fixture + app + a sharingan project with sourceUrl=target ...
  await fetch(`${base}/api/sharingan/${id}/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
  const cap = await fetch(`${base}/api/sharingan/${id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(cap.status, 200);
  const page = (await cap.json()) as { url: string; screenshots: Record<string,string>; skipped?: string };
  assert.ok(page.screenshots?.desktop, "returned a captured page with screenshots");
  assert.ok(existsSync(join(projectDir(dataDir, id), ".sharingan", "pages.json")), "wrote the pages.json manifest");
  // status now reports the captured page
  const status = (await (await fetch(`${base}/api/sharingan/${id}/status`)).json()) as { pages: unknown[] };
  assert.equal(status.pages.length, 1);
});
```
(Import `projectDir` from `../src/serve-static.ts`. Optionally add a pure over-budget unit if convenient — pre-fill `c.pages` to 6 is not reachable without a seam, so the budget path can be asserted by capturing in a loop up to the budget + asserting the next is `{skipped:"budget"}`, or left as a documented behavior + covered by reading; prefer the loop if fast enough.)

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts`
Expected: FAIL — `/capture` route 404s.

- [ ] **Step 3: Add the capture handler + manifest writes**

In `sharingan-handler.ts` (import `captureCurrentPage`, `writePagesManifest`, `SHARINGAN_PAGE_BUDGET`):
```ts
export async function handleSharinganCapture(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const c = get(id);
  if (c.pages.length >= SHARINGAN_PAGE_BUDGET) { sendJson(res, 200, { skipped: "budget", budget: SHARINGAN_PAGE_BUDGET }); return; }
  const body = (await readJsonBody(req)) as { url?: string };
  try {
    const session = await ensureProbeSession(id, dataDir);
    if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
      emit(c, { at: Date.now(), kind: "navigate", text: `Agent navigating to ${body.url}` });
      await session.navigate(body.url.trim());
    }
    const page = await captureCurrentPage(session, projectDir(dataDir, id), session.currentUrl(), (s) => emit(c, s));
    c.pages.push(page);
    writePagesManifest(projectDir(dataDir, id), c.url ?? page.url, c.pages);
    armProbeIdle(id);
    sendJson(res, 200, page);
  } catch (err) {
    sendJson(res, 409, { error: err instanceof Error ? err.message : "capture failed" });
  }
}
```
Also, in `startCapture` (after `c.pages.push(page)`) and `continueCapture` (after `c.pages.push(page)`), add `writePagesManifest(projectDir(dataDir, id), c.url ?? page.url, c.pages);` so the entry capture also produces the manifest.

- [ ] **Step 4: Add the route**

```ts
  { method: "POST", pattern: "/api/sharingan/:id/capture", handler: (req, res, p, deps) => handleSharinganCapture(req, res, p.id!, deps.dataDir) },
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test --test-force-exit apps/daemon/test/sharingan-probe.test.ts` and the entry-capture tests (`sharingan-handler.test.ts`, `sharingan-continue.test.ts`) → all PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-probe.test.ts
git commit -m "feat(sharingan): POST /capture (budget-enforced) + pages.json manifest on every capture"
```

---

## Task 5: Inject `DEZIN_DAEMON_TOKEN` into the agent env (daemon)

**Files:**
- Modify: `apps/daemon/src/agent-env.ts` (add the token to the built env)
- Test: `apps/daemon/test/agent-env.test.ts` (extend)

**Interfaces:**
- Produces: `buildAgentEnv` output includes `DEZIN_DAEMON_TOKEN` when a token is available to the daemon.

**Note:** Read `agent-env.ts` first to see how `buildAgentEnv` receives its inputs and how the daemon's token is reachable (it's generated in `start.ts` and passed through `deps`/config). Thread the token in the least-invasive way the existing structure allows (a `token` field on the input, sourced from the same place `deps.security` gets it). If the token is not readily threadable to `buildAgentEnv` without larger plumbing, fall back to `process.env.DEZIN_DAEMON_TOKEN` (start.ts already honors it) and document the limitation.

- [ ] **Step 1: Write the failing test**

Extend `apps/daemon/test/agent-env.test.ts`:
```ts
test("buildAgentEnv includes the daemon token so the agent can call gated endpoints", () => {
  const env = buildAgentEnv({ /* existing required inputs */, daemonToken: "tok-123" } as any);
  assert.equal(env.DEZIN_DAEMON_TOKEN, "tok-123");
});
```
(Match the real `buildAgentEnv` signature — read it first; add a `daemonToken?: string` input if that's the clean seam.)

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/agent-env.test.ts`
Expected: FAIL — `DEZIN_DAEMON_TOKEN` undefined.

- [ ] **Step 3: Inject the token**

In `agent-env.ts`, add `daemonToken?: string` to the input and set `if (daemonToken) env.DEZIN_DAEMON_TOKEN = daemonToken;`. Then update the ONE call site (in `run-handler.ts` where `buildAgentEnv`/`agentEnv` is constructed — grep for it) to pass the daemon token the daemon already holds (the same value `deps.security` uses; or `process.env.DEZIN_DAEMON_TOKEN`).

- [ ] **Step 4: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/agent-env.test.ts` → PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-env.ts apps/daemon/src/run-handler.ts apps/daemon/test/agent-env.test.ts
git commit -m "feat(sharingan): inject DEZIN_DAEMON_TOKEN into the agent env for gated probe calls"
```

---

## Task 6: `sharingan-context.ts` — the Agent prompt block (daemon)

**Files:**
- Create: `apps/daemon/src/sharingan-context.ts`
- Test: `apps/daemon/test/sharingan-context.test.ts` (new)

**Interfaces:**
- Produces: `buildSharinganContext(input: { sourceUrl: string; origin: string; budget: number; capturedCount: number }): { promptBlock: string }` — mirroring `buildProjectEffectContext`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-context.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSharinganContext } from "../src/sharingan-context.ts";

test("buildSharinganContext lists the probe endpoints, budget, and guardrails", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /example\.com/);
  assert.match(promptBlock, /\/api\/sharingan\/[^/]*\/capture/);         // tells the agent how to capture
  assert.match(promptBlock, /\/navigate/);
  assert.match(promptBlock, /x-dezin-daemon-token/);                      // auth
  assert.match(promptBlock, /DEZIN_DAEMON_TOKEN/);
  assert.match(promptBlock, /6/);                                          // budget
  assert.match(promptBlock, /reconstruct/i);                              // guardrail: reconstruct not rip
  assert.match(promptBlock, /placeholder/i);                              // guardrail: brand assets as placeholders
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-context.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the context builder**

Create `apps/daemon/src/sharingan-context.ts` (mirror `buildProjectEffectContext`'s shape; `:id` is filled by the agent from its run context — use `<projectId>` as a placeholder the prompt tells the agent to substitute, OR pass the id in and interpolate it; simplest: pass `projectId` in and interpolate):

```ts
export interface SharinganContextInput { projectId: string; sourceUrl: string; origin: string; budget: number; capturedCount: number }

export function buildSharinganContext(input: SharinganContextInput): { promptBlock: string } {
  const { projectId, sourceUrl, origin, budget, capturedCount } = input;
  const base = `${origin}/api/sharingan/${projectId}`;
  const promptBlock = [
    "## Sharingan — Reconstruct from Capture",
    `You are reconstructing the website ${sourceUrl} as a high-fidelity Standard (Vite + React) project. This is a RECONSTRUCTION of structure and design language — NOT a byte-for-byte copy. Treat logos, brand photography, and verbatim marketing copy as swappable placeholders; rebuild layout, components, and design tokens.`,
    "",
    "The entry page is already captured under `.sharingan/` (screenshots, dom.json, styles.json) and indexed in `.sharingan/pages.json` (which also lists the entry page's same-origin links). Read those files directly to understand the site.",
    "",
    "You may drive the live browser to explore + capture additional key pages by calling these local endpoints (send the `x-dezin-daemon-token` header with the `DEZIN_DAEMON_TOKEN` environment variable):",
    `- Navigate: POST ${base}/navigate  body {"url":"..."}`,
    `- Inspect: GET ${base}/read-dom , GET ${base}/computed-styles , GET ${base}/links`,
    `- Interact: POST ${base}/click {"selector":"..."} , POST ${base}/scroll {"y":1200}`,
    `- Capture the current page into the bundle: POST ${base}/capture  (optionally {"url":"..."} to navigate first)`,
    "",
    `Page budget: capture at most ${budget} pages total (captured so far: ${capturedCount}). Pick the highest-value pages (nav destinations, pricing, product, key flows). Stay same-origin. A /capture that returns {"skipped":"budget"} means you're at the cap — stop capturing and build from what you have.`,
    "",
    "Then build the project from the captured bundle: reproduce the structure, layout, and design tokens; use placeholder assets/copy for brand-owned content.",
  ].join("\n");
  return { promptBlock };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-context.test.ts` → PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sharingan-context.ts apps/daemon/test/sharingan-context.test.ts
git commit -m "feat(sharingan): sharingan-context.ts — Agent probe/reconstruct prompt block"
```

---

## Roadmap (context — not implemented here)

- **Phase 5:** `run-handler` capture-before-build integration — when `project.sharingan`, run the entry capture before the build turn, inject `buildSharinganContext(...)`'s prompt block into `agentBrief` (alongside moodboard/effect context), pass `research:false`, and build from the `.sharingan/` bundle. Visual Review / auto-improve run as usual.
