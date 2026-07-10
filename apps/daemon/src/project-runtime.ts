/**
 * Standard-mode project runtime. A standard project is a real Vite + React
 * app scaffolded from a template: copy the template, `git init`, `npm install`, and
 * (on demand) run a Vite dev server we can preview. This module owns that lifecycle.
 */

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";

export function templateDir(name = "react-vite"): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "templates", name);
}

export type SetupPhase = "scaffolding" | "installing" | "ready" | "error";
export interface RuntimeLog {
  at: number;
  level: "info" | "error";
  message: string;
}

interface Runtime {
  runtimeKey: string;
  generation: number;
  released: boolean;
  phase: SetupPhase;
  error?: string;
  logs: RuntimeLog[];
  children: Set<ChildProcess>;
  operation?: Promise<void>;
  stopPromise?: Promise<void>;
  dev?: { proc: ChildProcess; port: number; url: string; projectDir: string; fingerprint: string; releaseTimer?: ReturnType<typeof setTimeout> };
}

const runtimes = new Map<string, Runtime>();
const retiredRuntimes = new Set<Runtime>();
let nextRuntimeGeneration = 1;
export const DEV_SERVER_IDLE_MS = 60_000;
const PICKER_BRIDGE_BLOCK = /const PICKER_BRIDGE = `[\s\S]*?<\/script>`;/;
const PICKER_BRIDGE_START = "const PICKER_BRIDGE = ";
const PICKER_PLUGIN_START = "\nfunction dezinPicker";

function clearDevReleaseTimer(dev: Runtime["dev"]): void {
  if (!dev?.releaseTimer) return;
  clearTimeout(dev.releaseTimer);
  dev.releaseTimer = undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeNodeTimer = timer as { unref?: () => void };
  if (typeof maybeNodeTimer.unref === "function") maybeNodeTimer.unref();
}

function stopDev(dev: Runtime["dev"]): void {
  if (!dev) return;
  clearDevReleaseTimer(dev);
  if (!dev.proc.killed) dev.proc.kill();
}

function waitForChildExit(child: ChildProcess, timeoutMs = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("close", finish);
      child.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
    child.once("error", finish);
  });
}

function stopRuntime(rt: Runtime): Promise<void> {
  rt.released = true;
  rt.stopPromise ??= (async () => {
    const children = new Set(rt.children);
    if (rt.dev?.proc) children.add(rt.dev.proc);
    const exits = [...children].map((child) => waitForChildExit(child));
    stopDev(rt.dev);
    rt.dev = undefined;
    for (const child of rt.children) {
      if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill();
    }
    rt.children.clear();
    await Promise.allSettled(exits);
  })();
  return rt.stopPromise;
}

function createRuntime(runtimeKey: string, phase: SetupPhase, signal?: AbortSignal): { rt: Runtime; detach: () => void } {
  const previous = runtimes.get(runtimeKey);
  if (previous) retireRuntime(previous);
  const rt: Runtime = {
    runtimeKey,
    generation: nextRuntimeGeneration++,
    released: false,
    phase,
    logs: [],
    children: new Set(),
  };
  runtimes.set(runtimeKey, rt);
  return { rt, detach: attachRuntimeSignal(rt, signal) };
}

function retireRuntime(rt: Runtime): void {
  retiredRuntimes.add(rt);
  void Promise.resolve().then(async () => {
    await Promise.allSettled([stopRuntime(rt), rt.operation ?? Promise.resolve()]);
    retiredRuntimes.delete(rt);
  });
}

