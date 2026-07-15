import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { RuntimeScope } from "./runtime-supervisor.ts";

export interface PreviewLease {
  leaseId: string;
  url: string;
  bridgeNonce: string;
  expiresAt: number;
  release(): Promise<void>;
}

export interface PreviewBridgeCapability {
  url: string;
  bridgeNonce: string;
}

export function requirePreviewLease(value: unknown, label = "preview runtime"): PreviewLease {
  if (!value || typeof value !== "object") throw new Error(`${label} did not return a renewable lease`);
  const lease = value as Partial<PreviewLease>;
  const validNonce = typeof lease.bridgeNonce === "string"
    && /^[a-zA-Z0-9_-]{43}$/.test(lease.bridgeNonce);
  let matchingFragment = false;
  if (typeof lease.url === "string" && validNonce) {
    try {
      matchingFragment = new URL(lease.url, "http://dezin.invalid").hash
        === `#dezin-bridge=${lease.bridgeNonce}`;
    } catch {
      matchingFragment = false;
    }
  }
  if (typeof lease.leaseId !== "string"
    || lease.leaseId.length === 0
    || typeof lease.url !== "string"
    || lease.url.length === 0
    || !validNonce
    || !matchingFragment
    || typeof lease.expiresAt !== "number"
    || !Number.isFinite(lease.expiresAt)
    || typeof lease.release !== "function") {
    throw new Error(`${label} did not return a renewable nonce-bound lease`);
  }
  return lease as PreviewLease;
}

export interface PreviewChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface PreviewSpawnInput {
  projectDir: string;
  port: number;
  configPath?: string;
  onLog?: (message: string, level: "info" | "error") => void;
}

export interface PreviewRuntimeIdentity {
  artifactId: string;
  revisionId: string;
  sourceTreeHash: string;
  dependencyLockHash: string;
}

