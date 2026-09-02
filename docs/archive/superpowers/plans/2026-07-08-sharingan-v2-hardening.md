# Sharingan v2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sharingan actually work on auth-gated, image-heavy sites — detect & let the user pass login walls, capture a real blueprint (assets + per-node layout), and review the build against the captured source.

**Architecture:** Six daemon-side changes on `feat/sharingan-v2`. P0 removes the browser's automation tells and adds an OAuth/social login-wall heuristic so the entry capture pauses for user sign-in instead of capturing a login screen. P1 enriches the capture bundle (`assets.json` + per-node computed styles), tells the Agent to fill image slots with free placeholders, and feeds the captured source screenshot to the Visual Review critic as a fidelity reference. P2 keeps the just-authenticated entry session open for the Agent to reuse and raises the probe idle timeout.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), `puppeteer-core` (already a dep), `node:test`.

## Global Constraints

- **No new dependencies.** Stealth is manual launch flags + page hooks, not `puppeteer-extra`. (`puppeteer-core` only.)
- **Auth stays user-driven.** Stealth only makes the visible window non-bot-flagged so the USER can sign in; it never auto-logs-in, handles credentials, or solves CAPTCHAs.
- **Reconstruction, not rip.** Richer capture adds computed-layout *reference* only — never the source's verbatim HTML/CSS/JS or re-hosted brand assets. Brand images become free placeholders.
- **Commits:** NO `Co-Authored-By` trailer on any commit. Bump the root `package.json` version only at merge/landing — not per WIP commit.
- **Tests:** local fixtures / DI only — never a real external site. Chrome-gated tests use `{ skip: !findChrome() && "no Chrome" }`.
- **Daemon test command (run files individually — the full suite hangs on `runs.test.ts`/`variants.test.ts`):**
  `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/<file>.test.ts`
- **Typecheck (from repo root):** `pnpm exec tsc -p tsconfig.check.json --noEmit` (the node program: packages + daemon). This tsconfig is DOM-less — inside any `page.evaluate`/`evaluateOnNewDocument` body use `(globalThis as any)`, never bare `document`/`navigator`/`window`.

---

### Task 1: Stealth browser launch

Remove the automation tells from the Sharingan Chrome so Google/Cloudflare don't block the user's sign-in in the visible window.

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (add exports + change `open` at lines 27-42)
- Test: `apps/daemon/test/sharingan-browser.test.ts` (add tests)

**Interfaces:**
- Produces:
  - `sharinganLaunchOptions(executablePath: string, opts: { userDataDir?: string; headless?: boolean }): { executablePath: string; headless: boolean; userDataDir?: string; ignoreDefaultArgs: string[]; args: string[]; defaultViewport: { width: number; height: number } }`
  - `interface StealthPage { setUserAgent(ua: string): Promise<void>; evaluateOnNewDocument(fn: (...args: any[]) => unknown): Promise<unknown> }`
  - `applyStealth(page: StealthPage, userAgent: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/test/sharingan-browser.test.ts`:

