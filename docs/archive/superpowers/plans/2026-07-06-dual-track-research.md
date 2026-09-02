# Dual-track Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is written against **verified** current signatures (store methods, node data shape, handler shapes) — but still read the named file before editing, because line numbers drift.

**Goal:** Run Research as two parallel agent tracks — the existing product track plus a new visual track that collects real design-site inspiration onto a per-project "Visual research" moodboard — and feed both to the build agent as its knowledge base, with hardened source authority.

**Architecture:** `runResearchPhase` fans out two agent spawns via `Promise.all` (`track: "product" | "visual"`). Product writes the existing `.research/` layout unchanged; visual writes `.research/visual/`. A direct synthesizer copies the collected images into a global moodboard (created once, id remembered in `.research/visual/moodboard.json` since moodboards are not project-scoped) and lays them out with `replaceMoodboardNodes`. `buildResearchContext` prepends both reports + real screenshots to the build brief. The Research UI gains Product/Visual sub-tabs; the Visual tab shows the collected imagery and (Task 7) mounts the interactive `MoodboardCanvas`. Source authority is prompt discipline + a per-source `authority` tag + a junk-domain blocklist.

**Tech Stack:** Node built-ins only (no new deps). `node:test` + `--experimental-strip-types` (+ `--experimental-sqlite` for daemon store tests) for packages/daemon; vitest for `apps/web`. `node:sqlite` store. React 19 + leafer-react canvas.

## Global Constraints

- **Hermetic, zero-install:** Node built-ins only. Cross-package imports use RELATIVE paths (`../../../packages/research/src/index.ts`), NOT `@dezin/*` bare specifiers.
- **Additive `.research/` layout:** the product track's files (`research.md`, `sources.json`, `assets/`, `directions/`, `chosen`) stay exactly where they are; visual is new under `.research/visual/`.
- **Moodboards are global** (the `moodboards` table has no `project_id`); a run references boards by id passed per-request. The visual board is associated to a project only by the `.research/visual/moodboard.json` pointer this feature writes — do NOT assume a project→board DB link.
- **Tests before commit:** `bash scripts/test-all.sh` (node) + `cd apps/web && npm test` (vitest) + `bash scripts/typecheck.sh` all green.
- **Commits:** one per task, direct to `main`; bump root `package.json` `version` in the final task of the batch; **never** add a `Co-Authored-By` trailer.
- **Ignore competing-plugin noise:** the `.impeccable/` PostToolUse hook may emit design "findings" on edited files — leave `.impeccable/hook.cache.json` unstaged and ignore those findings.
- **Verify against a real run** (`npm run dev`, a Standard project, research enabled) before claiming the visual track works end-to-end — headless tests can't exercise the real agent's downloads.

## Verified interfaces this plan relies on (do not redefine)

- `packages/core` `SaveMoodboardNodeInput = { id?; type: MoodboardNodeType; x; y; width; height; rotation?; zIndex?; data?: Record<string, unknown> }`.
- `store.createMoodboard({ name }) → Moodboard`; `store.getMoodboard(id) → Moodboard | null`; `store.createMoodboardAsset(boardId, { kind: "image"|"video"; fileName; mimeType; width: number|null; height: number|null; source: "upload"|"generated"|"edited" }) → MoodboardAsset`; `store.listMoodboardAssets(boardId)`; `store.replaceMoodboardNodes(boardId, SaveMoodboardNodeInput[]) → MoodboardNode[]` (wipes+rewrites nodes, keeps assets); `store.listMoodboardNodes(boardId)`.
- `apps/daemon/src/project-moodboard-context.ts` exports `moodboardAssetPath(dataDir, boardId, asset) → join(dataDir, "moodboards", boardId, "assets", asset.id + extForMime(asset.mimeType))`. `extForMime` is private there — the synthesizer computes its own mime from the file extension.
- A moodboard asset is served over HTTP at `/api/moodboards/:boardId/assets/:assetId`. An `image` node renders from `node.data.url`; the standard image-node data shape is `{ assetId, url, fileName, source: "upload", originalWidth, originalHeight }` (see `apps/web/src/moodboard/moodboard-board-utils.ts` + `canvas-utils.ts` `assetUrl`).
- `research-handler.ts` `handleGetResearch` returns `{ exists, report, sources, directions, assets, chosenSlug? }` from `activeArtifactDir(deps, project)`; product assets served at `/api/projects/:id/research/assets/*rest`.
- `apps/web` `ResearchDetail` (api.ts:179), `getResearch`, `researchAssetUrl`; `ResearchPanel({ research, assetUrl })` (ResearchViews.tsx:225); `MoodboardCanvasProps` (useMoodboardCanvasController.ts:39) is a ~24-prop interactive surface.
- `research-phase.ts` `runResearchPhase(input)` currently spawns ONE agent via the module-private `spawnResearch(command, args, cwd, opts)`; retries once; success = `researchExists(dir)`.

---

### Task 1: Visual `.research/` paths + pointer, source authority, and dual research context

**Files:**
- Modify: `packages/research/src/convention.ts` (visual path helpers + moodboard pointer path)
- Modify: `packages/research/src/types.ts` (extend `ResearchSource`)
- Modify: `packages/research/src/sources.ts` (`normalizeSource`: blocklist + authority + platform/designer/reached)
- Modify: `packages/research/src/io.ts` (`visualResearchExists`, `readVisualReport`, `readVisualSources`, `listVisualAssets`, `readVisualMoodboardId`, `writeVisualMoodboardId`; extend `buildResearchContext`)
- Modify: `packages/research/src/index.ts` (export new symbols)
- Test: `packages/research/test/visual-io.test.ts` (new); append to `packages/research/test/sources.test.ts`

