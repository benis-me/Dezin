# Sharingan — Phase 1 (Daemon Capture Pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the daemon the ability to open a URL in a headful browser, capture it deterministically (multi-viewport screenshots + DOM snapshot + computed-style tokens + asset inventory + link discovery), detect a login wall, write a `.sharingan/` bundle, and expose it all over HTTP — the foundation the rest of Sharingan builds on.

**Architecture:** A daemon-owned puppeteer browser session (`sharingan-browser.ts`), a deterministic capture orchestrator (`sharingan-capture.ts`), and token-gated HTTP endpoints (`sharingan-handler.ts`) wired into `app.ts`. The project model gains a `sharingan` flag + `sourceUrl`. Everything is tested against local fixture sites served from a temp HTTP server with real puppeteer (`findChrome`), the same way `visual-qa` is exercised.

**Tech Stack:** TypeScript, `puppeteer-core` (`findChrome` from `capture-cover.ts`), node:test (daemon/core tests), better-sqlite project store (`packages/core`), the daemon's route table + `sse`/`sendJson` helpers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-sharingan-design.md`. This plan is **Phase 1 of 5**; see the roadmap below. It must produce a working, testable daemon capture pipeline on its own.
- The browser is **daemon-owned puppeteer** (headful in production, but tests launch it headless against fixtures). Reuse `findChrome()`; never hardcode a Chrome path.
- Persistent profile: the browser uses a persistent `userDataDir` under the data dir (`<dataDir>/.sharingan-profile`) so logins persist. In tests, use a fresh temp `userDataDir`.
- Capture output lives under `<projectDir>/.sharingan/` (git-ignored like other generated dirs).
- Login handling **pauses and asks** — never bypasses. Detection is heuristic (401/403, `/(login|signin|sign-in|auth|account)/i` redirect, or a password-field-only shell).
- Page budget for later Agent probing defaults to **6** (a constant `SHARINGAN_PAGE_BUDGET = 6`, defined here for later phases).
- HTTP endpoints are `x-dezin-daemon-token`-gated exactly like the rest of `/api/*`.
- All new daemon tests: `node --test` under `apps/daemon/test/`, run with `pnpm --filter ./apps/daemon test`. Core: `pnpm --filter @dezin/core test`. No `Co-Authored-By` trailer; no version bump on these commits (feature branch).

## Roadmap (context — not implemented here)

- **Phase 1 (this plan): daemon capture pipeline** — session, deterministic capture, login detection, endpoints, project model.
- Phase 2: Home entry/mode (double-click → Sharingan mode, URL input, forced Standard, authorized-use affirmation) + `createProject` wiring.
- Phase 3: Sharingan tab + CDP screencast (live mirror + action-log SSE + login banner).
- Phase 4: Agent-probe context (`sharingan-context.ts` prompt block) — Agent drives the endpoints during build.
- Phase 5: `run-handler` capture-before-build integration + `research:false` + build from the `.sharingan/` bundle.

---

### Task 1: Project model — `sharingan` flag + `sourceUrl`

**Files:**
- Modify: `packages/core/src/types.ts` (Project type)
- Modify: `packages/core/src/store.ts` (projects table column + `migrate()` + create/read mapping)
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Produces: `Project.sharingan: boolean`, `Project.sourceUrl?: string`; `createProject` accepts optional `{ sharingan?: boolean; sourceUrl?: string }` and round-trips them.

- [ ] **Step 1: Write the failing test** (append to `store.test.ts`, following its existing project-store helper `makeStore`/`new Store(":memory:")`)

```ts
test("a project persists the sharingan flag and sourceUrl", () => {
  const store = new Store(":memory:");
  const p = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: "https://example.com" });
  const read = store.getProject(p.id);
  assert.equal(read?.sharingan, true);
  assert.equal(read?.sourceUrl, "https://example.com");
  const plain = store.createProject({ name: "normal" });
  assert.equal(store.getProject(plain.id)?.sharingan, false);
  store.close();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @dezin/core test`
Expected: FAIL — `createProject` doesn't accept `sharingan`/`sourceUrl`, and `Project` has no such fields.

- [ ] **Step 3: Add the fields (mirror how `mode` is stored on projects)**

