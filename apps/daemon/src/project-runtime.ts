/**
 * Standard-mode project runtime. A standard project is a real Vite + React
 * app scaffolded from a template: copy the template, `git init`, `npm install`, and
 * (on demand) run a Vite dev server we can preview. This module owns that lifecycle.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import {
  previewLeaseManager,
  type PreviewLease,
  type PreviewLeaseManager,
  type PreviewRuntimeIdentity,
} from "./preview-lease.ts";
import type { RuntimeScope } from "./runtime-supervisor.ts";

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
  historicalPreviewConfig?: { dir: string; path: string; projectDir: string };
  previewCallers: number;
  previewEntryCount: number;
  previewPreparation?: PreviewPreparation;
}

interface PreviewPreparationResult {
  configPath?: string;
  fingerprint: string;
}

interface PreviewPreparation {
  key: string;
  promise: Promise<PreviewPreparationResult>;
}

const DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;
const DEPENDENCY_STAMP = ".dezin-dependency-fingerprint";

async function dependencyManifestFingerprint(projectDir: string): Promise<string> {
  const hash = createHash("sha256");
  let found = false;
  for (const name of DEPENDENCY_MANIFESTS) {
    const bytes = await readFile(join(projectDir, name)).catch(() => null);
    if (!bytes) continue;
    found = true;
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  if (!found) throw new Error("dependencies not installed yet");
  return hash.digest("hex");
}

async function writeDependencyStamp(projectDir: string): Promise<void> {
  const nodeModules = join(projectDir, "node_modules");
  if (!existsSync(nodeModules)) return;
  await writeFile(join(nodeModules, DEPENDENCY_STAMP), `${await dependencyManifestFingerprint(projectDir)}\n`, "utf8");
}

const runtimes = new Map<string, Runtime>();
const retiredRuntimes = new Set<Runtime>();
let nextRuntimeGeneration = 1;
export const DEV_SERVER_IDLE_MS = 60_000;
const PICKER_BRIDGE_BLOCK = /const PICKER_BRIDGE = `[\s\S]*?<\/script>`;/;
const PICKER_BRIDGE_START = "const PICKER_BRIDGE = ";
const PICKER_PLUGIN_START = "\nfunction dezinPicker";
const PICKER_CONFIG_EXPORT_START = "\nexport default defineConfig";
const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
] as const;

function findViteConfig(projectDir: string): string | undefined {
  return VITE_CONFIG_FILES.map((name) => join(projectDir, name)).find(existsSync);
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
    const exits = [...children].map((child) => waitForChildExit(child));
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
    previewCallers: 0,
    previewEntryCount: 0,
  };
  runtimes.set(runtimeKey, rt);
  return { rt, detach: attachRuntimeSignal(rt, signal) };
}

function retireRuntime(rt: Runtime): void {
  retiredRuntimes.add(rt);
  void Promise.resolve().then(async () => {
    await Promise.allSettled([
      stopRuntime(rt),
      rt.operation ?? Promise.resolve(),
      rt.previewPreparation?.promise ?? Promise.resolve(),
    ]);
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

async function historicalPreviewConfig(projectDir: string, rt: Runtime): Promise<string | undefined> {
  const current = rt.historicalPreviewConfig;
  if (current?.projectDir === projectDir && existsSync(current.path)) return current.path;
  if (current) await rm(current.dir, { recursive: true, force: true });

  const viteConfig = findViteConfig(projectDir);
  const template = await readFile(join(templateDir(), "vite.config.js"), "utf8");
  const instrumentationStart = template.indexOf(PICKER_BRIDGE_START);
  const instrumentationEnd = template.indexOf(PICKER_CONFIG_EXPORT_START, instrumentationStart);
  if (instrumentationStart < 0 || instrumentationEnd <= instrumentationStart) return undefined;

  const configDir = await mkdtemp(join(tmpdir(), "dezin-version-preview-"));
  const configPath = join(configDir, "vite.config.mjs");
  const originalConfigDeclaration = viteConfig
    ? `import originalConfig from ${JSON.stringify(pathToFileURL(viteConfig).href)};`
    : "const originalConfig = {};";
  const renderContextUrl = existsSync(join(projectDir, ".dezin", "render-context.js"))
    ? "/.dezin/render-context.js"
    : undefined;
  const instrumentation = template.slice(instrumentationStart, instrumentationEnd);
  await writeFile(
    configPath,
    `${originalConfigDeclaration}
${instrumentation}

function withoutStaleDezinPicker(plugin) {
  if (Array.isArray(plugin)) return plugin.map(withoutStaleDezinPicker).filter(Boolean);
  return plugin && plugin.name === "dezin-picker" ? null : plugin;
}

export default async function dezinHistoricalPreviewConfig(env) {
  const exported = await originalConfig;
  const resolved = typeof exported === "function" ? await exported(env) : exported;
  const config = resolved && typeof resolved === "object" ? resolved : {};
  const plugins = (Array.isArray(config.plugins) ? config.plugins : [])
    .map(withoutStaleDezinPicker)
    .filter(Boolean);
  return { ...config, plugins: [...plugins, dezinPicker(${JSON.stringify(renderContextUrl)})] };
}
`,
    "utf8",
  );
  rt.historicalPreviewConfig = { dir: configDir, path: configPath, projectDir };
  return configPath;
}

async function removeHistoricalPreviewConfig(rt: Runtime): Promise<void> {
  const config = rt.historicalPreviewConfig;
  rt.historicalPreviewConfig = undefined;
  if (config) await rm(config.dir, { recursive: true, force: true });
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
    appendLog(rt ?? { runtimeKey: "", generation: 0, released: false, phase: "ready", logs: [], children: new Set(), previewCallers: 0, previewEntryCount: 0 }, `$ ${label}`);
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
    if (code === 0) {
      await writeDependencyStamp(projectDir);
      await gitCommit(projectDir, "Dezin: install dependencies");
    }
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
    if (code === 0) {
      await writeDependencyStamp(projectDir);
      await gitCommit(projectDir, "Dezin: install dependencies");
    }
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

async function ensurePreviewDependencies(
  projectDir: string,
  runtimeKey: string,
  rt: Runtime,
  signal?: AbortSignal,
  immutableSource = false,
): Promise<void> {
  assertRuntimeActive(runtimeKey, rt, signal);
  if (!existsSync(join(projectDir, "package.json"))) throw new Error("dependencies not installed yet");
  if (immutableSource
    && !existsSync(join(projectDir, "package-lock.json"))
    && !existsSync(join(projectDir, "npm-shrinkwrap.json"))) {
    throw new Error("immutable preview requires an npm lockfile");
  }
  const expectedFingerprint = await dependencyManifestFingerprint(projectDir);
  const nodeModules = join(projectDir, "node_modules");
  const installedFingerprint = await readFile(join(nodeModules, DEPENDENCY_STAMP), "utf8").catch(() => "");
  if (existsSync(nodeModules) && installedFingerprint.trim() === expectedFingerprint) {
    rt.phase = "ready";
    rt.error = undefined;
    return;
  }

  rt.phase = "installing";
  rt.error = undefined;
  appendLog(rt, existsSync(nodeModules) ? "Refreshing preview dependencies after manifest change" : "Installing preview dependencies");
  await rm(nodeModules, { recursive: true, force: true });
  const installArgs = [
    immutableSource ? "ci" : "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  const code = await run("npm", installArgs, projectDir, rt, `npm ${immutableSource ? "ci" : "install"} --ignore-scripts`);
  assertRuntimeActive(runtimeKey, rt, signal);
  if (code !== 0) {
    rt.phase = "error";
    rt.error = "npm install failed";
    throw new Error(rt.error);
  }
  await writeDependencyStamp(projectDir);
  rt.phase = "ready";
  appendLog(rt, "Preview dependencies are ready");
}

export function previewRuntimeScope(projectId: string, runtimeKey = projectId): RuntimeScope {
  const versionPrefix = `${projectId}:version:`;
  if (runtimeKey.startsWith(versionPrefix)) return { projectId, runId: runtimeKey.slice(versionPrefix.length) };
  const variantPrefix = `${projectId}:`;
  if (runtimeKey.startsWith(variantPrefix)) return { projectId, variantId: runtimeKey.slice(variantPrefix.length) };
  return { projectId };
}

export interface PreviewRuntimeOptions {
  runtimeIdentity?: PreviewRuntimeIdentity;
  immutableSource?: boolean;
  disposeOnIdle?: boolean;
  onLeaseRelease?: () => void | Promise<void>;
  onEntryDispose?: () => void | Promise<void>;
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveValue, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolveValue(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function preparePreviewRuntime(
  projectId: string,
  projectDir: string,
  runtimeKey: string,
  rt: Runtime,
  immutableSource: boolean,
): Promise<PreviewPreparationResult> {
  assertRuntimeActive(runtimeKey, rt);
  const scope = previewRuntimeScope(projectId, runtimeKey);
  const isHistoricalVersion = scope.runId !== undefined;
  const hasGit = existsSync(join(projectDir, ".git"));
  const sourceStatus = hasGit ? await workingTreeFingerprint(projectDir) : "";
  if (isHistoricalVersion && sourceStatus) throw new Error("historical preview source is not clean");
  assertRuntimeActive(runtimeKey, rt);
  if (!isHistoricalVersion) {
    const bridgeUpdated = await ensureProjectPickerBridge(projectDir).catch(() => false);
    assertRuntimeActive(runtimeKey, rt);
    if (bridgeUpdated) {
      appendLog(rt, "Updated preview inspect bridge");
      if (!sourceStatus) await gitCommit(projectDir, "Dezin: update preview inspect bridge", { skipHooks: true });
    }
  }
  await ensurePreviewDependencies(projectDir, runtimeKey, rt, undefined, immutableSource);
  if (isHistoricalVersion && hasGit && await workingTreeFingerprint(projectDir) !== sourceStatus) {
    await run("git", ["reset", "--hard", "HEAD"], projectDir, rt, "git reset --hard HEAD");
    await run("git", ["clean", "-fd"], projectDir, rt, "git clean -fd");
    if (await workingTreeFingerprint(projectDir) !== sourceStatus) throw new Error("historical preview preparation changed source files");
  }
  const configPath = isHistoricalVersion ? await historicalPreviewConfig(projectDir, rt) : undefined;
  const fingerprint = await devServerFingerprint(projectDir);
  assertRuntimeActive(runtimeKey, rt);
  return { configPath, fingerprint };
}

async function acquirePreviewPreparation(
  projectId: string,
  projectDir: string,
  runtimeKey: string,
  rt: Runtime,
  immutableSource: boolean,
  signal?: AbortSignal,
): Promise<PreviewPreparationResult> {
  const key = `${projectDir}\u0000${immutableSource ? "immutable" : "mutable"}`;
  while (true) {
    let preparation = rt.previewPreparation;
    if (preparation && preparation.key !== key) {
      await waitForCaller(preparation.promise.catch(() => ({ fingerprint: "" })), signal);
      assertRuntimeActive(runtimeKey, rt, signal);
      continue;
    }
    if (!preparation) {
      const next = {} as PreviewPreparation;
      next.key = key;
      next.promise = preparePreviewRuntime(projectId, projectDir, runtimeKey, rt, immutableSource)
        .finally(() => {
          if (rt.previewPreparation === next) rt.previewPreparation = undefined;
        });
      rt.previewPreparation = next;
      preparation = next;
    }
    return waitForCaller(preparation.promise, signal);
  }
}

/**
 * Ensure a Vite dev server is running for the project; return its URL. The iframe
 * loads this URL directly (cross-origin) with allow-same-origin, so JSX is
 * transpiled and there is no CORS — no daemon proxy in the path.
 */