export interface PreviewAcquireOptions {
  fingerprint?: string;
  configPath?: string;
  runtimeIdentity?: PreviewRuntimeIdentity;
  signal?: AbortSignal;
  onLog?: PreviewSpawnInput["onLog"];
  /** Immutable targets do not keep a process whose last client lease is gone. */
  disposeOnIdle?: boolean;
  /** Per-client resource cleanup, run exactly once after the lease is detached. */
  onLeaseRelease?: () => void | Promise<void>;
  /** Per-process cleanup, run exactly once after the preview process is gone. */
  onEntryDispose?: () => void | Promise<void>;
  /** Internal lifecycle hook fired once when a new process entry becomes owned. */
  onEntryReady?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface PreviewLeaseManagerOptions {
  allocatePort?: () => Promise<number>;
  spawnProcess?: (input: PreviewSpawnInput) => PreviewChild;
  waitUntilReady?: (url: string, child: PreviewChild, signal: AbortSignal) => Promise<void>;
  killProcessGroup?: (child: PreviewChild, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (child: PreviewChild) => boolean;
  readyEntryCheckpoint?: (signal: AbortSignal) => void | Promise<void>;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  readyTimeoutMs?: number;
  cachedReadyTimeoutMs?: number;
  stopGraceMs?: number;
  forceKillWaitMs?: number;
  onTeardownError?: (error: Error, child: PreviewChild) => void;
  leaseTtlMs?: number;
  idleTtlMs?: number;
  maxIdle?: number;
}

export interface PreviewLeaseManager {
  acquire(scope: RuntimeScope, projectDir: string, options?: PreviewAcquireOptions): Promise<PreviewLease>;
  renew(leaseId: string): Promise<PreviewLease | null>;
  release(leaseId: string): Promise<boolean>;
  stopScope(scope: RuntimeScope): Promise<void>;
  stopAll(): Promise<void>;
  activeCount(): number;
  /** True while a scope owns a live client lease; maintenance must not evict its files. */
  hasActiveLease?(scope: RuntimeScope): boolean;
}

interface LeaseState {
  leaseId: string;
  bridgeNonce: string;
  entry: PreviewEntry;
  expiresAt: number;
  timer?: Timer;
  onRelease?: PreviewAcquireOptions["onLeaseRelease"];
  releasePromise?: Promise<void>;
}

interface PreviewEntry {
  identity: string;
  scope: RuntimeScope;
  projectDir: string;
  fingerprint: string;
  child: PreviewChild;
  url: string;
  leases: Map<string, LeaseState>;
  /** Leases detached by stopEntry but not releasable until the process is gone. */
  pendingReleaseLeases: Set<LeaseState>;
  pendingHandoffs: number;
  disposeOnIdle: boolean;
  onDispose?: PreviewAcquireOptions["onEntryDispose"];
  idleSince?: number;
  idleTimer?: Timer;
  healthCheck?: PreviewHealthCheck;
  unhealthy?: boolean;
  stopping?: Promise<void>;
  teardownFailed?: boolean;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
}

interface PreviewHealthCheck {
  controller: AbortController;
  promise: Promise<void>;
}

interface PreviewFlight {
  identity: string;
  scope: RuntimeScope;
  projectDir: string;
  fingerprint: string;
  configPath?: string;
  disposeOnIdle: boolean;
  onEntryDispose?: PreviewAcquireOptions["onEntryDispose"];
  onEntryReady?: PreviewAcquireOptions["onEntryReady"];
  controller: AbortController;
  waiters: number;
  entry?: PreviewEntry;
  promise: Promise<PreviewEntry>;
}

interface AcquireRecord {
  id: number;
  scope: RuntimeScope;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface StopBarrier {
  id: number;
  scope?: RuntimeScope;
}

// Fresh Vite processes can cross 15s when the full daemon suite or several
// immutable previews contend for CPU and disk. Keep that startup tolerant but
// still bounded; cached-process health checks remain intentionally short.
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_IDLE = 4;

function unref(timer: Timer): void {
  (timer as { unref?: () => void }).unref?.();
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Preview acquisition aborted");
  error.name = "AbortError";
  return error;
}

function matchesScope(candidate: RuntimeScope, scope: RuntimeScope): boolean {
  return candidate.projectId === scope.projectId
    && (scope.variantId === undefined || candidate.variantId === scope.variantId)
    && (scope.runId === undefined || candidate.runId === scope.runId);
}

function scopeKey(scope: RuntimeScope): string {
  return `${scope.projectId}\u0000${scope.variantId ?? ""}\u0000${scope.runId ?? ""}`;
}

function identityKey(scope: RuntimeScope, projectDir: string, fingerprint: string): string {
  return `${scopeKey(scope)}\u0000${resolve(projectDir)}\u0000${fingerprint}`;
}

export function previewRuntimeIdentityKey(identity: PreviewRuntimeIdentity): string {
  return JSON.stringify([
    identity.artifactId,
    identity.revisionId,
    identity.sourceTreeHash,
    identity.dependencyLockHash,
  ]);
}

function isExited(child: PreviewChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function previewBridgeUrl(baseUrl: string, nonce: string): string {
  return `${baseUrl.replace(/#.*$/s, "")}#dezin-bridge=${nonce}`;
}

export function issuePreviewBridgeCapability(baseUrl: string): PreviewBridgeCapability {
  const bridgeNonce = randomBytes(32).toString("base64url");
  return { url: previewBridgeUrl(baseUrl, bridgeNonce), bridgeNonce };
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate preview port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function spawnPreviewProcess(input: PreviewSpawnInput): PreviewChild {
  const args = ["run", "dev", "--", "--port", String(input.port), "--strictPort", "--host", "127.0.0.1"];
  if (input.configPath) args.push("--config", input.configPath);
  const child = spawn(
    "npm",
    args,
    {
      cwd: input.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: agentSpawnEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => input.onLog?.(data, "info"));
  child.stderr?.on("data", (data: string) => input.onLog?.(data, "error"));
  return child as ChildProcess & PreviewChild;
}

function killPreviewProcessGroup(child: PreviewChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  if (isExited(child)) return;
  try {
    child.kill?.(signal);
  } catch {
    // The process may have exited between the liveness check and kill.
  }
}

function previewProcessGroupAlive(child: PreviewChild): boolean {
  if (process.platform === "win32" || child.pid === undefined) return !isExited(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) return reject(abortError(signal.reason));
    const timer = setTimeout(finish, ms);
    // Readiness polling is awaited work; keep its delay referenced so a
    // one-shot caller cannot exit with the acquisition promise still pending.
    function finish(): void {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForHttpReady(url: string, _child: PreviewChild, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(800)]),
      });
      if (response.ok) return;
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if ((error as Error).name !== "TimeoutError" && (error as Error).name !== "AbortError") {
        // Connection refusal is expected until Vite has bound the port.
      }
    }
    await abortableDelay(250, signal);
  }
}

export function createPreviewLeaseManager(options: PreviewLeaseManagerOptions = {}): PreviewLeaseManager {
  const allocatePort = options.allocatePort ?? allocateFreePort;
  const spawnProcess = options.spawnProcess ?? spawnPreviewProcess;
  const waitUntilReady = options.waitUntilReady ?? waitForHttpReady;
  const killProcessGroup = options.killProcessGroup ?? killPreviewProcessGroup;
  const isProcessGroupAlive = options.isProcessGroupAlive ?? previewProcessGroupAlive;
  const readyEntryCheckpoint = options.readyEntryCheckpoint;
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const cancelTimer = options.clearTimeout ?? clearTimeout;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const cachedReadyTimeoutMs = options.cachedReadyTimeoutMs ?? 1_000;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const forceKillWaitMs = options.forceKillWaitMs ?? 2_000;
  const onTeardownError = options.onTeardownError ?? ((error: Error) => console.error(`[preview] ${error.message}`));
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxIdle = options.maxIdle ?? DEFAULT_MAX_IDLE;
  const entries = new Map<string, PreviewEntry>();
  const allEntries = new Set<PreviewEntry>();
  const flights = new Map<string, PreviewFlight>();
  const leases = new Map<string, LeaseState>();
  const acquires = new Map<number, AcquireRecord>();
  const stopBarriers = new Map<number, StopBarrier>();
  const quarantines = new Map<number, StopBarrier>();
  const childStops = new WeakMap<object, Promise<void>>();
  let nextAcquireId = 1;
  let nextStopBarrierId = 1;

  function stoppingError(): Error {
    const error = new Error("Preview scope is stopping");
    error.name = "AbortError";
    return error;
  }

  function barrierMatches(scope: RuntimeScope, barrier: StopBarrier): boolean {
    return barrier.scope === undefined || matchesScope(scope, barrier.scope);
  }

  function assertAdmission(scope: RuntimeScope): void {
    if ([...stopBarriers.values(), ...quarantines.values()].some((barrier) => barrierMatches(scope, barrier))) {
      throw stoppingError();
    }
  }

  function barrierCovers(covering: StopBarrier, covered: StopBarrier): boolean {
    return covering.scope === undefined
      || (covered.scope !== undefined && matchesScope(covered.scope, covering.scope));
  }

  function rememberQuarantine(barrier: StopBarrier): void {
    if ([...quarantines.values()].some((existing) => barrierCovers(existing, barrier))) return;
    for (const [id, existing] of quarantines) {
      if (barrierCovers(barrier, existing)) quarantines.delete(id);
    }
    quarantines.set(barrier.id, barrier);
  }

  function clearCoveredQuarantines(barrier: StopBarrier): void {
    for (const [id, existing] of quarantines) {
      if (barrierCovers(barrier, existing)) quarantines.delete(id);
    }
  }

  function clearLeaseTimer(lease: LeaseState): void {
    if (!lease.timer) return;
    cancelTimer(lease.timer);
    lease.timer = undefined;
  }

  function clearIdleTimer(entry: PreviewEntry): void {
    if (!entry.idleTimer) return;
    cancelTimer(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  function waitForGroupGone(child: PreviewChild, timeoutMs: number): Promise<boolean> {
    if (!isProcessGroupAlive(child)) return Promise.resolve(true);
    return new Promise((resolveExit) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const poll = (): void => {
        if (!isProcessGroupAlive(child)) return resolveExit(true);
        if (Date.now() >= deadline) return resolveExit(false);
        setTimeout(poll, Math.min(10, Math.max(1, deadline - Date.now())));
      };
      poll();
    });
  }

  function stopChild(child: PreviewChild): Promise<void> {
    const existing = childStops.get(child as object);
    if (existing) return existing;
    const stopping = (async () => {
      if (!isProcessGroupAlive(child)) return;
      killProcessGroup(child, "SIGTERM");
      if (await waitForGroupGone(child, stopGraceMs)) return;
      const forceDeadline = Date.now() + forceKillWaitMs;
      while (isProcessGroupAlive(child) && Date.now() < forceDeadline) {
        killProcessGroup(child, "SIGKILL");
        await waitForGroupGone(child, Math.min(100, Math.max(1, forceDeadline - Date.now())));
      }
      if (isProcessGroupAlive(child)) {
        const error = new Error(`Preview process group ${child.pid ?? "unknown"} did not terminate after SIGKILL`);
        error.name = "PreviewTeardownError";
        onTeardownError(error, child);
        throw error;
      }
    })();
    childStops.set(child as object, stopping);
    void stopping.catch(() => {
      if (childStops.get(child as object) === stopping) childStops.delete(child as object);
    });
    return stopping;
  }

  function detachEntryLeases(entry: PreviewEntry): LeaseState[] {
    clearIdleTimer(entry);
    const detached = [...entry.leases.values()];
    for (const lease of detached) {
      clearLeaseTimer(lease);
      leases.delete(lease.leaseId);
    }
    entry.leases.clear();
    for (const lease of detached) entry.pendingReleaseLeases.add(lease);
    return detached;
  }

  function releaseLeaseResource(lease: LeaseState): Promise<void> {
    lease.releasePromise ??= Promise.resolve().then(() => lease.onRelease?.());
    return lease.releasePromise;
  }

  function forgetEntry(entry: PreviewEntry): void {
    if (entries.get(entry.identity) === entry) entries.delete(entry.identity);
    allEntries.delete(entry);
    entry.child.off("close", entry.onClose);
    entry.child.off("error", entry.onError);
  }

  function stopEntry(entry: PreviewEntry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (entry.healthCheck && !entry.healthCheck.controller.signal.aborted) {
      entry.healthCheck.controller.abort(stoppingError());
    }
    detachEntryLeases(entry);
    // Defer the body until entry.stopping is assigned: killProcessGroup may emit
    // close synchronously and re-enter stopEntry through the child's listener.
    const stopping = Promise.resolve().then(async () => {
      await stopChild(entry.child);
      entry.teardownFailed = false;
      forgetEntry(entry);
      const pendingReleases = [...entry.pendingReleaseLeases];
      try {
        await entry.onDispose?.();
      } finally {
        try {
          await Promise.all(pendingReleases.map(releaseLeaseResource));
        } finally {
          for (const lease of pendingReleases) entry.pendingReleaseLeases.delete(lease);
        }
      }
    });
    entry.stopping = stopping;
    void stopping.catch(() => {
      entry.teardownFailed = true;
      if (entry.stopping === stopping) entry.stopping = undefined;
    });
    return stopping;
  }

  function evictIdleOverflow(): void {
    const idle = [...entries.values()]
      .filter((entry) => entry.leases.size === 0
        && entry.pendingHandoffs === 0
        && entry.idleSince !== undefined
        && !entry.stopping)
      .sort((a, b) => (a.idleSince! - b.idleSince!) || a.identity.localeCompare(b.identity));
    while (idle.length > maxIdle) {
      const oldest = idle.shift();
      if (oldest) void stopEntry(oldest).catch(() => {});
    }
  }

  function markIdle(entry: PreviewEntry): void {
    if (entry.stopping
      || entry.teardownFailed
      || entry.leases.size > 0
      || entry.pendingHandoffs > 0
      || entries.get(entry.identity) !== entry) return;
    if (entry.disposeOnIdle || entry.unhealthy) {
      void stopEntry(entry).catch(() => {});
      return;
    }
    if (!entry.idleTimer) {
      entry.idleSince = now();
      entry.idleTimer = schedule(() => {
        entry.idleTimer = undefined;
        if (entry.leases.size === 0) void stopEntry(entry).catch(() => {});
      }, idleTtlMs);
      unref(entry.idleTimer);
    }
    evictIdleOverflow();
  }

  async function expireLease(lease: LeaseState): Promise<boolean> {
    if (leases.get(lease.leaseId) !== lease) return false;
    clearLeaseTimer(lease);
    leases.delete(lease.leaseId);
    lease.entry.leases.delete(lease.leaseId);
    if (lease.entry.unhealthy
      && lease.entry.leases.size === 0
      && lease.entry.pendingHandoffs === 0) {
      await stopEntry(lease.entry);
    } else if (lease.entry.disposeOnIdle
      && lease.entry.leases.size === 0
      && lease.entry.pendingHandoffs === 0) {
      await stopEntry(lease.entry);
    } else {
      markIdle(lease.entry);
    }
    await releaseLeaseResource(lease);
    return true;
  }

  function armLease(lease: LeaseState): void {
    clearLeaseTimer(lease);
    lease.expiresAt = now() + leaseTtlMs;
    lease.timer = schedule(() => {
      lease.timer = undefined;
      void expireLease(lease).catch(() => {});
    }, leaseTtlMs);
    unref(lease.timer);
  }

  function publicLease(lease: LeaseState): PreviewLease {
    return {
      leaseId: lease.leaseId,
      url: previewBridgeUrl(lease.entry.url, lease.bridgeNonce),
      bridgeNonce: lease.bridgeNonce,
      expiresAt: lease.expiresAt,
      release: async () => {
        await expireLease(lease);
      },
    };
  }

  function addLease(entry: PreviewEntry, onRelease?: PreviewAcquireOptions["onLeaseRelease"]): PreviewLease {
    clearIdleTimer(entry);
    entry.idleSince = undefined;
    const state: LeaseState = {
      leaseId: randomUUID(),
      bridgeNonce: randomBytes(32).toString("base64url"),
      entry,
      expiresAt: 0,
      onRelease,
    };
    entry.leases.set(state.leaseId, state);
    leases.set(state.leaseId, state);
    armLease(state);
    return publicLease(state);
  }

  async function startFlight(flight: PreviewFlight, onLog?: PreviewSpawnInput["onLog"]): Promise<PreviewEntry> {
    const port = await allocatePort();
    assertAdmission(flight.scope);
    flight.controller.signal.throwIfAborted();
    const child = spawnProcess({ projectDir: flight.projectDir, port, configPath: flight.configPath, onLog });
    const url = `http://127.0.0.1:${port}/`;
    let readyTimer: Timer | undefined;
    const timeout = new Error(`Preview readiness timed out after ${readyTimeoutMs}ms`);
    timeout.name = "TimeoutError";
    readyTimer = schedule(() => flight.controller.abort(timeout), readyTimeoutMs);
    // This timeout settles the caller-visible acquisition promise. Unlike idle
    // and lease-expiry timers, it must keep an otherwise idle process alive.

    let closeListener!: (code: number | null, signal: NodeJS.Signals | null) => void;
    let errorListener!: (error: Error) => void;
    const exited = new Promise<never>((_resolve, reject) => {
      closeListener = (code, signal) => {
        const error = new Error(`Preview process exited before readiness (${signal ?? code ?? "unknown"})`);
        if (!flight.controller.signal.aborted) flight.controller.abort(error);
        reject(error);
      };
      errorListener = (cause) => {
        const error = new Error(`Preview process exited before readiness: ${cause.message}`);
        if (!flight.controller.signal.aborted) flight.controller.abort(error);
        reject(error);
      };
      child.once("close", closeListener);
      child.once("error", errorListener);
    });
    const readiness = Promise.resolve().then(() => waitUntilReady(url, child, flight.controller.signal));
    try {
      await Promise.race([readiness, exited]);
      flight.controller.signal.throwIfAborted();
      assertAdmission(flight.scope);
      if (isExited(child)) throw new Error("Preview process exited before readiness");
    } catch (error) {
      if (!flight.controller.signal.aborted) flight.controller.abort(error);
      await readiness.catch(() => {});
      await stopChild(child);
      if (flight.controller.signal.aborted) throw abortError(flight.controller.signal.reason);
      throw error;
    } finally {
      if (readyTimer) cancelTimer(readyTimer);
      child.off("close", closeListener);
      child.off("error", errorListener);
    }

    const entry = {} as PreviewEntry;
    entry.identity = flight.identity;
    entry.scope = flight.scope;
    entry.projectDir = flight.projectDir;
    entry.fingerprint = flight.fingerprint;
    entry.child = child;
    entry.url = url;
    entry.leases = new Map();
    entry.pendingReleaseLeases = new Set();
    entry.pendingHandoffs = flight.waiters;
    entry.disposeOnIdle = flight.disposeOnIdle;
    entry.onDispose = flight.onEntryDispose;
    entry.unhealthy = false;
    entry.teardownFailed = false;
    entry.onClose = () => { void stopEntry(entry).catch(() => {}); };
    entry.onError = () => { void stopEntry(entry).catch(() => {}); };
    child.once("close", entry.onClose);
    child.once("error", entry.onError);
    flight.entry = entry;
    entries.set(entry.identity, entry);
    allEntries.add(entry);
    try {
      flight.onEntryReady?.();
      markIdle(entry);
      await readyEntryCheckpoint?.(flight.controller.signal);
      flight.controller.signal.throwIfAborted();
      assertAdmission(flight.scope);
      if (entries.get(entry.identity) !== entry || entry.stopping) throw stoppingError();
      return entry;
    } catch (error) {
      await stopEntry(entry);
      throw error;
    }
  }

  function getOrCreateFlight(
    identity: string,
    scope: RuntimeScope,
    projectDir: string,
    fingerprint: string,
    configPath: string | undefined,
    disposeOnIdle: boolean,
    onEntryDispose: PreviewAcquireOptions["onEntryDispose"],
    onEntryReady: PreviewAcquireOptions["onEntryReady"],
    onLog?: PreviewSpawnInput["onLog"],
  ): PreviewFlight {
    assertAdmission(scope);
    const existing = flights.get(identity);
    if (existing) return existing;
    const flight: PreviewFlight = {
      identity,
      scope: { ...scope },
      projectDir: resolve(projectDir),
      fingerprint,
      configPath,
      disposeOnIdle,
      onEntryDispose,
      onEntryReady,
      controller: new AbortController(),
      waiters: 0,
      promise: undefined as unknown as Promise<PreviewEntry>,
    };
    flight.promise = startFlight(flight, onLog).finally(() => {
      if (flights.get(identity) === flight) flights.delete(identity);
    });
    flights.set(identity, flight);
    return flight;
  }

  function cachedHealthCheck(entry: PreviewEntry): Promise<void> {
    if (entry.healthCheck) return entry.healthCheck.promise;
    const controller = new AbortController();
    const timeout = new Error(`Cached preview readiness timed out after ${cachedReadyTimeoutMs}ms`);
    timeout.name = "TimeoutError";
    const timer = schedule(() => controller.abort(timeout), cachedReadyTimeoutMs);
    const health = {} as PreviewHealthCheck;
    health.controller = controller;
    health.promise = Promise.resolve()
      .then(async () => {
        await waitUntilReady(entry.url, entry.child, controller.signal);
        controller.signal.throwIfAborted();
        if (isExited(entry.child)) throw new Error("Preview process exited before readiness");
      })
      .finally(() => {
        cancelTimer(timer);
        if (entry.healthCheck === health) entry.healthCheck = undefined;
      });
    entry.healthCheck = health;
    return health.promise;
  }

  function confirmCachedReady(entry: PreviewEntry, callerSignal?: AbortSignal): Promise<void> {
    const health = cachedHealthCheck(entry);
    if (!callerSignal) return health;
    if (callerSignal.aborted) return Promise.reject(abortError(callerSignal.reason));
    return new Promise<void>((resolveReady, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(abortError(callerSignal.reason)));
      callerSignal.addEventListener("abort", onAbort, { once: true });
      void health.then(
        () => finish(resolveReady),
        (error) => finish(() => reject(error)),
      );
    });
  }

  function waitForFlight(flight: PreviewFlight, signal?: AbortSignal): Promise<PreviewEntry> {
    if (!signal) return flight.promise;
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolveEntry, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(abortError(signal.reason)));
      signal.addEventListener("abort", onAbort, { once: true });
      void flight.promise.then(
        (entry) => finish(() => resolveEntry(entry)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  function beginAcquire(scope: RuntimeScope): AcquireRecord {
    assertAdmission(scope);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolveDone) => {
      resolveSettled = resolveDone;
    });
    const record: AcquireRecord = {
      id: nextAcquireId++,
      scope: { ...scope },
      controller: new AbortController(),
      settled,
      resolveSettled,
    };
    acquires.set(record.id, record);
    return record;
  }

  function finishAcquire(record: AcquireRecord): void {
    if (acquires.get(record.id) === record) acquires.delete(record.id);
    record.resolveSettled();
  }

  async function drainBarrier(barrier: StopBarrier): Promise<void> {
    while (true) {
      const matchingAcquires = [...acquires.values()].filter((record) => barrierMatches(record.scope, barrier));
      const matchingFlights = [...flights.values()].filter((flight) => barrierMatches(flight.scope, barrier));
      const matchingEntries = [...allEntries].filter((entry) => barrierMatches(entry.scope, barrier));
      if (matchingAcquires.length === 0 && matchingFlights.length === 0 && matchingEntries.length === 0) return;

      const reason = stoppingError();
      for (const record of matchingAcquires) {
        if (!record.controller.signal.aborted) record.controller.abort(reason);
      }
      for (const flight of matchingFlights) {
        if (!flight.controller.signal.aborted) flight.controller.abort(reason);
      }
      const settlements = await Promise.allSettled([
        ...matchingAcquires.map((record) => record.settled),
        ...matchingFlights.map((flight) => flight.promise.then(() => {}, () => {})),
        ...matchingEntries.map((entry) => stopEntry(entry)),
      ]);
      const failures = settlements.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      // A dead process is not a successful lifecycle stop if its ownership
      // cleanup failed. Prefer the harder process-teardown error when multiple
      // entries fail, but never silently discard resource cleanup failures.
      const failure = failures.find(
        (result) => result.reason instanceof Error && result.reason.name === "PreviewTeardownError",
      ) ?? failures[0];
      if (failure) throw failure.reason;
    }
  }

  const manager: PreviewLeaseManager = {
    async acquire(scope, projectDir, acquireOptions = {}) {
      acquireOptions.signal?.throwIfAborted();
      const record = beginAcquire(scope);
      const operationSignal = acquireOptions.signal
        ? AbortSignal.any([acquireOptions.signal, record.controller.signal])
        : record.controller.signal;
      try {
        assertAdmission(scope);
        const fingerprint = acquireOptions.fingerprint ?? "";
        const identity = [
          identityKey(scope, projectDir, fingerprint),
          acquireOptions.configPath ?? "",
          acquireOptions.runtimeIdentity ? previewRuntimeIdentityKey(acquireOptions.runtimeIdentity) : "",
        ].join("\u0000");
        const cached = entries.get(identity);
        if (cached && !cached.stopping && !cached.teardownFailed && isProcessGroupAlive(cached.child)) {
          if (cached.unhealthy) {
            if (cached.leases.size > 0) {
              if (entries.get(identity) === cached) entries.delete(identity);
            } else {
              await stopEntry(cached);
            }
            operationSignal.throwIfAborted();
            assertAdmission(scope);
          } else {
          cached.disposeOnIdle ||= acquireOptions.disposeOnIdle === true;
          cached.onDispose ??= acquireOptions.onEntryDispose;
          try {
            await confirmCachedReady(cached, operationSignal);
            operationSignal.throwIfAborted();
            assertAdmission(scope);
            if (entries.get(identity) === cached && !cached.stopping && !cached.teardownFailed && isProcessGroupAlive(cached.child)) {
              cached.unhealthy = false;
              return addLease(cached, acquireOptions.onLeaseRelease);
            }
          } catch (error) {
            if (operationSignal.aborted) throw abortError(operationSignal.reason);
            cached.unhealthy = true;
            if (cached.leases.size > 0 && entries.get(identity) === cached) entries.delete(identity);
            if (cached.leases.size === 0) await stopEntry(cached);
          }
          if (!cached.unhealthy) await stopEntry(cached);
          operationSignal.throwIfAborted();
          assertAdmission(scope);
          }
        } else if (cached) {
          await stopEntry(cached);
          operationSignal.throwIfAborted();
          assertAdmission(scope);
        }

        let flight = getOrCreateFlight(
          identity,
          scope,
          projectDir,
          fingerprint,
          acquireOptions.configPath,
          acquireOptions.disposeOnIdle === true,
          acquireOptions.onEntryDispose,
          acquireOptions.onEntryReady,
          acquireOptions.onLog,
        );
        // A sole caller can abort a shared startup while startFlight is still
        // reaping its process.  The flight remains registered until teardown
        // settles so a new caller must wait for that cleanup, then create a
        // fresh generation instead of inheriting the prior caller's AbortError.
        while (flight.controller.signal.aborted) {
          await flight.promise.catch(() => {});
          operationSignal.throwIfAborted();
          assertAdmission(scope);
          flight = getOrCreateFlight(
            identity,
            scope,
            projectDir,
            fingerprint,
            acquireOptions.configPath,
            acquireOptions.disposeOnIdle === true,
            acquireOptions.onEntryDispose,
            acquireOptions.onEntryReady,
            acquireOptions.onLog,
          );
        }
        flight.disposeOnIdle ||= acquireOptions.disposeOnIdle === true;
        flight.onEntryDispose ??= acquireOptions.onEntryDispose;
        flight.waiters += 1;
        if (flight.entry) flight.entry.pendingHandoffs += 1;
        try {
          const entry = await waitForFlight(flight, operationSignal);
          operationSignal.throwIfAborted();
          assertAdmission(scope);
          if (entries.get(identity) !== entry || entry.stopping || entry.teardownFailed || !isProcessGroupAlive(entry.child)) throw stoppingError();
          return addLease(entry, acquireOptions.onLeaseRelease);
        } catch (error) {
          if (operationSignal.aborted && flight.waiters === 1 && !flight.controller.signal.aborted) {
            flight.controller.abort(abortError(operationSignal.reason));
            await flight.promise.catch(() => {});
          }
          throw error;
        } finally {
          flight.waiters -= 1;
          if (flight.entry) {
            flight.entry.pendingHandoffs = Math.max(0, flight.entry.pendingHandoffs - 1);
            if (flight.entry.pendingHandoffs === 0 && flight.entry.leases.size === 0) markIdle(flight.entry);
          }
          if (flight.waiters === 0 && flights.get(identity) === flight && !flight.controller.signal.aborted) {
            flight.controller.abort(abortError());
          }
        }
      } finally {
        finishAcquire(record);
      }
    },

    async renew(leaseId) {
      const lease = leases.get(leaseId);
      if (!lease || lease.entry.unhealthy || lease.entry.stopping || lease.entry.teardownFailed || isExited(lease.entry.child)) return null;
      armLease(lease);
      return publicLease(lease);
    },

    async release(leaseId) {
      const lease = leases.get(leaseId);
      return lease ? await expireLease(lease) : false;
    },

    async stopScope(scope) {
      const barrier: StopBarrier = { id: nextStopBarrierId++, scope: { ...scope } };
      stopBarriers.set(barrier.id, barrier);
      try {
        await drainBarrier(barrier);
        clearCoveredQuarantines(barrier);
      } catch (error) {
        rememberQuarantine(barrier);
        throw error;
      } finally {
        stopBarriers.delete(barrier.id);
      }
    },

    async stopAll() {
      const barrier: StopBarrier = { id: nextStopBarrierId++ };
      stopBarriers.set(barrier.id, barrier);
      try {
        await drainBarrier(barrier);
        clearCoveredQuarantines(barrier);
      } catch (error) {
        rememberQuarantine(barrier);
        throw error;
      } finally {
        stopBarriers.delete(barrier.id);
      }
    },

    activeCount() {
      return allEntries.size;
    },

    hasActiveLease(scope) {
      return [...allEntries].some((entry) => matchesScope(entry.scope, scope) && entry.leases.size > 0);
    },
  };

  return manager;
}

export const previewLeaseManager = createPreviewLeaseManager();