- `types.ts` `Project`: add `sharingan: boolean;` and `sourceUrl?: string;`.
- `store.ts` — the projects `CREATE TABLE` (add `sharingan INTEGER NOT NULL DEFAULT 0,` and `source_url TEXT`) AND `migrate()` (`ensureColumn("projects", "sharingan", "sharingan INTEGER NOT NULL DEFAULT 0")` and `ensureColumn("projects", "source_url", "source_url TEXT")`) — beside the existing `ensureColumn("projects", "mode", "mode TEXT")`.
- `createProject(input)`: accept `input.sharingan`/`input.sourceUrl`; in the INSERT add the two columns/placeholders/values (`input.sharingan ? 1 : 0`, `input.sourceUrl ?? null`) at matching positions.
- The project row → `Project` mapper: `sharingan: Number(r.sharingan ?? 0) === 1`, `sourceUrl: r.source_url ?? undefined`.

- [ ] **Step 4: Run core test, verify pass**

Run: `pnpm --filter @dezin/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/store.ts packages/core/test/store.test.ts
git commit -m "feat(sharingan): project model gains sharingan flag + sourceUrl"
```

---

### Task 2: `sharingan-browser.ts` — the puppeteer session

**Files:**
- Create: `apps/daemon/src/sharingan-browser.ts`
- Test: `apps/daemon/test/sharingan-browser.test.ts`

**Interfaces:**
- Produces:
  - `interface Viewport { width: number; height: number; label: string }`
  - `const VIEWPORTS: Viewport[]` — `[{width:390,height:844,label:"mobile"},{width:1440,height:900,label:"desktop"}]`
  - `class SharinganSession` with: `static async open(url: string, opts?: { userDataDir?: string; headless?: boolean }): Promise<SharinganSession>`; `navigate(url: string): Promise<{ status: number; finalUrl: string }>`; `screenshot(opts: { fullPage?: boolean }): Promise<Buffer>`; `readDom(maxNodes?: number): Promise<DomNode[]>`; `styleTokens(): Promise<StyleTokens>`; `discoverLinks(): Promise<string[]>`; `hasPasswordField(): Promise<boolean>`; `setViewport(v: Viewport): Promise<void>`; `close(): Promise<void>`; `currentUrl(): string`.
  - `interface DomNode { tag: string; role?: string; classes: string; text: string; box: { x:number;y:number;w:number;h:number } }`
  - `interface StyleTokens { colors: string[]; fontFamilies: string[]; fontSizes: string[]; radii: string[]; shadows: string[] }`