function attachRuntimeSignal(rt: Runtime, signal?: AbortSignal): () => void {
  const onAbort = (): void => {
    void stopRuntime(rt);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return () => signal?.removeEventListener("abort", onAbort);
}

function assertRuntimeActive(runtimeKey: string, rt: Runtime, signal?: AbortSignal): void {
  if (rt.released || signal?.aborted || runtimes.get(runtimeKey) !== rt) {
    const error = new Error("runtime released");
    error.name = "AbortError";
    throw error;
  }
}

export async function ensureProjectPickerBridge(projectDir: string): Promise<boolean> {
  const viteConfig = join(projectDir, "vite.config.js");
  if (!existsSync(viteConfig)) return false;
  const [current, template] = await Promise.all([readFile(viteConfig, "utf8"), readFile(join(templateDir(), "vite.config.js"), "utf8")]);
  const start = current.indexOf(PICKER_BRIDGE_START);
  const pluginStart = start >= 0 ? current.indexOf(PICKER_PLUGIN_START, start) : -1;
  const currentBlock = current.match(PICKER_BRIDGE_BLOCK);
  const isWideRange = start >= 0 && pluginStart > start;
  const range = isWideRange
    ? { start, end: pluginStart }
    : currentBlock
      ? { start: currentBlock.index ?? -1, end: (currentBlock.index ?? -1) + currentBlock[0].length }
      : undefined;
  if (!range || range.start < 0) return false;
  // When the current file still has a `function dezinPicker` anchor, restore everything
  // between the bridge declaration and that anchor — picker bridge, runtime probe, and any
  // comments/blank lines between them — verbatim from the template, so a corrupted project
  // gets both scripts back, not just the picker (the template slice already carries its own
  // trailing newline, and `suffix` below starts with the plugin marker's leading newline, so
  // no extra separator is needed). Otherwise (minimal/legacy files with no plugin-function
  // anchor) fall back to replacing only the regex-matched PICKER_BRIDGE block.
  const templateStart = template.indexOf(PICKER_BRIDGE_START);
  const templatePluginStart = templateStart >= 0 ? template.indexOf(PICKER_PLUGIN_START, templateStart) : -1;
  const templateBlock =
    isWideRange && templateStart >= 0 && templatePluginStart > templateStart
      ? template.slice(templateStart, templatePluginStart)
      : template.match(PICKER_BRIDGE_BLOCK)?.[0];
  if (!templateBlock) return false;
  const suffix = current.slice(range.end);
  const updated = `${current.slice(0, range.start)}${templateBlock}${suffix.startsWith("\n") ? "" : "\n"}${suffix}`;
  if (updated === current) return false;
  await writeFile(viteConfig, updated);
  return true;
}

function appendLog(rt: Runtime, message: string, level: RuntimeLog["level"] = "info"): void {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) rt.logs.push({ at: Date.now(), level, message: line });
  if (rt.logs.length > 80) rt.logs.splice(0, rt.logs.length - 80);
}

function run(command: string, args: string[], cwd: string, rt?: Runtime, label = `${command} ${args.join(" ")}`): Promise<number> {
  return new Promise((resolve) => {
    appendLog(rt ?? { runtimeKey: "", generation: 0, released: false, phase: "ready", logs: [], children: new Set() }, `$ ${label}`);
    if (rt?.released) return resolve(1);
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    rt?.children.add(child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => rt && appendLog(rt, data, "info"));
    child.stderr?.on("data", (data: string) => rt && appendLog(rt, data, "error"));
    child.on("error", (err) => {
      rt?.children.delete(child);
      if (rt) appendLog(rt, err.message, "error");
      resolve(1);
    });
    child.on("close", (code) => {
      rt?.children.delete(child);
      if (rt) appendLog(rt, `${label} exited ${code ?? 1}`, code === 0 ? "info" : "error");
      resolve(code ?? 1);
    });
  });
}