**Interfaces produced (later tasks rely on these exact names):**
- `VISUAL_DIRNAME = "visual"`, `VISUAL_REPORT_FILE = "visual.md"`, `VISUAL_MOODBOARD_FILE = "moodboard.json"`
- `visualDir(projectDir): string`, `visualReportPath(projectDir): string`, `visualSourcesPath(projectDir): string`, `visualAssetsDir(projectDir): string`, `visualMoodboardPointerPath(projectDir): string`
- `ResearchSource` gains `authority?: "primary" | "secondary" | "unknown"`, `platform?: string`, `designer?: string`, `reached?: boolean`
- `JUNK_DOMAINS: readonly string[]`
- `visualResearchExists(projectDir): boolean`, `readVisualReport(projectDir): Promise<string | null>`, `readVisualSources(projectDir): Promise<ResearchSource[]>`, `listVisualAssets(projectDir): Promise<string[]>` (returns `visual/assets/<name>` paths), `readVisualMoodboardId(projectDir): Promise<string | null>`, `writeVisualMoodboardId(projectDir, boardId): Promise<void>`
- `buildResearchContext(projectDir)` — unchanged signature; now also folds in the visual report + visual asset paths.

- [ ] **Step 1: Write failing tests**

Append to `packages/research/test/sources.test.ts`:
```typescript
import { JUNK_DOMAINS } from "../src/index.ts";

test("normalizeSource drops junk-domain sources and defaults authority to unknown", () => {
  assert.equal(normalizeSource({ title: "listicle", url: "https://medium.com/@x/top-10", kind: "article" }), null);
  const ok = normalizeSource({ title: "Stripe docs", url: "https://stripe.com/docs", kind: "article" })!;
  assert.equal(ok.authority, "unknown");
  const primary = normalizeSource({ title: "Stripe", url: "https://stripe.com", kind: "competitor", authority: "primary", platform: "dribbble", designer: "Jane", reached: true })!;
  assert.equal(primary.authority, "primary");
  assert.equal(primary.platform, "dribbble");
  assert.equal(primary.designer, "Jane");
  assert.equal(primary.reached, true);
  assert.ok(JUNK_DOMAINS.includes("medium.com"));
});
```

Create `packages/research/test/visual-io.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  visualDir, visualReportPath, visualAssetsDir, visualMoodboardPointerPath,
  visualResearchExists, readVisualReport, listVisualAssets,
  readVisualMoodboardId, writeVisualMoodboardId, buildResearchContext,
} from "../src/index.ts";

function proj(): string {
  return mkdtempSync(join(tmpdir(), "dezin-visual-"));
}

test("visual path helpers point under .research/visual", () => {
  const p = "/x";
  assert.match(visualDir(p), /\.research\/visual$/);
  assert.match(visualReportPath(p), /\.research\/visual\/visual\.md$/);
  assert.match(visualAssetsDir(p), /\.research\/visual\/assets$/);
  assert.match(visualMoodboardPointerPath(p), /\.research\/visual\/moodboard\.json$/);
});

test("visualResearchExists + readers reflect on-disk visual research", async () => {
  const p = proj();
  assert.equal(visualResearchExists(p), false);
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(visualReportPath(p), "# Visual\n\nCalm palette.");
  writeFileSync(join(visualAssetsDir(p), "shot.png"), "x");
  assert.equal(visualResearchExists(p), true);
  assert.match((await readVisualReport(p))!, /Calm palette/);
  assert.deepEqual(await listVisualAssets(p), ["visual/assets/shot.png"]);
});

test("visual moodboard pointer round-trips", async () => {
  const p = proj();
  assert.equal(await readVisualMoodboardId(p), null);
  await writeVisualMoodboardId(p, "board-123");
  assert.equal(await readVisualMoodboardId(p), "board-123");
});

test("buildResearchContext folds in BOTH the product report and the visual report + assets", async () => {
  const p = proj();
  mkdirSync(join(p, ".research", "assets"), { recursive: true });
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(join(p, ".research", "research.md"), "# Product\n\nUsers skim.");
  writeFileSync(visualReportPath(p), "# Visual\n\nMono, generous whitespace.");
  writeFileSync(join(visualAssetsDir(p), "hero.png"), "x");
  const ctx = (await buildResearchContext(p))!;
  assert.match(ctx, /Users skim/);
  assert.match(ctx, /Mono, generous whitespace/);
  assert.match(ctx, /visual\/assets\/hero\.png/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/sources.test.ts' 'test/visual-io.test.ts'`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Add path helpers to `convention.ts`**

