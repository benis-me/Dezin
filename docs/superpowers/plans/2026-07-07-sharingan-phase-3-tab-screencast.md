# Sharingan Phase 3 — Tab (work-log + results + login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Sharingan project a workspace "Sharingan" tab that streams the capture's work-log while running, shows image-rich results (captured pages + screenshots) when done, and — when a login wall is hit — shows a prompt with a button that raises the controlled headful Chrome window plus a Continue button to resume.

**Architecture:** No live video mirror. The daemon keeps the browser **headful** (login + anti-bot fidelity); the tab reuses the existing capture **action-log** (`/events` SSE) for the running record and the capture's own **screenshots** (`.sharingan/<page>/shot-*.png`) for the image-rich results. New daemon surface: `POST /continue` (resume after login), `POST /focus` (raise the Chrome window), status enriched with per-page screenshot paths, and a shot-serving endpoint. (CDP `Page.startScreencast` is intentionally deferred — not built here.)

**Tech Stack:** puppeteer-core 25 (`page.bringToFront()`); daemon node:http SSE + static file serving; `node --test` (Chrome-gated + pure); web React + Vite + vitest; existing `consumeSse`/`parseSseBlock` + asset-URL helpers in `apps/web/src/lib/api.ts`.

## Global Constraints

- **Branch:** continue on `feat/sharingan`. **NO `Co-Authored-By` trailer. NO version bump** (bump only at feature landing).
- **Builds on Phases 1 & 2:** `SharinganSession` (`this.page`/`this.browser`/`close()`, `screenshot`, `navigate`…); the capture registry + `startCapture`/`handleSharingan{Start,Status,Events}` in `sharingan-handler.ts`; routes at `app.ts` (`/api/sharingan/:id/{start,status,events}`); `capturePage` writes `<projectDir>/.sharingan/<page>/shot-<label>.png` + `dom.json` + `styles.json` and returns `CapturedPage { url, title, screenshots: Record<label, relPath>, dom, styles }`; web `Project` carries `sharingan`/`sourceUrl`.
- **Headful, read-only:** the browser is headful in production (login + fidelity). The tab does NOT mirror it live; login is user-driven in the raised Chrome window. Never bypass auth.
- **Login flow:** on `login-required`, the tab shows a prompt + a **"Open the browser"** button (`POST /focus` → raise the Chrome window) + a **Continue** button (`POST /continue` → re-run capture on the still-open, authenticated session).
- **Capture trigger:** the tab auto-starts the capture when it first activates and `phase === "idle"` (via `POST /start` with the project's `sourceUrl`), plus a manual "Re-capture" button.
- **Daemon tests:** `node --test` under `apps/daemon/test/`; Chrome-dependent tests gate `{ skip: !findChrome() && "no Chrome" }` against LOCAL fixtures; run individual files (`node --test <file>`), never the full suite (pre-existing `runs.test.ts`/`variants.test.ts` hang).
- **Web tests:** vitest; wrap in `ApiProvider`+`ToastProvider` with `makeFakeApi({…})`; the web declares its OWN types in `apps/web/src/lib/api.ts`.

## File Structure

- `apps/daemon/src/sharingan-browser.ts` — `SharinganSession.bringToFront()`.
- `apps/daemon/src/sharingan-handler.ts` — registry gains `url`; `startCapture` records `url`; `continueCapture` + `handleSharinganContinue`; `handleSharinganFocus`; `handleSharinganStatus` enriched with per-page screenshot paths; `handleSharinganShot` (serve a captured PNG).
- `apps/daemon/src/app.ts` — routes `POST /continue`, `POST /focus`, `GET /shot`.
- `apps/web/src/lib/api.ts` — `startSharingan`, `sharinganStatus`, `continueSharingan`, `focusSharingan`, `streamSharinganEvents`, `sharinganShotUrl` (+ types + `ApiClient` entries).
- `apps/web/src/test/fake-api.ts` — fakes for the new methods.
- `apps/web/src/screens/SharinganTab.tsx` (new) — the tab UI.
- `apps/web/src/screens/WorkspaceScreen.tsx` — the `"Sharingan"` tab (conditional + auto-select + render).

---

## Task 1: Session control for login — `/continue` + `/focus` (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (`bringToFront()`)
- Modify: `apps/daemon/src/sharingan-handler.ts` (`Capture.url`; `startCapture` records url; `continueCapture` + `handleSharinganContinue`; `handleSharinganFocus`)
- Modify: `apps/daemon/src/app.ts` (routes `POST /continue`, `POST /focus`)
- Test: `apps/daemon/test/sharingan-continue.test.ts` (new)

**Interfaces:**
- Consumes: `capturePage`, the registry, `session.close()`.
- Produces: `SharinganSession.bringToFront(): Promise<void>`; `continueCapture(id, dataDir): Promise<void>` (re-runs `capturePage` on the paused session when `phase==="login-required"`, else no-op); `handleSharinganContinue(res, id, dataDir): void` → 200 `{ok:true}`; `handleSharinganFocus(res, id): void` → raises the browser, 200 `{ok:true}`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-continue.test.ts` (no Chrome — DI fake session, mirroring the Phase-1 leak test):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startCapture, continueCapture, handleSharinganStatus, handleSharinganFocus } from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

function callHandler(fn: (res: import("node:http").ServerResponse) => void): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => fn(res));
    server.listen(0, "127.0.0.1", async () => {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/`);
      const json = await r.json().catch(() => null);
      server.close(() => resolve({ status: r.status, json }));
    });
  });
}

