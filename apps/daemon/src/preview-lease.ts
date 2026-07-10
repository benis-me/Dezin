import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { agentSpawnEnv } from "../../../packages/agent/src/index.ts";
import type { RuntimeScope } from "./runtime-supervisor.ts";

export interface PreviewLease {
  leaseId: string;
  url: string;
  expiresAt: number;
  release(): Promise<void>;
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
  onLog?: (message: string, level: "info" | "error") => void;
}

export interface PreviewAcquireOptions {
  fingerprint?: string;
  signal?: AbortSignal;
  onLog?: PreviewSpawnInput["onLog"];
}

type Timer = ReturnType<typeof setTimeout>;

export interface PreviewLeaseManagerOptions {
  allocatePort?: () => Promise<number>;
  spawnProcess?: (input: PreviewSpawnInput) => PreviewChild;
  waitUntilReady?: (url: string, child: PreviewChild, signal: AbortSignal) => Promise<void>;
  killProcessGroup?: (child: PreviewChild, signal: NodeJS.Signals) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  readyTimeoutMs?: number;
  cachedReadyTimeoutMs?: number;
  stopGraceMs?: number;
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
}

interface LeaseState {
  leaseId: string;
  entry: PreviewEntry;
  expiresAt: number;
  timer?: Timer;
}

interface PreviewEntry {
  identity: string;
  scope: RuntimeScope;
  projectDir: string;
  fingerprint: string;
  child: PreviewChild;
  url: string;
  leases: Map<string, LeaseState>;
  idleSince?: number;
  idleTimer?: Timer;
  stopping?: Promise<void>;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
}