- [ ] **Step 1: Write the failing test** — `apps/daemon/test/sharingan-browser.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SharinganSession } from "../src/sharingan-browser.ts";
import { findChrome } from "../src/capture-cover.ts";

const FIXTURE = `<!doctype html><html><head><style>:root{--x:0}body{font-family:Inter,sans-serif;color:#111}h1{font-size:40px}.btn{background:#2563eb;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.1)}</style></head>
<body><h1>Acme</h1><p>Real copy that describes the product in a sentence or two.</p><a class="btn" href="/pricing">Pricing</a><a href="https://external.example/x">Ext</a></body></html>`;

function fixtureServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test("SharinganSession captures screenshot, DOM, style tokens, and same-origin links", { skip: !findChrome() && "no Chrome" }, async () => {
  const fx = await fixtureServer(FIXTURE);
  const dir = mkdtempSync(join(tmpdir(), "shar-"));
  const s = await SharinganSession.open(fx.url, { userDataDir: dir, headless: true });
  try {
    const shot = await s.screenshot({ fullPage: true });
    assert.ok(shot.length > 100, "screenshot has bytes");
    const dom = await s.readDom(200);
    assert.ok(dom.some((n) => n.tag === "h1" && n.text.includes("Acme")));
    const tokens = await s.styleTokens();
    assert.ok(tokens.colors.length > 0 && tokens.fontFamilies.length > 0);
    const links = await s.discoverLinks();
    assert.ok(links.some((l) => l.endsWith("/pricing")), "same-origin link found");
    assert.ok(!links.some((l) => l.includes("external.example")), "cross-origin link excluded");
  } finally {
    await s.close();
    await fx.close();
  }
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/daemon test sharingan-browser`
Expected: FAIL — module not found. (If `findChrome()` returns null in this env the test SKIPS — that's acceptable; CI has Chrome, as `visual-qa` tests rely on it.)

- [ ] **Step 3: Implement `sharingan-browser.ts`**

```ts
import puppeteer from "puppeteer-core";
import { findChrome } from "./capture-cover.ts";

export interface Viewport { width: number; height: number; label: string }
export const VIEWPORTS: Viewport[] = [
  { width: 390, height: 844, label: "mobile" },
  { width: 1440, height: 900, label: "desktop" },
];

export interface DomNode { tag: string; role?: string; classes: string; text: string; box: { x: number; y: number; w: number; h: number } }
export interface StyleTokens { colors: string[]; fontFamilies: string[]; fontSizes: string[]; radii: string[]; shadows: string[] }

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

export class SharinganSession {
  private constructor(private browser: Browser, private page: Page, private origin: string) {}

  static async open(url: string, opts: { userDataDir?: string; headless?: boolean } = {}): Promise<SharinganSession> {
    const executablePath = findChrome();
    if (!executablePath) throw new Error("Chrome not found (required for Sharingan capture)");
    const browser = await puppeteer.launch({
      executablePath,
      headless: opts.headless ?? false,
      userDataDir: opts.userDataDir,
      args: ["--no-sandbox", "--hide-scrollbars"],
      defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
    const origin = new URL(url).origin;
    const session = new SharinganSession(browser, page, origin);
    await session.navigate(url);
    return session;
  }

  currentUrl(): string { return this.page.url(); }

  async navigate(url: string): Promise<{ status: number; finalUrl: string }> {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    // Give client-rendered pages a moment + trigger lazy content by scrolling.
    await this.page.evaluate(() => new Promise<void>((r) => { window.scrollTo(0, document.body.scrollHeight); setTimeout(() => { window.scrollTo(0, 0); r(); }, 400); })).catch(() => {});
    return { status: res?.status() ?? 0, finalUrl: this.page.url() };
  }

  async setViewport(v: Viewport): Promise<void> { await this.page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: 1 }); }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return (await this.page.screenshot({ fullPage: opts.fullPage ?? false, type: "png" })) as Buffer;
  }

  async readDom(maxNodes = 400): Promise<DomNode[]> {
    return this.page.evaluate((max: number) => {
      const out: any[] = [];
      const walk = (el: Element) => {
        if (out.length >= max) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || undefined,
            classes: typeof el.className === "string" ? el.className : "",
            text: (el.childNodes.length && (el as HTMLElement).innerText ? (el as HTMLElement).innerText : "").replace(/\s+/g, " ").trim().slice(0, 120),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
        for (const c of Array.from(el.children)) walk(c);
      };
      if (document.body) walk(document.body);
      return out;
    }, maxNodes);
  }

  async styleTokens(): Promise<StyleTokens> {
    return this.page.evaluate(() => {
      const colors = new Set<string>(), fonts = new Set<string>(), sizes = new Set<string>(), radii = new Set<string>(), shadows = new Set<string>();
      const nodes = Array.from(document.querySelectorAll("body *")).slice(0, 1500);
      for (const el of nodes) {
        const s = getComputedStyle(el);
        if (s.color) colors.add(s.color);
        if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") colors.add(s.backgroundColor);
        if (s.fontFamily) fonts.add(s.fontFamily);
        if (s.fontSize) sizes.add(s.fontSize);
        if (s.borderRadius && s.borderRadius !== "0px") radii.add(s.borderRadius);
        if (s.boxShadow && s.boxShadow !== "none") shadows.add(s.boxShadow);
      }
      const top = (set: Set<string>, n: number) => Array.from(set).slice(0, n);
      return { colors: top(colors, 24), fontFamilies: top(fonts, 8), fontSizes: top(sizes, 16), radii: top(radii, 8), shadows: top(shadows, 8) };
    });
  }

  async discoverLinks(): Promise<string[]> {
    const origin = this.origin;
    return this.page.evaluate((org: string) => {
      const urls = new Set<string>();
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        try {
          const u = new URL((a as HTMLAnchorElement).href, location.href);
          if (u.origin === org) urls.add(u.origin + u.pathname);
        } catch { /* ignore */ }
      }
      return Array.from(urls).slice(0, 50);
    }, origin);
  }

  async hasPasswordField(): Promise<boolean> { return this.page.evaluate(() => !!document.querySelector('input[type="password"]')); }
  async click(selector: string): Promise<void> { await this.page.click(selector).catch(() => {}); }
  async scroll(y: number): Promise<void> { await this.page.evaluate((yy: number) => window.scrollTo(0, yy), y); }

  async close(): Promise<void> { await this.browser.close().catch(() => {}); }
}

export const SHARINGAN_PAGE_BUDGET = 6;
```

- [ ] **Step 4: Run test, verify pass (or skip when no Chrome)**

Run: `pnpm --filter ./apps/daemon test sharingan-browser`
Expected: PASS (or the single test SKIPS if Chrome is absent).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/test/sharingan-browser.test.ts
git commit -m "feat(sharingan): daemon-owned puppeteer browser session"
```

---

### Task 3: `sharingan-capture.ts` — deterministic first-pass + login detection + bundle writer

**Files:**
- Create: `apps/daemon/src/sharingan-capture.ts`
- Test: `apps/daemon/test/sharingan-capture.test.ts`

**Interfaces:**
- Consumes: `SharinganSession`, `VIEWPORTS`, `DomNode`, `StyleTokens` (Task 2).
- Produces:
  - `interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "login-required" | "done"; text: string }`
  - `interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string }`
  - `function detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number }): boolean`
  - `async function capturePage(session: SharinganSession, projectDir: string, url: string, onStep: (s: CaptureStep) => void): Promise<{ page: CapturedPage | null; loginRequired: boolean }>`

- [ ] **Step 1: Write the failing test** — `apps/daemon/test/sharingan-capture.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { detectLoginWall, capturePage } from "../src/sharingan-capture.ts";
import { SharinganSession } from "../src/sharingan-browser.ts";
import { findChrome } from "../src/capture-cover.ts";

