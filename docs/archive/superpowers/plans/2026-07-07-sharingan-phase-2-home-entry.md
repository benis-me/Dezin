# Sharingan Phase 2 — Home Entry & Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user enter Sharingan (clone-from-URL) mode by double-clicking "Start a design" on Home, paste a URL, and create a `sharingan`/`standard`/`sourceUrl` project — gated once by an authorized-use affirmation and available only in the desktop build.

**Architecture:** Two thin backend slices (a persisted `sharinganAffirmed` settings flag; the daemon `POST /api/projects` handler forwarding `sharingan`+`sourceUrl` and forcing Standard) plus three frontend slices (a clone-URL validator + API type; the HomeScreen Sharingan mode wired through `onNewProject`→`App`→`createProject`; the first-run affirmation dialog). Phase 1's project model already stores `sharingan`+`sourceUrl`; this phase just wires the entry.

**Tech Stack:** TypeScript; daemon = `node --test` + node:http; core = `node:sqlite` + `node --test`; web = React + Vite + **vitest** (jsdom + @testing-library/react) + Radix `Dialog`.

## Global Constraints

- **Branch:** continue on `feat/sharingan` (Phase 1 lives here). **NO `Co-Authored-By` trailer. NO version bump** (feature branch — the root `package.json` version bumps only when the whole Sharingan feature lands).
- **Builds on Phase 1:** the `Project` model already has `sharingan: boolean` + `sourceUrl?: string`, and the core `CreateProjectInput` (`packages/core`) already accepts them (`store.createProject` persists them). This phase does NOT change the store's project schema.
- **Desktop-only entry:** the Sharingan entry is gated on `native?.isElectron` (`apps/web/src/lib/native.ts`). On the web/dev build, double-click does NOT enter the mode — it shows a toast noting the desktop app is required. Enabling web later is just removing the gate.
- **Forced Standard:** a Sharingan project is always `mode: "standard"`. The UI forces it and the daemon enforces it defensively.
- **Settings flag mirrors `autoFixLiveRuntimeErrors` exactly** — same 8 edit sites in `packages/core` (CREATE TABLE, `ensureColumn`, `DEFAULT_SETTINGS`, read mapper, `updateSettings` merge, upsert column-list + excluded-set + value-binding). `Settings` is a shared core type, so the web sees the new field automatically.
- **`onNewProject` extension:** add a single trailing optional param `sharingan?: { sourceUrl: string }`. Its *presence* means Sharingan mode; its `sourceUrl` carries the URL. Do not add separate boolean+string params.
- **Naming (verbatim):** settings field `sharinganAffirmed` / column `sharingan_affirmed`; URL helper `isCloneUrl`; URL placeholder text `Paste a URL to clone…`.
- **Tests:** backend `node --test` under the package's `test/`; web `pnpm --filter ./apps/web test` (vitest), wrapping components in `ApiProvider` + `ToastProvider` (+ `AgentsProvider` for HomeScreen) with `makeFakeApi({…})`. All tests use fakes/fixtures — never a real external site.

## File Structure

- `packages/core/src/types.ts` — `Settings` gains `sharinganAffirmed`.
- `packages/core/src/store.ts` — settings migration/read/write for `sharingan_affirmed` (8 sites).
- `packages/core/test/store.test.ts` — round-trip test for the flag.
- `apps/daemon/src/app.ts` — `POST /api/projects` forwards `sharingan`+`sourceUrl`, forces Standard, validates the URL.
- `apps/daemon/test/projects-sharingan.test.ts` (new) — endpoint tests.
- `apps/web/src/lib/clone-url.ts` (new) — `isCloneUrl`.
- `apps/web/src/lib/clone-url.test.ts` (new) — helper unit test.
- `apps/web/src/lib/api.ts` — `CreateProjectInput` gains `sharingan?`+`sourceUrl?`.
- `apps/web/src/screens/HomeScreen.tsx` — Sharingan mode (double-click entry, URL input, forced Standard, hidden Research, indicator, desktop gate) + extended `onNewProject`.
- `apps/web/src/App.tsx` — `onNewProject` handler forwards `sharingan`+`sourceUrl` to `createProject`.
- `apps/web/src/screens/HomeScreen.sharingan.test.tsx` (new) — mode + submit + affirmation tests.