function makeFake(over: Partial<Record<string, unknown>> = {}): { session: SharinganSession; calls: string[] } {
  const calls: string[] = [];
  let nav = 0;
  const session = {
    navigate: async () => { calls.push("navigate"); return { status: nav++ === 0 ? 401 : 200, finalUrl: "http://x.test/" }; },
    readDom: async () => [{ tag: "h1", classes: "", text: "Home", box: { x: 0, y: 0, w: 10, h: 10 } }],
    hasPasswordField: async () => false,
    setViewport: async () => {},
    screenshot: async () => Buffer.from("x"),
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    discoverLinks: async () => [],
    bringToFront: async () => { calls.push("bringToFront"); },
    close: async () => { calls.push("close"); },
    ...over,
  } as unknown as SharinganSession;
  return { session, calls };
}

test("continueCapture resumes only from a login pause; focus raises the browser", async () => {
  const id = "cont";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cont-"));
  const { session, calls } = makeFake();

  await startCapture(id, "http://x.test/", dataDir, "/tmp/unused", async () => session);
  const s1 = await callHandler((res) => handleSharinganStatus(res, id));
  assert.equal(s1.json.phase, "login-required", "first capture hits the 401 login wall");

  // Focus raises the browser without changing phase.
  const f = await callHandler((res) => handleSharinganFocus(res, id));
  assert.equal(f.status, 200);
  assert.ok(calls.includes("bringToFront"), "focus called bringToFront on the session");

  await continueCapture(id, dataDir);
  const s2 = await callHandler((res) => handleSharinganStatus(res, id));
  assert.equal(s2.json.phase, "captured", "continue re-runs the capture on the authenticated session");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-continue.test.ts`
Expected: FAIL — `continueCapture` / `handleSharinganFocus` not exported.

- [ ] **Step 3: Add `bringToFront` to the session**

In `apps/daemon/src/sharingan-browser.ts`, add near `close()`:

```ts
  async bringToFront(): Promise<void> { await this.page.bringToFront().catch(() => {}); }
```

- [ ] **Step 4: Record the url + implement continue/focus in the handler**

In `apps/daemon/src/sharingan-handler.ts`:

- Add `url?: string` to the `Capture` interface:
```ts
interface Capture { phase: Phase; steps: CaptureStep[]; pages: CapturedPage[]; session?: SharinganSession; listeners: Set<ServerResponse>; url?: string; error?: string }
```
- In `startCapture`, record the url right after `c.session = session;`:
```ts
    c.url = url;
```
- Add the two functions:
```ts
export async function continueCapture(id: string, dataDir: string): Promise<void> {
  const c = get(id);
  if (c.phase !== "login-required" || !c.session || !c.url) return;
  c.phase = "capturing";
  try {
    const { page, loginRequired } = await capturePage(c.session, projectDir(dataDir, id), c.url, (s) => emit(c, s));
    if (loginRequired) { c.phase = "login-required"; return; }
    if (page) c.pages.push(page);
    await c.session.close();
    c.session = undefined;
    c.phase = "captured";
  } catch (err) {
    if (c.session) { await c.session.close().catch(() => {}); c.session = undefined; }
    c.error = err instanceof Error ? err.message : "capture failed";
    emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
    c.phase = "error";
  }
}

export function handleSharinganContinue(res: ServerResponse, id: string, dataDir: string): void {
  void continueCapture(id, dataDir);
  sendJson(res, 200, { ok: true });
}

export function handleSharinganFocus(res: ServerResponse, id: string): void {
  const c = get(id);
  void c.session?.bringToFront();
  sendJson(res, 200, { ok: true });
}
```

- [ ] **Step 5: Register the routes**

In `apps/daemon/src/app.ts` (import `handleSharinganContinue`, `handleSharinganFocus`), after the `/events` route:

```ts
  {
    method: "POST",
    pattern: "/api/sharingan/:id/continue",
    handler: (_req, res, p, deps) => handleSharinganContinue(res, p.id!, deps.dataDir),
  },
  {
    method: "POST",
    pattern: "/api/sharingan/:id/focus",
    handler: (_req, res, p) => handleSharinganFocus(res, p.id!),
  },
```

- [ ] **Step 6: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-continue.test.ts`
Expected: PASS. Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-continue.test.ts
git commit -m "feat(sharingan): POST /continue (resume after login) + /focus (raise the browser)"
```

---

## Task 2: Results — status screenshots + serve captured shots (daemon)

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts` (`handleSharinganStatus` returns per-page screenshot paths; add `handleSharinganShot`)
- Modify: `apps/daemon/src/app.ts` (route `GET /api/sharingan/:id/shot`)
- Test: `apps/daemon/test/sharingan-shot.test.ts` (new)

**Interfaces:**
- Consumes: the capture registry (`c.pages[].screenshots`); `projectDir(dataDir, id)`.
- Produces: `handleSharinganStatus` payload gains `pages: { url, title, screenshots: Record<string,string> }[]`; `handleSharinganShot(res, id, relPath, dataDir): void` serves `<projectDir>/.sharingan/<relPath>` as `image/png`, rejecting path traversal with 400 and a missing file with 404.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/test/sharingan-shot.test.ts` (no Chrome — write a fake shot under the project dir and fetch it):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { projectDir } from "../src/serve-static.ts";

test("GET /shot serves a captured screenshot and blocks path traversal", async () => {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-shot-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: "https://example.test/" });
  // Plant a fake shot where capturePage would write it.
  const shotDir = join(projectDir(dataDir, project.id), ".sharingan", "example-test");
  mkdirSync(shotDir, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
  writeFileSync(join(shotDir, "shot-desktop.png"), png);

  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("example-test/shot-desktop.png")}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.ok((await ok.arrayBuffer()).byteLength >= 8);

    const traversal = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("../../secret")}`);
    assert.equal(traversal.status, 400);

    const missing = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("example-test/nope.png")}`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-shot.test.ts`