export async function ensureDevServer(
  projectId: string,
  projectDir: string,
  runtimeKey = projectId,
  signal?: AbortSignal,
  leaseManager: PreviewLeaseManager = previewLeaseManager,
  options: PreviewRuntimeOptions = {},
): Promise<PreviewLease> {
  let rt = runtimes.get(runtimeKey);
  // A released generation can still be reaping an aborted npm preparation.
  // Keep it as a per-runtime-key barrier: replacing it early would let a late
  // caller run rm(node_modules)/npm ci against the same immutable directory.
  while (rt?.released) {
    const settling = Promise.allSettled([
      rt.stopPromise ?? Promise.resolve(),
      rt.operation ?? Promise.resolve(),
      rt.previewPreparation?.promise ?? Promise.resolve(),
    ]).then(() => undefined);
    await waitForCaller(settling, signal);
    if (runtimes.get(runtimeKey) === rt) runtimes.delete(runtimeKey);
    rt = runtimes.get(runtimeKey);
  }
  if (!rt) {
    rt = createRuntime(runtimeKey, existsSync(join(projectDir, "node_modules")) ? "ready" : "installing").rt;
  }
  rt.previewCallers += 1;
  let acquired = false;
  try {
    assertRuntimeActive(runtimeKey, rt, signal);
    const scope = previewRuntimeScope(projectId, runtimeKey);
    const prepared = await acquirePreviewPreparation(
      projectId,
      projectDir,
      runtimeKey,
      rt,
      options.immutableSource === true,
      signal,
    );
    assertRuntimeActive(runtimeKey, rt, signal);
    appendLog(rt, "Acquiring ready preview server");
    const lease = await leaseManager.acquire(scope, projectDir, {
      fingerprint: prepared.fingerprint,
      configPath: prepared.configPath,
      runtimeIdentity: options.runtimeIdentity,
      disposeOnIdle: options.disposeOnIdle,
      onLeaseRelease: options.onLeaseRelease,
      onEntryReady: () => {
        rt!.previewEntryCount += 1;
      },
      onEntryDispose: async () => {
        rt!.previewEntryCount = Math.max(0, rt!.previewEntryCount - 1);
        await options.onEntryDispose?.();
      },
      signal,
      onLog: (message, level) => appendLog(rt!, message, level),
    });
    acquired = true;
    return lease;
  } finally {
    rt.previewCallers = Math.max(0, rt.previewCallers - 1);
    if (!acquired && rt.previewCallers === 0 && rt.previewEntryCount === 0 && runtimes.get(runtimeKey) === rt) {
      await disposePreviewRuntimeState(runtimeKey);
    }
  }
}

