# Sharingan v3 — 1:1 Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Sharingan clone reproduce the source's structure, styling, and imagery as faithfully as possible (1:1), instead of drifting into a re-designed, image-less skeleton.

**Architecture:** Six tasks on `feat/sharingan-v3`. Daemon: a nested-tree DOM capture, real-image caching via the authenticated session, a "reproduce faithfully" build prompt, and a clone-aware lint that stops the anti-slop gate from fighting faithful cloning. Web: a large-file guard for the Files viewer, and a red "Sharingan/写轮眼" entry treatment with the mode tag hidden. Everything is gated on `project.sharingan`/`isSharingan` — zero behavior change for normal builds.

**Tech Stack:** TypeScript (`--experimental-strip-types` daemon; Vite/React web), `puppeteer-core`, `node:test` (daemon), `vitest` + `@testing-library/react` (web). `motion` + `tw-animate-css` already in web deps.

## Global Constraints

- **No new dependencies.**
- **Guardrail shift (v3):** faithful reproduction INCLUDING cached real images — not "placeholders only, never rip." Auth stays user-driven; the clone still runs only after the authorized-use affirmation.
- **All changes gated on `project.sharingan`/`isSharingan`** — non-Sharingan builds and normal Files/Home behavior must be byte-unchanged.
- **Commits:** NO `Co-Authored-By` trailer. Bump the root `package.json` version only at merge, not per task.
- **Daemon tests run per-file** (full suite hangs on `runs.test.ts`/`variants.test.ts`): `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/<file>.test.ts`. Chrome-gated tests use `{ skip: !findChrome() && "no Chrome" }`.
- **Daemon typecheck (repo root):** `pnpm exec tsc -p tsconfig.check.json --noEmit`. DOM-less — inside `page.evaluate` bodies use `(globalThis as any)`, never bare `document`/`window`/`fetch`/`URL`.
- **Web tests:** `cd apps/web && pnpm exec vitest run <path>`. **Web typecheck:** `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json`.

---

### Task 1: Nested-tree DOM capture

Give the builder the real DOM hierarchy + fuller styles instead of a flat box list, so it mirrors structure instead of guessing.

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (add `DomTreeStyle`, `DomTreeNode`, `readDomTree`; near `DomNode` at line 10 and after `readDom` ~line 94)
- Modify: `apps/daemon/src/sharingan-capture.ts` (`captureCurrentPage` — use `readDomTree` for `dom.json` + recursive title)
- Test: `apps/daemon/test/sharingan-capture.test.ts`

**Interfaces:**
- Produces:
  - `interface DomTreeStyle` — the 12 existing `DomNodeStyle` fields plus `width, height, border, borderColor, backgroundImage, gridTemplateColumns, gridTemplateRows, opacity, textAlign, lineHeight, letterSpacing` (all `string`).
  - `interface DomTreeNode { tag: string; role?: string; classes: string; text: string; box: {x:number;y:number;w:number;h:number}; style: DomTreeStyle; children: DomTreeNode[] }`
  - `SharinganSession.readDomTree(maxNodes = 1500): Promise<DomTreeNode[]>`
