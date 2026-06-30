/**
 * Standard-mode project runtime. A standard project is a real Vite + React + GSAP
 * app scaffolded from a template: copy the template, `git init`, `npm install`, and
 * (on demand) run a Vite dev server we can preview. This module owns that lifecycle.
 */

import { cp, mkdir } from "node:fs/promises";
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

interface Runtime {
  phase: SetupPhase;
  error?: string;
  dev?: { proc: ChildProcess; port: number; url: string; releaseTimer?: ReturnType<typeof setTimeout> };
}

const runtimes = new Map<string, Runtime>();
export const DEV_SERVER_IDLE_MS = 60_000;

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

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore", env: agentSpawnEnv() });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
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
  const rt: Runtime = { phase: "scaffolding" };
  runtimes.set(projectId, rt);
  try {
    await mkdir(projectDir, { recursive: true });
    await cp(templateDir(), projectDir, { recursive: true });
    await run("git", ["init", "-q"], projectDir);
    await gitCommit(projectDir, "Dezin: scaffold Vite + React + GSAP");

    rt.phase = "installing";
    const code = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], projectDir);
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    rt.phase = code === 0 ? "ready" : "error";
    if (code !== 0) rt.error = "npm install failed";
  } catch (err) {
    rt.phase = "error";
    rt.error = err instanceof Error ? err.message : "setup failed";
  }
}

/** Prepare an imported Standard project without copying the template over its source. */
export async function setupImportedStandardProject(projectId: string, projectDir: string): Promise<void> {
  const rt: Runtime = { phase: "installing" };
  runtimes.set(projectId, rt);
  try {
    await mkdir(projectDir, { recursive: true });
    if (!existsSync(join(projectDir, ".git"))) await run("git", ["init", "-q"], projectDir);
    await gitCommit(projectDir, "Dezin: import project");
    const code = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], projectDir);
    if (code === 0) await gitCommit(projectDir, "Dezin: install dependencies");
    rt.phase = code === 0 ? "ready" : "error";
    if (code !== 0) rt.error = "npm install failed";
  } catch (err) {
    rt.phase = "error";
    rt.error = err instanceof Error ? err.message : "setup failed";
  }
}

export function getSetup(projectId: string, projectDir: string): { phase: SetupPhase; error?: string } {
  const rt = runtimes.get(projectId);
  if (rt) return { phase: rt.phase, error: rt.error };
  // Not tracked this process: infer from disk (e.g. after a daemon restart).
  if (existsSync(join(projectDir, "node_modules"))) return { phase: "ready" };
  if (existsSync(join(projectDir, "package.json"))) return { phase: "installing" };
  return { phase: "scaffolding" };
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
    rt = { phase: existsSync(join(projectDir, "node_modules")) ? "ready" : "installing" };
    runtimes.set(runtimeKey, rt);
  }
  if (!existsSync(join(projectDir, "node_modules"))) throw new Error("dependencies not installed yet");
  if (rt.dev && !rt.dev.proc.killed) {
    clearDevReleaseTimer(rt.dev);
    return { url: rt.dev.url };
  }

  const port = await freePort();
  const proc = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: projectDir,
    stdio: "ignore",
    env: agentSpawnEnv(),
    detached: false,
  });
  proc.on("close", () => {
    if (rt!.dev?.proc === proc) {
      clearDevReleaseTimer(rt!.dev);
      rt!.dev = undefined;
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  rt.dev = { proc, port, url };

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

/** Commit the project's current state as a version. */
export async function gitCommit(projectDir: string, message: string): Promise<{ changed: boolean; committed: boolean }> {
  if (!existsSync(join(projectDir, ".git"))) return { changed: false, committed: false };
  await run("git", ["add", "-A"], projectDir);
  const status = await workingTreeFingerprint(projectDir);
  if (!status) return { changed: false, committed: false };
  const code = await run("git", [...GIT_IDENTITY, "commit", "-q", "-m", message.replace(/\s+/g, " ").slice(0, 72) || "Dezin update"], projectDir);
  return { changed: true, committed: code === 0 };
}

/** Stop all dev servers (called on daemon shutdown). */
export function stopAllDevServers(): void {
  for (const rt of runtimes.values()) {
    stopDev(rt.dev);
    rt.dev = undefined;
  }
}