Expected: FAIL — `/shot` route 404s / not registered.

- [ ] **Step 3: Enrich status + add the shot handler**

In `apps/daemon/src/sharingan-handler.ts`:

- Change the `handleSharinganStatus` pages mapping to include screenshots:
```ts
export function handleSharinganStatus(res: ServerResponse, id: string): void {
  const c = get(id);
  sendJson(res, 200, { phase: c.phase, steps: c.steps.length, pages: c.pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots })), error: c.error });
}
```
- Add the shot handler (imports: `join` from `node:path`, `createReadStream`/`existsSync`/`statSync` from `node:fs`, `projectDir` from `./serve-static.ts`):
```ts
export function handleSharinganShot(res: ServerResponse, id: string, relPath: string, dataDir: string): void {
  const rel = relPath.replace(/^[/\\]+/, "");
  if (rel.includes("..") || rel.includes("\0")) { sendJson(res, 400, { error: "bad path" }); return; }
  const abs = join(projectDir(dataDir, id), ".sharingan", rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) { sendJson(res, 404, { error: "not found" }); return; }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
  createReadStream(abs).pipe(res);
}
```

- [ ] **Step 4: Register the route**

In `apps/daemon/src/app.ts` (import `handleSharinganShot`; read the query — check how other GET routes read query params, e.g. via a `URL`/`req.url` parse the router already exposes):