Append (reuse the module's existing `join`, `researchDir`, `ASSETS_DIRNAME`, `SOURCES_FILE`):
```typescript
export const VISUAL_DIRNAME = "visual";
export const VISUAL_REPORT_FILE = "visual.md";
export const VISUAL_MOODBOARD_FILE = "moodboard.json";

export function visualDir(projectDir: string): string {
  return join(researchDir(projectDir), VISUAL_DIRNAME);
}
export function visualReportPath(projectDir: string): string {
  return join(visualDir(projectDir), VISUAL_REPORT_FILE);
}
export function visualSourcesPath(projectDir: string): string {
  return join(visualDir(projectDir), SOURCES_FILE);
}
export function visualAssetsDir(projectDir: string): string {
  return join(visualDir(projectDir), ASSETS_DIRNAME);
}
export function visualMoodboardPointerPath(projectDir: string): string {
  return join(visualDir(projectDir), VISUAL_MOODBOARD_FILE);
}
```

- [ ] **Step 4: Extend `ResearchSource` in `types.ts`**

Add to the `ResearchSource` interface:
```typescript
  /** Provenance quality: primary (official/first-party), secondary (reputable), or unknown. */
  authority?: "primary" | "secondary" | "unknown";
  /** Design platform for visual sources (dribbble/behance/awwwards/mobbin/pinterest/other). */
  platform?: string;
  /** Attributed designer/author, when known. */
  designer?: string;
  /** Whether the site was actually reachable (false = cited but blocked/login-walled). */
  reached?: boolean;
```

- [ ] **Step 5: Blocklist + authority in `sources.ts`**

Add near the top of `packages/research/src/sources.ts`:
```typescript
/** Low-authority hosts (SEO/content mills, AI-listicle mills) dropped at parse time. */
export const JUNK_DOMAINS: readonly string[] = [
  "medium.com", "quora.com", "slideshare.net", "scribd.com", "coursehero.com",
  "geeksforgeeks.org", "w3schools.com", "tutorialspoint.com", "javatpoint.com",
];

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
```
Inside `normalizeSource`, after `url` is resolved and before the final return, add (using the raw input object — match the file's existing variable name for it, e.g. `value`):
```typescript
  const host = hostOf(source.url);
  if (host && JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return null;
  const authorityRaw = value.authority;
  source.authority = authorityRaw === "primary" || authorityRaw === "secondary" ? authorityRaw : "unknown";
  const platform = typeof value.platform === "string" ? value.platform.trim() : "";
  if (platform) source.platform = platform;
  const designer = typeof value.designer === "string" ? value.designer.trim() : "";
  if (designer) source.designer = designer;
  if (typeof value.reached === "boolean") source.reached = value.reached;
```

- [ ] **Step 6: Visual readers + pointer + dual context in `io.ts`**

Import the new convention helpers + `VISUAL_DIRNAME`, `ASSETS_DIRNAME`. Add:
```typescript
export function visualResearchExists(projectDir: string): boolean {
  return existsSync(visualReportPath(projectDir));
}
export async function readVisualReport(projectDir: string): Promise<string | null> {
  return readText(visualReportPath(projectDir));
}
export async function readVisualSources(projectDir: string): Promise<ResearchSource[]> {
  return parseSources(await readText(visualSourcesPath(projectDir)));
}
export async function listVisualAssets(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(visualAssetsDir(projectDir), { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => `${VISUAL_DIRNAME}/${ASSETS_DIRNAME}/${e.name}`).sort();
  } catch {
    return [];
  }
}
export async function readVisualMoodboardId(projectDir: string): Promise<string | null> {
  const raw = await readText(visualMoodboardPointerPath(projectDir));
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { boardId?: unknown }).boardId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
export async function writeVisualMoodboardId(projectDir: string, boardId: string): Promise<void> {
  await mkdir(visualDir(projectDir), { recursive: true });
  await writeFile(visualMoodboardPointerPath(projectDir), `${JSON.stringify({ boardId }, null, 2)}\n`, "utf8");
}
```
(Confirm `readText`, `parseSources`, `readdir`, `mkdir`, `writeFile`, `existsSync` are already imported in `io.ts`; add any missing `node:fs`/`node:fs/promises` imports.)

In `buildResearchContext`, relax the early return and append the visual parts. Replace the product-report region so it reads:
```typescript
  const report = await readReport(projectDir);
  const visualReport = await readVisualReport(projectDir);
  if (!report && !visualReport) return null;
  const parts: string[] = [];
  if (report) parts.push(report.trim());
  // ... existing product assets push stays, guarded by `report` ...
  if (visualReport) parts.push(`## Visual research (design-site inspiration)\n\n${visualReport.trim()}`);
  const visualAssets = await listVisualAssets(projectDir);
  if (visualAssets.length) {
    parts.push(`Visual reference imagery is available locally: ${visualAssets.map((a) => `\`${join("research", a)}\``).join(", ")}. Study these real screenshots as source material.`);
  }
  // ... existing chosen-direction push stays ...
```

- [ ] **Step 7: Export from `index.ts`**

Add all new `convention.ts`, `io.ts`, and `sources.ts` exports listed under "Interfaces produced" above to `packages/research/src/index.ts`.

- [ ] **Step 8: Run to verify pass**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/*.test.ts'`
Expected: PASS (all research tests).

- [ ] **Step 9: Commit**

```bash
git add packages/research/src packages/research/test
git commit -m "research: visual .research/ paths + moodboard pointer, source authority + junk blocklist, dual context"
```

---

### Task 2: Visual research prompt + product-prompt authority hardening

**Files:**
- Modify: `packages/research/src/prompts.ts` (add `buildVisualResearchPrompt`; harden `buildResearchPrompt`)
- Modify: `packages/research/src/index.ts` (export `buildVisualResearchPrompt`)
- Test: `packages/research/test/prompts.test.ts` (create or append)

**Interfaces produced:**
- `buildVisualResearchPrompt(input: { brief: string; designSystemName?: string; platforms?: string[] }): string`
- `buildResearchPrompt` — unchanged signature; text gains authority + citation + assumption discipline.

- [ ] **Step 1: Write failing tests**

`packages/research/test/prompts.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVisualResearchPrompt, buildResearchPrompt } from "../src/index.ts";

test("buildVisualResearchPrompt targets design sites, best-effort real + fallback, writes .research/visual", () => {
  const p = buildVisualResearchPrompt({ brief: "a fintech dashboard" });
  assert.match(p, /dribbble/i);
  assert.match(p, /behance/i);
  assert.match(p, /awwwards/i);
  assert.match(p, /mobbin/i);
  assert.match(p, /\.research\/visual\/assets/);
  assert.match(p, /\.research\/visual\/visual\.md/);
  assert.match(p, /reachable|blocked|fall ?back/i);
  assert.match(p, /download/i);
  assert.match(p, /real (product )?UI|not marketing/i);
});

test("buildResearchPrompt hardens authority: prefer primary, cite claims, label assumptions", () => {
  const p = buildResearchPrompt({ brief: "a pricing page" });
  assert.match(p, /primary|authoritative|first-party/i);
  assert.match(p, /assumption/i);
  assert.match(p, /cite|traces to|sources\.json/i);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/prompts.test.ts'`
Expected: FAIL — `buildVisualResearchPrompt` not exported.

- [ ] **Step 3: Add `buildVisualResearchPrompt`**

Append to `packages/research/src/prompts.ts` (reuse the module's `RESEARCH_DIRNAME`, `VISUAL_DIRNAME`, `ASSETS_DIRNAME`, `SOURCES_FILE`, `VISUAL_REPORT_FILE` — import from convention if not already):
```typescript
const VISUAL_PLATFORMS = ["dribbble", "behance", "awwwards", "mobbin", "pinterest"];

export function buildVisualResearchPrompt(input: { brief: string; designSystemName?: string; platforms?: string[] }): string {
  const platforms = (input.platforms?.length ? input.platforms : VISUAL_PLATFORMS).join(", ");
  const brand = input.designSystemName ? `\n- Active brand: **${input.designSystemName}** — collect references that fit its spirit.` : "";
  return `# Phase: Visual Research

You are a design researcher collecting VISUAL inspiration for this build — running IN PARALLEL with a separate product-research agent. Do NOT write the product report; focus only on visual direction.

Use web search + page reads freely. Target professional design sites — ${platforms} — where reachable. Some (e.g. Mobbin, much of Pinterest) are login-walled or block bots: where a site is unreachable, FALL BACK to general web/image search for comparable REAL product UI. Prefer real product interfaces and design-system references over marketing pages, hero shots, stock, portraits, or logos.

## Collect (write these under \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/\`)

- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${ASSETS_DIRNAME}/\` — 8–12 DOWNLOADED images (never hotlink), kebab-case names. Each MUST be a real UI screenshot or a genuine style/type/color reference. After downloading, verify each truly shows UI/design and DELETE anything that does not.
- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${SOURCES_FILE}\` — a JSON array; one entry per image: \`{ "id", "platform": "dribbble|behance|awwwards|mobbin|pinterest|other", "url", "designer": "<if known>", "reached": true, "takeaways": ["what this teaches: palette / type / layout / motion"], "assets": ["${ASSETS_DIRNAME}/name.png"] }\`. For a site you could NOT reach but still want to cite, add an entry with \`"reached": false\` and no asset.
- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${VISUAL_REPORT_FILE}\` — a short curated read distilling the collected imagery into concrete direction: palette, type system, layout, motion, texture. Embed the images with relative markdown paths (\`![caption](${ASSETS_DIRNAME}/name.png)\`). END with a one-line "Reached vs. blocked" note listing which sites you actually got imagery from.

## Rules
- Finish WITHIN this turn — the files above must exist on disk before you return.
- Never invent a source or a designer; only attribute what you can verify.${brand}
- Write in the user's language.

## Brief

${input.brief.trim()}`;
}
```

- [ ] **Step 4: Harden `buildResearchPrompt`**

In `buildResearchPrompt`'s rules block, near the existing `NEVER_INVENT` line, add:
```typescript
- ${NEVER_INVENT}
- **Authority.** Prefer PRIMARY / authoritative sources: official docs, the actual product, first-party data, reputable publications. Distrust SEO content farms, AI-generated listicles, and unsourced statistics — do not cite them. Tag each source in \`${SOURCES_FILE}\` with \`"authority": "primary" | "secondary"\`.
- **Cite everything.** Every factual claim in the report must trace to a source id in \`${SOURCES_FILE}\`. State genuinely-unknown things as an explicit ASSUMPTION — never as fact.
```

- [ ] **Step 5: Export + run to verify pass**

Add `buildVisualResearchPrompt` to `packages/research/src/index.ts`.
Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/prompts.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/research/src packages/research/test
git commit -m "research: visual-research prompt + product-prompt authority hardening"
```

---

### Task 3: Parallel product + visual spawn with per-track activity tagging

**Files:**
- Modify: `apps/daemon/src/research-phase.ts` (`ResearchPhaseInput.onActivity` gains `track`; `ResearchPhaseResult.visualProduced`; fan out two tracks; injectable spawner)
- Test: `apps/daemon/test/research-phase.test.ts` (new)

**Interfaces produced:**
- `TrackedResearchActivity = ResearchActivity & { track: "product" | "visual" }` (exported)
- `ResearchPhaseInput.onActivity?: (a: TrackedResearchActivity) => void`
- `ResearchPhaseResult` gains `visualProduced: boolean`
- `runResearchPhase(input, spawner?: SpawnResearchFn)` — second arg defaults to the real `spawnResearch`; `SpawnResearchFn = (command, args, cwd, opts) => Promise<{ code: number | null; stderr: string }>`

- [ ] **Step 1: Write the failing test (inject a fake spawner)**

`apps/daemon/test/research-phase.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchPhase } from "../src/research-phase.ts";
import { reportPath, visualReportPath, visualAssetsDir } from "../../../packages/research/src/index.ts";

test("runResearchPhase runs product + visual in parallel and tags activities by track", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-"));
  const seen: Array<{ track: string; kind: string }> = [];
  const spawn = async (_cmd: string, args: string[], cwd: string, opts: any) => {
    const isVisual = args.join(" ").includes("Visual Research");
    if (isVisual) {
      mkdirSync(visualAssetsDir(cwd), { recursive: true });
      writeFileSync(visualReportPath(cwd), "# Visual");
      opts.onActivity?.({ kind: "search", text: "dribbble" });
    } else {
      writeFileSync(reportPath(cwd), "# Product");
      opts.onActivity?.({ kind: "search", text: "competitors" });
    }
    return { code: 0, stderr: "" };
  };
  const result = await runResearchPhase(
    { dir, brief: "a hero", agentCommand: "claude", onActivity: (a) => seen.push({ track: a.track, kind: a.kind }) },
    spawn,
  );
  assert.equal(result.produced, true);
  assert.equal(result.visualProduced, true);
  assert.ok(seen.some((a) => a.track === "product"));
  assert.ok(seen.some((a) => a.track === "visual"));
});
```
(Confirm `reportPath` is exported from `packages/research`; if the product report path helper has a different name, use that.)

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/research-phase.test.ts'`
Expected: FAIL — `runResearchPhase` ignores the 2nd arg / no `visualProduced` / `a.track` undefined.

- [ ] **Step 3: Implement the fan-out**

In `research-phase.ts`:
- Import `buildVisualResearchPrompt`, `visualResearchExists`, `visualAssetsDir` from research; and `mkdir` from `node:fs/promises`.
- Add and export `export type TrackedResearchActivity = ResearchActivity & { track: "product" | "visual" }` and `export type SpawnResearchFn = (command: string, args: string[], cwd: string, opts: SpawnResearchOpts) => Promise<{ code: number | null; stderr: string }>`.
- Change `ResearchPhaseInput.onActivity` to `(a: TrackedResearchActivity) => void`.
- Add `visualProduced: boolean` to `ResearchPhaseResult`.
- Rewrite `runResearchPhase(input, spawner: SpawnResearchFn = spawnResearch)`:
```typescript
export async function runResearchPhase(input: ResearchPhaseInput, spawner: SpawnResearchFn = spawnResearch): Promise<ResearchPhaseResult> {
  const productDone = researchExists(input.dir);
  const visualDone = visualResearchExists(input.dir);
  if (productDone && visualDone) return { ran: false, produced: true, visualProduced: true };
  await ensureResearchScaffold(input.dir);
  await mkdir(visualAssetsDir(input.dir), { recursive: true });

  const provider = getProvider(input.agentCommand);
  const argsFor = (prompt: string): string[] => {
    const base = provider ? provider.oneShotArgs(input.model, prompt) : ["-p", prompt];
    return [...base, "--output-format", "stream-json", "--verbose"];
  };

  const runTrack = async (track: "product" | "visual", prompt: string, alreadyDone: boolean): Promise<boolean> => {
    const exists = () => (track === "product" ? researchExists(input.dir) : visualResearchExists(input.dir));
    if (alreadyDone) return true;
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (input.signal?.aborted) break;
      try {
        await spawner(input.agentCommand, argsFor(prompt), input.dir, {
          env: input.env ?? {}, signal: input.signal, timeoutMs: input.timeoutMs,
          onActivity: input.onActivity ? (a) => input.onActivity!({ ...a, track }) : undefined,
        });
      } catch (err) {
        if (exists()) return true;
        if (err instanceof Error && /aborted/i.test(err.message)) break;
      }
      if (exists()) return true;
      if (attempt < MAX_ATTEMPTS && !input.signal?.aborted) {
        input.onActivity?.({ kind: "note", text: `${track} research produced nothing — retrying once.`, track });
      }
    }
    return exists();
  };

  const [produced, visualProduced] = await Promise.all([
    runTrack("product", buildResearchPrompt({ brief: input.brief, skill: input.skill, designSystemName: input.designSystemName, hasUserReferences: input.hasUserReferences }), productDone),
    runTrack("visual", buildVisualResearchPrompt({ brief: input.brief, designSystemName: input.designSystemName }), visualDone),
  ]);
  return { ran: true, produced, visualProduced };
}
```
- Keep `spawnResearch` + `SpawnResearchOpts` as-is (ensure `SpawnResearchOpts` is declared before `SpawnResearchFn` references it).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/research-phase.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/research-phase.ts apps/daemon/test/research-phase.test.ts
git commit -m "daemon: run product + visual research tracks in parallel, tag activities by track"
```

---

### Task 4: Visual-research → moodboard synthesizer

**Files:**
- Create: `apps/daemon/src/visual-research-moodboard.ts`
- Test: `apps/daemon/test/visual-research-moodboard.test.ts`

**Interfaces produced:**
- `syncVisualResearchMoodboard(deps: { store: Store; dataDir: string; projectDir: string }): Promise<{ boardId: string; nodes: number }>` — reads `.research/visual/assets` + `visual/sources.json` + the pointer; creates/reuses one "Visual research" board; copies assets into the board's on-disk store; lays out `image` nodes in a grid via `replaceMoodboardNodes`; writes the pointer. Idempotent: reuses the board id from the pointer and reuses assets by fileName.

- [ ] **Step 1: Write the failing test (`:memory:` store)**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { syncVisualResearchMoodboard } from "../src/visual-research-moodboard.ts";
import { visualAssetsDir, visualSourcesPath, readVisualMoodboardId } from "../../../packages/research/src/index.ts";
import { moodboardAssetPath } from "../src/project-moodboard-context.ts";

function setup() {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-vrm-"));
  const projectDir = join(dataDir, "projects", "p1");
  mkdirSync(visualAssetsDir(projectDir), { recursive: true });
  writeFileSync(join(visualAssetsDir(projectDir), "a.png"), "x");
  writeFileSync(join(visualAssetsDir(projectDir), "b.png"), "y");
  writeFileSync(visualSourcesPath(projectDir), JSON.stringify([
    { id: "s1", platform: "dribbble", url: "https://dribbble.com/shots/1", designer: "Jane", takeaways: ["mono"], assets: ["assets/a.png"], reached: true },
  ]));
  return { store, dataDir, projectDir };
}

test("syncVisualResearchMoodboard builds a board with an image node per asset, attributed + rendered", async () => {
  const { store, dataDir, projectDir } = setup();
  const out = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  assert.ok(out.boardId);
  assert.equal(out.nodes, 2);
  assert.equal(await readVisualMoodboardId(projectDir), out.boardId);

  const nodes = store.listMoodboardNodes(out.boardId);
  const images = nodes.filter((n) => n.type === "image");
  assert.equal(images.length, 2);
  assert.ok(images.every((n) => typeof n.data.url === "string" && (n.data.url as string).includes(`/api/moodboards/${out.boardId}/assets/`)));
  assert.ok(images.some((n) => n.data.sourceUrl === "https://dribbble.com/shots/1" && n.data.designer === "Jane"));

  // asset files were copied into the board store
  const assets = store.listMoodboardAssets(out.boardId);
  assert.equal(assets.length, 2);
  assert.ok(assets.every((a) => existsSync(moodboardAssetPath(dataDir, out.boardId, a))));
  store.close();
});

test("syncVisualResearchMoodboard is idempotent — reuses the board id and asset rows", async () => {
  const { store, dataDir, projectDir } = setup();
  const first = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  const second = await syncVisualResearchMoodboard({ store, dataDir, projectDir });
  assert.equal(second.boardId, first.boardId);
  assert.equal(second.nodes, 2);
  assert.equal(store.listMoodboardAssets(first.boardId).length, 2); // not doubled
  store.close();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/visual-research-moodboard.test.ts'`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `syncVisualResearchMoodboard`**

Create `apps/daemon/src/visual-research-moodboard.ts`:
```typescript
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { SaveMoodboardNodeInput, Store } from "../../../packages/core/src/index.ts";
import {
  listVisualAssets, readVisualSources, readVisualMoodboardId, writeVisualMoodboardId,
} from "../../../packages/research/src/index.ts";
import { moodboardAssetPath } from "./project-moodboard-context.ts";

const BOARD_NAME = "Visual research";
const COLS = 4, W = 280, H = 180, GAP = 24, X0 = 80, Y0 = 80;

function mimeForExt(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

export async function syncVisualResearchMoodboard(deps: { store: Store; dataDir: string; projectDir: string }): Promise<{ boardId: string; nodes: number }> {
  const { store, dataDir, projectDir } = deps;
  const assets = await listVisualAssets(projectDir);           // ["visual/assets/a.png", ...]
  if (!assets.length) return { boardId: "", nodes: 0 };
  const sources = await readVisualSources(projectDir);

  // Resolve (or create) the single per-project board via the pointer file.
  const pointerId = await readVisualMoodboardId(projectDir);
  const board = (pointerId && store.getMoodboard(pointerId)) || store.createMoodboard({ name: BOARD_NAME });
  if (board.id !== pointerId) await writeVisualMoodboardId(projectDir, board.id);

  const existingByName = new Map(store.listMoodboardAssets(board.id).map((a) => [a.fileName, a]));
  const nodes: SaveMoodboardNodeInput[] = [];
  assets.forEach((rel, i) => {
    const fileName = basename(rel);                             // "a.png"
    const mimeType = mimeForExt(fileName);
    const asset = existingByName.get(fileName) ?? store.createMoodboardAsset(board.id, {
      kind: "image", fileName, mimeType, width: null, height: null, source: "upload",
    });
    // Copy the downloaded file into the board's on-disk asset store (path keyed by asset id + ext).
    const dest = moodboardAssetPath(dataDir, board.id, asset);
    mkdirSync(join(dataDir, "moodboards", board.id, "assets"), { recursive: true });
    copyFileSync(join(projectDir, ".research", rel), dest);
    const src = sources.find((s) => (s.assets ?? []).some((a) => basename(a) === fileName));
    const col = i % COLS, row = Math.floor(i / COLS);
    nodes.push({
      type: "image",
      x: X0 + col * (W + GAP), y: Y0 + row * (H + GAP), width: W, height: H, zIndex: i,
      data: {
        assetId: asset.id, url: `/api/moodboards/${board.id}/assets/${asset.id}`, fileName, source: "upload",
        ...(src?.url ? { sourceUrl: src.url } : {}),
        ...(src?.designer ? { designer: src.designer } : {}),
        ...(src?.platform ? { platform: src.platform } : {}),
      },
    });
  });
  store.replaceMoodboardNodes(board.id, nodes);
  return { boardId: board.id, nodes: nodes.length };
}
```
(`ResearchSource.assets` is the array on each source entry; if the field name differs, mirror what `readVisualSources` returns.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/visual-research-moodboard.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/visual-research-moodboard.ts apps/daemon/test/visual-research-moodboard.test.ts
git commit -m "daemon: synthesize collected visual research into a per-project Visual research moodboard"
```

---

### Task 5: Wire both tracks into the run — brief, moodboard sync, SSE track, research-handler visual section

**Files:**
- Modify: `apps/daemon/src/run-handler.ts` (research block: SSE `research-activity` carries `track`; after research, call `syncVisualResearchMoodboard`)
- Modify: `apps/daemon/src/research-handler.ts` (return a `visual` section)
- Modify: `apps/daemon/src/app.ts` (route to serve visual assets)
- Test: `apps/daemon/test/research-handler.test.ts` (new or existing) for the visual section; extend the existing dual-research run test if present.

**Interfaces produced:**
- `handleGetResearch` response gains `visual: { exists: boolean; report: string; sources: ResearchSource[]; assets: string[]; boardId?: string }`.
- New route `GET /api/projects/:id/research/visual/assets/*rest`.
- SSE `research-activity` event gains a `track: "product" | "visual"` field.

- [ ] **Step 1: Write the failing test (research-handler visual section)**

`apps/daemon/test/research-handler.test.ts` — build minimal deps with a temp project dir containing `.research/research.md` + `.research/visual/visual.md` + `visual/sources.json` + `visual/moodboard.json`, call `handleGetResearch`, and assert the response includes `visual.exists === true`, `visual.report` matching the visual markdown, `visual.boardId`, and the visual sources. (Mirror the existing research-handler test's deps/harness; if none exists, construct `deps` with a `:memory:` `Store`, a `dataDir`, and an `activeArtifactDir` that resolves to the temp project dir. Capture the response via a fake `ServerResponse` that records the `sendJson` body — copy the pattern from another daemon handler test.)

- [ ] **Step 2: Run to verify fail.**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/research-handler.test.ts'`
Expected: FAIL — no `visual` key on the response.

- [ ] **Step 3: Implement the research-handler visual section**

In `research-handler.ts`, import `visualResearchExists, readVisualReport, readVisualSources, listVisualAssets, readVisualMoodboardId` from research. After the existing product reads:
```typescript
  const [visualReport, visualSources, visualAssets, visualBoardId] = await Promise.all([
    readVisualReport(dir),
    readVisualSources(dir).catch(() => []),
    listVisualAssets(dir).catch(() => []),
    readVisualMoodboardId(dir).catch(() => null),
  ]);
```
Add to the returned JSON:
```typescript
    visual: {
      exists: visualResearchExists(dir),
      report: visualReport ?? "",
      sources: visualSources,
      assets: visualAssets,
      ...(visualBoardId ? { boardId: visualBoardId } : {}),
    },
```

- [ ] **Step 4: Add the visual-assets route in `app.ts`**

Next to the existing `"/api/projects/:id/research/assets/*rest"` route (app.ts:655), add a sibling with the SAME option flags:
```typescript
  {
    pattern: "/api/projects/:id/research/visual/assets/*rest",
    // publicRead so <img src> works; safeJoin blocks traversal.
    handler: (_req, res, { id, rest }, { dataDir }) => serveProjectFile(res, dataDir, id!, join(".research", "visual", "assets", rest ?? "")),
    // copy the exact publicRead/method flags the sibling research-assets route uses
  },
```

- [ ] **Step 5: Wire run-handler**

In `run-handler.ts` research block: change the `onActivity` passed to the research phase so the SSE payload includes the track, e.g.:
```typescript
      onActivity: (a) => sse({ type: "research-activity", runId: run.id, kind: a.kind, text: a.text, track: a.track }),
```
After the research phase resolves (guarded so a missing board is harmless), add:
```typescript
      try { await syncVisualResearchMoodboard({ store: deps.store, dataDir: deps.dataDir, projectDir: dir }); } catch { /* visual moodboard is best-effort */ }
```
Import `syncVisualResearchMoodboard`. Use the same `dir` the research phase wrote to (the active artifact dir) and the `deps.store` / `deps.dataDir` already in scope. Keep this consistent with the Bug-2 `alreadyResearched` gating already in the block — the sync is safe to run on every research pass (idempotent).

- [ ] **Step 6: Run daemon tests + typecheck to verify pass**

Run: `bash scripts/test-all.sh` and `bash scripts/typecheck.sh`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/run-handler.ts apps/daemon/src/research-handler.ts apps/daemon/src/app.ts apps/daemon/test/research-handler.test.ts
git commit -m "daemon: feed both research tracks to the build, sync visual moodboard, serve visual assets + track SSE"
```

---

### Task 6: Research UI — Product · Visual sub-tabs + visual data panel + two-lane live activities

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`ResearchDetail.visual`; `ResearchSource` fields; `researchVisualAssetUrl`)
- Modify: `apps/web/src/test/fake-api.ts` (`researchVisualAssetUrl` stub)
- Modify: `apps/web/src/screens/ResearchViews.tsx` (`ResearchPanel` sub-tabs; `ResearchCard` two lanes by `track`)
- Modify: `apps/web/src/screens/WorkspaceScreen.tsx` (pass a `visualAssetUrl`; route `research-activity.track` into the card)
- Test: extend `apps/web/src/screens/research-views.test.tsx`