/** Drop the in-memory setup state and temporary Vite config after its leased process is gone. */
export async function disposePreviewRuntimeState(runtimeKey: string): Promise<void> {
  const rt = runtimes.get(runtimeKey);
  if (!rt) return;
  if (rt.previewCallers > 0 || rt.previewEntryCount > 0) return;
  const operation = rt.operation;
  const preparation = rt.previewPreparation?.promise;
  const stopping = stopRuntime(rt);
  await Promise.allSettled([
    stopping,
    operation ?? Promise.resolve(),
    preparation ?? Promise.resolve(),
  ]);
  if (runtimes.get(runtimeKey) === rt) runtimes.delete(runtimeKey);
  await removeHistoricalPreviewConfig(rt);
}

/** Compatibility cleanup for legacy callers that only retained the runtime key. */
export async function releaseDevServer(runtimeKey: string): Promise<boolean> {
  const projectId = runtimeKey.split(":", 1)[0];
  if (!projectId) return false;
  await previewLeaseManager.stopScope(previewRuntimeScope(projectId, runtimeKey));
  await disposePreviewRuntimeState(runtimeKey);
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
export async function gitCommit(
  projectDir: string,
  message: string,
  options: { skipHooks?: boolean } = {},
): Promise<{ changed: boolean; committed: boolean; commitHash: string | null }> {
  if (!existsSync(join(projectDir, ".git"))) return { changed: false, committed: false, commitHash: null };
  await run("git", ["add", "-A"], projectDir);
  const status = await workingTreeFingerprint(projectDir);
  if (!status) return { changed: false, committed: false, commitHash: null };
  const emptyHooksDir = options.skipHooks ? await mkdtemp(join(tmpdir(), "dezin-empty-hooks-")) : null;
  try {
    const code = await run(
      "git",
      [
        ...GIT_IDENTITY,
        ...(emptyHooksDir ? ["-c", `core.hooksPath=${emptyHooksDir}`] : []),
        "commit",
        "-q",
        "-m",
        message.replace(/\s+/g, " ").slice(0, 72) || "Dezin update",
      ],
      projectDir,
    );
    if (code !== 0) return { changed: true, committed: false, commitHash: null };
    const head = await capture("git", ["rev-parse", "HEAD"], projectDir);
    return { changed: true, committed: true, commitHash: head.code === 0 ? head.out.trim() : null };
  } finally {
    if (emptyHooksDir) await rm(emptyHooksDir, { recursive: true, force: true });
  }
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
  await Promise.allSettled(owned.flatMap((rt) => [
    stopRuntime(rt),
    rt.operation ?? Promise.resolve(),
    rt.previewPreparation?.promise ?? Promise.resolve(),
  ]));
  for (const rt of retired) retiredRuntimes.delete(rt);
  for (const [key, rt] of entries) {
    if (runtimes.get(key) === rt) runtimes.delete(key);
  }
  await previewLeaseManager.stopScope({ projectId });
  await Promise.allSettled(owned.map(removeHistoricalPreviewConfig));
}

/** Stop and forget one variant runtime plus version previews owned by its Runs. */
export async function releaseVariantRuntime(projectId: string, variantId: string, runIds: string[] = []): Promise<void> {
  const keys = new Set([`${projectId}:${variantId}`, ...runIds.map((runId) => `${projectId}:version:${runId}`)]);
  const entries = [...runtimes.entries()].filter(([key]) => keys.has(key));
  const retired = [...retiredRuntimes].filter((rt) => keys.has(rt.runtimeKey));
  const owned = [...new Set([...entries.map(([, rt]) => rt), ...retired])];
  for (const rt of owned) void stopRuntime(rt);
  await Promise.allSettled(owned.flatMap((rt) => [
    stopRuntime(rt),
    rt.operation ?? Promise.resolve(),
    rt.previewPreparation?.promise ?? Promise.resolve(),
  ]));
  for (const rt of retired) retiredRuntimes.delete(rt);
  for (const [key, rt] of entries) {
    if (runtimes.get(key) === rt) runtimes.delete(key);
  }
  await Promise.all([
    previewLeaseManager.stopScope({ projectId, variantId }),
    ...runIds.map((runId) => previewLeaseManager.stopScope({ projectId, runId })),
  ]);
  await Promise.allSettled(owned.map(removeHistoricalPreviewConfig));
}

/** Stop all runtime resources and await bounded child settlement. */
export async function stopAllProjectRuntimes(): Promise<void> {
  const entries = [...new Set([...runtimes.values(), ...retiredRuntimes])];
  for (const rt of entries) void stopRuntime(rt);
  await Promise.allSettled(entries.flatMap((rt) => [
    stopRuntime(rt),
    rt.operation ?? Promise.resolve(),
    rt.previewPreparation?.promise ?? Promise.resolve(),
  ]));
  for (const [key, rt] of runtimes) {
    if (entries.includes(rt)) runtimes.delete(key);
  }
  retiredRuntimes.clear();
  await previewLeaseManager.stopAll();
  await Promise.allSettled(entries.map(removeHistoricalPreviewConfig));
}

/** Await teardown of every legacy dev/setup resource. */
export async function stopAllDevServers(): Promise<void> {
  await stopAllProjectRuntimes();
}