```ts
  {
    method: "GET",
    pattern: "/api/sharingan/:id/shot",
    publicRead: true,
    handler: (req, res, p, deps) => handleSharinganShot(res, p.id!, new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "", deps.dataDir),
  },
```

**Auth (important):** this route is loaded by an `<img src>`, which cannot send the `x-dezin-daemon-token` header — so it must be reachable WITHOUT the token. Mirror however the existing asset routes (preview/research — the ones `previewUrl`/`researchAssetUrl` point at) declare this: if they use a `publicRead: true` flag on the route (the daemon is 127.0.0.1-only), use it here too (shown above); if instead they embed the token as a query param, drop `publicRead` and have `sharinganShotUrl` (Task 3) append the token the same way. Read one of those asset routes + its URL helper and match it exactly. (If the router already parses query params into a `params`/`query` object, use that instead of re-parsing `req.url`.)

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/sharingan-shot.test.ts`
Expected: PASS (200 + image/png; 400 traversal; 404 missing). Then `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-shot.test.ts
git commit -m "feat(sharingan): status exposes captured-page screenshots + GET /shot serves them"
```

---

## Task 3: Web Sharingan API client (web)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (types + client methods + `ApiClient` entries)
- Modify: `apps/web/src/test/fake-api.ts` (fakes)
- Test: `apps/web/src/lib/sharingan-api.test.ts` (new)

**Interfaces:**
- Produces on the client: `startSharingan(id, url): Promise<void>`; `sharinganStatus(id): Promise<SharinganStatus>`; `continueSharingan(id): Promise<void>`; `focusSharingan(id): Promise<void>`; `streamSharinganEvents(id, signal?): AsyncGenerator<SharinganStep>`; `sharinganShotUrl(id, relPath): string`. Types: `SharinganStep = { at: number; kind: string; text: string }`; `SharinganPage = { url: string; title: string; screenshots: Record<string, string> }`; `SharinganStatus = { phase: string; steps: number; pages: SharinganPage[]; error?: string }`.

**Note:** `consumeSse` is typed to `RunEvent`. Add a generic `consumeSseJson<T>` sibling (reuse `parseSseBlock`), or reuse `consumeSse` and cast. Read the existing `streamRun`/`consumeSse`/`parseSseBlock` (api.ts ~640–680), and the existing asset-URL builder (e.g. `researchAssetUrl`) to mirror `sharinganShotUrl`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/sharingan-api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSseBlock } from "./api.ts";

describe("sharingan SSE steps parse", () => {
  it("parses a capture step block", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 1, kind: "navigate", text: "Navigating" })}`)).toEqual({ at: 1, kind: "navigate", text: "Navigating" });
  });
  it("parses a login-required step", () => {
    expect(parseSseBlock(`data: ${JSON.stringify({ at: 2, kind: "login-required", text: "Sign in" })}`)).toEqual({ at: 2, kind: "login-required", text: "Sign in" });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test sharingan-api`
Expected: FAIL if `parseSseBlock` isn't exported (export it — it exists per api.ts recon).

- [ ] **Step 3: Add types + generic SSE consumer**

In `apps/web/src/lib/api.ts`, near the SSE helpers:

```ts
export interface SharinganStep { at: number; kind: string; text: string }
export interface SharinganPage { url: string; title: string; screenshots: Record<string, string> }
export interface SharinganStatus { phase: string; steps: number; pages: SharinganPage[]; error?: string }

export async function* consumeSseJson<T>(res: Response): AsyncGenerator<T> {
  if (!res.ok) throw new ApiError(res.status, await safeText(res));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseBlock(block) as T | null;
      if (parsed) yield parsed;
    }
  }
}
```

- [ ] **Step 4: Add the client methods + interface entries**

Add to the `ApiClient` interface and client object (mirror `streamRun` for the fetch wrapper `f`/`baseUrl`/`initWithDaemonToken`, `json`/`jsonInit`, and the asset-URL helper for `sharinganShotUrl`):

```ts
// interface
  startSharingan: (id: string, url: string) => Promise<void>;
  sharinganStatus: (id: string) => Promise<SharinganStatus>;
  continueSharingan: (id: string) => Promise<void>;
  focusSharingan: (id: string) => Promise<void>;
  streamSharinganEvents: (id: string, signal?: AbortSignal) => AsyncGenerator<SharinganStep>;
  sharinganShotUrl: (id: string, relPath: string) => string;