---

## Task 1: Persisted `sharinganAffirmed` settings flag (core)

**Files:**
- Modify: `packages/core/src/types.ts` (the `Settings` interface, ~line 319)
- Modify: `packages/core/src/store.ts` (CREATE TABLE ~127; `ensureColumn` ~537; `DEFAULT_SETTINGS` ~222; read mapper ~1397; `updateSettings` merge ~1432; upsert column-list ~1447, excluded-set ~1472, value-binding ~1503)
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings.sharinganAffirmed: boolean` (default `false`); `store.getSettings()` returns it; `store.updateSettings({ sharinganAffirmed })` persists it.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/store.test.ts`:

```ts
test("settings persist the sharinganAffirmed flag (default false)", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(store.getSettings().sharinganAffirmed, false);
    const updated = store.updateSettings({ sharinganAffirmed: true });
    assert.equal(updated.sharinganAffirmed, true);
    assert.equal(store.getSettings().sharinganAffirmed, true);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @dezin/core test`
Expected: FAIL — `sharinganAffirmed` is `undefined` (TS error and/or assertion `undefined !== false`).

- [ ] **Step 3: Add the field to the `Settings` type**

In `packages/core/src/types.ts`, inside `interface Settings` (next to `autoFixLiveRuntimeErrors`):

```ts
  /** True once the user has affirmed they're authorized to reproduce a site with Sharingan (asked once, not per run). */
  sharinganAffirmed: boolean;
```

- [ ] **Step 4: Migrate + read + write in the store**

In `packages/core/src/store.ts`, mirror `autoFixLiveRuntimeErrors` at all 8 sites. Read the surrounding lines first so you place each addition in the matching spot.

1. CREATE TABLE `settings` (near line 127, after `auto_fix_live_runtime_errors ...`):
```
  sharingan_affirmed INTEGER NOT NULL DEFAULT 0,
```
2. `ensureColumn` block (near line 537, after the last settings `ensureColumn`):
```ts
    ensureColumn("settings", "sharingan_affirmed", "sharingan_affirmed INTEGER NOT NULL DEFAULT 0");
```
3. `DEFAULT_SETTINGS` (near line 222):
```ts
  sharinganAffirmed: false,
```
4. read mapper (near line 1397):
```ts
      sharinganAffirmed: Number(r.sharingan_affirmed ?? 0) === 1,
```
5. `updateSettings` merge (near line 1432):
```ts
      sharinganAffirmed: patch.sharinganAffirmed ?? cur.sharinganAffirmed,
```
6–8. The upsert statement (near lines 1447 / 1472 / 1503). **This is positional — align all three.** Add `sharingan_affirmed` to the INSERT column list, add a matching `?` placeholder if the statement lists placeholders explicitly, add `sharingan_affirmed = excluded.sharingan_affirmed,` to the `ON CONFLICT … DO UPDATE SET`, and push the value `next.sharinganAffirmed ? 1 : 0,` at the **same ordinal position** in the bound-values array. The round-trip test in Step 1 is your alignment guard — if the value lands in the wrong column, `getSettings()` reads back wrong and the test fails.

- [ ] **Step 5: Fix required-literal `Settings` sites across the monorepo**

`sharinganAffirmed` is a **required** field, so every full `Settings` object literal must include it or its package's typecheck breaks. `DEFAULT_SETTINGS` is done above. Grep for the other literal(s) — at minimum the web test fake:

Run: `grep -rn "researchEnabled:" apps packages --include=*.ts --include=*.tsx` (each hit constructing a full `Settings` literal needs the new field).

In `apps/web/src/test/fake-api.ts`, in the `getSettings` default object, add:
```ts
    sharinganAffirmed: false,
```
Add the same to any other full-`Settings` literal the grep surfaces (a spread like `{ ...settings, … }` does NOT need it).

- [ ] **Step 6: Run the tests and typechecks**