```typescript
import { SharinganSession, sharinganLaunchOptions, applyStealth } from "../src/sharingan-browser.ts";
// (findChrome import already present)

test("sharinganLaunchOptions strips the automation tells", () => {
  const opts = sharinganLaunchOptions("/path/to/chrome", { userDataDir: "/tmp/p", headless: false });
  assert.deepEqual(opts.ignoreDefaultArgs, ["--enable-automation"]);
  assert.ok(opts.args.includes("--disable-blink-features=AutomationControlled"), "disables the AutomationControlled blink feature");
  assert.ok(!opts.args.includes("--enable-automation"), "never re-adds --enable-automation");
  assert.equal(opts.executablePath, "/path/to/chrome");
  assert.equal(opts.userDataDir, "/tmp/p");
});

test("applyStealth sets a non-headless UA and registers a webdriver spoof", async () => {
  const calls: { ua?: string; docHooks: number } = { docHooks: 0 };
  const fakePage = {
    setUserAgent: async (ua: string) => { calls.ua = ua; },
    evaluateOnNewDocument: async () => { calls.docHooks += 1; },
  };
  await applyStealth(fakePage, "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36");
  assert.equal(calls.ua, "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36");
  assert.ok(!/Headless/i.test(calls.ua ?? ""), "UA has no Headless marker");
  assert.equal(calls.docHooks, 1, "registered exactly one new-document hook (the webdriver spoof)");
});

test("a stealth session reports no webdriver flag and no Headless UA to page scripts", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><body><h1 id="w"></h1>
<script>document.getElementById('w').textContent = 'wd=' + String(navigator.webdriver) + ' headless=' + /Headless/i.test(navigator.userAgent);</script>
</body></html>`;
  const fx = await fixtureServer(html);
  const dir = mkdtempSync(join(tmpdir(), "shar-stealth-"));
  const s = await SharinganSession.open(fx.url, { userDataDir: dir, headless: true });
  try {
    const dom = await s.readDom(50);
    const marker = dom.find((n) => n.tag === "h1")?.text ?? "";
    assert.match(marker, /wd=(false|undefined)/, "navigator.webdriver is not true");
    assert.match(marker, /headless=false/, "userAgent has no Headless marker");
  } finally {
    await s.close();
    await fx.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-browser.test.ts`
Expected: FAIL — `sharinganLaunchOptions`/`applyStealth` are not exported.

- [ ] **Step 3: Implement stealth in `sharingan-browser.ts`**

Add these exports above the `SharinganSession` class (after the `type Page = ...` line, ~line 14):

```typescript
/** Chrome launch options with the automation tells removed: no `--enable-automation`, and the
 *  AutomationControlled blink feature disabled. Pure so the flags can be asserted without launching. */
export function sharinganLaunchOptions(
  executablePath: string,
  opts: { userDataDir?: string; headless?: boolean },
): {
  executablePath: string;
  headless: boolean;
  userDataDir?: string;
  ignoreDefaultArgs: string[];
  args: string[];
  defaultViewport: { width: number; height: number };
} {
  return {
    executablePath,
    headless: opts.headless ?? false,
    userDataDir: opts.userDataDir,
    // Puppeteer adds --enable-automation by default; that flag (and the navigator.webdriver it sets)
    // is exactly what Google/Cloudflare fingerprint. Drop it and disable the matching blink feature.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-sandbox", "--hide-scrollbars", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1440, height: 900 },
  };
}

/** The structural slice of a puppeteer Page that applyStealth drives (so it can be faked in tests). */
export interface StealthPage {
  setUserAgent(ua: string): Promise<void>;
  evaluateOnNewDocument(fn: (...args: any[]) => unknown): Promise<unknown>;
}

/** Apply the runtime stealth hooks to a freshly-opened page: set a normal (non-Headless) UA and make
 *  navigator.webdriver read as undefined on every document. Does NOT bypass auth — it only stops the
 *  window from being flagged as a bot so the USER can complete Google/Cloudflare sign-in themselves. */
export async function applyStealth(page: StealthPage, userAgent: string): Promise<void> {
  await page.setUserAgent(userAgent);
  await page.evaluateOnNewDocument(() => {
    const nav = (globalThis as any).navigator;
    try {
      Object.defineProperty(nav, "webdriver", { get: () => undefined });
    } catch {
      /* navigator is frozen on some pages — best-effort */
    }
  });
}
```

Then replace the `puppeteer.launch({...})` block and page setup inside `open` (lines 30-39) with:

```typescript
    const browser = await puppeteer.launch(sharinganLaunchOptions(executablePath, opts));
    const page = await browser.newPage();
    // Strip "HeadlessChrome" from the UA the automated browser advertises (headful already says
    // "Chrome"; this covers the headless test/CI path and is belt-and-suspenders in production).
    const userAgent = (await browser.userAgent()).replace(/Headless/g, "");
    await applyStealth(page, userAgent);
    const origin = new URL(url).origin;
    const session = new SharinganSession(browser, page, origin);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-browser.test.ts`
Expected: PASS (the Chrome-gated one PASSES if Chrome is present, else SKIPS).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/test/sharingan-browser.test.ts
git commit -m "Sharingan v2: stealth Chrome launch (strip automation tells for user login)"
```

---

### Task 2: OAuth / social-login wall detection

Add a content heuristic so SPA/OAuth login screens (HTTP 200, no password field, no `/login` URL) pause for sign-in instead of being captured as the "site".

**Files:**
- Modify: `apps/daemon/src/sharingan-capture.ts` (`detectLoginWall` at lines 11-16; `capturePage` at lines 65-83)
- Test: `apps/daemon/test/sharingan-capture.test.ts` (add tests)

**Interfaces:**
- Consumes: `DomNode` from `./sharingan-browser.ts` (`{ tag; role?; classes; text; box }`).
- Produces:
  - `looksLikeLoginWall(dom: DomNode[]): boolean`
  - `detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number; dom?: DomNode[] }): boolean` (new optional `dom` field; existing 4-field callers still valid)

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/test/sharingan-capture.test.ts` (add `looksLikeLoginWall` and `type DomNode` to the existing import from `../src/sharingan-capture.ts` / `../src/sharingan-browser.ts`):

```typescript
import { detectLoginWall, looksLikeLoginWall, capturePage, captureCurrentPage } from "../src/sharingan-capture.ts";
import type { DomNode } from "../src/sharingan-browser.ts";

const node = (tag: string, text: string): DomNode => ({ tag, classes: "", text, box: { x: 0, y: 0, w: 10, h: 10 } });

// Shaped after the real tapnow OAuth wall the demo captured: "登录或注册" + provider buttons, little else.
const OAUTH_WALL: DomNode[] = [
  node("h1", "登录或注册"),
  node("button", "使用 Google 继续"),
  node("button", "使用手机号继续"),
  node("a", "使用邮箱登录"),
  node("p", "登录即代表你同意服务条款"),
];

const CONTENT_PAGE: DomNode[] = [
  node("h1", "Acme Analytics"),
  node("p", "The fastest way to understand your product usage across every channel and team."),
  node("a", "Pricing"),
  node("a", "Log in"), // a login LINK in the nav — must NOT trip the heuristic
  ...Array.from({ length: 40 }, (_, i) => node("p", `Feature paragraph number ${i} describing real product value at length.`)),
];

test("looksLikeLoginWall flags an OAuth-dominated low-content page but not a content page with a login link", () => {
  assert.equal(looksLikeLoginWall(OAUTH_WALL), true);
  assert.equal(looksLikeLoginWall(CONTENT_PAGE), false);
  assert.equal(looksLikeLoginWall([]), false);
});

test("detectLoginWall folds in the OAuth content heuristic via the dom field", () => {
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://app.x/home", hasPasswordField: false, textLength: 40, dom: OAUTH_WALL }), true);
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://app.x/home", hasPasswordField: false, textLength: 4000, dom: CONTENT_PAGE }), false);
  // Existing 4-field callers (no dom) still behave exactly as before.
  assert.equal(detectLoginWall({ status: 200, finalUrl: "https://x/", hasPasswordField: false, textLength: 2000 }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: FAIL — `looksLikeLoginWall` is not exported.

- [ ] **Step 3: Implement in `sharingan-capture.ts`**

Add the `DomNode` type import at the top (extend the existing `./sharingan-browser.ts` import):

```typescript
import { SharinganSession, VIEWPORTS, type DomNode } from "./sharingan-browser.ts";
```

Add `looksLikeLoginWall` above `detectLoginWall` (before line 11), and rewrite `detectLoginWall`:

```typescript
// Multilingual login/register keywords + OAuth-provider button phrasings. Kept broad on purpose —
// the low-content gate below is what prevents false positives on normal pages that merely link to login.
const LOGIN_KW = /\b(log ?in|sign ?in|sign ?up|register)\b|登录|登入|注册|登录或注册|ログイン|로그인|로그아웃|sign in/gi;
const OAUTH_BTN = /(continue|sign ?in|log ?in|signup|sign ?up) with (google|apple|github|facebook|microsoft|x|twitter)|使用\s*[^ ]{0,8}(继续|登录)|以\s*[^ ]{0,8}(继续|登录)/i;

/** A page that IS a login/OAuth screen (little else on it) rather than a content page that merely links
 *  to login. Gated on low content — a real landing page has hundreds of nodes and lots of copy, so a
 *  nav "Log in" link never trips this; a bare "登录或注册 / 使用 Google 继续" wall does. */
export function looksLikeLoginWall(dom: DomNode[]): boolean {
  if (!dom.length) return false;
  const joined = dom.map((n) => n.text).filter(Boolean).join(" ");
  const totalText = joined.length;
  const loginHits = (joined.match(LOGIN_KW) ?? []).length;
  const hasOauthBtn = dom.some((n) => OAUTH_BTN.test(n.text));
  const lowContent = dom.length <= 80 && totalText < 800;
  return lowContent && (hasOauthBtn || loginHits >= 3);
}

export function detectLoginWall(input: { status: number; finalUrl: string; hasPasswordField: boolean; textLength: number; dom?: DomNode[] }): boolean {
  if (input.status === 401 || input.status === 403) return true;
  if (LOGIN_URL_RE.test(input.finalUrl)) return true;
  if (input.hasPasswordField && input.textLength < 80) return true;
  if (input.dom && looksLikeLoginWall(input.dom)) return true;
  return false;
}
```

Then pass the DOM into `detectLoginWall` in `capturePage` (the `dom` is already read at line 74):

```typescript
  if (detectLoginWall({ status: nav.status, finalUrl: nav.finalUrl, hasPasswordField, textLength, dom })) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: PASS (the pure tests pass; the Chrome-gated capture tests pass or skip).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "Sharingan v2: detect OAuth/social login walls (pause for user sign-in, don't capture)"
```

---

### Task 3: Richer capture — assets.json + per-node DOM styles

Give the Agent a real blueprint: an image inventory and per-node computed layout, instead of a token summary + a screenshot to guess from.

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (`DomNode` at line 10; `readDom` at lines 73-94; add `Asset` + `assets()` after `discoverLinks`, ~line 129)
- Modify: `apps/daemon/src/sharingan-capture.ts` (`CapturedPage` at line 7; `CaptureStep` kind at line 6; `captureCurrentPage` at lines 28-63; `writePagesManifest` at lines 85-89)
- Modify: `apps/daemon/test/sharingan-ensure.test.ts` (`fakeThatCaptures` at lines 9-20 — add `assets`)
- Test: `apps/daemon/test/sharingan-capture.test.ts` (extend the Chrome-gated capture test)

**Interfaces:**
- Produces:
  - `interface DomNodeStyle { display: string; position: string; flexDirection: string; justifyContent: string; alignItems: string; gap: string; fontSize: string; fontWeight: string; color: string; backgroundColor: string; padding: string; margin: string }`
  - `DomNode` gains `style?: DomNodeStyle`
  - `interface Asset { url: string; kind: "img" | "background" | "video"; alt?: string; w?: number; h?: number }`
  - `SharinganSession.assets(): Promise<Asset[]>`
  - `readDom(maxNodes = 1500)` — default raised; attaches `style` per node
  - `CapturedPage` gains `assets: string` (project-dir-relative path to `assets.json`)

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/test/sharingan-capture.test.ts`:

```typescript
test("captureCurrentPage writes an asset inventory + per-node DOM styles", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><style>
    #row{display:flex;justify-content:center;gap:12px}
    h1{font-size:40px;color:rgb(17,17,17)}
    .hero{background-image:url("/img/hero.png")}
  </style></head><body>
    <div id="row"><h1>Acme</h1></div>
    <img src="/img/logo.png" alt="Acme logo" width="120" height="40">
    <div class="hero" style="width:200px;height:80px">bg</div>
  </body></html>`;
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-rich-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-rich-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    // Asset inventory
    assert.ok(page.assets, "CapturedPage.assets path is set");
    const assets = JSON.parse(readFileSync(join(dir, page.assets), "utf8")) as Array<{ url: string; kind: string; alt?: string }>;
    assert.ok(assets.some((a) => a.kind === "img" && a.url.endsWith("/img/logo.png") && a.alt === "Acme logo"), "captured the <img> with alt");
    assert.ok(assets.some((a) => a.kind === "background" && a.url.endsWith("/img/hero.png")), "captured the CSS background-image");
    // Per-node styles
    const dom = JSON.parse(readFileSync(join(dir, page.dom), "utf8")) as Array<{ tag: string; style?: Record<string, string> }>;
    const row = dom.find((n) => n.style?.display === "flex");
    assert.ok(row && row.style?.justifyContent === "center", "flex container carries computed display + justifyContent");
    const h1 = dom.find((n) => n.tag === "h1");
    assert.equal(h1?.style?.fontSize, "40px", "h1 carries its computed font size");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: FAIL — `page.assets` is undefined / `style` absent (or skip if no Chrome; if skipped, rely on Step 4's pass once Chrome is present — proceed).

- [ ] **Step 3a: Enrich `DomNode` + `readDom` and add `Asset` + `assets()` in `sharingan-browser.ts`**

Replace the `DomNode` interface (line 10) with:

```typescript
export interface DomNodeStyle {
  display: string; position: string; flexDirection: string; justifyContent: string; alignItems: string; gap: string;
  fontSize: string; fontWeight: string; color: string; backgroundColor: string; padding: string; margin: string;
}
export interface DomNode { tag: string; role?: string; classes: string; text: string; box: { x: number; y: number; w: number; h: number }; style?: DomNodeStyle }
export interface Asset { url: string; kind: "img" | "background" | "video"; alt?: string; w?: number; h?: number }
```

Replace `readDom` (lines 73-94) with (default cap raised to 1500; attach the computed-style subset per node):

```typescript
  async readDom(maxNodes = 1500): Promise<DomNode[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const out: any[] = [];
      const walk = (el: any) => {
        if (out.length >= max) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const s = win.getComputedStyle(el);
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || undefined,
            classes: typeof el.className === "string" ? el.className : "",
            text: (el.childNodes.length && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim().slice(0, 120),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            style: {
              display: s.display, position: s.position, flexDirection: s.flexDirection, justifyContent: s.justifyContent,
              alignItems: s.alignItems, gap: s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
              backgroundColor: s.backgroundColor, padding: s.padding, margin: s.margin,
            },
          });
        }
        for (const c of Array.from(el.children)) walk(c);
      };
      if (doc.body) walk(doc.body);
      return out;
    }, maxNodes);
  }

  /** Inventory the page's images: <img> (with alt + rendered size), CSS background-images, and
   *  <video>/<source> URLs. All URLs resolved absolute. The Agent uses this to know which image slots
   *  exist so it can fill them with free placeholders — NOT to re-host the source's brand assets. */
  async assets(maxAssets = 80): Promise<Asset[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      const abs = (u: string): string | null => { try { return new win.URL(u, win.location.href).href; } catch { return null; } };
      const seen = new Set<string>();
      const out: any[] = [];
      const push = (url: string | null, kind: string, alt?: string, w?: number, h?: number) => {
        if (!url || url.startsWith("data:") || seen.has(url) || out.length >= max) return;
        seen.add(url);
        out.push({ url, kind, alt: alt || undefined, w: w || undefined, h: h || undefined });
      };
      for (const img of Array.from<any>(doc.querySelectorAll("img"))) {
        const r = img.getBoundingClientRect();
        push(abs(img.currentSrc || img.src), "img", img.getAttribute("alt") || undefined, Math.round(r.width), Math.round(r.height));
      }
      for (const v of Array.from<any>(doc.querySelectorAll("video"))) {
        push(abs(v.getAttribute("poster") || ""), "img", undefined);
        push(abs(v.currentSrc || v.src || ""), "video");
      }
      for (const sc of Array.from<any>(doc.querySelectorAll("source"))) push(abs(sc.getAttribute("src") || ""), "video");
      for (const el of Array.from<any>(doc.querySelectorAll("body *")).slice(0, 1500)) {
        const bg = win.getComputedStyle(el).backgroundImage as string;
        if (!bg || bg === "none") continue;
        const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
        if (m) { const r = el.getBoundingClientRect(); push(abs(m[1]), "background", undefined, Math.round(r.width), Math.round(r.height)); }
      }
      return out;
    }, maxAssets);
  }
