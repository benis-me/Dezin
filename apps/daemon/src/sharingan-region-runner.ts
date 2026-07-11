import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  extractAskUserQuestion,
  extractFinalSummary,
  isAbortError,
  runTurnWithRetry,
  type AgentRunner,
} from "../../../packages/agent/src/index.ts";

const execFileAsync = promisify(execFile);

export interface SharinganRegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SharinganSourceRegion {
  id?: unknown;
  label?: unknown;
  bbox?: unknown;
  counts?: unknown;
  texts?: unknown;
  assets?: unknown;
  textRuns?: unknown;
  media?: unknown;
  paintBoxes?: unknown;
  vectors?: unknown;
  styleTokens?: unknown;
  refs?: unknown;
}

export interface SharinganRegionPlan {
  version?: unknown;
  sourceUrl?: unknown;
  viewport?: unknown;
  document?: unknown;
  regions?: unknown;
}

export interface SharinganPreparedRegion {
  id: string;
  label: string;
  bbox: SharinganRegionBox | null;
  counts: unknown;
  texts: string[];
  assets: string[];
  textRuns: unknown[];
  media: unknown[];
  paintBoxes: unknown[];
  vectors: unknown[];
  styleTokens: unknown;
  refs: unknown[];
}

export interface SharinganRegionBuild {
  id: string;
  label: string;
  file: string;
  summary: string;
  attempts: number;
}

interface SharinganRegionFailure {
  id: string;
  label: string;
  attempts: number;
  error: string;
}

const SHARINGAN_REGION_MAX_ATTEMPTS = 2;

async function readSharinganRegionPlan(root: string): Promise<SharinganRegionPlan | null> {
  const text = await readFile(join(root, ".sharingan", "region-plan.json"), "utf8").catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as SharinganRegionPlan;
  } catch {
    return null;
  }
}

async function ensureSharinganRegionPlan(root: string): Promise<SharinganRegionPlan | null> {
  const existing = await readSharinganRegionPlan(root);
  if (Array.isArray(existing?.regions) && existing.regions.length) return existing;

  const probe = join(root, ".sharingan", "probe.mjs");
  if (!existsSync(probe)) return existing;
  await execFileAsync(process.execPath, [probe, "source-scaffold"], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 10_000_000,
  }).catch(() => null);
  return readSharinganRegionPlan(root);
}

function safeSharinganRegionId(value: unknown, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || fallback;
}