Run: `pnpm --filter @dezin/core test` → PASS (new + existing settings tests).
Run: `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS (core + daemon).
Run: `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → PASS (proves no web `Settings` literal is missing the field).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/store.ts packages/core/test/store.test.ts apps/web/src/test/fake-api.ts
git commit -m "feat(sharingan): persist sharinganAffirmed settings flag"
```

---

## Task 2: `POST /api/projects` forwards sharingan + sourceUrl (daemon)

**Files:**
- Modify: `apps/daemon/src/app.ts` (the `POST /api/projects` handler, ~lines 373–391; add an `isHttpUrl` helper near `isNonEmptyString`)
- Test: `apps/daemon/test/projects-sharingan.test.ts` (new)

**Interfaces:**
- Consumes: core `CreateProjectInput` (already has `sharingan?`, `sourceUrl?`); `store.createProject(...)`; `createApp({ store, dataDir, standardProjectSetup? })` (the handler reads `deps.standardProjectSetup ?? setupStandardProject`, so tests inject a no-op).
- Produces: the endpoint persists `sharingan`+`sourceUrl` and forces `mode: "standard"` when `sharingan`; rejects `sharingan` without a valid http(s) `sourceUrl` (400).

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/test/projects-sharingan.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

function startApp() {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-proj-"));
  const app = createApp({ store, dataDir, standardProjectSetup: async () => {} });
  return { store, app };
}

test("POST /api/projects persists sharingan + sourceUrl and forces standard mode", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clone", mode: "prototype", sharingan: true, sourceUrl: "https://example.test/" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as { sharingan: boolean; sourceUrl?: string; mode: string };
    assert.equal(proj.sharingan, true);
    assert.equal(proj.sourceUrl, "https://example.test/");
    assert.equal(proj.mode, "standard", "sharingan forces standard even when prototype was requested");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});

test("POST /api/projects rejects sharingan without a valid http(s) sourceUrl", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clone", sharingan: true }),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});

test("POST /api/projects still creates a normal (non-sharingan) project", async () => {
  const { store, app } = startApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "normal", mode: "standard" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as { sharingan: boolean; sourceUrl?: string };
    assert.equal(proj.sharingan, false);
    assert.equal(proj.sourceUrl, undefined);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/projects-sharingan.test.ts`
Expected: FAIL — first test gets `sharingan: false`/`mode: "prototype"`; second test gets `201` instead of `400`.

