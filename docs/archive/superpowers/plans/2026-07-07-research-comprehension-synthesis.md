# Research comprehension + synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the named file before editing — line numbers drift.

**Goal:** Make the build agent actually consume the visual research — the visual track opens + studies each downloaded image to ground `visual.md`, a new synthesis step produces the candidate directions from the *comprehensive* (product + visual + brief) understanding, and the build brief hands the agent the *correct* `.research/` image paths with a forceful "open these first" instruction.

**Architecture:** Three pure prompt/IO changes in `packages/research` + one daemon wiring change. `runResearchPhase` keeps the parallel `Promise.all([product, visual])` and adds a third **sequential** synthesis spawn that writes `directions/`. Direction-generation is removed from the product prompt. Image understanding is 100% agent-driven (no provider vision model).

**Tech Stack:** Node built-ins only. `node:test` + `--experimental-strip-types` (+ `--experimental-sqlite` for daemon). Relative `.ts` imports.

## Global Constraints

- **Hermetic, zero-install:** Node built-ins only, no new deps. Cross-package imports use RELATIVE paths, never `@dezin/*`.
- **Image understanding is agent-driven:** NO provider image-analysis model, NO daemon vision pass. The agent opens the images itself.
- **Images opened twice, by design:** the visual track (to write `visual.md`) and the build (to execute). The synthesis step does NOT re-open images — it relies on `visual.md`.
- **Directions format unchanged:** the synthesis step writes the SAME `.research/directions/<slug>/direction.md` the product prompt used, so the direction gate + `buildResearchContext(chosenDirection)` keep working.
- **Tests before commit:** `bash scripts/test-all.sh` + `cd apps/web && npm test` + `bash scripts/typecheck.sh` green.
- **Commits:** one per task, direct to `main`; bump root `package.json` `version` in the final task; **never** a `Co-Authored-By` trailer; leave `packages/quality/.impeccable/hook.cache.json` unstaged.
- **Verify against a real run** (`npm run dev`, a vision-capable agent, research on) before declaring done — the agent-sees-images path can't be exercised headless.

---

### Task 1: Prompts — visual "open+study each image", product de-direction, new synthesis prompt

**Files:**
- Modify: `packages/research/src/prompts.ts` (`buildVisualResearchPrompt` strengthen; `buildResearchPrompt` remove directions; add `buildSynthesisPrompt`)
- Modify: `packages/research/src/index.ts` (export `buildSynthesisPrompt`)
- Test: `packages/research/test/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: `RESEARCH_DIRNAME`, `REPORT_FILE`, `VISUAL_DIRNAME`, `VISUAL_REPORT_FILE`, `DIRECTIONS_DIRNAME`, `ASSETS_DIRNAME`, `SOURCES_FILE` (from `./convention.ts`, all already imported in prompts.ts), `ResearchInput`.
- Produces: `buildSynthesisPrompt(input: ResearchInput): string` (same input type as `buildResearchPrompt`). `buildVisualResearchPrompt`/`buildResearchPrompt` keep their signatures.

- [ ] **Step 1: Write the failing tests**

Append to `packages/research/test/prompts.test.ts`:
```typescript
import { buildSynthesisPrompt } from "../src/index.ts";
import { DIRECTIONS_DIRNAME } from "../src/convention.ts";

test("buildVisualResearchPrompt makes the agent OPEN and study each downloaded image", () => {
  const p = buildVisualResearchPrompt({ brief: "a portfolio" });
  assert.match(p, /open .*(each|every).*image|open and study each/i);
  assert.match(p, /what you (actually )?see|from the pixels/i);
});

test("buildResearchPrompt no longer generates directions (moved to the synthesis step)", () => {
  const p = buildResearchPrompt({ brief: "a pricing page" });
  assert.doesNotMatch(p, new RegExp(`${DIRECTIONS_DIRNAME}/`)); // no directions/ path
  assert.doesNotMatch(p, /direction\.md/);
});