**Interfaces produced:**
- `ResearchDetail.visual?: { exists: boolean; report: string; sources: ResearchDetail["sources"]; assets: string[]; boardId?: string }`
- `api.researchVisualAssetUrl(id, assetPath): string`
- `ResearchPanel({ research, assetUrl, visualAssetUrl })`

- [ ] **Step 1: Write failing vitest**

Append to `apps/web/src/screens/research-views.test.tsx`:
```typescript
test("ResearchPanel shows Product and Visual sub-tabs; Visual renders the collected imagery + sources", async () => {
  const research = {
    exists: true, report: "# Product\n\nUsers skim.", sources: [], directions: [], assets: [],
    visual: {
      exists: true, report: "# Visual\n\n![hero](assets/hero.png)\n\nMono palette.",
      sources: [{ id: "s1", title: "Shot", url: "https://dribbble.com/shots/1", platform: "dribbble", designer: "Jane", reached: true }],
      assets: ["visual/assets/hero.png"], boardId: "board-1",
    },
  };
  const { getByRole, findByText, getByText } = render(
    <ResearchPanel research={research as any} assetUrl={(p) => `/a/${p}`} visualAssetUrl={(p) => `/v/${p}`} />,
  );
  getByText(/Users skim/);                         // Product visible by default
  getByRole("tab", { name: /visual/i }).click();   // switch to Visual
  await findByText(/Mono palette/);
  getByText(/dribbble/i);
  getByText(/Jane/);
});

test("ResearchCard splits activities into product and visual lanes", () => {
  const { getByText } = render(
    <ResearchCard
      status="running"
      activities={[
        { kind: "search", text: "competitors", track: "product" },
        { kind: "search", text: "dribbble shots", track: "visual" },
      ] as any}
    />,
  );
  getByText(/competitors/);
  getByText(/dribbble shots/);
  getByText(/visual/i);   // a lane label
});
```
(Match `ResearchCard`'s real required props — copy them from an existing `ResearchCard` test in the same file; add only the `track` field to the activities.)

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/web && npx vitest run src/screens/research-views.test.tsx`
Expected: FAIL — no sub-tabs / `visualAssetUrl` prop / lane labels.

- [ ] **Step 3: Extend the web types + api**

In `apps/web/src/lib/api.ts`: add `platform?: string; designer?: string; reached?: boolean; authority?: string` to the web source type that `ResearchDetail.sources` uses; add to `ResearchDetail`:
```typescript
  visual?: {
    exists: boolean;
    report: string;
    sources: ResearchDetail["sources"];
    assets: string[];
    boardId?: string;
  };
```
Add to the `ApiClient` interface + implementation:
```typescript
  researchVisualAssetUrl(id: string, assetPath: string): string;
  // impl (mirror researchAssetUrl at api.ts:801):
  researchVisualAssetUrl: (id, assetPath) => `${baseUrl}/api/projects/${enc(id)}/research/visual/assets/${assetPath.replace(/^(visual\/)?assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
```
Add `researchVisualAssetUrl: (_id, p) => \`/v/${p}\`` to `apps/web/src/test/fake-api.ts`.

- [ ] **Step 4: Implement `ResearchPanel` sub-tabs + `ResearchCard` lanes**

- `ResearchPanel` gains a `visualAssetUrl` prop and internal `const [subTab, setSubTab] = useState<"product" | "visual">("product")`. Render a small tab bar (`role="tablist"` with two `role="tab"` buttons `Product` / `Visual`; hide the bar when `!research.visual?.exists`). Keep the current body under `subTab === "product"`. Under `subTab === "visual"`, render: the visual report markdown (rewrite `![](assets/x.png)` → `visualAssetUrl(path)` exactly as the product report rewrites `assets/`), an assets grid using `visualAssetUrl`, and a sources list showing `platform`, `designer`, and a reached/blocked badge (`s.reached === false ? "blocked" : "reached"`). Leave a `data-testid="visual-moodboard-mount"` empty container where Task 7 will mount the canvas.
- `ResearchCard`: when any activity has a `track`, render two labelled lanes ("Product" / "Visual"), each filtering `activities` by track; otherwise fall back to the current single list.

- [ ] **Step 5: Thread `visualAssetUrl` + `track` in `WorkspaceScreen.tsx`**

- At the `<ResearchPanel .../>` render (WorkspaceScreen.tsx:4886), add `visualAssetUrl={(p) => api.researchVisualAssetUrl(projectId, p)}`.
- Where `research-activity` SSE events are consumed into the `ResearchCard` activities, carry the `track` field through (default `"product"` when absent, for backward-compat with older events).

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/web && npx vitest run` (full web suite — ensure nothing else broke)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "web: Research Product/Visual sub-tabs + visual data panel + two-lane live research activities"
```

---

### Task 7: Mount the interactive Visual-research moodboard in the Visual tab

> Heaviest task, isolated last so Task 6's Visual tab already ships value if this slips. `MoodboardCanvasProps` is a ~24-prop interactive surface; this task wires the **curate/rearrange** subset (nodes, selection, asset list, node-persistence) and no-ops authoring-creation callbacks (note/section/image-generator/upload). Re-running research replaces the board's nodes (documented behavior) — so user rearrangement is transient until they stop re-running; acceptable for v1.

**Files:**
- Create: `apps/web/src/screens/VisualResearchBoard.tsx` (loads the board by id, mounts `MoodboardCanvas`, persists node changes)
- Modify: `apps/web/src/screens/ResearchViews.tsx` (render `VisualResearchBoard` at the `visual-moodboard-mount` when `research.visual?.boardId`)
- Test: `apps/web/src/screens/visual-research-board.test.tsx` (new), mocking `../moodboard/MoodboardCanvas.tsx` (same pattern as `moodboard-screen.test.tsx`)

**Interfaces produced:**
- `VisualResearchBoard({ boardId }: { boardId: string })` — self-contained; loads nodes/assets via the existing moodboard api the `MoodboardScreen` uses and persists edits via the same save method.

- [ ] **Step 1: Read the reference** — read `apps/web/src/screens/MoodboardScreen.tsx` in full to copy exactly how it loads a board's nodes/assets, maps assets to URLs, and persists `onNodesChange` (the api method name for saving nodes, e.g. `api.replaceMoodboardNodes` or similar). Use the SAME methods; do not invent new ones.

- [ ] **Step 2: Write the failing test**

`apps/web/src/screens/visual-research-board.test.tsx`:
```typescript
import { test, expect, vi } from "vitest";
import { render } from "@testing-library/react";
vi.mock("../moodboard/MoodboardCanvas.tsx", () => ({
  MoodboardCanvas: (props: { nodes: unknown[] }) => <div data-testid="visual-moodboard" data-nodes={(props.nodes as unknown[]).length} />,
}));
// mock the api module the board uses to return one image node + one asset for boardId "b1"
// (mirror the api-mock style used elsewhere in apps/web/src/screens tests)
import { VisualResearchBoard } from "./VisualResearchBoard.tsx";

test("VisualResearchBoard loads the board and mounts the canvas", async () => {
  const { findByTestId } = render(<VisualResearchBoard boardId="b1" />);
  const el = await findByTestId("visual-moodboard");
  expect(el).toBeTruthy();
});
```

- [ ] **Step 3: Run to verify fail.**

Run: `cd apps/web && npx vitest run src/screens/visual-research-board.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `VisualResearchBoard`** — load the board's nodes + assets on mount (`useEffect` + the api methods from Step 1), map assets → `{...asset, url: api.moodboardAssetUrl(boardId, asset.id)}` exactly as `MoodboardScreen` does, render `MoodboardCanvas` with `nodes`, `selectedIds`, `moodboardAssets`, `onSelectIds`, and `onNodesChange` (persist via the save method), and no-op the creation callbacks (`onAddNote`/`onAddSection`/`onAddImageGenerator`/`onUploadFiles`/`onGenerateImage`) with empty handlers. Wrap in a fixed-height container so the infinite canvas has bounds.

- [ ] **Step 5: Render it in `ResearchViews.tsx`** — at the `data-testid="visual-moodboard-mount"` container, when `research.visual?.boardId`, render `<VisualResearchBoard boardId={research.visual.boardId} />`.

- [ ] **Step 6: Run to verify pass** — `cd apps/web && npx vitest run`. Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -m "web: mount interactive Visual-research moodboard in the Research Visual tab"`.

---

## Final verification (after Task 7)

- [ ] `bash scripts/test-all.sh` + `cd apps/web && npm test` + `bash scripts/typecheck.sh` all green.
- [ ] Bump root `package.json` `version` (e.g. `0.26.4 → 0.27.0` — new feature); commit `chore: v0.27.0`.
- [ ] **Real-run spot check** (`npm run dev`, a Standard project, research enabled): two lanes stream (Product + Visual); the visual track downloads real screenshots; a "Visual research" moodboard populates and appears in the Visual tab; both reports reach the build brief; note reached-vs-blocked coverage. This can't be exercised headless — do it before declaring done.

## Self-review notes

- **Spec coverage:** §Parallel tracks → Task 3. §Visual prompt → Task 2. §Moodboard population → Task 4. §Knowledge base (both feed build) → Task 1 `buildResearchContext` + Task 5 wiring. §Research UI sub-tabs → Task 6 (data) + Task 7 (interactive canvas). §Source authority → Task 1 (blocklist + `authority`/`platform`/`designer`/`reached`) + Task 2 (prompt). §`.research/visual/` additive layout → Task 1. All spec sections map to a task.
- **Placeholder scan:** every code step shows real code against verified signatures. The two areas that say "read the reference file first" (Task 5's run-handler block, Task 7's MoodboardScreen load/persist) are glue whose exact call sites drift by line number; each is pinned by a concrete failing test and an explicit interface, and names the exact file to read — not a placeholder for logic.
- **Type consistency:** `syncVisualResearchMoodboard({ store, dataDir, projectDir })` — same shape in Tasks 4 and 5. `TrackedResearchActivity.track` — produced in Task 3, consumed by SSE in Task 5 and the card in Task 6. `ResearchDetail.visual` shape — identical in the handler (Task 5) and the web type (Task 6). Image node `data` — `{ assetId, url, fileName, source }` matches the verified canvas renderer. `researchVisualAssetUrl` strips `^(visual/)?assets/` to match the server route added in Task 5.
- **Scope:** single subsystem (Research). Task 7 is the one integration-heavy task and is deliberately last + independently droppable.