interface PreviewFlight {
  identity: string;
  scope: RuntimeScope;
  projectDir: string;
  fingerprint: string;
  controller: AbortController;
  waiters: number;
  promise: Promise<PreviewEntry>;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
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

function isExited(child: PreviewChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(input.port), "--strictPort", "--host", "127.0.0.1"],
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
  if (isExited(child)) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill?.(signal);
  } catch {
    // The process may have exited between the liveness check and kill.
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) return reject(abortError(signal.reason));
    const timer = setTimeout(finish, ms);
    unref(timer);
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
      if (response.ok || response.status === 404) return;
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
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const cancelTimer = options.clearTimeout ?? clearTimeout;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const cachedReadyTimeoutMs = options.cachedReadyTimeoutMs ?? 1_000;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxIdle = options.maxIdle ?? DEFAULT_MAX_IDLE;
  const entries = new Map<string, PreviewEntry>();
  const flights = new Map<string, PreviewFlight>();
  const leases = new Map<string, LeaseState>();
  const childStops = new WeakMap<object, Promise<void>>();

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

  function waitForExit(child: PreviewChild, timeoutMs: number): Promise<boolean> {
    if (isExited(child)) return Promise.resolve(true);
    return new Promise((resolveExit) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("close", onClose);
        child.off("error", onError);
        resolveExit(exited);
      };
      const onClose = (): void => finish(true);
      const onError = (): void => finish(true);
      const timer = setTimeout(() => finish(isExited(child)), Math.max(0, timeoutMs));
      unref(timer);
      child.once("close", onClose);
      child.once("error", onError);
    });
  }

  function stopChild(child: PreviewChild): Promise<void> {
    const existing = childStops.get(child as object);
    if (existing) return existing;
    const stopping = (async () => {
      if (isExited(child)) return;
      killProcessGroup(child, "SIGTERM");
      if (await waitForExit(child, stopGraceMs)) return;
      killProcessGroup(child, "SIGKILL");
      await waitForExit(child, stopGraceMs);
    })();
    childStops.set(child as object, stopping);
    return stopping;
  }

  function forgetEntry(entry: PreviewEntry): void {
    if (entries.get(entry.identity) === entry) entries.delete(entry.identity);
    clearIdleTimer(entry);
    for (const lease of entry.leases.values()) {
      clearLeaseTimer(lease);
      leases.delete(lease.leaseId);
    }
    entry.leases.clear();
    entry.child.off("close", entry.onClose);
    entry.child.off("error", entry.onError);
  }

  function stopEntry(entry: PreviewEntry): Promise<void> {
    entry.stopping ??= (async () => {
      forgetEntry(entry);
      await stopChild(entry.child);
    })();
    return entry.stopping;
  }

  function evictIdleOverflow(): void {
    const idle = [...entries.values()]
      .filter((entry) => entry.leases.size === 0 && entry.idleSince !== undefined && !entry.stopping)
      .sort((a, b) => (a.idleSince! - b.idleSince!) || a.identity.localeCompare(b.identity));
    while (idle.length > maxIdle) {
      const oldest = idle.shift();
      if (oldest) void stopEntry(oldest);
    }
  }

  function markIdle(entry: PreviewEntry): void {
    if (entry.stopping || entry.leases.size > 0 || entries.get(entry.identity) !== entry) return;
    clearIdleTimer(entry);
    entry.idleSince = now();
    entry.idleTimer = schedule(() => {
      entry.idleTimer = undefined;
      if (entry.leases.size === 0) void stopEntry(entry);
    }, idleTtlMs);
    unref(entry.idleTimer);
    evictIdleOverflow();
  }

  function expireLease(lease: LeaseState): boolean {
    if (leases.get(lease.leaseId) !== lease) return false;
    clearLeaseTimer(lease);
    leases.delete(lease.leaseId);
    lease.entry.leases.delete(lease.leaseId);
    markIdle(lease.entry);
    return true;
  }

  function armLease(lease: LeaseState): void {
    clearLeaseTimer(lease);
    lease.expiresAt = now() + leaseTtlMs;
    lease.timer = schedule(() => {
      lease.timer = undefined;
      expireLease(lease);
    }, leaseTtlMs);
    unref(lease.timer);
  }

  function publicLease(lease: LeaseState): PreviewLease {
    return {
      leaseId: lease.leaseId,
      url: lease.entry.url,
      expiresAt: lease.expiresAt,
      release: async () => {
        expireLease(lease);
      },
    };
  }

  function addLease(entry: PreviewEntry): PreviewLease {
    clearIdleTimer(entry);
    entry.idleSince = undefined;
    const state: LeaseState = {
      leaseId: randomUUID(),
      entry,
      expiresAt: 0,
    };
    entry.leases.set(state.leaseId, state);
    leases.set(state.leaseId, state);
    armLease(state);
    return publicLease(state);
  }

  async function startFlight(flight: PreviewFlight, onLog?: PreviewSpawnInput["onLog"]): Promise<PreviewEntry> {
    const port = await allocatePort();
    flight.controller.signal.throwIfAborted();
    const child = spawnProcess({ projectDir: flight.projectDir, port, onLog });
    const url = `http://127.0.0.1:${port}/`;
    let readyTimer: Timer | undefined;
    const timeout = new Error(`Preview readiness timed out after ${readyTimeoutMs}ms`);
    timeout.name = "TimeoutError";
    readyTimer = schedule(() => flight.controller.abort(timeout), readyTimeoutMs);
    unref(readyTimer);

    let closeListener!: (code: number | null, signal: NodeJS.Signals | null) => void;
    let errorListener!: (error: Error) => void;
    const exited = new Promise<never>((_resolve, reject) => {
      closeListener = (code, signal) => reject(new Error(`Preview process exited before readiness (${signal ?? code ?? "unknown"})`));
      errorListener = (error) => reject(new Error(`Preview process exited before readiness: ${error.message}`));
      child.once("close", closeListener);
      child.once("error", errorListener);
    });
    try {
      await Promise.race([waitUntilReady(url, child, flight.controller.signal), exited]);
      flight.controller.signal.throwIfAborted();
      if (isExited(child)) throw new Error("Preview process exited before readiness");
    } catch (error) {
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
    entry.onClose = () => forgetEntry(entry);
    entry.onError = () => forgetEntry(entry);
    child.once("close", entry.onClose);
    child.once("error", entry.onError);
    entries.set(entry.identity, entry);
    return entry;
  }

  function getOrCreateFlight(
    identity: string,
    scope: RuntimeScope,
    projectDir: string,
    fingerprint: string,
    onLog?: PreviewSpawnInput["onLog"],
  ): PreviewFlight {
    const existing = flights.get(identity);
    if (existing) return existing;
    const flight: PreviewFlight = {
      identity,
      scope: { ...scope },
      projectDir: resolve(projectDir),
      fingerprint,
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

  async function confirmCachedReady(entry: PreviewEntry, callerSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const timeout = new Error(`Cached preview readiness timed out after ${cachedReadyTimeoutMs}ms`);
    timeout.name = "TimeoutError";
    const timer = schedule(() => controller.abort(timeout), cachedReadyTimeoutMs);
    unref(timer);
    const onAbort = (): void => controller.abort(abortError(callerSignal?.reason));
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();
    try {
      await waitUntilReady(entry.url, entry.child, controller.signal);
      controller.signal.throwIfAborted();
      if (isExited(entry.child)) throw new Error("Preview process exited before readiness");
    } finally {
      cancelTimer(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
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

  const manager: PreviewLeaseManager = {
    async acquire(scope, projectDir, acquireOptions = {}) {
      acquireOptions.signal?.throwIfAborted();
      const fingerprint = acquireOptions.fingerprint ?? "";
      const identity = identityKey(scope, projectDir, fingerprint);
      const cached = entries.get(identity);
      if (cached && !cached.stopping && !isExited(cached.child)) {
        try {
          await confirmCachedReady(cached, acquireOptions.signal);
          return addLease(cached);
        } catch (error) {
          if (acquireOptions.signal?.aborted) throw error;
          await stopEntry(cached);
        }
      } else if (cached) {
        await stopEntry(cached);
      }

      const flight = getOrCreateFlight(identity, scope, projectDir, fingerprint, acquireOptions.onLog);
      flight.waiters += 1;
      try {
        const entry = await waitForFlight(flight, acquireOptions.signal);
        acquireOptions.signal?.throwIfAborted();
        return addLease(entry);
      } catch (error) {
        if (acquireOptions.signal?.aborted && flight.waiters === 1 && !flight.controller.signal.aborted) {
          flight.controller.abort(abortError(acquireOptions.signal.reason));
          await flight.promise.catch(() => {});
        }
        throw error;
      } finally {
        flight.waiters -= 1;
        if (flight.waiters === 0 && flights.get(identity) === flight && !flight.controller.signal.aborted) {
          flight.controller.abort(abortError());
        }
      }
    },

    async renew(leaseId) {
      const lease = leases.get(leaseId);
      if (!lease || lease.entry.stopping || isExited(lease.entry.child)) return null;
      armLease(lease);
      return publicLease(lease);
    },

    async release(leaseId) {
      const lease = leases.get(leaseId);
      return lease ? expireLease(lease) : false;
    },

    async stopScope(scope) {
      const matchingFlights = [...flights.values()].filter((flight) => matchesScope(flight.scope, scope));
      for (const flight of matchingFlights) flight.controller.abort(abortError());
      const matchingEntries = [...entries.values()].filter((entry) => matchesScope(entry.scope, scope));
      await Promise.allSettled([
        ...matchingEntries.map((entry) => stopEntry(entry)),
        ...matchingFlights.map((flight) => flight.promise.then(() => {}, () => {})),
      ]);
    },

    async stopAll() {
      const allFlights = [...flights.values()];
      for (const flight of allFlights) flight.controller.abort(abortError());
      const allEntries = [...entries.values()];
      await Promise.allSettled([
        ...allEntries.map((entry) => stopEntry(entry)),
        ...allFlights.map((flight) => flight.promise.then(() => {}, () => {})),
      ]);
    },

    activeCount() {
      return entries.size;
    },
  };

  return manager;
}

export const previewLeaseManager = createPreviewLeaseManager();