// client
  startSharingan: (id, url) => json<void>(`/api/sharingan/${id}/start`, jsonInit("POST", { url })),
  sharinganStatus: (id) => json<SharinganStatus>(`/api/sharingan/${id}/status`),
  continueSharingan: (id) => json<void>(`/api/sharingan/${id}/continue`, jsonInit("POST")),
  focusSharingan: (id) => json<void>(`/api/sharingan/${id}/focus`, jsonInit("POST")),
  streamSharinganEvents: async function* (id, signal) {
    yield* consumeSseJson<SharinganStep>(await f(baseUrl + `/api/sharingan/${id}/events`, initWithDaemonToken({ signal })));
  },
  sharinganShotUrl: (id, relPath) => `${baseUrl}/api/sharingan/${id}/shot?path=${encodeURIComponent(relPath)}`,
```

(Match the exact base-URL + token pattern the sibling asset-URL helper uses — the daemon token may need to be a query param for `<img src>` if the asset routes aren't cookie-authed; read how `researchAssetUrl`/`previewUrl` embed auth and mirror it.)

- [ ] **Step 5: Add fakes**

In `apps/web/src/test/fake-api.ts`:

```ts
    startSharingan: async () => {},
    sharinganStatus: async () => ({ phase: "idle", steps: 0, pages: [] }),
    continueSharingan: async () => {},
    focusSharingan: async () => {},
    streamSharinganEvents: async function* () {},
    sharinganShotUrl: (id: string, relPath: string) => `/shot/${id}/${relPath}`,
```

- [ ] **Step 6: Run and watch it pass**

Run: `pnpm --filter ./apps/web test sharingan-api` → PASS.
Run: `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/test/fake-api.ts apps/web/src/lib/sharingan-api.test.ts
git commit -m "feat(sharingan): web api client for status, events, continue, focus, shots"
```

---

## Task 4: SharinganTab component (web)

**Files:**
- Create: `apps/web/src/screens/SharinganTab.tsx`
- Test: `apps/web/src/screens/SharinganTab.test.tsx` (new)

**Interfaces:**
- Consumes: `useApi()` (Task 3), `useToast()`; props `{ projectId: string; sourceUrl: string }`.
- Produces: `export function SharinganTab({ projectId, sourceUrl }: { projectId: string; sourceUrl: string })`.

**Behavior:** on mount, fetch `sharinganStatus`; if `phase==="idle"`, `startSharingan(projectId, sourceUrl)`. Stream `streamSharinganEvents` into a live log; on a `login-required` step set phase `login-required`; on a `done` step re-fetch status (→ phase + captured pages). Render: a phase chip + "Re-capture"; when running, the streaming **work-log**; when `login-required`, a prompt with **"Open the browser"** (`focusSharingan`) + **Continue** (`continueSharingan`); when captured, **results** — each page's title/url + its screenshots via `sharinganShotUrl`. Abort the stream on unmount.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/screens/SharinganTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { SharinganTab } from "./SharinganTab.tsx";

function renderTab(over = {}) {
  const api = makeFakeApi({
    sharinganStatus: async () => ({ phase: "login-required", steps: 1, pages: [] }),
    streamSharinganEvents: async function* () {
      yield { at: 1, kind: "navigate", text: "Navigating to example.com" };
      yield { at: 2, kind: "login-required", text: "This page needs a login." };
    },
    ...over,
  });
  render(<ApiProvider client={api}><ToastProvider><SharinganTab projectId="p1" sourceUrl="https://example.com" /></ToastProvider></ApiProvider>);
  return api;
}

describe("SharinganTab", () => {
  it("streams the work-log", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText(/Navigating to example.com/)).toBeInTheDocument());
  });

  it("shows the login prompt with Open-the-browser + Continue", async () => {
    const focusSharingan = vi.fn(async () => {});
    const continueSharingan = vi.fn(async () => {});
    renderTab({ focusSharingan, continueSharingan });
    fireEvent.click(await screen.findByRole("button", { name: /open the browser/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
    await waitFor(() => expect(focusSharingan).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(continueSharingan).toHaveBeenCalledWith("p1"));
  });

  it("auto-starts capture when idle", async () => {
    const startSharingan = vi.fn(async () => {});
    renderTab({ startSharingan, sharinganStatus: async () => ({ phase: "idle", steps: 0, pages: [] }) });
    await waitFor(() => expect(startSharingan).toHaveBeenCalledWith("p1", "https://example.com"));
  });

  it("renders captured-page results with a screenshot", async () => {
    renderTab({
      sharinganStatus: async () => ({ phase: "captured", steps: 3, pages: [{ url: "https://example.com/", title: "Home", screenshots: { desktop: "home/shot-desktop.png" } }] }),
      streamSharinganEvents: async function* () { yield { at: 9, kind: "done", text: "Capture complete" }; },
    });
    const img = await screen.findByAltText(/Home/i);
    expect(img.getAttribute("src")).toContain("home/shot-desktop.png");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test SharinganTab`