function capture(command: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (out += d));
    child.on("error", (err) => resolve({ code: 1, out: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const GIT_IDENTITY = ["-c", "user.name=Dezin", "-c", "user.email=dezin@local"];

/** Copy the template, git init + initial commit, then npm install (the slow part). */
export async function setupStandardProject(projectId: string, projectDir: string, signal?: AbortSignal): Promise<void> {
  const { rt, detach } = createRuntime(projectId, "scaffolding", signal);
  const operation = (async () => {
    try {
    assertRuntimeActive(projectId, rt, signal);
    appendLog(rt, "Scaffolding standard project");
    await mkdir(projectDir, { recursive: true });
    assertRuntimeActive(projectId, rt, signal);
    await cp(templateDir(), projectDir, { recursive: true });
    assertRuntimeActive(projectId, rt, signal);
    await run("git", ["init", "-q"], projectDir, rt, "git init");
    assertRuntimeActive(projectId, rt, signal);
    await gitCommit(projectDir, "Dezin: scaffold Vite + React");
    assertRuntimeActive(projectId, rt, signal);

    rt.phase = "installing";
    appendLog(rt, "Installing dependencies");
    const code = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], projectDir, rt, "npm install");
    assertRuntimeActive(projectId, rt, signal);
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    assertRuntimeActive(projectId, rt, signal);
    rt.phase = code === 0 ? "ready" : "error";
    appendLog(rt, rt.phase === "ready" ? "Standard project is ready" : "Standard project setup failed", rt.phase === "ready" ? "info" : "error");
    if (code !== 0) rt.error = "npm install failed";
    } catch (err) {
      if (!rt.released && !signal?.aborted && runtimes.get(projectId) === rt) {
        rt.phase = "error";
        rt.error = err instanceof Error ? err.message : "setup failed";
        appendLog(rt, rt.error, "error");
      }
    } finally {
      detach();
    }
  })();
  rt.operation = operation;
  await operation;
}

/** Prepare an imported Standard project without copying the template over its source. */
export async function setupImportedStandardProject(projectId: string, projectDir: string, signal?: AbortSignal): Promise<void> {
  const { rt, detach } = createRuntime(projectId, "installing", signal);
  const operation = (async () => {
    try {
    assertRuntimeActive(projectId, rt, signal);
    appendLog(rt, "Preparing imported standard project");
    await mkdir(projectDir, { recursive: true });
    assertRuntimeActive(projectId, rt, signal);
    if (!existsSync(join(projectDir, ".git"))) await run("git", ["init", "-q"], projectDir, rt, "git init");
    assertRuntimeActive(projectId, rt, signal);
    await gitCommit(projectDir, "Dezin: import project");
    assertRuntimeActive(projectId, rt, signal);
    const code = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], projectDir, rt, "npm install --ignore-scripts");
    assertRuntimeActive(projectId, rt, signal);
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    assertRuntimeActive(projectId, rt, signal);
    rt.phase = code === 0 ? "ready" : "error";
    appendLog(rt, rt.phase === "ready" ? "Imported standard project is ready" : "Imported standard project setup failed", rt.phase === "ready" ? "info" : "error");
    if (code !== 0) rt.error = "npm install failed";
    } catch (err) {
      if (!rt.released && !signal?.aborted && runtimes.get(projectId) === rt) {
        rt.phase = "error";
        rt.error = err instanceof Error ? err.message : "setup failed";
        appendLog(rt, rt.error, "error");
      }
    } finally {
      detach();
    }
  })();
  rt.operation = operation;
  await operation;
}

export function getSetup(projectId: string, projectDir: string): { phase: SetupPhase; error?: string; logs: RuntimeLog[] } {
  const rt = runtimes.get(projectId);
  const relatedLogs = [...runtimes.entries()]
    .filter(([key]) => key === projectId || key.startsWith(`${projectId}:`))
    .flatMap(([, runtime]) => runtime.logs)
    .sort((a, b) => a.at - b.at)
    .slice(-30);
  if (rt) return { phase: rt.phase, error: rt.error, logs: relatedLogs };
  // Not tracked this process: infer from disk (e.g. after a daemon restart).
  if (existsSync(join(projectDir, "node_modules"))) return { phase: "ready", logs: relatedLogs };
  if (existsSync(join(projectDir, "package.json"))) return { phase: "installing", logs: relatedLogs };
  return { phase: "scaffolding", logs: relatedLogs };
}