test("detectLoginWall flags 401, auth redirects, and password-only shells", () => {
  assert.equal(detectLoginWall({ status: 401, finalUrl: "https://x/y", hasPasswordField: false, textLength: 500 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/login?next=/app", hasPasswordField: false, textLength: 500 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: true, textLength: 30 }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: false, textLength: 2000 }), false);
});

test("capturePage writes screenshots + dom + styles into .sharingan and reports steps", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><title>Home</title><style>h1{font-size:40px;color:#111}</style></head><body><h1>Acme</h1><p>${"word ".repeat(60)}</p></body></html>`;
  const server = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const projectDir = mkdtempSync(join(tmpdir(), "shar-proj-"));
  const profile = mkdtempSync(join(tmpdir(), "shar-prof-"));
  const s = await SharinganSession.open(url, { userDataDir: profile, headless: true });
  const steps: string[] = [];
  try {
    const { page, loginRequired } = await capturePage(s, projectDir, url, (st) => steps.push(st.kind));
    assert.equal(loginRequired, false);
    assert.ok(page, "captured a page");
    assert.ok(existsSync(join(projectDir, ".sharingan")), ".sharingan dir created");
    assert.ok(Object.keys(page!.screenshots).length >= 2, "screenshot per viewport");
    const styles = JSON.parse(readFileSync(join(projectDir, page!.styles), "utf8"));
    assert.ok(Array.isArray(styles.colors));
    assert.ok(steps.includes("screenshot") && steps.includes("styles") && steps.includes("done"));
  } finally {
    await s.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/daemon test sharingan-capture`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sharingan-capture.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SharinganSession, VIEWPORTS } from "./sharingan-browser.ts";

export interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "login-required" | "done"; text: string }
export interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string }

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account)(\/|\?|$)/i;

export function detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number }): boolean {
  if (input.status === 401 || input.status === 403) return true;
  if (LOGIN_URL_RE.test(input.finalUrl)) return true;
  if (input.hasPasswordField && input.textLength < 80) return true;
  return false;
}

function pageDir(url: string): string {
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
  return slug;
}

export async function capturePage(
  session: SharinganSession,
  projectDir: string,
  url: string,
  onStep: (s: CaptureStep) => void,
): Promise<{ page: CapturedPage | null; loginRequired: boolean }> {
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
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));

  step("styles", "Reading computed style tokens");
  const styleRel = join(rel, "styles.json");
  writeFileSync(join(projectDir, styleRel), JSON.stringify(await session.styleTokens(), null, 0));

  step("links", "Discovering same-origin links");
  await session.discoverLinks();

  const title = (dom.find((n) => n.tag === "h1")?.text || url).slice(0, 80);
  step("done", "Capture complete");
  return { page: { url, title, screenshots, dom: domRel, styles: styleRel }, loginRequired: false };
}
```

> Note on the `hasPasswordField` probe: the minimal version above infers from the DOM snapshot. If the reviewer wants a precise check, replace the `probe` block with a dedicated `session`-level `hasPasswordField(): Promise<boolean>` (a one-line `page.evaluate(() => !!document.querySelector('input[type=password]'))`) added to Task 2's session — but keep the `detectLoginWall` pure function and its unit test unchanged.

- [ ] **Step 4: Run test, verify pass (login unit test always runs; capture test skips without Chrome)**

Run: `pnpm --filter ./apps/daemon test sharingan-capture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "feat(sharingan): deterministic page capture + login-wall detection"
```

---

### Task 4: `sharingan-handler.ts` + routes — the HTTP surface

**Files:**
- Create: `apps/daemon/src/sharingan-handler.ts`
- Modify: `apps/daemon/src/app.ts` (register routes)
- Test: `apps/daemon/test/sharingan-handler.test.ts`

**Interfaces:**
- Consumes: `SharinganSession`, `capturePage`, `CaptureStep` (Tasks 2-3); the store (`deps.store`), `deps.dataDir`, `sendJson`, `matchPath`.
- Produces: a per-project capture registry + these routes (all token-gated by the existing middleware): `POST /api/sharingan/:id/start`, `GET /api/sharingan/:id/status`, `GET /api/sharingan/:id/events` (SSE). (navigate/screenshot/read-dom/etc. and the screencast SSE are Phase 3/4 — Phase 1 ships start/status/events so the pipeline is drivable + observable.)

- [ ] **Step 1: Write the failing test** — `apps/daemon/test/sharingan-handler.test.ts` (mirror `runs.test.ts`'s `withRunServer` harness: `createApp({ store, dataDir })`, `server.listen(0)`, then fetch)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";

test("POST /start begins a capture and GET /status reports progress", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>T</title><h1>Acme</h1><p>" + "w ".repeat(60) + "</p>"); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-dd-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const started = await fetch(`${base}/api/sharingan/${project.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
    assert.equal(started.status, 200);
    // Poll status until the capture finishes.
    let phase = "";
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(`${base}/api/sharingan/${project.id}/status`)).json();
      phase = s.phase;
      if (phase === "captured" || phase === "login-required" || phase === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(phase, "captured");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    await new Promise<void>((r) => fixture.close(() => r()));
    store.close();
  }
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter ./apps/daemon test sharingan-handler`
Expected: FAIL — routes not registered (404).

- [ ] **Step 3: Implement `sharingan-handler.ts`**

```ts
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SharinganSession } from "./sharingan-browser.ts";
import { capturePage, type CaptureStep, type CapturedPage } from "./sharingan-capture.ts";
import { projectDir } from "./serve-static.ts";
import { sendJson, readJsonBody } from "./http-util.ts";

type Phase = "idle" | "capturing" | "login-required" | "captured" | "error";
interface Capture { phase: Phase; steps: CaptureStep[]; pages: CapturedPage[]; session?: SharinganSession; listeners: Set<ServerResponse>; error?: string }

const captures = new Map<string, Capture>();

function get(id: string): Capture {
  let c = captures.get(id);
  if (!c) { c = { phase: "idle", steps: [], pages: [], listeners: new Set() }; captures.set(id, c); }
  return c;
}

function emit(c: Capture, step: CaptureStep): void {
  c.steps.push(step);
  const line = `data: ${JSON.stringify(step)}\n\n`;
  for (const res of c.listeners) res.write(line);
}

export async function startCapture(id: string, url: string, dataDir: string, profileDir: string): Promise<void> {
  const c = get(id);
  if (c.phase === "capturing") return;
  c.phase = "capturing"; c.steps = []; c.pages = []; c.error = undefined;
  try {
    const session = await SharinganSession.open(url, { userDataDir: profileDir, headless: process.env.DEZIN_SHARINGAN_HEADLESS === "1" });
    c.session = session;
    const { page, loginRequired } = await capturePage(session, projectDir(dataDir, id), url, (s) => emit(c, s));
    if (loginRequired) { c.phase = "login-required"; return; }
    if (page) c.pages.push(page);
    c.phase = "captured";
    await session.close();
    c.session = undefined;
  } catch (err) {
    c.phase = "error"; c.error = err instanceof Error ? err.message : "capture failed";
    emit(c, { at: Date.now(), kind: "done", text: `Capture failed: ${c.error}` });
  }
}

export async function handleSharinganStart(req: IncomingMessage, res: ServerResponse, id: string, dataDir: string): Promise<void> {
  const body = (await readJsonBody(req)) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "a valid http(s) url is required" }); return; }
  const profileDir = join(dataDir, ".sharingan-profile");
  void startCapture(id, url, dataDir, profileDir);
  sendJson(res, 200, { ok: true });
}

export function handleSharinganStatus(res: ServerResponse, id: string): void {
  const c = get(id);
  sendJson(res, 200, { phase: c.phase, steps: c.steps.length, pages: c.pages.map((p) => ({ url: p.url, title: p.title })), error: c.error });
}

export function handleSharinganEvents(res: ServerResponse, id: string): void {
  const c = get(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const s of c.steps) res.write(`data: ${JSON.stringify(s)}\n\n`);
  c.listeners.add(res);
  res.on("close", () => c.listeners.delete(res));
}
```

- [ ] **Step 4: Register the routes in `app.ts`**

Add to the routes array (mirror the existing `/api/capture` entries; `matchPath` provides `:id`):

```ts
{ method: "POST", pattern: "/api/sharingan/:id/start", handler: (req, res, p, deps) => handleSharinganStart(req, res, p.id, deps.dataDir) },
{ method: "GET", pattern: "/api/sharingan/:id/status", handler: (_req, res, p) => handleSharinganStatus(res, p.id) },
{ method: "GET", pattern: "/api/sharingan/:id/events", handler: (_req, res, p) => handleSharinganEvents(res, p.id) },
```

Add the import at the top of `app.ts`:

```ts
import { handleSharinganStart, handleSharinganStatus, handleSharinganEvents } from "./sharingan-handler.ts";
```

(If `handler` param names differ — e.g. the route table passes `(req, res, params, deps)` — match the existing entries' exact shape; the `:id` param key is `params.id`.)

- [ ] **Step 5: Run test, verify pass (skips without Chrome)**

Run: `pnpm --filter ./apps/daemon test sharingan-handler`
Expected: PASS.

- [ ] **Step 6: Full daemon suite + commit**

```bash
pnpm --filter ./apps/daemon test
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/app.ts apps/daemon/test/sharingan-handler.test.ts
git commit -m "feat(sharingan): capture HTTP endpoints (start/status/events SSE)"
```

---

## Phase 1 verification

- [ ] `pnpm --filter @dezin/core test` — project model round-trips.
- [ ] `pnpm --filter ./apps/daemon test` — browser/capture/handler suites green (capture tests SKIP if Chrome is absent; the pure `detectLoginWall` test always runs).
- [ ] `pnpm typecheck` — clean.
- [ ] Manual smoke (with Chrome, `DEZIN_SHARINGAN_HEADLESS=1`): `POST /api/sharingan/<id>/start {url}` against a real public page, then `GET /status` → `captured`, and `.sharingan/<page>/` holds `shot-mobile.png`, `shot-desktop.png`, `dom.json`, `styles.json`.

## Notes for the implementer

- Chrome is required for capture; tests SKIP cleanly without it (matching how `visual-qa` behaves). Don't fake puppeteer — the value is in real capture.
- Keep `detectLoginWall` a pure function with its own always-running unit test — it's the safety-critical "don't bypass auth" gate.
- Screencast, navigate/click/read-dom endpoints, and the Agent-probe prompt block are **Phase 3/4** — do not add them here.
- After Phase 1 lands, the next planning cycle is Phase 2 (Home entry/mode) — it has no dependency on the browser internals, only on the project model from Task 1.