Expected: FAIL — `./SharinganTab.tsx` does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/screens/SharinganTab.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { SharinganStep, SharinganPage } from "../lib/api.ts";

export function SharinganTab({ projectId, sourceUrl }: { projectId: string; sourceUrl: string }) {
  const api = useApi();
  const { toast } = useToast();
  const [phase, setPhase] = useState<string>("idle");
  const [log, setLog] = useState<SharinganStep[]>([]);
  const [pages, setPages] = useState<SharinganPage[]>([]);
  const started = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    const refreshStatus = async () => {
      const s = await api.sharinganStatus(projectId).catch(() => null);
      if (alive && s) { setPhase(s.phase); setPages(s.pages); }
      return s;
    };
    (async () => {
      const s = await refreshStatus();
      if (alive && s && s.phase === "idle" && !started.current) {
        started.current = true;
        await api.startSharingan(projectId, sourceUrl).then(() => setPhase("capturing")).catch(() => toast("Couldn't start the capture.", { variant: "error" }));
      }
    })();
    (async () => {
      try {
        for await (const step of api.streamSharinganEvents(projectId, ac.signal)) {
          if (!alive) return;
          setLog((l) => [...l, step]);
          if (step.kind === "login-required") setPhase("login-required");
          if (step.kind === "done") await refreshStatus();
        }
      } catch { /* aborted on unmount */ }
    })();
    return () => { alive = false; ac.abort(); };
  }, [api, projectId, sourceUrl, toast]);

  const recapture = () => {
    started.current = true;
    setLog([]);
    setPages([]);
    api.startSharingan(projectId, sourceUrl).then(() => setPhase("capturing")).catch(() => toast("Couldn't re-capture.", { variant: "error" }));
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Sharingan</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">{phase}</span>
        <button type="button" onClick={recapture} className="ml-auto rounded-md border px-2 py-1 text-xs">Re-capture</button>
      </div>

      {phase === "login-required" ? (
        <div role="status" className="rounded-md border border-amber-400/40 bg-amber-50/60 p-3 text-sm dark:bg-amber-500/10">
          This page needs a login. Open the controlled browser, sign in there, then click Continue.
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void api.focusSharingan(projectId)} className="rounded-md border px-3 py-1">Open the browser</button>
            <button type="button" onClick={() => void api.continueSharingan(projectId)} className="rounded-md border px-3 py-1">Continue</button>
          </div>
        </div>
      ) : null}

      {pages.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {pages.map((p) => (
            <figure key={p.url} className="overflow-hidden rounded-lg border">
              {Object.entries(p.screenshots).slice(0, 1).map(([label, rel]) => (
                <img key={label} alt={p.title} src={api.sharinganShotUrl(projectId, rel)} className="w-full" />
              ))}
              <figcaption className="truncate p-2 text-xs text-muted-foreground">{p.title} — {p.url}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      <ol className="max-h-48 flex-1 overflow-auto rounded-md border p-2 text-xs text-muted-foreground">
        {log.map((s, i) => (<li key={i} className="py-0.5">{s.text}</li>))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm --filter ./apps/web test SharinganTab`
Expected: PASS (4/4). Then `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/SharinganTab.tsx apps/web/src/screens/SharinganTab.test.tsx
git commit -m "feat(sharingan): SharinganTab — work-log, results, login prompt with focus + Continue"
```

---

## Task 5: WorkspaceScreen tab integration (web)

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx` (`TABS`, `TAB_ICON`, conditional filter, auto-select, render)
- Test: `apps/web/src/screens/workspace.test.tsx` (add a case) — or a focused new file if the harness is hard to extend.

**Interfaces:**
- Consumes: `SharinganTab` (Task 4); the loaded `project` (`sharingan`/`sourceUrl`).
- Produces: a `"Sharingan"` tab shown only when `project?.sharingan`, auto-selected on first load, rendering `<SharinganTab projectId={projectId} sourceUrl={project.sourceUrl ?? ""} />`.

**Note:** `WorkspaceScreen.tsx` is large — READ the anchors first (reconnaissance, approximate): `TABS` (~65), `TAB_ICON` (~4196), the `TABS.filter(...)` tab-items (~4202), tab state `useState<Tab>("Preview")` (~2356), the tab-content render chain (~4961), and where `project` is set after `getProject` (~3523).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/screens/workspace.test.tsx` (reuse its render harness; the fake api needs `getProject` → `{ sharingan: true, sourceUrl: "https://example.com", mode: "standard", … }`, plus `sharinganStatus`/`streamSharinganEvents` from `makeFakeApi` defaults):

```tsx
it("shows an auto-selected Sharingan tab for a sharingan project", async () => {
  // render WorkspaceScreen; fake getProject returns sharingan: true
  await waitFor(() => expect(screen.getByRole("tab", { name: /Sharingan/i })).toBeInTheDocument());
});

it("shows no Sharingan tab for a normal project", async () => {
  // fake getProject returns sharingan: false
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Sharingan/i })).not.toBeInTheDocument());
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test workspace`
Expected: FAIL — no `"Sharingan"` tab.

- [ ] **Step 3: Add the tab**

In `apps/web/src/screens/WorkspaceScreen.tsx`:
- `TABS` (~65): `const TABS = ["Preview", "Sharingan", "Research", "Files", "Quality"] as const;`
- `TAB_ICON` (~4196): import `Aperture` from `lucide-react`, add `Sharingan: <Aperture size={13} strokeWidth={1.75} />,`
- The `TABS.filter(...)` (~4202): `(t !== "Research" || research?.exists) && (t !== "Sharingan" || project?.sharingan)`
- Render chain (~4961): add `) : tab === "Sharingan" ? (<SharinganTab projectId={projectId} sourceUrl={project?.sourceUrl ?? ""} />`
- Auto-select: in the `getProject` effect (~3523), after `setProject(proj)`, add `if (proj.sharingan) setTab("Sharingan");`
- Import: `import { SharinganTab } from "./SharinganTab.tsx";`

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm --filter ./apps/web test workspace`
Expected: PASS. Then full web suite (`pnpm --filter ./apps/web test`) + `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/workspace.test.tsx
git commit -m "feat(sharingan): Sharingan workspace tab (conditional + auto-selected)"
```

---

## Roadmap (context — not implemented here)

- **Phase 4:** Agent-probe context (`sharingan-context.ts`) — the build Agent drives the capture endpoints (navigate/screenshot/read-dom/…) within the page budget; the captured screenshots become the Agent's visual reference/knowledge base.
- **Phase 5:** `run-handler` capture-before-build integration + `research:false` + build from the `.sharingan/` bundle.
- **Deferred capability:** live CDP `Page.startScreencast` mirror (a real-time video of the browser in the tab) — parked per the Phase-3 product decision; the current tab uses captured screenshots for its image-rich view.