(Note: `pnpm --filter ./apps/daemon test <name>` does NOT filter to one file in this repo — invoke `node --test <file>` directly, as above. Confirm `createApp`'s deps type includes `standardProjectSetup` — the handler already reads `deps.standardProjectSetup ?? setupStandardProject`, so it does; the no-op avoids real Vite scaffolding.)

- [ ] **Step 3: Add an `isHttpUrl` helper**

In `apps/daemon/src/app.ts`, near the existing `isNonEmptyString` helper:

```ts
function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try { new URL(s); return true; } catch { return false; }
}
```

- [ ] **Step 4: Wire the handler**

Replace the body of the `POST /api/projects` handler (~lines 376–390) with:

```ts
    handler: async (req, res, _p, deps) => {
      const { store, dataDir } = deps;
      const body = (await readJsonBody(req)) as Partial<CreateProjectInput>;
      if (!isNonEmptyString(body.name)) return sendError(res, 400, "name is required");
      const sharingan = body.sharingan === true;
      if (sharingan && !isHttpUrl(body.sourceUrl)) return sendError(res, 400, "sharingan requires a valid http(s) sourceUrl");
      // Sharingan always reconstructs into a Standard project.
      const mode = sharingan || body.mode === "standard" ? "standard" : "prototype";
      const project = store.createProject({
        name: body.name,
        skillId: body.skillId ?? null,
        designSystemId: body.designSystemId ?? null,
        mode,
        sharingan,
        sourceUrl: sharingan ? body.sourceUrl : undefined,
      });
      if (mode === "standard") void (deps.standardProjectSetup ?? setupStandardProject)(project.id, projectDir(dataDir, project.id));
      sendJson(res, 201, projectPayload(dataDir, project));
    },
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --experimental-strip-types --experimental-sqlite --no-warnings --test apps/daemon/test/projects-sharingan.test.ts`
Expected: PASS (3/3). Then typecheck: `pnpm exec tsc -p tsconfig.check.json --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/app.ts apps/daemon/test/projects-sharingan.test.ts
git commit -m "feat(sharingan): POST /api/projects forwards sharingan + sourceUrl, forces standard"
```

---

## Task 3: Clone-URL validator + API type (web lib)

**Files:**
- Create: `apps/web/src/lib/clone-url.ts`
- Create: `apps/web/src/lib/clone-url.test.ts`
- Modify: `apps/web/src/lib/api.ts` (`CreateProjectInput`, lines ~64–69)

**Interfaces:**
- Produces: `isCloneUrl(value: string): boolean`; `CreateProjectInput` gains `sharingan?: boolean` and `sourceUrl?: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/clone-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isCloneUrl } from "./clone-url.ts";

describe("isCloneUrl", () => {
  it("accepts http and https URLs (trimmed)", () => {
    expect(isCloneUrl("https://example.com")).toBe(true);
    expect(isCloneUrl("http://example.com/path?q=1")).toBe(true);
    expect(isCloneUrl("  https://example.com  ")).toBe(true);
  });
  it("rejects empty, schemeless, and non-http schemes", () => {
    expect(isCloneUrl("")).toBe(false);
    expect(isCloneUrl("example.com")).toBe(false);
    expect(isCloneUrl("ftp://example.com")).toBe(false);
    expect(isCloneUrl("not a url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test clone-url`
Expected: FAIL — `./clone-url.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/clone-url.ts`:

```ts
/** True when the string is a well-formed http(s) URL usable as a Sharingan clone source. */
export function isCloneUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Extend `CreateProjectInput`**

In `apps/web/src/lib/api.ts` (~lines 64–69):

```ts
export interface CreateProjectInput {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  mode?: ProjectMode;
  sharingan?: boolean;
  sourceUrl?: string;
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm --filter ./apps/web test clone-url`
Expected: PASS (2/2).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/clone-url.ts apps/web/src/lib/clone-url.test.ts apps/web/src/lib/api.ts
git commit -m "feat(sharingan): clone-url validator + CreateProjectInput fields"
```

---

## Task 4: HomeScreen Sharingan mode + onNewProject/App wiring (web)

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx` (prop ~208; state ~229–234; heading ~630; Research toggle ~637–642; mode selector ~796–814; textarea ~721–729; `submit` ~477)
- Modify: `apps/web/src/App.tsx` (the `onNewProject` handler, ~lines 59–71)
- Test: `apps/web/src/screens/HomeScreen.sharingan.test.tsx` (new)

**Interfaces:**
- Consumes: `isCloneUrl` (Task 3); `native` (`../lib/native.ts` → `native?.isElectron`); `CreateProjectInput.sharingan`/`sourceUrl` (Task 3); daemon endpoint (Task 2).
- Produces: `onNewProject?: (brief, skillId, designSystemId, mode, sharingan?: { sourceUrl: string }) => void`. In Sharingan mode, submit calls `onNewProject(url, skillId, designSystemId, "standard", { sourceUrl: url })`. App forwards to `createProject({ …, sharingan: !!sharingan, sourceUrl: sharingan?.sourceUrl })`.

**Note to implementer:** Read `HomeScreen.tsx` fully first — the line numbers are anchors from reconnaissance, not exact. Preserve the existing composer behavior for non-Sharingan mode. The composer's submit button — use its actual accessible name in the test (find the button that calls `submit`).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/screens/HomeScreen.sharingan.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiProvider } from "../lib/api-context.tsx";
import { ToastProvider } from "../components/Toast.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { HomeScreen } from "./HomeScreen.tsx";

// Desktop build: Sharingan entry is enabled only when native.isElectron is true.
vi.mock("../lib/native.ts", () => ({
  native: { isElectron: true, platform: "darwin", pickFiles: async () => [], pickFolder: async () => [] },
}));

function renderHome(onNewProject = vi.fn()) {
  const api = makeFakeApi({
    // getSettings is used to init research/visual toggles; affirmed=true so this task's
    // submit path calls onNewProject directly (the not-affirmed gate arrives in Task 5).
    getSettings: async () => ({ ...(await makeFakeApi().getSettings()), sharinganAffirmed: true }),
  });
  render(
    <ApiProvider client={api}>
      <ToastProvider>
        <AgentsProvider>
          <HomeScreen projects={[]} onNewProject={onNewProject} onOpenProject={vi.fn()} />
        </AgentsProvider>
      </ToastProvider>
    </ApiProvider>,
  );
  return onNewProject;
}

describe("HomeScreen Sharingan mode", () => {
  it("double-clicking the heading enters Sharingan mode: URL placeholder shown, Research hidden", () => {
    renderHome();
    expect(screen.queryByPlaceholderText("Paste a URL to clone…")).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    expect(screen.getByPlaceholderText("Paste a URL to clone…")).toBeInTheDocument();
    expect(screen.queryByText("Design Research")).not.toBeInTheDocument();
    expect(screen.getByText(/Sharingan/i)).toBeInTheDocument();
  });

  it("submitting a valid URL calls onNewProject with the sourceUrl and standard mode", () => {
    const onNewProject = renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
    // Replace with the actual submit button's accessible name in HomeScreen:
    fireEvent.click(screen.getByRole("button", { name: /build|start design|create/i }));
    expect(onNewProject).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(String),
      expect.any(String),
      "standard",
      { sourceUrl: "https://example.com" },
    );
  });

  it("does not submit an invalid URL", () => {
    const onNewProject = renderHome();
    fireEvent.doubleClick(screen.getByText("Start a design"));
    fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: /build|start design|create/i }));
    expect(onNewProject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test HomeScreen.sharingan`
Expected: FAIL — no "Paste a URL to clone…" placeholder appears on double-click.

- [ ] **Step 3: Add the prop, state, and imports**

In `HomeScreen.tsx`:
- Add imports near the top:
```tsx
import { native } from "../lib/native.ts";
import { isCloneUrl } from "../lib/clone-url.ts";
```
- Extend the `onNewProject` prop type (~line 208):
```tsx
  onNewProject?: (brief: string, skillId: string, designSystemId: string, mode: ProjectMode, sharingan?: { sourceUrl: string }) => void;
```
- Add state alongside `mode`/`researchOn` (~line 229–234):
```tsx
  const [sharingan, setSharingan] = useState(false);
```
- Add a toggle handler (place near the other composer callbacks, e.g. after `toggleFeature`):
```tsx
  const toggleSharingan = useCallback(() => {
    if (sharingan) { setSharingan(false); return; }
    if (!native?.isElectron) { toast("Sharingan (clone from a URL) requires the desktop app.", { variant: "error" }); return; }
    setSharingan(true);
    setMode("standard");
  }, [sharingan, toast]);
```

- [ ] **Step 4: Wire the heading, toggles, mode selector, textarea, and submit**

- Heading (~line 630): add a double-click handler.
```tsx
        <h1 className="text-2xl font-semibold" onDoubleClick={toggleSharingan}>Start a design</h1>
```
- Research toggle (~line 637–642): hide it in Sharingan mode.
```tsx
        {!sharingan && (
          <PillToggle on={researchOn} label="Design Research" tip="Before designing, study real competitors…" onToggle={() => toggleFeature("researchEnabled", !researchOn)} />
        )}
```
- Mode selector (~line 796–814): in Sharingan mode show a fixed "Standard" indicator + a "Sharingan" chip with an exit control, instead of the editable `FieldSelect`.
```tsx
        {sharingan ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded-md border px-2 py-1 opacity-70">Standard</span>
            <button type="button" onClick={toggleSharingan} className="inline-flex items-center gap-1 rounded-md border px-2 py-1" aria-label="Exit Sharingan mode">
              Sharingan <span aria-hidden>✕</span>
            </button>
          </div>
        ) : (
          <FieldSelect label="Mode" value={mode} onChange={setMode} options={[
            { value: "prototype", label: "Prototype", icon: <Zap size={15} strokeWidth={1.75} />, description: "One self-contained HTML file — fastest to iterate." },
            { value: "standard", label: "Standard", icon: <Boxes size={15} strokeWidth={1.75} />, description: "A real Vite + React project with components and routing." },
          ]} />
        )}
```
- Textarea placeholder (~line 721–729):
```tsx
    placeholder={sharingan ? "Paste a URL to clone…" : (images.length ? "Add notes, or just build to recreate the screenshot…" : "A pricing page with three plans…")}
```
- `submit` (~line 477): validate + call with the sharingan payload.
```tsx
  const submit = () => {
    const text = brief.trim() || (images.length ? "Recreate the reference screenshot…" : refs.length ? "Build on the referenced design." : "");
    if (sharingan) {
      if (!isCloneUrl(text)) { toast("Enter a valid http(s) URL to clone.", { variant: "error" }); return; }
      onNewProject?.(text, skillId, designSystemId, "standard", { sourceUrl: text });
      return;
    }
    if (!text) return;
    if (images.length) setPendingImages(images.map((i) => ({ name: i.name, base64: i.base64 })));
    if (refs.length) setPendingRefs(refs.map((r) => ({ name: r.name, base64: r.base64 })));
    if (homeAgent) setPendingAgent(homeAgent, homeModel || undefined);
    onNewProject?.(text, skillId, designSystemId, mode);
  };
```

- [ ] **Step 5: Forward the fields in App.tsx**

Replace the `onNewProject` handler (`apps/web/src/App.tsx` ~lines 59–71):

```tsx
        onNewProject={async (brief, skillId, designSystemId, mode, sharingan) => {
          try {
            const project = await api.createProject({
              name: briefToName(brief),
              skillId,
              designSystemId,
              mode,
              sharingan: !!sharingan,
              sourceUrl: sharingan?.sourceUrl,
            });
            setPendingBrief(brief);
            void api
              .generateProjectTitle(project.id, brief)
              .then((updated) => window.dispatchEvent(new CustomEvent("dezin:project-title", { detail: updated })))
              .catch(() => {});
            navigate(`/projects/${project.id}`);
          } catch {
            toast("Couldn't create the project.", { variant: "error" });
          }
        }}
```

- [ ] **Step 6: Run and watch it pass**

Run: `pnpm --filter ./apps/web test HomeScreen.sharingan`
Expected: PASS (3/3). Then `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/screens/HomeScreen.tsx apps/web/src/App.tsx apps/web/src/screens/HomeScreen.sharingan.test.tsx
git commit -m "feat(sharingan): HomeScreen clone-from-URL mode + createProject wiring"
```

---

## Task 5: First-run authorized-use affirmation (web)

**Files:**
- Modify: `apps/web/src/screens/HomeScreen.tsx` (settings load for `sharinganAffirmed`; a `Dialog`; gate the Sharingan submit)
- Test: `apps/web/src/screens/HomeScreen.sharingan.test.tsx` (add cases)

**Interfaces:**
- Consumes: `Settings.sharinganAffirmed` (Task 1); `api.getSettings`/`api.updateSettings`; `publishSettingsUpdated` (`../lib/settings-events.ts`); Radix `Dialog` (`../components/ui/Dialog.tsx`).
- Produces: in Sharingan mode, when `sharinganAffirmed` is false the submit opens an affirmation dialog and defers `onNewProject`; confirming persists `updateSettings({ sharinganAffirmed: true })` and then proceeds.

- [ ] **Step 1: Write the failing test**

Add to `HomeScreen.sharingan.test.tsx`:

```tsx
import { waitFor } from "@testing-library/react";

it("first Sharingan run gates on the authorized-use affirmation, then proceeds", async () => {
  const onNewProject = vi.fn();
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => ({ ...(await makeFakeApi().getSettings()), ...patch }));
  const api = makeFakeApi({
    getSettings: async () => ({ ...(await makeFakeApi().getSettings()), sharinganAffirmed: false }),
    updateSettings,
  });
  render(
    <ApiProvider client={api}>
      <ToastProvider>
        <AgentsProvider>
          <HomeScreen projects={[]} onNewProject={onNewProject} onOpenProject={vi.fn()} />
        </AgentsProvider>
      </ToastProvider>
    </ApiProvider>,
  );
  fireEvent.doubleClick(screen.getByText("Start a design"));
  fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), { target: { value: "https://example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /build|start design|create/i }));

  // The affirmation gates the run: onNewProject not called yet, a dialog is shown.
  expect(onNewProject).not.toHaveBeenCalled();
  const affirm = await screen.findByRole("button", { name: /i have the right|affirm|i agree/i });
  fireEvent.click(affirm);

  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ sharinganAffirmed: true }));
  await waitFor(() =>
    expect(onNewProject).toHaveBeenCalledWith("https://example.com", expect.any(String), expect.any(String), "standard", { sourceUrl: "https://example.com" }),
  );
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter ./apps/web test HomeScreen.sharingan`
Expected: FAIL — no affirmation button; `onNewProject` is called immediately (from Task 4's direct path).

- [ ] **Step 3: Track `sharinganAffirmed` in HomeScreen**

Find where HomeScreen initializes `researchOn` from settings (the mount `getSettings()` effect and/or the `SETTINGS_UPDATED_EVENT` listener at ~lines 291–300). Add affirmation state that follows the same pattern:

```tsx
  const [affirmed, setAffirmed] = useState(false);
  const [affirmPending, setAffirmPending] = useState<null | { url: string }>(null);
```

In the settings-load effect (where `setResearchOn(!!s.researchEnabled)` runs, on mount and in the `SETTINGS_UPDATED_EVENT` handler), also set:
```tsx
    setAffirmed(!!s.sharinganAffirmed);
```

- [ ] **Step 4: Gate the submit and render the dialog**

Change the Sharingan branch of `submit` (from Task 4) to gate on `affirmed`:

```tsx
    if (sharingan) {
      if (!isCloneUrl(text)) { toast("Enter a valid http(s) URL to clone.", { variant: "error" }); return; }
      if (!affirmed) { setAffirmPending({ url: text }); return; }
      onNewProject?.(text, skillId, designSystemId, "standard", { sourceUrl: text });
      return;
    }
```

Add a confirm handler:
```tsx
  const confirmAffirmation = useCallback(() => {
    const pending = affirmPending;
    if (!pending) return;
    setAffirmed(true);
    setAffirmPending(null);
    api.updateSettings({ sharinganAffirmed: true }).then((s) => publishSettingsUpdated(s)).catch(() => {});
    onNewProject?.(pending.url, skillId, designSystemId, "standard", { sourceUrl: pending.url });
  }, [affirmPending, api, onNewProject, skillId, designSystemId]);
```

Import `publishSettingsUpdated` and `Dialog`:
```tsx
import { publishSettingsUpdated } from "../lib/settings-events.ts";
import { Dialog } from "../components/ui/Dialog.tsx";
```

Render the dialog (near the other dialogs at the end of the component's JSX, e.g. by the rename dialog):
```tsx
      <Dialog open={affirmPending !== null} onClose={() => setAffirmPending(null)} label="Authorized use" className="max-w-md">
        <div className="p-5">
          <h2 className="text-base font-semibold tracking-tight">Confirm authorized use</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Sharingan reconstructs a site's structure and design as a new, editable project — it doesn't copy brand assets or content verbatim. Only clone sites you own or are authorized to reproduce.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAffirmPending(null)}>Cancel</Button>
            <Button type="button" onClick={confirmAffirmation}>I have the right to reproduce this site</Button>
          </div>
        </div>
      </Dialog>
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm --filter ./apps/web test HomeScreen.sharingan`
Expected: PASS (all 4 cases — Task 4's affirmed-direct path still passes because its fake returns `sharinganAffirmed: true`). Then `pnpm --filter ./apps/web exec tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/screens/HomeScreen.tsx apps/web/src/screens/HomeScreen.sharingan.test.tsx
git commit -m "feat(sharingan): first-run authorized-use affirmation gate"
```

---

## Roadmap (context — not implemented here)

- **Phase 3:** Sharingan tab (`SharinganTab.tsx`) + CDP screencast mirror + action-log SSE + login banner/Continue.
- **Phase 4:** Agent-probe context (`sharingan-context.ts`) — the build Agent drives the capture endpoints (bounded page budget).
- **Phase 5:** `run-handler` capture-before-build integration + `research:false` + build from the `.sharingan/` bundle.