- Note: the existing flat `readDom` is UNCHANGED (login detection + probe endpoint keep using it).

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/test/sharingan-capture.test.ts`:

```typescript
test("captureCurrentPage writes a NESTED dom tree with fuller per-node styles", { skip: !findChrome() && "no Chrome" }, async () => {
  const html = `<!doctype html><html><head><style>
    #row{display:flex;justify-content:center;gap:12px;width:400px}
    h1{font-size:40px;color:rgb(17,17,17);text-align:center}
  </style></head><body><div id="row"><h1>Acme</h1><p>hello</p></div></body></html>`;
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-tree-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-tree-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    const tree = JSON.parse(readFileSync(join(dir, page.dom), "utf8")) as Array<{ tag: string; children: any[]; style: Record<string, string> }>;
    // Root is <body>, with the #row div nested under it, and h1/p nested under that.
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.tag, "body");
    const row = tree[0]!.children.find((n: any) => n.style?.display === "flex");
    assert.ok(row, "flex row is a nested child of body");
    assert.equal(row.style.justifyContent, "center");
    assert.ok(row.style.width, "fuller styles: width is captured");
    const h1 = row.children.find((n: any) => n.tag === "h1");
    assert.ok(h1 && h1.style.textAlign === "center" && h1.text.includes("Acme"), "h1 nested under row with textAlign + text");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: FAIL — `dom.json` is a flat array (no `children`).

- [ ] **Step 3a: Add the tree types + `readDomTree` in `sharingan-browser.ts`**

After the `DomNode` interface (line 10), add:

```typescript
export interface DomTreeStyle extends DomNodeStyle {
  width: string; height: string; border: string; borderColor: string; backgroundImage: string;
  gridTemplateColumns: string; gridTemplateRows: string; opacity: string; textAlign: string; lineHeight: string; letterSpacing: string;
}
export interface DomTreeNode {
  tag: string; role?: string; classes: string; text: string;
  box: { x: number; y: number; w: number; h: number };
  style: DomTreeStyle; children: DomTreeNode[];
}
```

After the `readDom` method (after line 94), add:

```typescript
  /** Capture the DOM as a NESTED tree (hierarchy preserved) with a fuller per-node computed-style
   *  subset — the reproduction blueprint the Sharingan builder mirrors. Invisible subtrees (0-area)
   *  are dropped. `maxNodes` bounds the total node count across the whole tree. Only leaf nodes carry
   *  `text` (interior text is redundant — the children carry it). */
  async readDomTree(maxNodes = 1500): Promise<DomTreeNode[]> {
    return this.page.evaluate((max: number) => {
      const win = globalThis as any;
      const doc = win.document;
      let count = 0;
      const build = (el: any): any | null => {
        if (count >= max) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        count++;
        const s = win.getComputedStyle(el);
        const node: any = {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || undefined,
          classes: typeof el.className === "string" ? el.className : "",
          text: (el.children.length === 0 && el.innerText ? el.innerText : "").replace(/\s+/g, " ").trim().slice(0, 200),
          box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          style: {
            display: s.display, position: s.position, flexDirection: s.flexDirection, justifyContent: s.justifyContent,
            alignItems: s.alignItems, gap: s.gap, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
            backgroundColor: s.backgroundColor, padding: s.padding, margin: s.margin, width: s.width, height: s.height,
            border: s.border, borderColor: s.borderColor, backgroundImage: s.backgroundImage,
            gridTemplateColumns: s.gridTemplateColumns, gridTemplateRows: s.gridTemplateRows, opacity: s.opacity,
            textAlign: s.textAlign, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          },
          children: [],
        };
        for (const c of Array.from(el.children)) {
          const child = build(c);
          if (child) node.children.push(child);
        }
        return node;
      };
      const root = doc.body ? build(doc.body) : null;
      return root ? [root] : [];
    }, maxNodes);
  }
```

- [ ] **Step 3b: Use `readDomTree` for `dom.json` in `captureCurrentPage`**

In `apps/daemon/src/sharingan-capture.ts`, replace the DOM read + title lines. The current block reads:

```typescript
  step("dom", "Reading DOM structure");
  const dom = await session.readDom();
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));
```

Replace with:

```typescript
  step("dom", "Reading DOM structure");
  const dom = await session.readDomTree();
  const domRel = join(rel, "dom.json");
  writeFileSync(join(projectDir, domRel), JSON.stringify(dom, null, 0));
```

The title line currently reads `const title = (dom.find((n) => n.tag === "h1")?.text || url).slice(0, 80);`. `dom` is now a tree, so replace it with a recursive find. Add this helper above `captureCurrentPage` (near `pageDir`):

```typescript
function firstText(nodes: import("./sharingan-browser.ts").DomTreeNode[], tag: string): string | undefined {
  for (const n of nodes) {
    if (n.tag === tag && n.text) return n.text;
    const found = firstText(n.children, tag);
    if (found) return found;
  }
  return undefined;
}
```

And change the title line to:

```typescript
  const title = (firstText(dom, "h1") || url).slice(0, 80);
```

Update the import at the top of `sharingan-capture.ts` to include `DomTreeNode` (it already imports from `./sharingan-browser.ts`):

```typescript
import { SharinganSession, VIEWPORTS, type DomNode, type DomTreeNode } from "./sharingan-browser.ts";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: PASS (or skip without Chrome). The pre-existing capture tests still pass.

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "Sharingan v3: nested-tree DOM capture (hierarchy + fuller per-node styles) for dom.json"
```

---

### Task 2: Cache real images into the project

Download the source's actual images via the authenticated session so the clone shows real imagery, not empty slots.

**Files:**
- Modify: `apps/daemon/src/sharingan-browser.ts` (`Asset` gains `local?`; add `fetchAsset`)
- Modify: `apps/daemon/src/sharingan-capture.ts` (`captureCurrentPage` downloads images + rewrites `assets.json`)
- Test: `apps/daemon/test/sharingan-capture.test.ts`

**Interfaces:**
- Consumes: `Asset { url; kind: "img"|"background"|"video"; alt?; w?; h? }` (from v2).
- Produces:
  - `Asset` gains `local?: string` (a web path like `/_assets/<file>` when cached, else absent).
  - `SharinganSession.fetchAsset(url: string): Promise<{ bytes: number[]; contentType: string } | null>` — fetches bytes in the page context (inherits login cookies); `null` on any failure.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/test/sharingan-capture.test.ts`:

```typescript
test("captureCurrentPage downloads real images into public/_assets and rewrites assets.json local paths", { skip: !findChrome() && "no Chrome" }, async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // minimal PNG signature bytes
  const fixture = createServer((req, res) => {
    if (req.url === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><body><h1>Acme</h1><img src="/logo.png" alt="logo" width="80" height="40"></body></html>');
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "shar-img-"));
  const session = await SharinganSession.open(url, { userDataDir: mkdtempSync(join(tmpdir(), "shar-img-prof-")), headless: true });
  try {
    const page = await captureCurrentPage(session, dir, url, () => {});
    const assets = JSON.parse(readFileSync(join(dir, page.assets), "utf8")) as Array<{ url: string; kind: string; local?: string }>;
    const logo = assets.find((a) => a.url.endsWith("/logo.png"));
    assert.ok(logo?.local && logo.local.startsWith("/_assets/"), "logo asset gained a local /_assets/ path");
    assert.ok(existsSync(join(dir, "public", logo!.local!.replace(/^\//, ""))), "the image file was written under public/_assets");
  } finally {
    await session.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: FAIL — assets have no `local` field; `public/_assets` not written.

- [ ] **Step 3a: Add `Asset.local` + `fetchAsset` in `sharingan-browser.ts`**

Change the `Asset` interface (line 12) to add `local?`:

```typescript
export interface Asset { url: string; kind: "img" | "background" | "video"; alt?: string; w?: number; h?: number; local?: string }
```

After the `assets()` method, add:

```typescript
  /** Fetch an asset's bytes in the PAGE context so it inherits the authenticated session's cookies
   *  (some source images are login-gated). Returns the raw bytes + content-type, or null on any
   *  failure (network error, non-2xx, CORS). Best-effort — callers treat null as "not cached". */
  async fetchAsset(url: string): Promise<{ bytes: number[]; contentType: string } | null> {
    return this.page.evaluate(async (u: string) => {
      try {
        const g = globalThis as any;
        const res = await g.fetch(u);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab)) as number[];
        if (!bytes.length) return null;
        return { bytes, contentType: res.headers.get("content-type") || "" };
      } catch {
        return null;
      }
    }, url);
  }
```

- [ ] **Step 3b: Download + rewrite in `captureCurrentPage` (`sharingan-capture.ts`)**

Add `createHash` is already imported. Add an extension helper above `captureCurrentPage`:

```typescript
const CT_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" };
function assetExt(url: string, contentType: string): string {
  const ct = CT_EXT[contentType.split(";")[0]?.trim() ?? ""];
  if (ct) return ct;
  const m = /\.(png|jpe?g|webp|gif|svg|avif)(?:\?|#|$)/i.exec(url);
  return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : "png";
}
```

The current assets block in `captureCurrentPage` reads:

```typescript
  step("assets", "Inventorying image assets");
  const assetRel = join(rel, "assets.json");
  writeFileSync(join(projectDir, assetRel), JSON.stringify(await session.assets(), null, 0));
```

Replace it with (inventory → download images into `public/_assets/` → write enriched `assets.json`):

```typescript
  step("assets", "Inventorying image assets");
  const assets = await session.assets();
  step("assets", "Downloading source images");
  const publicAssetsDir = join(projectDir, "public", "_assets");
  mkdirSync(publicAssetsDir, { recursive: true });
  for (const a of assets) {
    if (a.kind === "video") continue; // skip heavy video files; posters are inventoried as kind "img"
    const got = await session.fetchAsset(a.url).catch(() => null);
    if (!got) continue;
    const name = `${createHash("sha1").update(a.url).digest("hex").slice(0, 12)}.${assetExt(a.url, got.contentType)}`;
    try {
      writeFileSync(join(publicAssetsDir, name), Buffer.from(got.bytes));
      a.local = `/_assets/${name}`;
    } catch { /* best-effort: leave a.local unset */ }
  }
  const assetRel = join(rel, "assets.json");
  writeFileSync(join(projectDir, assetRel), JSON.stringify(assets, null, 0));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-capture.test.ts`
Expected: PASS (or skip without Chrome).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sharingan-browser.ts apps/daemon/src/sharingan-capture.ts apps/daemon/test/sharingan-capture.test.ts
git commit -m "Sharingan v3: cache real source images (authed fetch) into public/_assets + assets.json local paths"
```

---

### Task 3: "Reproduce faithfully" build prompt

Flip the context from "reconstruct the design language" to "reproduce this page 1:1 using the nested tree, exact palette, and cached real images."

**Files:**
- Modify: `apps/daemon/src/sharingan-context.ts` (`buildSharinganContext.promptBlock`)
- Test: `apps/daemon/test/sharingan-context.test.ts`

**Interfaces:** `buildSharinganContext(input)` — signature unchanged; the `promptBlock` copy changes.

- [ ] **Step 1: Write the failing test**

Replace the placeholder-image assertions in `apps/daemon/test/sharingan-context.test.ts` with a faithful-reproduction test (add alongside the existing endpoint test):

```typescript
test("buildSharinganContext directs a faithful 1:1 reproduction using the nested tree, exact palette, and cached local images", () => {
  const { promptBlock } = buildSharinganContext({ projectId: "p1", sourceUrl: "https://example.com", origin: "http://127.0.0.1:8787", budget: 6, capturedCount: 1 });
  assert.match(promptBlock, /faithful|reproduce|1:1|1 ?: ?1/i);       // reproduce, not reconstruct
  assert.match(promptBlock, /\/_assets\//);                            // use the cached local images
  assert.match(promptBlock, /styles\.json|palette/i);                  // match the exact captured palette
  assert.match(promptBlock, /dom\.json/);                              // mirror the captured tree
  assert.ok(!/NOT a byte-for-byte copy/i.test(promptBlock), "the old reconstruct-not-copy framing is gone");
  assert.ok(!/placeholder/i.test(promptBlock) || /_assets/.test(promptBlock), "no longer instructs placeholder-only images");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-context.test.ts`
Expected: FAIL — the block still says "RECONSTRUCTION … NOT a byte-for-byte copy" and recommends placeholder CDNs.

- [ ] **Step 3: Rewrite the promptBlock in `sharingan-context.ts`**

Replace the `promptBlock` array (the whole `[ ... ].join("\n")`) with:

```typescript
  const promptBlock = [
    "## Sharingan — Reproduce from Capture (1:1)",
    `You are reproducing the website ${sourceUrl} as a high-fidelity Standard (Vite + React) project. The goal is a FAITHFUL 1:1 reproduction of the ORIGINAL — match its structure, layout, spacing, typography, and colors as closely as you can. This is authorized cloning; do not redesign it in your own taste.`,
    "",
    "The entry page is already captured under `.sharingan/` and indexed in `.sharingan/pages.json`. Read these directly:",
    "- `dom.json` — the captured DOM as a NESTED TREE (parent/child hierarchy) with per-node computed styles (display/flex/grid/size/padding/margin/font/color/border/etc.). MIRROR this structure and these styles — it is your blueprint. Do not invent a different layout.",
    "- `styles.json` — the source's exact design tokens (colors, fonts, radii, shadows). Use THESE colors and fonts verbatim. Do NOT substitute default AI colors (no indigo/violet/purple unless the source actually uses them).",
    "- `assets.json` — the image inventory. Each entry has a `local` path (e.g. `/_assets/ab12cd34ef56.png`) — the REAL source image already downloaded into this project's `public/` folder. Reference every image by its `local` path (they resolve at the web root). Fill EVERY image slot the source has; an entry without a `local` path failed to download — use a neutral sized placeholder box for just those.",
    "- the desktop/mobile screenshots — the visual source of truth; your result should look like them.",
    "",
    "You may drive the live browser to explore + capture additional key pages via these local endpoints (send `x-dezin-daemon-token: $DEZIN_DAEMON_TOKEN`):",
    `- Navigate: POST ${base}/navigate  {"url":"..."}`,
    `- Inspect: GET ${base}/read-dom , GET ${base}/computed-styles , GET ${base}/links`,
    `- Interact: POST ${base}/click {"selector":"..."} , POST ${base}/scroll {"y":1200}`,
    `- Capture into the bundle: POST ${base}/capture  (optionally {"url":"..."})`,
    "",
    `Page budget: capture at most ${budget} pages total (captured so far: ${capturedCount}). Pick the highest-value pages; stay same-origin. A /capture returning {"skipped":"budget"} means stop capturing.`,
    "",
    "Then build the project to match the capture as closely as possible: mirror the `dom.json` tree, apply the `styles.json` palette exactly, and use the cached `/_assets/` images. Reproduce the real text content from the capture (do not fall back to lorem/filler).",
  ].join("\n");
```

(`base` is the already-computed `${origin…}/api/sharingan/${projectId}` variable — leave its definition above unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/sharingan-context.test.ts`
Expected: PASS (update the pre-existing endpoint/guardrail test if it asserted the old "placeholder" wording — the endpoint/token/budget assertions still hold; drop any assertion on "reconstruct"/"placeholder" that no longer matches).

- [ ] **Step 5: Typecheck + Commit**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit` → no errors.

```bash
git add apps/daemon/src/sharingan-context.ts apps/daemon/test/sharingan-context.test.ts
git commit -m "Sharingan v3: reproduce-faithfully build prompt (mirror tree, exact palette, cached images)"
```

---

### Task 4: Clone-aware lint

Stop the anti-slop objective gate from punishing a faithful clone.

**Files:**
- Modify: `packages/quality/src/types.ts` (`LintOptions.isSharingan`)
- Modify: `packages/quality/src/lint-artifact.ts` (`lintArtifact` early return)
- Modify: `apps/daemon/src/visual-qa.ts` (`VisualQaInput.isSharingan`; skip `detectComputedFindings`)
- Modify: `apps/daemon/src/run-handler.ts` (thread `isSharingan` into both `lintArtifact` sites + `runVisualQa`)
- Test: `packages/quality/test/lint-artifact.test.ts` (or the existing quality test file) + `apps/daemon/test/visual-qa.test.ts`

**Interfaces:**
- Produces: `LintOptions.isSharingan?: boolean`; `VisualQaInput.isSharingan?: boolean`.
- Behavior: when `isSharingan`, `lintArtifact` returns ONLY `filler-copy` findings (lorem = the agent failed to reproduce real copy); `auditVisualArtifact` skips `detectComputedFindings` (keeps `findingsFromGeometry` + the agent critic).

- [ ] **Step 1: Write the failing tests**

Find the quality test file that tests `lintArtifact` (grep `packages/quality/test` for `lintArtifact`). Add:

```typescript
test("lintArtifact in Sharingan mode skips the anti-slop/taste family but still catches lorem filler", () => {
  const indigo = `<div style="background:#6366f1">x</div>`;
  assert.ok(lintArtifact(indigo, {}).some((f) => f.id === "ai-default-indigo"), "flags indigo normally");
  assert.ok(!lintArtifact(indigo, { isSharingan: true }).some((f) => f.id === "ai-default-indigo"), "clone mode skips the indigo/taste rule");
  const lorem = `<p>Lorem ipsum dolor sit amet consectetur.</p>`;
  assert.ok(lintArtifact(lorem, { isSharingan: true }).some((f) => f.id === "filler-copy"), "clone mode STILL flags lorem filler");
});
```

Add to `apps/daemon/test/visual-qa.test.ts` — a DI test that `auditVisualArtifact` doesn't run the computed detector in Sharingan mode. Since `collectGeometry` needs Chrome, test the gating at the unit boundary instead: assert the option threads through `agentReviewPrompt` is NOT where it lives; instead add a focused test on a new exported helper. Add this exported helper to `visual-qa.ts` and test it:

```typescript
// in visual-qa.test.ts
import { shouldRunComputedDetector } from "../src/visual-qa.ts";
test("computed anti-slop detector is skipped for Sharingan clones", () => {
  assert.equal(shouldRunComputedDetector({ isSharingan: true } as any), false);
  assert.equal(shouldRunComputedDetector({ isSharingan: false } as any), true);
  assert.equal(shouldRunComputedDetector({} as any), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/quality && node --experimental-strip-types --no-warnings --test test/<quality-lint-test>.test.ts` (Expected: FAIL — `isSharingan` ignored, indigo still flagged)
Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/visual-qa.test.ts` (Expected: FAIL — `shouldRunComputedDetector` not exported)

- [ ] **Step 3a: Add `isSharingan` to `LintOptions` (`packages/quality/src/types.ts`)**

Add to the `LintOptions` interface (after `provider`, line 52):

```typescript
  /** True when linting a Sharingan CLONE. Faithful reproduction of a source must not be penalized by
   *  the anti-slop/taste gate, so all taste + accessibility rules are skipped; only lorem/filler
   *  (the agent failing to reproduce the real copy) is kept. */
  isSharingan?: boolean;
```

- [ ] **Step 3b: Early return in `lintArtifact` (`packages/quality/src/lint-artifact.ts`)**

At the top of `lintArtifact` (right after the `const prototypeOnly = …` line, before the `const findings: Finding[] = [` assembly), add:

```typescript
  if (options.isSharingan) {
    // Clone mode: trust the source. Skip the entire anti-slop / taste / accessibility family —
    // faithfully reproducing a source's colors, fonts, contrast, and markers is 1:1, not a defect.
    // Keep only lorem/filler, which signals the agent failed to reproduce the real copy.
    return checkRegexList(html, FILLER_PATTERNS, {
      severity: "P0",
      id: "filler-copy",
      message: "Filler/placeholder copy (lorem ipsum, 'feature one/two/three').",
      fix: "Reproduce the real copy from the captured source instead of filler.",
    }).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  }
```

(`checkRegexList`, `FILLER_PATTERNS`, and `SEVERITY_ORDER` are all already defined in this file.)

- [ ] **Step 3c: Thread `isSharingan` through `visual-qa.ts`**

Add to `VisualQaInput` (after `sharinganReference`, ~line 26):

```typescript
  /** True for a Sharingan clone — skips the computed anti-slop detector (taste/contrast/type rules)
   *  so faithful reproduction isn't penalized; structural geometry checks + the critic still run. */
  isSharingan?: boolean;
```

Add the exported helper (near the other exported helpers, e.g. above `collectGeometry`):

```typescript
/** The computed anti-slop detector (color/type/contrast/spacing/component tells) is skipped for
 *  Sharingan clones — reproducing a source faithfully must not be flagged as slop. */
export function shouldRunComputedDetector(input: Pick<VisualQaInput, "isSharingan">): boolean {
  return !input.isSharingan;
}
```

In `collectGeometry`, add a parameter and gate the computed block. Change the signature:

```typescript
async function collectGeometry(
  htmlPath: string,
  screenshotPath?: string,
  renderUrl?: string,
  computedCtx: ComputedContext = {},
  runComputed = true,
): Promise<{ findings: QualityFinding[]; consoleMessages: VisualQaConsoleMessage[]; elements: CriticElement[] }> {
```

Where `computedFindings` is assigned (the `detectComputedFindings(...)` block on the desktop viewport), wrap it:

```typescript
        computedFindings = runComputed
          ? boundComputedFindings(
              detectComputedFindings(toComputedElements(desktopElements), {
                ...computedCtx,
                pageBackground: (snapshot as GeometrySnapshot).pageBackground,
                designTokens: (snapshot as GeometrySnapshot).designTokens,
              }),
            )
          : [];
```

In `auditVisualArtifact`, pass the flag:

```typescript
  const geometry = await collectGeometry(input.htmlPath, screenshotPath, input.renderUrl, { provider: input.provider }, shouldRunComputedDetector(input));
```

- [ ] **Step 3d: Thread `isSharingan` from `run-handler.ts`**

Both `lintArtifact` call sites — add `isSharingan: project.sharingan`. The standard-mode site (~line 974):

```typescript
  const staticFindings = suppress((staticSurface.trim() ? lintArtifact(staticSurface, { mode: "standard", provider: runProviderFamily, isSharingan: project.sharingan }) : []) as QualityFinding[]);
```

The prototype-mode site (~line 1297):

```typescript
  const staticFindings = suppress(lintArtifact(currentHtml, { provider: runProviderFamily, isSharingan: project.sharingan }) as QualityFinding[]);
```

The `runVisualQa` call (~line 996) — widen the options Pick to include `"isSharingan"` (in `runVisualQa`'s signature at ~line 460: add `| "isSharingan"`) and pass it:

```typescript
            sharinganReference: project.sharingan ? sharinganReviewReference(projectDir(deps.dataDir, project.id)) : undefined,
            isSharingan: project.sharingan,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the quality lint test + `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test test/visual-qa.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run (repo root): `pnpm exec tsc -p tsconfig.check.json --noEmit` → no errors.

```bash
git add packages/quality/src/types.ts packages/quality/src/lint-artifact.ts apps/daemon/src/visual-qa.ts apps/daemon/src/run-handler.ts packages/quality/test/*.test.ts apps/daemon/test/visual-qa.test.ts
git commit -m "Sharingan v3: clone-aware lint (skip anti-slop/taste + computed detector for clones)"
```

---

### Task 5: Files-viewer large-file guard

Stop the ~400KB `dom.json` from freezing the app.

**Files:**
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx` (`CodeView`, lines 1248-1274)
- Test: `apps/web/src/screens/workspace.test.tsx` (or a new `code-view.test.tsx`)

**Interfaces:** `CodeView({ name, text })` — unchanged props; large files render as plain text.

- [ ] **Step 1: Write the failing test**

Add a vitest + RTL test (new file `apps/web/src/screens/code-view.test.tsx`) — since `CodeView` is not exported, either export it or test the highlight decision. Export `CodeView` from `WorkspaceScreen.tsx` (add `export` to `function CodeView`), then:

```tsx
import { render } from "@testing-library/react";
import { CodeView } from "./WorkspaceScreen";

test("CodeView highlights a small file but renders a large file as plain text", () => {
  const small = render(<CodeView name="a.css" text={`const x = 1; /* c */`} />);
  // a keyword like "const" is wrapped in a colored span for small files
  assert.ok(small.container.querySelector("code span"), "small file is syntax-highlighted");

  const big = "const x = 1;\n".repeat(20000); // ~240KB, > 100KB threshold
  const large = render(<CodeView name="dom.json" text={big} />);
  assert.equal(large.container.querySelector("code span"), null, "large file has NO highlight spans (plain text)");
  assert.ok(large.container.textContent?.includes("const x = 1;"), "large file text is still shown");
});
```

(Use the project's existing test runner conventions — if the file uses `expect` from vitest rather than `node:assert`, match that. Check a sibling test like `workspace.test.tsx`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/screens/code-view.test.tsx`
Expected: FAIL — the large file is still tokenized into spans (or the test times out / is very slow, demonstrating the freeze).

- [ ] **Step 3: Guard large files in `CodeView`**

Add a threshold constant above `CodeView` and gate the highlight. Change `CodeView` to:

```tsx
const HIGHLIGHT_MAX_CHARS = 100_000;

export function CodeView({ name, text }: { name: string; text: string }) {
  const lines = text.length ? text.split("\n") : [""];
  const highlight = text.length <= HIGHLIGHT_MAX_CHARS;
  return (
    <div className="flex h-full flex-col bg-card">
      <PanelBar className="font-mono">
        <FileCode2 size={13} strokeWidth={1.75} />
        {name}
        {!highlight && <span className="ml-2 text-muted-foreground/60">· large file, highlighting off</span>}
        <span className="tnum ml-auto">{lines.length} lines</span>
      </PanelBar>
      <div className="flex-1 overflow-auto">
        <div className="flex min-h-full font-mono text-xs leading-[1.6]">
          <div
            aria-hidden
            className="sticky left-0 shrink-0 select-none border-r border-border bg-muted/30 py-3 pl-3 pr-2.5 text-right tabular-nums text-muted-foreground/50"
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="flex-1 py-3 pl-4 pr-6 text-foreground-2">
            <code>{highlight ? highlightToReact(text) : text}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/screens/code-view.test.tsx`
Expected: PASS, and fast (no freeze).

- [ ] **Step 5: Typecheck + Commit**

Run: `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json` → no errors.

```bash
git add apps/web/src/screens/WorkspaceScreen.tsx apps/web/src/screens/code-view.test.tsx
git commit -m "Sharingan v3: guard the Files viewer against large files (>100KB → plain text, no freeze)"
```

---

### Task 6: Sharingan red entry theme + hide the mode tag

Make entering clone mode feel like a 写轮眼 activating, and drop the redundant mode badge.

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx` (heading/description copy + red theme class; mode badge → hidden)
- Modify: `apps/web/src/index.css` (a `sharingan-glow` keyframe)
- Test: `apps/web/src/screens/home-sharingan.test.tsx` (new)

**Interfaces:** internal to `HomeScreen`. Consumes existing `sharingan` state + `toggleSharingan` (line 237).

- [ ] **Step 1: Write the failing test**

New file `apps/web/src/screens/home-sharingan.test.tsx`. Render `HomeScreen`, mocking the minimum surface (follow the provider/mocks used by `workspace.test.tsx`; `native.isElectron` must be truthy so `toggleSharingan` enters clone mode). Assert:

```tsx
import { render, fireEvent } from "@testing-library/react";
// ...mocks per workspace.test.tsx (native isElectron=true, toast, store/api)...

test("double-clicking the heading enters Sharingan mode: red theme, 'Sharingan' label, no mode badge", () => {
  const { getByText, queryByText, container } = render(/* <HomeScreen ...mockedProps/> */ null as any);
  const heading = getByText("Start a design");
  fireEvent.doubleClick(heading);
  assert.ok(queryByText("Sharingan"), "heading now reads Sharingan");
  assert.equal(queryByText("Start a design"), null);
  // mode badge gone
  assert.equal(queryByText("Sharingan ✕"), null);
  // red theme applied (a data attribute or class we add)
  assert.ok(container.querySelector("[data-sharingan='true']"), "the composer carries the sharingan red-theme marker");
  // exit by double-clicking the heading again
  fireEvent.doubleClick(getByText("Sharingan"));
  assert.ok(queryByText("Start a design"));
});
```

If `HomeScreen` is impractical to render with mocks, extract the header block (heading + description + the dropzone container) into a small `DesignPromptHeader({ sharingan, onToggle })` component in the same file and test THAT — it isolates the copy + red-theme logic cleanly. Prefer the extraction if the mock surface exceeds ~30 lines.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/screens/home-sharingan.test.tsx`
Expected: FAIL — heading stays "Start a design"; no `data-sharingan` marker.

- [ ] **Step 3a: Add the `sharingan-glow` keyframe to `apps/web/src/index.css`**

Append (near the other `@keyframes` like `dz-fade-in`):

```css
@keyframes sharingan-glow {
  0%, 100% { box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.5), 0 0 22px -6px rgba(220, 38, 38, 0.55); }
  50% { box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.9), 0 0 34px -4px rgba(220, 38, 38, 0.8); }
}
@media (prefers-reduced-motion: reduce) {
  .sharingan-active { animation: none !important; box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.7) !important; }
}
```

- [ ] **Step 3b: Heading/description copy + red theme in `HomeScreen.tsx`**

Replace the heading + description block (lines 682-688) with sharingan-aware copy:

```tsx
              <h1 className={cn("text-2xl font-semibold tracking-tight", sharingan ? "text-red-500" : "text-foreground")} onDoubleClick={toggleSharingan}>
                {sharingan ? "Sharingan" : "Start a design"}
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {sharingan
                  ? "Paste a URL — Dezin clones its structure, styling, and imagery into an editable project. Double-click the title to exit."
                  : "Describe what you want. Dezin builds a real, tasteful artifact, then lints it against its own anti-slop rules."}
              </p>
```

Add the red-theme marker + glow to the dropzone container (line 710-715). Change its `className` to append the sharingan classes and add the `data-sharingan` attribute:

```tsx
          <div
            aria-label="Design prompt dropzone"
            data-sharingan={sharingan}
            className={cn(
              "mt-5 w-full rounded-2xl border p-2.5 transition-[color,border-color,background-color,box-shadow] duration-150 hover:border-border-strong focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:hover:border-ring",
              optimizingPrompt ? "border-border-strong bg-surface-2/80 shadow-inner" : "border-input bg-card/80",
              sharingan && "sharingan-active border-red-500/60 [animation:sharingan-glow_2.4s_ease-in-out_infinite]",
            )}
            onDragEnter={handlePromptDragOver}
            onDragOver={handlePromptDragOver}
            onDrop={handlePromptDrop}
          >
```

- [ ] **Step 3c: Hide the mode badge (`HomeScreen.tsx` lines 859-870)**

Replace the `{sharingan ? ( <Standard + Sharingan✕ badges> ) : ( <FieldSelect Mode/> )}` ternary with a render-only-when-not-sharingan guard, keeping the existing `FieldSelect` "Mode" exactly:

```tsx
                  {!sharingan && (
                    <FieldSelect
                      label="Mode"
                      value={mode}
                      onChange={setMode}
                      /* …keep the remaining existing FieldSelect props/options verbatim… */
                    />
                  )}
```

(Delete the entire `sharingan ?` branch with the "Standard" span + "Sharingan ✕" button. Exit is now the heading double-click.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/screens/home-sharingan.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + Commit**

Run: `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json` → no errors.

```bash
git add apps/web/src/screens/HomeScreen.tsx apps/web/src/index.css apps/web/src/screens/home-sharingan.test.tsx
git commit -m "Sharingan v3: red 写轮眼 entry theme + hide the mode tag (exit via heading double-click)"
```

---

## Final Verification (after all tasks)

- [ ] Daemon: run each touched test file individually — `sharingan-capture`, `sharingan-context`, `visual-qa`, plus the quality lint test — all PASS/skip.
- [ ] Web: `cd apps/web && pnpm exec vitest run src/screens/code-view.test.tsx src/screens/home-sharingan.test.tsx` → PASS.
- [ ] Typecheck both programs: `pnpm exec tsc -p tsconfig.check.json --noEmit` and `cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json`.
- [ ] Version bump deferred to merge.

## Self-review notes

- Spec coverage: A1→T1, A2→T2, A3→T3, A4→T4, B→T5, C+D→T6. All covered.
- Type consistency: `DomTreeNode`/`DomTreeStyle` (T1) consumed by `captureCurrentPage`'s `firstText` (T1) and written to `dom.json`; `Asset.local` (T2) written by capture + read by the builder via the prompt (T3); `LintOptions.isSharingan` (T4) + `VisualQaInput.isSharingan` (T4) threaded from run-handler (T4). `shouldRunComputedDetector` (T4) is the tested seam. No cross-task name drift.
- Gating: every daemon change keys on `project.sharingan`/`isSharingan`; the web changes key on the `sharingan` state — non-clone paths unchanged.
