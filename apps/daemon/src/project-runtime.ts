/**
 * Standard-mode project runtime. A standard project is a real Vite + React + GSAP
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

export function templateDir(name = "react-vite-gsap"): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content", "templates", name);
}

export type SetupPhase = "scaffolding" | "installing" | "ready" | "error";
export interface RuntimeLog {
  at: number;
  level: "info" | "error";
  message: string;
}

interface Runtime {
  phase: SetupPhase;
  error?: string;
  logs: RuntimeLog[];
  dev?: { proc: ChildProcess; port: number; url: string; projectDir: string; fingerprint: string; releaseTimer?: ReturnType<typeof setTimeout> };
}

const runtimes = new Map<string, Runtime>();
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
    appendLog(rt ?? { phase: "ready", logs: [] }, `$ ${label}`);
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: agentSpawnEnv() });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => rt && appendLog(rt, data, "info"));
    child.stderr?.on("data", (data: string) => rt && appendLog(rt, data, "error"));
    child.on("error", (err) => {
      if (rt) appendLog(rt, err.message, "error");
      resolve(1);
    });
    child.on("close", (code) => {
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
export async function setupStandardProject(projectId: string, projectDir: string): Promise<void> {
  const rt: Runtime = { phase: "scaffolding", logs: [] };
  runtimes.set(projectId, rt);
  try {
    appendLog(rt, "Scaffolding standard project");
    await mkdir(projectDir, { recursive: true });
    await cp(templateDir(), projectDir, { recursive: true });
    await run("git", ["init", "-q"], projectDir, rt, "git init");
    await gitCommit(projectDir, "Dezin: scaffold Vite + React + GSAP");

    rt.phase = "installing";
    appendLog(rt, "Installing dependencies");
    const code = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], projectDir, rt, "npm install");
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    rt.phase = code === 0 ? "ready" : "error";
    appendLog(rt, rt.phase === "ready" ? "Standard project is ready" : "Standard project setup failed", rt.phase === "ready" ? "info" : "error");
    if (code !== 0) rt.error = "npm install failed";
  } catch (err) {
    rt.phase = "error";
    rt.error = err instanceof Error ? err.message : "setup failed";
    appendLog(rt, rt.error, "error");
  }
}

/** Prepare an imported Standard project without copying the template over its source. */
export async function setupImportedStandardProject(projectId: string, projectDir: string): Promise<void> {
  const rt: Runtime = { phase: "installing", logs: [] };
  runtimes.set(projectId, rt);
  try {
    appendLog(rt, "Preparing imported standard project");
    await mkdir(projectDir, { recursive: true });
    if (!existsSync(join(projectDir, ".git"))) await run("git", ["init", "-q"], projectDir, rt, "git init");
    await gitCommit(projectDir, "Dezin: import project");
    const code = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], projectDir, rt, "npm install --ignore-scripts");
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    rt.phase = code === 0 ? "ready" : "error";
    appendLog(rt, rt.phase === "ready" ? "Imported standard project is ready" : "Imported standard project setup failed", rt.phase === "ready" ? "info" : "error");
    if (code !== 0) rt.error = "npm install failed";
  } catch (err) {
    rt.phase = "error";
    rt.error = err instanceof Error ? err.message : "setup failed";
    appendLog(rt, rt.error, "error");
  }
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

async function ensurePreviewDependencies(projectDir: string, rt: Runtime): Promise<void> {
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
export async function ensureDevServer(projectId: string, projectDir: string, runtimeKey = projectId): Promise<{ url: string }> {
  let rt = runtimes.get(runtimeKey);
  if (!rt) {
    rt = { phase: existsSync(join(projectDir, "node_modules")) ? "ready" : "installing", logs: [] };
    runtimes.set(runtimeKey, rt);
  }
  const statusBeforeBridgeUpdate = existsSync(join(projectDir, ".git")) ? await workingTreeFingerprint(projectDir) : "";
  const bridgeUpdated = await ensureProjectPickerBridge(projectDir).catch(() => false);
  if (bridgeUpdated) {
    appendLog(rt, "Updated preview inspect bridge");
    if (!statusBeforeBridgeUpdate) await gitCommit(projectDir, "Dezin: update preview inspect bridge");
    if (rt.dev && !rt.dev.proc.killed) {
      stopDev(rt.dev);
      rt.dev = undefined;
    }
  }
  await ensurePreviewDependencies(projectDir, rt);
  const currentFingerprint = await devServerFingerprint(projectDir);
  if (rt.dev && !rt.dev.proc.killed) {
    if (rt.dev.projectDir !== projectDir || rt.dev.fingerprint !== currentFingerprint) {
      appendLog(rt, "Restarting dev server for updated project files");
      stopDev(rt.dev);
      rt.dev = undefined;
    } else if (await portResponds(rt.dev.port)) {
      clearDevReleaseTimer(rt.dev);
      return { url: rt.dev.url };
    }
    if (rt.dev) {
      stopDev(rt.dev);
      rt.dev = undefined;
    }
  }

  const port = await freePort();
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
    if (await portResponds(port)) return { url };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url }; // return anyway; the iframe will retry
}

/** Mark one dev server as no longer used; it is stopped after a short idle grace period. */
export function releaseDevServer(runtimeKey: string, idleMs = DEV_SERVER_IDLE_MS): boolean {
  const rt = runtimes.get(runtimeKey);
  const dev = rt?.dev;
  if (!rt || !dev || dev.proc.killed) return false;
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

/** Stop all dev servers (called on daemon shutdown). */
export function stopAllDevServers(): void {
  for (const rt of runtimes.values()) {
    stopDev(rt.dev);
    rt.dev = undefined;
  }
}