function sharinganRegionBox(value: unknown): SharinganRegionBox | null {
  if (!value || typeof value !== "object") return null;
  const box = value as Record<string, unknown>;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function sharinganStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function sharinganUnknownList(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

export function sharinganRegionsForSubagents(plan: SharinganRegionPlan, maxRegions = 8): SharinganPreparedRegion[] {
  const rawRegions = Array.isArray(plan.regions) ? (plan.regions as SharinganSourceRegion[]) : [];
  const used = new Set<string>();
  const out: SharinganPreparedRegion[] = [];
  for (const raw of rawRegions) {
    if (!raw || typeof raw !== "object") continue;
    const fallback = `region-${out.length + 1}`;
    let id = safeSharinganRegionId(raw.id, fallback);
    if (used.has(id)) id = `${id}-${out.length + 1}`;
    used.add(id);
    const texts = sharinganStringList(raw.texts, 18);
    const assets = sharinganStringList(raw.assets, 14);
    const refs = Array.isArray(raw.refs) ? raw.refs.slice(0, 24) : [];
    out.push({
      id,
      label: String(raw.label || texts[0] || fallback).trim().slice(0, 80),
      bbox: sharinganRegionBox(raw.bbox),
      counts: raw.counts ?? {},
      texts,
      assets,
      textRuns: sharinganUnknownList(raw.textRuns, 24),
      media: sharinganUnknownList(raw.media, 18),
      paintBoxes: sharinganUnknownList(raw.paintBoxes, 18),
      vectors: sharinganUnknownList(raw.vectors, 18),
      styleTokens: raw.styleTokens ?? {},
      refs,
    });
    if (out.length >= maxRegions) break;
  }
  return out;
}

function sharinganRegionSubagentPrompt(region: SharinganPreparedRegion, index: number, total: number): string {
  return [
    "# SHARINGAN REGION SUBAGENT",
    `Region ID: ${region.id}`,
    `Region label: ${region.label}`,
    `Region order: ${index + 1}/${total}`,
    "",
    "You are an isolated implementation subagent for one measured source region. Build only this region as normal Standard React source.",
    `Write \`src/sharingan-regions/${region.id}.jsx\` for this region. You may also create a sibling CSS file if needed.`,
    "Do not edit `src/App.jsx`, `src/index.css`, package files, git metadata, `.sharingan/source-scaffold/*`, or any other region file.",
    "Use only the measured text, assets, bbox, counts, and refs below. Do not invent extra copy, UI states, icons, controls, metrics, sections, animations, placeholders, or decorative effects.",
    "If an asset listed below is required, reference the captured local `/_assets/...` path directly. If a visible asset is missing, render a same-size neutral box rather than using external stock or generated media.",
    "Use `textRuns` for exact visible copy, font size, weight, color, line height, line count, and alignment. Do not substitute copy or let text resize its container.",
    "Use `media` and `paintBoxes` as measured slots. Preserve their relative position within this region's bbox and keep icon/text alignment from the captured boxes.",
    "Keep layout dimensions explicit and stable so the main integrator can compose regions without text overflow, accidental wrapping, clipping, or alignment drift.",
    "Do not ask a question. Edit the region file, then stop.",
    "",
    "Region spec JSON:",
    JSON.stringify(region, null, 2),
  ].join("\n");
}

function sharinganRegionSystemPrompt(): string {
  return [
    "# Sharingan Region Subagent",
    "",
    "You are running in Sharingan mode as an isolated child implementation task.",
    "This is not a design-generation task and not a normal Standard project task.",
    "The Region spec JSON in the user message is the authoritative source for this turn.",
    "",
    "Rules:",
    "- Produce one source-derived region component only.",
    "- Do not run source-summary, source-scaffold, outline, render-map, grep, find, tree, or raw `.sharingan` inspection.",
    "- Do not edit the main app or other regions.",
    "- Do not invent content, structure, images, icons, interactions, animations, or completion states.",
    "- Match the provided measured textRuns, media boxes, paintBoxes, bbox, styleTokens, and captured `/_assets/` references.",
  ].join("\n");
}

export function appendSharinganRegionIntegrationContext(message: string, builds: SharinganRegionBuild[]): string {
  if (!builds.length) return message;
  const lines = builds.map((build, index) => {
    const retry = build.attempts > 1 ? ` after ${build.attempts} attempts` : "";
    const summary = build.summary ? ` — ${build.summary.replace(/\s+/g, " ").slice(0, 180)}` : "";
    return `${index + 1}. ${build.file} (${build.label})${retry}${summary}`;
  });
  return [
    message,
    "",
    "## SHARINGAN MAIN INTEGRATION",
    "Region subagents have already converted measured source regions into isolated files. Integrate these files into the real Standard app instead of replaying `.sharingan/source-scaffold` or replacing them with a guessed generic layout.",
    "Use the files below as source-derived building blocks. Compose them in captured page order, wire shared CSS in `src/index.css` if needed, and run the project build. Do not add missing sections, fake interactions, synthetic icons, external images, or invented text.",
    "",
    ...lines,
  ].join("\n");
}

export function sharinganMainIntegrationRetryPrompt(builds: SharinganRegionBuild[]): string {
  const lines = builds.map((build, index) => `${index + 1}. ${build.file} (${build.label})`);
  return [
    "# SHARINGAN MAIN INTEGRATION RETRY",
    "",
    "The previous main integration turn made no project-file changes after the source-region subagents completed. That is incomplete.",
    "Do not analyze the capture again. Do not say it is done. Edit the real Standard app now.",
    "",
    "Required edits:",
    "- Compose the generated region components into `src/App.jsx` in source page order.",
    "- Add or adjust shared CSS in `src/index.css` only as needed for stable layout.",
    "- Keep source fidelity: no invented sections, fake content, extra controls, stock images, or decorative redesign.",
    "- Run the project build after editing.",
    "",
    "Validated source-region files:",
    ...lines,
  ].join("\n");
}

async function copyIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await cp(from, to, { recursive: true, force: true });
}

export async function syncSharinganCaptureBundle(sourceRoot: string, targetRoot: string): Promise<void> {
  if (sourceRoot === targetRoot) return;
  // A selected variant's checked-in capture is authoritative. The project-root bundle is only a
  // legacy seed for a transaction that has no bundle of its own; never overlay divergent variants.
  if (existsSync(join(targetRoot, ".sharingan"))) return;
  await copyIfExists(join(sourceRoot, ".sharingan"), join(targetRoot, ".sharingan"));
  await rm(join(targetRoot, ".sharingan", "region-work"), { recursive: true, force: true });
  await rm(join(targetRoot, ".sharingan", "region-build.json"), { force: true });
  await mkdir(join(targetRoot, "public"), { recursive: true });
  await copyIfExists(join(sourceRoot, "public", "_assets"), join(targetRoot, "public", "_assets"));
}

async function prepareSharinganRegionWorkspace(root: string, runId: string, region: SharinganPreparedRegion, attempt: number): Promise<string> {
  const workspace = join(root, ".sharingan", "region-work", runId, `${region.id}-attempt-${attempt}`);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await Promise.all([
    copyIfExists(join(root, "package.json"), join(workspace, "package.json")),
    copyIfExists(join(root, "index.html"), join(workspace, "index.html")),
    copyIfExists(join(root, "vite.config.js"), join(workspace, "vite.config.js")),
    copyIfExists(join(root, "tsconfig.json"), join(workspace, "tsconfig.json")),
    copyIfExists(join(root, "tsconfig.app.json"), join(workspace, "tsconfig.app.json")),
    copyIfExists(join(root, "src"), join(workspace, "src")),
    copyIfExists(join(root, "public"), join(workspace, "public")),
  ]);
  await rm(join(workspace, "src", "sharingan-regions"), { recursive: true, force: true });
  await mkdir(join(workspace, "src", "sharingan-regions"), { recursive: true });
  return workspace;
}

async function validateAndCopySharinganRegionOutput(root: string, workspace: string, region: SharinganPreparedRegion): Promise<string> {
  const outputRel = join("src", "sharingan-regions", `${region.id}.jsx`);
  const outputPath = join(workspace, outputRel);
  const text = await readFile(outputPath, "utf8").catch(() => "");
  if (!text.trim()) throw new Error(`missing ${outputRel}`);
  if (!/\bexport\s+default\b/.test(text)) throw new Error(`${outputRel} must export a default React component`);

  const targetDir = join(root, "src", "sharingan-regions");
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(root, outputRel), text, "utf8");
  for (const cssName of [`${region.id}.css`, `${region.id}.module.css`]) {
    const cssPath = join(workspace, "src", "sharingan-regions", cssName);
    if (existsSync(cssPath)) await cp(cssPath, join(targetDir, cssName), { force: true });
  }
  return `src/sharingan-regions/${region.id}.jsx`;
}