```

- [ ] **Step 3b: Write `assets.json` in `captureCurrentPage` (`sharingan-capture.ts`)**

Add `"assets"` to the `CaptureStep` kind union (line 6):

```typescript
export interface CaptureStep { at: number; kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "assets" | "login-required" | "done"; text: string }
```

Add `assets` to `CapturedPage` (line 7):

```typescript
export interface CapturedPage { url: string; title: string; screenshots: Record<string, string>; dom: string; styles: string; assets: string; links: string[] }
```

In `captureCurrentPage`, after the styles block (after line 55) and before the links step, add the asset inventory; and change the stored-DOM read (line 49) to use the default (1500) cap:

```typescript
  step("dom", "Reading DOM structure");
  const dom = await session.readDom();
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));

  step("styles", "Reading computed style tokens");
  const styleRel = join(rel, "styles.json");
  writeFileSync(join(projectDir, styleRel), JSON.stringify(await session.styleTokens(), null, 0));

  step("assets", "Inventorying image assets");
  const assetRel = join(rel, "assets.json");
  writeFileSync(join(projectDir, assetRel), JSON.stringify(await session.assets(), null, 0));
```

And update the returned object (line 62) to include `assets`:

```typescript
  return { url, title, screenshots, dom: domRel, styles: styleRel, assets: assetRel, links };