test("buildSynthesisPrompt synthesizes BOTH reports + brief into directions, without re-opening images", () => {
  const p = buildSynthesisPrompt({ brief: "a fintech dashboard" });
  assert.match(p, /Phase: Synthesis/);
  assert.match(p, /research\.md/);          // reads product report
  assert.match(p, /visual\.md/);            // reads visual report
  assert.match(p, new RegExp(`${DIRECTIONS_DIRNAME}/`)); // writes directions/
  assert.match(p, /direction\.md/);
  assert.match(p, /synthesi/i);
  // Relies on visual.md — must NOT tell the synthesis agent to re-open the images.
  assert.doesNotMatch(p, /open .*(each|every).*image/i);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/prompts.test.ts'`
Expected: FAIL — `buildSynthesisPrompt` not exported; the visual/product assertions fail.

- [ ] **Step 3a: Strengthen `buildVisualResearchPrompt`**

In `buildVisualResearchPrompt`'s `## Rules` block, add a bullet after the "Finish WITHIN this turn" line:
```typescript
- **Actually look.** After downloading, OPEN each kept image with your file tools and study it. Write \`${VISUAL_REPORT_FILE}\` from what you SEE in the pixels — concrete, per-image observations (palette / type / layout / motion, as specific as you can), not generic prose. If you genuinely cannot open an image, say so rather than guessing its content.
```

- [ ] **Step 3b: Remove direction-generation from `buildResearchPrompt`**

Three edits inside `buildResearchPrompt`'s template:
1. The `${REPORT_FILE}` bullet currently ends: `End with **Synthesis → 2–3 candidate directions**, each with a concept, an information architecture (the sections/screens in order), and the ONE distinctive move that would give it soul.` — replace that sentence with:
   `END with a short **Synthesis** — the key product insights a designer must honor. (Candidate DIRECTIONS are produced by a later synthesis step that also sees the visual research — do NOT write directions here.)`
2. DELETE the entire directions bullet:
   `` - `${RESEARCH_DIRNAME}/${DIRECTIONS_DIRNAME}/<slug>/direction.md` — one file per candidate direction: its concept, its information architecture, and its distinctive move. ``
3. In the first `## Rules` bullet, change `A turn that ends before \`${REPORT_FILE}\` and the direction files exist has failed` → `A turn that ends before \`${REPORT_FILE}\` exists has failed`.

- [ ] **Step 3c: Add `buildSynthesisPrompt`**

Append to `prompts.ts` (reuse the module's convention imports):
```typescript
/**
 * Synthesis prompt — after BOTH research tracks, read the product report + the visual
 * report + the brief and produce the candidate directions from the COMPREHENSIVE
 * understanding. Does NOT re-open the reference images: visual.md already captures the
 * visual track's seen-it understanding.
 */
export function buildSynthesisPrompt(input: ResearchInput): string {
  const brandLine = input.designSystemName
    ? `\n- Active brand: **${input.designSystemName}** — directions must fit its spirit.`
    : "";
  return `# Phase: Synthesis

Both research tracks are done. Do NOT design or write any artifact. Your one job: read the
research already on disk and propose the candidate design DIRECTIONS, grounded in the FULL
picture — product + visual + the actual need.

## Read first (already written to \`${RESEARCH_DIRNAME}/\`)

- \`${RESEARCH_DIRNAME}/${REPORT_FILE}\` — the product/competitive/audience/domain research.
- \`${RESEARCH_DIRNAME}/${VISUAL_DIRNAME}/${VISUAL_REPORT_FILE}\` — the visual research: the palette /
  type / layout / motion direction the visual agent distilled from the real reference images it
  opened. Trust it as the visual understanding; you do NOT need to re-open the images.
- The brief (below).

If one report is missing, synthesize from whichever exists.

## Produce

- \`${RESEARCH_DIRNAME}/${DIRECTIONS_DIRNAME}/<slug>/direction.md\` — 2–3 candidate directions, one
  file each (kebab-case slug). Every direction must SYNTHESIZE both tracks: state its concept, its
  information architecture (the sections/screens in order), and the ONE distinctive move that gives
  it soul — and it must reflect what THIS brief actually needs. If the brief + research point at a
  rich visual/interactive treatment, say so concretely (and name the technique the build should
  reach for); if they point at something restrained, do NOT manufacture spectacle. Directions are
  grounded understanding, not a menu of unrelated styles.

## Rules
- Finish WITHIN this turn — the direction files must exist on disk before you return.
- Ground every direction in the two reports; do not invent research that isn't there.${brandLine}
- Write in the user's language.

## Brief

${input.brief.trim()}`;
}
```

- [ ] **Step 4: Export + run to verify pass**

Add `buildSynthesisPrompt` to `packages/research/src/index.ts`.
Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/prompts.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/prompts.ts packages/research/src/index.ts packages/research/test/prompts.test.ts
git commit -m "research: visual prompt opens each image; move directions to a new synthesis prompt"
```

---

### Task 2: `buildResearchContext` — fix the `.research` image path + force-open, add `directionsExist`

**Files:**
- Modify: `packages/research/src/io.ts` (`buildResearchContext` path fix + force-open; add `directionsExist`)
- Modify: `packages/research/src/index.ts` (export `directionsExist`)
- Test: `packages/research/test/visual-io.test.ts` (extend)

**Interfaces:**
- Consumes: `researchDir`, `directionsDir`, `basename`, `readReport`/`readVisualReport`/`listAssets`/`listVisualAssets` (already in io.ts).
- Produces: `directionsExist(projectDir: string): boolean`. `buildResearchContext` keeps its signature; the imagery lines now emit `.research/…` paths + a force-open instruction.

- [ ] **Step 1: Write the failing tests**

Append to `packages/research/test/visual-io.test.ts`:
```typescript
import { mkdirSync as mkdirSyncNode } from "node:fs";
import { directionsExist } from "../src/index.ts";

test("buildResearchContext gives the agent the REAL .research image paths (not research/) and forces opening them", async () => {
  const p = proj();
  mkdirSync(join(p, ".research", "assets"), { recursive: true });
  mkdirSync(visualAssetsDir(p), { recursive: true });
  writeFileSync(join(p, ".research", "research.md"), "# Product\n\nUsers skim.");
  writeFileSync(visualReportPath(p), "# Visual\n\nMono.");
  writeFileSync(join(p, ".research", "assets", "ref.png"), "x");
  writeFileSync(join(visualAssetsDir(p), "hero.png"), "x");
  const ctx = (await buildResearchContext(p))!;
  // Paths must carry the leading dot (RESEARCH_DIRNAME = ".research").
  assert.match(ctx, /\.research\/visual\/assets\/hero\.png/);
  assert.match(ctx, /\.research\/assets\/ref\.png/);
  // And must NOT hand the agent the broken dot-less path (a backtick directly before "research/").
  assert.doesNotMatch(ctx, /`research\//);
  // Force-open instruction (not the passive "study these").
  assert.match(ctx, /open .*(each|every).*(image|screenshot|reference)|open and study/i);
  assert.match(ctx, /primary visual evidence/i);
});