async function runSharinganRegionWithRetry(
  params: {
    runner: AgentRunner;
    projectDir: string;
    runId: string;
    signal: AbortSignal;
    env: NodeJS.ProcessEnv;
    onActivity: (activity: unknown, region: SharinganPreparedRegion) => void;
    emit: (event: unknown) => void;
  },
  region: SharinganPreparedRegion,
  index: number,
  total: number,
): Promise<{ ok: true; build: SharinganRegionBuild } | { ok: false; failure: SharinganRegionFailure }> {
  let lastError = "";
  for (let attempt = 1; attempt <= SHARINGAN_REGION_MAX_ATTEMPTS; attempt += 1) {
    let workspace = "";
    try {
      workspace = await prepareSharinganRegionWorkspace(params.projectDir, params.runId, region, attempt);
      params.emit({ type: "sharingan-region-start", runId: params.runId, regionId: region.id, label: region.label, index, total, attempt, maxAttempts: SHARINGAN_REGION_MAX_ATTEMPTS });
      const result = await runTurnWithRetry(params.runner, {
        systemPrompt: sharinganRegionSystemPrompt(),
        message: sharinganRegionSubagentPrompt(region, index, total),
        projectDir: workspace,
        history: [],
        isRepair: attempt > 1,
        onActivity: (activity) => params.onActivity(activity, region),
        signal: params.signal,
        env: params.env,
      });
      const file = await validateAndCopySharinganRegionOutput(params.projectDir, workspace, region);
      const asked = extractAskUserQuestion(result.text);
      const final = extractFinalSummary(asked.text);
      const summary = (final.summaryText || asked.text || result.text || "").trim();
      const build = { id: region.id, label: region.label, file, summary, attempts: attempt };
      params.emit({ type: "sharingan-region-done", runId: params.runId, regionId: region.id, label: region.label, index, total, attempt, file, summary });
      return { ok: true, build };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err instanceof Error ? err.message : "region subagent failed";
      if (attempt < SHARINGAN_REGION_MAX_ATTEMPTS) {
        params.emit({ type: "sharingan-region-retry", runId: params.runId, regionId: region.id, label: region.label, index, total, attempt, nextAttempt: attempt + 1, error: lastError });
      } else {
        params.emit({ type: "sharingan-region-failed", runId: params.runId, regionId: region.id, label: region.label, index, total, attempts: attempt, error: lastError });
      }
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ok: false, failure: { id: region.id, label: region.label, attempts: SHARINGAN_REGION_MAX_ATTEMPTS, error: lastError || "region subagent failed" } };
}

function sharinganRegionFailureMessage(failures: SharinganRegionFailure[]): string {
  return failures.map((failure) => `${failure.id} (${failure.label}) after ${failure.attempts} attempts: ${failure.error}`).join("; ");
}

async function writeSharinganRegionBuildManifest(root: string, builds: SharinganRegionBuild[], failures: SharinganRegionFailure[]): Promise<void> {
  await mkdir(join(root, ".sharingan"), { recursive: true });
  await writeFile(
    join(root, ".sharingan", "region-build.json"),
    JSON.stringify({ version: 1, builtAt: new Date().toISOString(), regions: builds, failures }, null, 2),
    "utf8",
  );
}

async function cleanupSharinganRegionWorkspaces(root: string, runId: string): Promise<void> {
  await rm(join(root, ".sharingan", "region-work", runId), { recursive: true, force: true }).catch(() => {});
}

export async function runSharinganRegionSubagents(params: {
  runner: AgentRunner;
  projectDir: string;
  runId: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  onActivity: (activity: unknown, region: SharinganPreparedRegion) => void;
  emit: (event: unknown) => void;
}): Promise<SharinganRegionBuild[]> {
  const plan = await ensureSharinganRegionPlan(params.projectDir);
  const regions = plan ? sharinganRegionsForSubagents(plan) : [];
  if (!regions.length) return [];

  await mkdir(join(params.projectDir, "src", "sharingan-regions"), { recursive: true });
  try {
    const settled = await Promise.allSettled(regions.map((region, index) => runSharinganRegionWithRetry(params, region, index, regions.length)));
    const builds: SharinganRegionBuild[] = [];
    const failures: SharinganRegionFailure[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        if (result.value.ok) builds.push(result.value.build);
        else failures.push(result.value.failure);
        continue;
      }
      if (isAbortError(result.reason)) throw result.reason;
      failures.push({
        id: regions[index]?.id ?? `region-${index + 1}`,
        label: regions[index]?.label ?? `Region ${index + 1}`,
        attempts: SHARINGAN_REGION_MAX_ATTEMPTS,
        error: result.reason instanceof Error ? result.reason.message : "region subagent failed",
      });
    }
    const sourceOrder = new Map(regions.map((region, index) => [region.id, index]));
    builds.sort((a, b) => (sourceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    failures.sort((a, b) => (sourceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    await writeSharinganRegionBuildManifest(params.projectDir, builds, failures);
    if (failures.length) throw new Error(`Sharingan region subagents failed: ${sharinganRegionFailureMessage(failures)}`);
    return builds;
  } finally {
    await cleanupSharinganRegionWorkspaces(params.projectDir, params.runId);
  }
}