```

Add `assets` to the manifest projection in `writePagesManifest` (line 87):

```typescript
  const manifest = { sourceUrl, pages: pages.map((p) => ({ url: p.url, title: p.title, screenshots: p.screenshots, dom: p.dom, styles: p.styles, assets: p.assets, links: p.links })) };
```

- [ ] **Step 3c: Update the capture fake in `sharingan-ensure.test.ts`**

`captureCurrentPage` now calls `session.assets()`; the ensure test's fake must provide it. In `fakeThatCaptures` (lines 9-20) add one line inside the returned object:

```typescript
    assets: async () => [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Then: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-ensure.test.ts`
Expected: PASS (capture test passes with Chrome / skips without; ensure test passes — the `assets` fake keeps `captureCurrentPage` working).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors. (If any other `SharinganSession` fake in the daemon tests feeds `captureCurrentPage` and now lacks `assets`, add `assets: async () => []` to it — grep `as unknown as SharinganSession` across `apps/daemon/test`.)

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts apps/daemon/test/sharingan-ensure.test.ts
git commit -m "Sharingan v2: richer capture — assets.json inventory + per-node DOM computed styles"
```

---

### Task 4: Placeholder-image + match-source build context

Tell the Agent to read `assets.json`, fill image slots with free placeholders, and match the captured source's structure — so "该有图的地方" gets an image.

**Files:**
- Modify: `apps/daemon/src/sharingan-context.ts` (`buildSharinganContext` promptBlock at lines 24-39)
- Test: `apps/daemon/test/sharingan-context.test.ts` (add assertions)

**Interfaces:**
- Consumes/Produces: `buildSharinganContext(input)` — unchanged signature; the returned `promptBlock` gains asset/placeholder/match-source guidance.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/test/sharingan-context.test.ts` (inside the existing test or as a new one):

```typescript
test("buildSharinganContext tells the agent to inventory assets and fill image slots with free placeholders", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /assets\.json/);                         // read the image inventory
  assert.match(promptBlock, /picsum\.photos|placehold\.co|unsplash/i); // a free placeholder source
  assert.match(promptBlock, /image slot|placeholder image/i);         // fill empty image slots
  assert.match(promptBlock, /match|reproduce/i);                      // match the source structure
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-context.test.ts`
Expected: FAIL — `assets.json` / `picsum` not present.

- [ ] **Step 3: Implement in `sharingan-context.ts`**

In `buildSharinganContext`, update the `.sharingan/` line (line 28) to mention `assets.json`, and add two lines before the final "Then build..." line (line 38). Replace line 28:

```typescript
    "The entry page is already captured under `.sharingan/` (screenshots, `dom.json` with per-node computed layout, `styles.json`, and `assets.json` — an inventory of the source's images) and indexed in `.sharingan/pages.json` (which also lists the entry page's same-origin links). Read those files directly to understand the site.",
```

And insert before the final array element (before line 38's "Then build..."):

```typescript
    "For every image slot the source has (see `assets.json` — each entry lists the URL, kind, alt, and rendered size), place a FREE placeholder image sized to match, never the source's brand asset: use `https://picsum.photos/seed/<word>/<w>/<h>`, `https://placehold.co/<w>x<h>`, or an Unsplash source URL keyed to the content, and write a sensible `alt`. Do not leave image slots empty and do not hotlink the source's images.",
    "Match the source: reproduce its layout structure, component hierarchy, image-slot placement, type scale, and color palette from the captured `dom.json`/`styles.json`/screenshots — this is a faithful reconstruction, not a redesign.",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-context.test.ts`
Expected: PASS (both the existing and new assertions).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-context.ts apps/daemon/test/sharingan-context.test.ts
git commit -m "Sharingan v2: instruct the agent to fill image slots with free placeholders + match source"
```

---

### Task 5: Sharingan-aware Visual Review

Feed the captured source screenshot + asset summary to the Visual Review critic as a fidelity reference, so it drives "match the source" instead of only generic color tweaks.

**Files:**
- Modify: `apps/daemon/src/visual-qa.ts` (`VisualQaInput` at lines 13-31; `agentReviewPrompt` at lines 175-217)
- Modify: `apps/daemon/src/sharingan-capture.ts` (add `sharinganReviewReference` helper)
- Modify: `apps/daemon/src/run-handler.ts` (`runVisualQa` options Pick at line 460; call site at lines 995-999; add import)
- Test: `apps/daemon/test/visual-qa.test.ts` (add `agentReviewPrompt` assertions)
- Test: `apps/daemon/test/sharingan-capture.test.ts` (add `sharinganReviewReference` test)

**Interfaces:**
- Consumes: `CapturedPage` shape from Task 3 (`screenshots`, `assets`); the `.sharingan/pages.json` manifest.
- Produces:
  - `VisualQaInput` gains `sharinganReference?: { screenshotPath: string; assetsSummary?: string }`
  - `sharinganReviewReference(projectDir: string): { screenshotPath: string; assetsSummary?: string } | undefined` (in `sharingan-capture.ts`)
  - `runVisualQa(..., options)` — `options` Pick widened to include `"sharinganReference"`

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/test/visual-qa.test.ts`:

```typescript
test("agentReviewPrompt adds a source-fidelity section when a Sharingan reference is present", () => {
  const input = {
    htmlPath: "/proj/index.html",
    projectRoot: "/proj",
    brief: "Rebuild the site",
    sharinganReference: { screenshotPath: "/proj/.sharingan/home-abcd1234/shot-desktop.png", assetsSummary: "6 images: hero (1200x400), logo (120x40)" },
  } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.match(prompt, /\.sharingan\/home-abcd1234\/shot-desktop\.png/); // the source screenshot, path relative to projectRoot
  assert.match(prompt, /source/i);
  assert.match(prompt, /reconstruc/i); // "reconstructing" / "reconstruction"
  assert.match(prompt, /6 images: hero/);
});

test("agentReviewPrompt has no source-fidelity section for a normal (non-Sharingan) build", () => {
  const input = { htmlPath: "/proj/index.html", projectRoot: "/proj", brief: "A chat UI" } as unknown as VisualQaInput;
  const prompt = agentReviewPrompt(input, "/proj/.visual-qa/shot.png");
  assert.ok(!/Source screenshot/i.test(prompt), "no fidelity section without a reference");
});
```

Add to `apps/daemon/test/sharingan-capture.test.ts` (needs `writeFileSync`, `mkdirSync` — extend the existing `node:fs` import):

```typescript
import { detectLoginWall, looksLikeLoginWall, capturePage, captureCurrentPage, writePagesManifest, sharinganReviewReference } from "../src/sharingan-capture.ts";

test("sharinganReviewReference resolves the entry screenshot + an asset summary from the bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "shar-ref-"));
  const pageRel = join(".sharingan", "home-abcd1234");
  mkdirSync(join(dir, pageRel), { recursive: true });
  writeFileSync(join(dir, pageRel, "shot-desktop.png"), "png");
  writeFileSync(join(dir, pageRel, "assets.json"), JSON.stringify([{ url: "https://x/a.png", kind: "img", alt: "logo" }, { url: "https://x/b.png", kind: "background" }]));
  writeFileSync(join(dir, ".sharingan", "pages.json"), JSON.stringify({
    sourceUrl: "https://x/",
    pages: [{ url: "https://x/", title: "Home", screenshots: { desktop: join(pageRel, "shot-desktop.png"), mobile: join(pageRel, "shot-mobile.png") }, dom: join(pageRel, "dom.json"), styles: join(pageRel, "styles.json"), assets: join(pageRel, "assets.json"), links: [] }],
  }));
  const ref = sharinganReviewReference(dir);
  assert.ok(ref, "returns a reference");
  assert.equal(ref!.screenshotPath, join(dir, pageRel, "shot-desktop.png"), "absolute path to the entry desktop screenshot");
  assert.match(ref!.assetsSummary ?? "", /2 image/);
  // No bundle -> undefined.
  assert.equal(sharinganReviewReference(mkdtempSync(join(tmpdir(), "shar-empty-"))), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/visual-qa.test.ts`
Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: FAIL — `sharinganReference` block absent; `sharinganReviewReference` not exported.

- [ ] **Step 3a: Add `sharinganReference` to `VisualQaInput` + the fidelity section in `agentReviewPrompt` (`visual-qa.ts`)**

Add the field to `VisualQaInput` (after `directionSpec`, ~line 25):

```typescript
  /** When this build is a Sharingan clone: the captured SOURCE screenshot (absolute path) + a short
   *  asset summary, so the critic can judge fidelity to the source, not just generic quality. */
  sharinganReference?: { screenshotPath: string; assetsSummary?: string };
```

In `agentReviewPrompt`, compute the source line near the top (after `screenshotRel`, ~line 178):

```typescript
  const ref = input.sharinganReference;
  const sourceRel = ref ? toRel(projectDir, ref.screenshotPath) : "";
```

Add two entries to the prompt array — a source-evidence line near the rendered-screenshot line (after the `Rendered screenshot` line at ~line 197) and a fidelity instruction. Insert after the `Final artifact` line:

```typescript
    ref ? `Source screenshot (the ORIGINAL site you are RECONSTRUCTING — the build should match its layout, hierarchy, image slots, type scale, and palette): ${sourceRel}` : "",
    ref?.assetsSummary ? `Source image inventory: ${ref.assetsSummary}` : "",
```

And extend the `"improvement"` kind description (line 210) so fidelity gaps are filed as improvements — append this sentence to that string (before its closing `"`):

```
 For a Sharingan reconstruction, a divergence from the SOURCE screenshot (different layout structure, missing/empty image slot the source fills, wrong component hierarchy, off type scale or palette) is exactly this kind of advisory improvement — cite the specific gap from the source.
```

- [ ] **Step 3b: Add `sharinganReviewReference` to `sharingan-capture.ts`**

Add at the end of the file:

```typescript
/** Locate the Sharingan review reference for a project: the entry page's desktop screenshot (absolute
 *  path, so the critic can read it) + a one-line summary of the source's image inventory. Returns
 *  undefined when there is no captured bundle yet. Reads the on-disk `.sharingan/pages.json`. */
export function sharinganReviewReference(projectDir: string): { screenshotPath: string; assetsSummary?: string } | undefined {
  const manifestPath = join(projectDir, ".sharingan", "pages.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { pages?: Array<{ screenshots?: Record<string, string>; assets?: string }> };
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return undefined; }
  const entry = manifest.pages?.[0];
  const shotRel = entry?.screenshots?.desktop;
  if (!shotRel) return undefined;
  const screenshotPath = join(projectDir, shotRel);
  if (!existsSync(screenshotPath)) return undefined;
  let assetsSummary: string | undefined;
  if (entry?.assets && existsSync(join(projectDir, entry.assets))) {
    try {
      const assets = JSON.parse(readFileSync(join(projectDir, entry.assets), "utf8")) as Array<{ kind: string; alt?: string; w?: number; h?: number }>;
      const imgs = assets.filter((a) => a.kind === "img" || a.kind === "background");
      const sample = imgs.slice(0, 4).map((a) => `${a.alt || a.kind}${a.w && a.h ? ` (${a.w}x${a.h})` : ""}`).join(", ");
      if (imgs.length) assetsSummary = `${imgs.length} image slot${imgs.length === 1 ? "" : "s"}: ${sample}`;
    } catch { /* ignore a malformed assets.json */ }
  }
  return { screenshotPath, assetsSummary };
}
```

Add `existsSync`, `readFileSync` to the `node:fs` import at the top of `sharingan-capture.ts`:

```typescript
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
```

- [ ] **Step 3c: Wire it through `run-handler.ts`**

Add the import (near line 60):

```typescript
import { buildSharinganContext } from "./sharingan-context.ts";
import { sharinganReviewReference } from "./sharingan-capture.ts";
```

Widen the `runVisualQa` `options` Pick (line 460):

```typescript
  options: Pick<VisualQaInput, "projectRoot" | "renderUrl" | "directionSpec" | "sharinganReference"> = {},
```

Pass the reference at the call site (lines 995-999):

```typescript
            visualFindings = await runVisualQa(deps, join(dir, "index.html"), settings, runAgentCommand, runModel, visibleBrief, turnHistory, {
              projectRoot: dir,
              renderUrl,
              directionSpec: chosenDirectionSpec,
              sharinganReference: project.sharingan ? sharinganReviewReference(projectDir(deps.dataDir, project.id)) : undefined,
            });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/visual-qa.test.ts`
Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/visual-qa.ts apps/daemon/src/sharingan-capture.ts apps/daemon/src/run-handler.ts apps/daemon/test/visual-qa.test.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "Sharingan v2: Sharingan-aware Visual Review (critic compares build against captured source)"
```

---

### Task 6: Session lifecycle — keep the entry session open + raise idle timeout

Stop Chrome churning: keep the just-authenticated entry session open for the Agent to reuse as a probe during the build, and raise the too-aggressive 2-minute idle timeout to 5 minutes.

**Files:**
- Modify: `apps/daemon/src/sharingan-handler.ts` (`SHARINGAN_PROBE_IDLE_MS` line 29; `Capture` line 17-26; `startCapture` lines 98-118; `continueCapture` lines 176-189; `ensureCaptured` lines 132-156)
- Modify: `apps/daemon/src/run-handler.ts` (`ensureCaptured` call at line 748)
- Test: `apps/daemon/test/sharingan-ensure.test.ts` (add lifecycle tests)

**Interfaces:**
- Consumes: `fakeThatCaptures()` (now with `assets`, from Task 3).
- Produces:
  - `SHARINGAN_PROBE_IDLE_MS` — exported const, raised to `300_000`
  - `ensureCaptured(id, dataDir, url, opts)` — `opts` gains `keepSessionForProbe?: boolean`; returns `"probing"` as a terminal success when the entry session is kept open
  - `Capture` gains internal `keepForProbe?: boolean`

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/test/sharingan-ensure.test.ts` (extend imports to include `ensureProbeSession` and `SHARINGAN_PROBE_IDLE_MS`):

```typescript
import { ensureCaptured, capturedPageCount, ensureProbeSession, SHARINGAN_PROBE_IDLE_MS } from "../src/sharingan-handler.ts";

test("SHARINGAN_PROBE_IDLE_MS is at least 5 minutes", () => {
  assert.ok(SHARINGAN_PROBE_IDLE_MS >= 300_000, "idle window raised from the too-aggressive 2 minutes");
});

test("ensureCaptured with keepSessionForProbe keeps the entry session open for probe reuse", async () => {
  const id = "keep-probe";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-keep-"));
  let opens = 0;
  const fake = fakeThatCaptures();
  const open = async () => { opens += 1; return fake; };
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 5000, pollMs: 30, keepSessionForProbe: true, open });
  assert.equal(phase, "probing", "kept open (probing), not closed to captured");
  assert.equal(capturedPageCount(id), 1, "entry page still captured");
  const s = await ensureProbeSession(id, dataDir, open);
  assert.equal(opens, 1, "probe reuses the kept-open entry session — no reopen");
  assert.equal(s, fake);
});

test("ensureCaptured without keepSessionForProbe closes the entry session (probe reopens)", async () => {
  const id = "no-keep";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-nokeep-"));
  let opens = 0, closes = 0;
  const fake = { ...fakeThatCaptures(), close: async () => { closes += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => { opens += 1; return fake; };
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 5000, pollMs: 30, open });
  assert.equal(phase, "captured");
  assert.ok(closes >= 1, "entry session closed on captured");
  await ensureProbeSession(id, dataDir, open);
  assert.equal(opens, 2, "probe had to reopen a fresh session");
});
```

Note: `fakeThatCaptures()` returns a value cast `as unknown as SharinganSession`; spreading it in the "no-keep" test then re-casting is fine because it's an object literal of async stubs.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-ensure.test.ts`
Expected: FAIL — `SHARINGAN_PROBE_IDLE_MS` not exported / `keepSessionForProbe` unsupported / phase is `"captured"` not `"probing"`.

- [ ] **Step 3a: Raise + export the idle constant and add the keep-open flag (`sharingan-handler.ts`)**

Change line 29:

```typescript
/** Idle-release window for a lazily-opened (or build-reused) probe session. */
export const SHARINGAN_PROBE_IDLE_MS = 300_000;
```

Add `keepForProbe` to the `Capture` interface (inside lines 17-26):

```typescript
  probeTimer?: ReturnType<typeof setTimeout>;
  keepForProbe?: boolean;
```

- [ ] **Step 3b: Add a shared finalize helper + use it in both capture paths**

Add this helper above `startCapture` (after `ensureProbeSession`, ~line 82):

```typescript
/** Finalize a successful capture: persist the manifest, then either KEEP the session open for the
 *  build Agent to reuse as a probe (phase "probing", idle-released) or close it (phase "captured").
 *  Keeping it open avoids reopening Chrome mid-build and preserves the just-authenticated session. */
async function finishCapturedSession(id: string, dataDir: string, c: Capture, page: CapturedPage | null): Promise<void> {
  if (page) { c.pages.push(page); writePagesManifest(projectDir(dataDir, id), c.url ?? page.url, c.pages); }
  if (c.keepForProbe && c.session) {
    c.phase = "probing";
    armProbeIdle(id);
  } else {
    await c.session?.close();
    c.session = undefined;
    c.phase = "captured";
  }
}
```

In `startCapture`, replace the success tail (lines 104-110) — keep the `loginRequired` early return, then delegate:

```typescript
    if (loginRequired) { c.phase = "login-required"; return; }
    await finishCapturedSession(id, dataDir, c, page);
```

In `continueCapture`, replace the success tail (lines 179-183) the same way:

```typescript
    if (loginRequired) { c.phase = "login-required"; return; }
    await finishCapturedSession(id, dataDir, c, page);
```

- [ ] **Step 3c: Teach `ensureCaptured` the keep-open option + terminal `"probing"`**

Update the `ensureCaptured` signature `opts` (line 136) and body (lines 138-155):

```typescript
export async function ensureCaptured(
  id: string,
  dataDir: string,
  url: string,
  opts: { maxWaitMs?: number; pollMs?: number; keepSessionForProbe?: boolean; open?: (url: string, o: { userDataDir?: string; headless?: boolean }) => Promise<SharinganSession> } = {},
): Promise<Phase> {
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const pollMs = opts.pollMs ?? 500;
  const c = get(id);
  if (opts.keepSessionForProbe) c.keepForProbe = true;
  if (c.phase === "captured") return c.phase;
  if (c.phase === "idle" || c.phase === "error") {
    const profileDir = join(dataDir, ".sharingan-profile");
    void startCapture(id, url, dataDir, profileDir, opts.open);
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const phase = get(id).phase;
    // "probing" is a terminal SUCCESS here: the entry capture finished and its session was kept open
    // for the Agent to reuse (keepSessionForProbe). The build can proceed.
    if (phase === "captured" || phase === "error" || phase === "probing") return phase;
    if (Date.now() >= deadline) return phase;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
```

- [ ] **Step 3d: Pass `keepSessionForProbe` from the build (`run-handler.ts`)**

Change the `ensureCaptured` call (line 748):

```typescript
    await ensureCaptured(project.id, deps.dataDir, project.sourceUrl, { keepSessionForProbe: true }).catch(() => {});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-ensure.test.ts`
Expected: PASS. Also re-run the probe + handler suites to confirm the shared helper didn't regress them:
`cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-continue.test.ts test/sharingan-handler.test.ts`
Expected: PASS (probe tests are Chrome-gated; they skip without Chrome).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-handler.ts apps/daemon/src/run-handler.ts apps/daemon/test/sharingan-ensure.test.ts
git commit -m "Sharingan v2: keep the entry session open for probe reuse + raise idle timeout to 5m"
```

---

## Final Verification (after all tasks)

- [ ] Run every touched daemon test file individually (all PASS or skip-without-Chrome):
  `sharingan-browser`, `sharingan-capture`, `sharingan-context`, `sharingan-ensure`, `sharingan-continue`, `sharingan-handler`, `visual-qa`.
- [ ] Typecheck the node program: `pnpm exec tsc -p tsconfig.check.json --noEmit`.
- [ ] Leave the version bump for merge/landing (Global Constraints).

## Self-Review notes (spec coverage)

- Spec P0-1 stealth → Task 1. P0-2 OAuth detection → Task 2. P1-3 assets.json → Task 3. P1-4 richer capture → Task 3. P1-5 placeholder images → Task 4. P1-6 Sharingan-aware review → Task 5. P2-7 lifecycle → Task 6. All seven spec items are covered.
- Type consistency: `Asset`/`DomNodeStyle`/`DomNode.style` (Task 3) consumed by nothing downstream except the on-disk bundle; `CapturedPage.assets` (Task 3) consumed by `sharinganReviewReference` (Task 5) and `writePagesManifest` (Task 3). `sharinganReference` shape identical in `VisualQaInput` (Task 5), `sharinganReviewReference` return (Task 5), and `runVisualQa` Pick (Task 5). `keepSessionForProbe`/`keepForProbe`/`SHARINGAN_PROBE_IDLE_MS` all Task 6.