async function ensurePreviewDependencies(projectDir: string, runtimeKey: string, rt: Runtime, signal?: AbortSignal): Promise<void> {
  assertRuntimeActive(runtimeKey, rt, signal);
  if (existsSync(join(projectDir, "node_modules"))) {
    rt.phase = "ready";
    rt.error = undefined;
    return;
  }
  if (!existsSync(join(projectDir, "package.json"))) throw new Error("dependencies not installed yet");

  rt.phase = "installing";
  rt.error = undefined;
  appendLog(rt, "Installing preview dependencies");
  const code = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], projectDir, rt, "npm install --ignore-scripts");
  assertRuntimeActive(runtimeKey, rt, signal);
  if (code !== 0) {
    rt.phase = "error";
    rt.error = "npm install failed";
    throw new Error(rt.error);
  }
  rt.phase = "ready";
  appendLog(rt, "Preview dependencies are ready");
}

async function portResponds(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return res.ok || res.status === 200 || res.status === 404;
  } catch {
    return false;
  }
}

/** Grab a free TCP port from the OS (avoids clashing with orphaned dev servers). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Ensure a Vite dev server is running for the project; return its URL. The iframe
 * loads this URL directly (cross-origin) with allow-same-origin, so JSX is
 * transpiled and there is no CORS — no daemon proxy in the path.
 */