test("directionsExist reflects whether any candidate direction is on disk", () => {
  const p = proj();
  assert.equal(directionsExist(p), false);
  mkdirSyncNode(join(p, ".research", "directions", "bold"), { recursive: true });
  assert.equal(directionsExist(p), true);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/visual-io.test.ts'`
Expected: FAIL — `directionsExist` not exported; current context uses `research/…` + "Study these".

- [ ] **Step 3: Fix the paths + force-open in `buildResearchContext`**

In `io.ts`, at the top of `buildResearchContext` (after resolving `report`/`visualReport`), add a relative research-dir base:
```typescript
  const researchRel = basename(researchDir(projectDir)); // ".research" — the real on-disk dir
```
Replace the product-assets push:
```typescript
  if (assets.length) {
    parts.push(`Reference imagery is available locally: ${assets.map((a) => `\`${join(researchRel, a)}\``).join(", ")}.`);
  }
```
Replace the visual-assets push (path fix + force-open):
```typescript
  const visualAssets = await listVisualAssets(projectDir);
  if (visualAssets.length) {
    parts.push(
      `Reference screenshots are on disk: ${visualAssets.map((a) => `\`${join(researchRel, a)}\``).join(", ")}. Before you design, OPEN and study EACH of them with your file tools — they are PRIMARY visual evidence for the look, not decoration. Do not design from the text alone.`,
    );
  }
```
(`join` and `basename` are already imported in io.ts; `researchDir` too. If not, add them.)

- [ ] **Step 4: Add `directionsExist`**

Add to `io.ts` (import `readdirSync` from `node:fs` and `directionsDir` from `./convention.ts` if not present):
```typescript
/** True when at least one candidate direction dir exists on disk. */
export function directionsExist(projectDir: string): boolean {
  try {
    return readdirSync(directionsDir(projectDir), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}
```
Export `directionsExist` from `packages/research/src/index.ts`.

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/research && node --experimental-strip-types --no-warnings --test 'test/*.test.ts'`
Expected: PASS (all research tests).

- [ ] **Step 6: Commit**

```bash
git add packages/research/src/io.ts packages/research/src/index.ts packages/research/test/visual-io.test.ts
git commit -m "research: fix build-brief image paths (.research not research) + force-open; add directionsExist"
```

---

### Task 3: Synthesis spawn in `runResearchPhase`

**Files:**
- Modify: `apps/daemon/src/research-phase.ts` (add sequential synthesis spawn after `Promise.all`; product track no longer produces directions)
- Test: `apps/daemon/test/research-phase.test.ts` (extend)

**Interfaces:**
- Consumes: `buildSynthesisPrompt` (Task 1), `directionsExist` (Task 2), the existing injectable `spawner`, `researchExists`/`visualResearchExists`.
- Produces: `runResearchPhase` now also produces `.research/directions/` via a synthesis spawn; `ResearchPhaseResult` shape unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/test/research-phase.test.ts`:
```typescript
import { buildSynthesisPrompt } from "../../../packages/research/src/index.ts";
import { directionsExist } from "../../../packages/research/src/index.ts";
import { mkdirSync as mkdirSyncN } from "node:fs";

test("runResearchPhase runs a synthesis step after both tracks and produces directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-rp-synth-"));
  const calls: string[] = [];
  const spawn = async (_cmd: string, args: string[], cwd: string, opts: any) => {
    const joined = args.join(" ");
    if (joined.includes("Phase: Synthesis")) {
      calls.push("synthesis");
      mkdirSyncN(join(cwd, ".research", "directions", "bold"), { recursive: true });
      writeFileSync(join(cwd, ".research", "directions", "bold", "direction.md"), "# Bold");
    } else if (joined.includes("Visual Research")) {
      calls.push("visual");
      mkdirSync(visualAssetsDir(cwd), { recursive: true });
      writeFileSync(visualReportPath(cwd), "# Visual");
    } else {
      calls.push("product");
      writeFileSync(reportPath(cwd), "# Product");
    }
    return { code: 0, stderr: "" };
  };
  const result = await runResearchPhase({ dir, brief: "a hero", agentCommand: "claude" }, spawn);
  assert.equal(result.produced, true);
  assert.equal(result.visualProduced, true);
  assert.ok(directionsExist(dir), "synthesis step should have produced directions");
  assert.ok(calls.includes("synthesis"), "synthesis spawn should run");
  // Synthesis runs AFTER both tracks.
  assert.ok(calls.indexOf("synthesis") > calls.indexOf("product"));
  assert.ok(calls.indexOf("synthesis") > calls.indexOf("visual"));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/research-phase.test.ts'`
Expected: FAIL — no synthesis spawn; `directionsExist(dir)` false.

- [ ] **Step 3: Add the synthesis spawn**

In `research-phase.ts`:
- Import `buildSynthesisPrompt`, `directionsExist` from research.
- Change the early return to also require directions:
```typescript
  if (productDone && visualDone && directionsExist(input.dir)) return { ran: false, produced: true, visualProduced: true };
```
- After the `const [product, visual] = await Promise.all([...])` line and before building `reasons`, add:
```typescript
  // Synthesis: read BOTH reports + the brief and produce the candidate directions from the
  // comprehensive understanding. Sequential (needs both tracks). Does not re-open the images.
  if (!directionsExist(input.dir) && (product.produced || visual.produced) && !input.signal?.aborted) {
    const synthArgs = argsFor(
      buildSynthesisPrompt({
        brief: input.brief,
        skill: input.skill,
        designSystemName: input.designSystemName,
      }),
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (input.signal?.aborted) break;
      try {
        await spawner(input.agentCommand, synthArgs, input.dir, {
          env: input.env ?? {},
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
      } catch (err) {
        if (directionsExist(input.dir)) break;
        if (err instanceof Error && /aborted/i.test(err.message)) break;
      }
      if (directionsExist(input.dir)) break;
    }
  }
```
- Define `MAX_ATTEMPTS` if it isn't already a module/function const (the tracks use 2 — reuse the same value; if it's local to `runTrack`, lift it to a `const MAX_ATTEMPTS = 2` in `runResearchPhase` scope so both the tracks and synthesis use it).
- The synthesis spawn intentionally omits `onActivity` (silent for v1 — the two-lane card covers the parallel discovery; surfacing synthesis progress is a future nicety). Do NOT add a `"synthesis"` track value.

- [ ] **Step 4: Run to verify pass + full typecheck**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/research-phase.test.ts'`
Then: `bash scripts/typecheck.sh`
Expected: PASS both.

- [ ] **Step 5: Run the run-handler regression gate**

Run: `cd apps/daemon && node --experimental-strip-types --experimental-sqlite --no-warnings --test 'test/runs.test.ts'`
Expected: PASS (this exercises `runResearchPhase` end-to-end; ~7 min — run in the FOREGROUND, do not background/monitor).

- [ ] **Step 6: Bump version + commit**

Bump root `package.json` `version` (e.g. `0.27.1 → 0.28.0` — new feature). Then:
```bash
git add apps/daemon/src/research-phase.ts apps/daemon/test/research-phase.test.ts package.json
git commit -m "daemon: synthesis step produces directions from both research tracks (v0.28.0)"
```

---

## Final verification (after Task 3)

- [ ] `bash scripts/test-all.sh` + `cd apps/web && npm test` + `bash scripts/typecheck.sh` all green.
- [ ] **Real-run spot check** (`npm run dev`, a vision-capable agent, research enabled): confirm (1) `visual.md` reads as seen-it (concrete per-image observations); (2) the synthesis directions reflect the brief's actual need (a 3D brief → visual-forward direction; a restrained brief → no manufactured spectacle); (3) the build brief lists `.research/visual/assets/*` paths that actually exist and the build agent opens them; (4) a 3D brief now drives a visual-forward build (e.g. installs three.js when the direction earns it). Cannot be exercised headless.

## Self-review notes

- **Spec coverage:** §Synthesis step → Task 3 (+ the prompt in Task 1). §Product prompt stops directions → Task 1. §Visual track opens+studies each image → Task 1. §Build brief `.research` path fix + force-open → Task 2. §Idempotency (skip when directions exist) → Task 3 (early-return + guard). §Runs on whatever reports exist → Task 3 (`product.produced || visual.produced`) + the synthesis prompt's "if one report is missing" line. All covered.
- **Placeholder scan:** every code step is concrete. The one "confirm it's imported" notes (join/basename/readdirSync/MAX_ATTEMPTS) name the exact symbol to check — not placeholders for logic.
- **Type consistency:** `buildSynthesisPrompt(input: ResearchInput)` — same input type as `buildResearchPrompt` (Task 1), consumed in Task 3. `directionsExist(projectDir): boolean` — defined in Task 2, consumed in Task 3. `MAX_ATTEMPTS` reused for tracks + synthesis. Synthesis prompt starts with `# Phase: Synthesis` (Task 1) — the daemon test (Task 3) detects it by that marker.