export async function ensureDevServer(projectId: string, projectDir: string, runtimeKey = projectId, signal?: AbortSignal): Promise<{ url: string }> {
  let rt = runtimes.get(runtimeKey);
  let detach = (): void => {};
  if (!rt) {
    const created = createRuntime(runtimeKey, existsSync(join(projectDir, "node_modules")) ? "ready" : "installing", signal);
    rt = created.rt;
    detach = created.detach;
  } else {
    detach = attachRuntimeSignal(rt, signal);
  }
  try {
  assertRuntimeActive(runtimeKey, rt, signal);
  const statusBeforeBridgeUpdate = existsSync(join(projectDir, ".git")) ? await workingTreeFingerprint(projectDir) : "";
  assertRuntimeActive(runtimeKey, rt, signal);
  const bridgeUpdated = await ensureProjectPickerBridge(projectDir).catch(() => false);
  assertRuntimeActive(runtimeKey, rt, signal);
  if (bridgeUpdated) {
    appendLog(rt, "Updated preview inspect bridge");
    if (!statusBeforeBridgeUpdate) await gitCommit(projectDir, "Dezin: update preview inspect bridge");
    if (rt.dev && !rt.dev.proc.killed) {
      stopDev(rt.dev);
      rt.dev = undefined;
    }
  }
  await ensurePreviewDependencies(projectDir, runtimeKey, rt, signal);
  const currentFingerprint = await devServerFingerprint(projectDir);
  assertRuntimeActive(runtimeKey, rt, signal);
  if (rt.dev && !rt.dev.proc.killed) {
    if (rt.dev.projectDir !== projectDir || rt.dev.fingerprint !== currentFingerprint) {
      appendLog(rt, "Restarting dev server for updated project files");
      stopDev(rt.dev);
      rt.dev = undefined;
    } else if (await portResponds(rt.dev.port)) {
      assertRuntimeActive(runtimeKey, rt, signal);
      clearDevReleaseTimer(rt.dev);
      return { url: rt.dev.url };
    }
    if (rt.dev) {
      stopDev(rt.dev);
      rt.dev = undefined;
    }
  }

  const port = await freePort();
  assertRuntimeActive(runtimeKey, rt, signal);
  appendLog(rt, `Starting dev server on ${port}`);
  const proc = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: agentSpawnEnv(),
    detached: false,
  });
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (data: string) => appendLog(rt!, data, "info"));
  proc.stderr?.on("data", (data: string) => appendLog(rt!, data, "error"));
  proc.on("close", () => {
    appendLog(rt!, "Dev server stopped");
    if (rt!.dev?.proc === proc) {
      clearDevReleaseTimer(rt!.dev);
      rt!.dev = undefined;
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  rt.dev = { proc, port, url, projectDir, fingerprint: currentFingerprint };

  // Wait for Vite to come up (up to ~15s).
  for (let i = 0; i < 30; i++) {
    assertRuntimeActive(runtimeKey, rt, signal);
    if (await portResponds(port)) return { url };
    await new Promise((r) => setTimeout(r, 500));
  }
  assertRuntimeActive(runtimeKey, rt, signal);
  return { url }; // return anyway; the iframe will retry
  } finally {
    detach();
  }
}

/** Mark one dev server as no longer used; it is stopped after a short idle grace period. */
export function releaseDevServer(runtimeKey: string, idleMs = DEV_SERVER_IDLE_MS): boolean {
  const rt = runtimes.get(runtimeKey);
  const dev = rt?.dev;
  if (!rt || rt.released || !dev || dev.proc.killed) return false;
  clearDevReleaseTimer(dev);
  dev.releaseTimer = setTimeout(() => {
    if (rt.dev !== dev) return;
    stopDev(dev);
    if (rt.dev === dev) rt.dev = undefined;
  }, idleMs);
  unrefTimer(dev.releaseTimer);
  return true;
}

export async function workingTreeFingerprint(projectDir: string): Promise<string> {
  if (!existsSync(join(projectDir, ".git"))) return "__no_git__";
  const res = await capture("git", ["status", "--porcelain=v1"], projectDir);
  return res.code === 0 ? res.out.trim() : `__git_status_failed__:${res.out.trim()}`;
}

async function devServerFingerprint(projectDir: string): Promise<string> {
  if (!existsSync(join(projectDir, ".git"))) return `__no_git__:${projectDir}`;
  const head = await capture("git", ["rev-parse", "HEAD"], projectDir);
  const status = await workingTreeFingerprint(projectDir);
  const headText = head.code === 0 ? head.out.trim() : `__git_head_failed__:${head.out.trim()}`;
  return `${headText}\n${status}`;
}

/** Commit the project's current state as a version. */
export async function gitCommit(projectDir: string, message: string): Promise<{ changed: boolean; committed: boolean; commitHash: string | null }> {
  if (!existsSync(join(projectDir, ".git"))) return { changed: false, committed: false, commitHash: null };
  await run("git", ["add", "-A"], projectDir);
  const status = await workingTreeFingerprint(projectDir);
  if (!status) return { changed: false, committed: false, commitHash: null };
  const code = await run("git", [...GIT_IDENTITY, "commit", "-q", "-m", message.replace(/\s+/g, " ").slice(0, 72) || "Dezin update"], projectDir);
  if (code !== 0) return { changed: true, committed: false, commitHash: null };
  const head = await capture("git", ["rev-parse", "HEAD"], projectDir);
  return { changed: true, committed: true, commitHash: head.code === 0 ? head.out.trim() : null };
}

/**
 * Discard the working tree's uncommitted changes back to HEAD. Called when a run is cancelled or
 * fails mid-turn so its half-written edits aren't silently bundled into the NEXT run's `git add -A`
 * commit (and don't corrupt the workingTreeFingerprint "changed?" check). Preserves Dezin's internal
 * dirs (.research/.versions/.refs/.sharingan) and .gitignore'd files (node_modules, dist). Keeping
 * .sharingan means a failed Sharingan build doesn't discard the (expensive) capture bundle, so a retry
 * can reuse it instead of re-capturing.
 */
export async function gitDiscardChanges(projectDir: string): Promise<void> {
  if (!existsSync(join(projectDir, ".git"))) return;
  await run("git", ["reset", "--hard", "HEAD"], projectDir);
  await run("git", ["clean", "-fd", "-e", ".research", "-e", ".versions", "-e", ".refs", "-e", ".sharingan"], projectDir);
}

/**
 * Restore the project files to a PAST commit's content and commit that as a NEW HEAD — history is
 * preserved (the intermediate commits stay reachable, so the version snapshots that point at them keep
 * working). Used to return the best-scoring repair round instead of a worse last round. Internal dirs
 * like .research are written once before the build (not per repair round), so restoring an earlier
 * round leaves them effectively unchanged. Returns { committed:false } (tree left as-is) if the target
 * commit can't be checked out.
 */
export async function gitRestoreTree(projectDir: string, commitHash: string, message: string): Promise<{ committed: boolean; commitHash: string | null }> {
  if (!existsSync(join(projectDir, ".git"))) return { committed: false, commitHash: null };
  // Restore every tracked file under . to the target commit's content (does NOT move HEAD).
  const code = await run("git", ["checkout", commitHash, "--", "."], projectDir);
  if (code !== 0) return { committed: false, commitHash: null };
  // `checkout -- .` restores/adds paths present in the target but does NOT delete files that were
  // ADDED after it — remove those so the restored tree matches the target exactly. --no-renames is
  // load-bearing: without it git classifies a later rename as R (not A), so --diff-filter=A would miss
  // the renamed-in file and leave it as a stray orphan in the "best" tree.
  const added = await capture("git", ["diff", "--no-renames", "--name-only", "--diff-filter=A", commitHash, "HEAD"], projectDir);
  if (added.code === 0) {
    for (const f of added.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      await run("git", ["rm", "-f", "--", f], projectDir);
    }
  }
  const res = await gitCommit(projectDir, message);
  return { committed: res.committed, commitHash: res.commitHash };
}

/** Stop and forget every runtime owned by one project, including setup children. */
export async function releaseProjectRuntime(projectId: string): Promise<void> {
  const entries = [...runtimes.entries()].filter(([key]) => key === projectId || key.startsWith(`${projectId}:`));
  const retired = [...retiredRuntimes].filter((rt) => rt.runtimeKey === projectId || rt.runtimeKey.startsWith(`${projectId}:`));
  const owned = [...new Set([...entries.map(([, rt]) => rt), ...retired])];
  for (const rt of owned) void stopRuntime(rt);
  await Promise.allSettled(owned.flatMap((rt) => [stopRuntime(rt), rt.operation ?? Promise.resolve()]));
  for (const rt of retired) retiredRuntimes.delete(rt);
  for (const [key, rt] of entries) {
    if (runtimes.get(key) === rt) runtimes.delete(key);
  }
}

/** Stop and forget one variant runtime plus version previews owned by its Runs. */
export async function releaseVariantRuntime(projectId: string, variantId: string, runIds: string[] = []): Promise<void> {
  const keys = new Set([`${projectId}:${variantId}`, ...runIds.map((runId) => `${projectId}:version:${runId}`)]);
  const entries = [...runtimes.entries()].filter(([key]) => keys.has(key));
  const retired = [...retiredRuntimes].filter((rt) => keys.has(rt.runtimeKey));
  const owned = [...new Set([...entries.map(([, rt]) => rt), ...retired])];
  for (const rt of owned) void stopRuntime(rt);
  await Promise.allSettled(owned.flatMap((rt) => [stopRuntime(rt), rt.operation ?? Promise.resolve()]));
  for (const rt of retired) retiredRuntimes.delete(rt);
  for (const [key, rt] of entries) {
    if (runtimes.get(key) === rt) runtimes.delete(key);
  }
}

/** Stop all runtime resources and await bounded child settlement. */
export async function stopAllProjectRuntimes(): Promise<void> {
  const entries = [...new Set([...runtimes.values(), ...retiredRuntimes])];
  for (const rt of entries) void stopRuntime(rt);
  await Promise.allSettled(entries.flatMap((rt) => [stopRuntime(rt), rt.operation ?? Promise.resolve()]));
  for (const [key, rt] of runtimes) {
    if (entries.includes(rt)) runtimes.delete(key);
  }
  retiredRuntimes.clear();
}

/** Stop all dev/setup resources synchronously enough for legacy teardown callers. */
export function stopAllDevServers(): void {
  for (const rt of new Set([...runtimes.values(), ...retiredRuntimes])) {
    void stopRuntime(rt);
  }
  runtimes.clear();
  retiredRuntimes.clear();
}
