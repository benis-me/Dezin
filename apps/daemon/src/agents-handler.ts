/**
 * GET /api/agents — detect which coding-agent CLIs are available and report their models.
 * The per-agent knowledge (command, models, discovery, runner) lives in the provider
 * registry (@dezin/agent providers); this file just drives the scan, caches it for the
 * daemon's lifetime, and serves the HTTP routes.
 */

import type { ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_PROVIDERS,
  ProcessGroupCleanupError,
  abortError,
  isAbortError,
  probeVersion,
  type AgentProvider,
  type AgentReadiness,
} from "../../../packages/agent/src/index.ts";
import { sendJson } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

export interface AgentProbe {
  available: boolean;
  version?: string;
  readiness?: AgentReadiness;
}

export type AgentProber = (command: string, signal?: AbortSignal) => Promise<AgentProbe>;

export type AgentAvailability =
  | "ready"
  | "not-installed"
  | "authentication-required"
  | "verification-required";

export interface AgentInfo {
  id: string;
  command: string;
  available: boolean;
  availability: AgentAvailability;
  unavailableReason?: string;
  version?: string;
  /** Models this agent offers — real (probed from the CLI/API) when possible, else a seed. */
  models: string[];
}

/** Real prober: `<command> --version` on the augmented PATH, with a short timeout. */
export const defaultAgentProber: AgentProber = (command, signal) => probeVersion(command, signal);

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (error instanceof ProcessGroupCleanupError) throw error;
  if (isAbortError(error)) throw error;
  if (signal?.aborted) signal.throwIfAborted();
}

export async function inspectAgent(
  provider: AgentProvider,
  prober: AgentProber,
  deep: boolean,
  onPhase?: (phase: "probe" | "readiness" | "models") => void,
  signal?: AbortSignal,
): Promise<AgentInfo> {
  signal?.throwIfAborted();
  onPhase?.("probe");
  const probe = await prober(provider.command, signal);
  signal?.throwIfAborted();
  if (!probe.available) {
    return {
      id: provider.id,
      command: provider.command,
      available: false,
      availability: "not-installed",
      version: probe.version,
      models: provider.seedModels,
    };
  }

  let readiness: AgentReadiness = probe.readiness ?? { status: "ready" };
  if (probe.readiness === undefined && provider.probeReadiness) {
    onPhase?.("readiness");
    try {
      readiness = await provider.probeReadiness(provider.command, { signal });
    } catch (error) {
      rethrowCancellation(error, signal);
      readiness = {
        status: "verification-required",
        reason: `${provider.label} sign-in couldn't be verified. Rescan agents to try again.`,
      };
    }
  }
  const available = readiness.status === "ready";
  let models = provider.seedModels;
  if (available && provider.discoverModels) {
    signal?.throwIfAborted();
    onPhase?.("models");
    try {
      const real = await provider.discoverModels(provider.command, deep, signal);
      signal?.throwIfAborted();
      if (real.length) models = real;
    } catch (error) {
      rethrowCancellation(error, signal);
      /* keep the seed on any discovery failure */
    }
  }
  return {
    id: provider.id,
    command: provider.command,
    available,
    availability: readiness.status,
    unavailableReason: readiness.status === "ready" ? undefined : readiness.reason,
    version: probe.version,
    models,
  };
}

export async function detectAgents(
  prober: AgentProber,
  deep = false,
  signal?: AbortSignal,
): Promise<AgentInfo[]> {
  signal?.throwIfAborted();
  const settled = await Promise.allSettled(AGENT_PROVIDERS.map((provider) => inspectAgent(
    provider,
    prober,
    deep,
    undefined,
    signal,
  )));
  // Promise.all would reject on the first fast provider and let slower owned CLI
  // process-group cleanup escape the daemon lifecycle. Treat all providers as one
  // cleanup barrier, then surface cancellation or the first real failure.
  const cleanupFailure = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && result.reason instanceof ProcessGroupCleanupError,
  );
  if (cleanupFailure) throw cleanupFailure.reason;
  signal?.throwIfAborted();
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<AgentInfo>).value);
}

// Probing every CLI is slow, so cache the result for the daemon's lifetime and only
// re-probe on an explicit rescan. The cache is also persisted to disk and reloaded at
// startup, so a restart shows the last (deep) scan instantly instead of re-probing.
let cache: AgentInfo[] | null = null;
let persistPath: string | null = null;
let cacheNeedsRefresh = false;

interface AgentScan {
  readonly id: number;
  readonly deep: boolean;
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  promise: Promise<AgentInfo[]>;
  settled: boolean;
}

let inflight: AgentScan | null = null;
const activeScans = new Set<AgentScan>();
let scanSequence = 0;
let latestStartedScanId = 0;

function startAgentScan(
  deep: boolean,
  operation: (signal: AbortSignal, scanId: number) => Promise<AgentInfo[]>,
): AgentScan {
  const controller = new AbortController();
  const id = ++scanSequence;
  latestStartedScanId = id;
  const scan: AgentScan = {
    id,
    deep,
    controller,
    waiters: new Set(),
    promise: Promise.resolve([]),
    settled: false,
  };
  activeScans.add(scan);
  scan.promise = Promise.resolve()
    .then(() => operation(controller.signal, id))
    .finally(() => {
      scan.settled = true;
      activeScans.delete(scan);
      if (inflight === scan) inflight = null;
    });
  inflight = scan;
  return scan;
}

function waitForAgentScan(scan: AgentScan, signal?: AbortSignal): Promise<AgentInfo[]> {
  if (signal?.aborted) {
    if (!scan.settled && scan.waiters.size === 0 && !scan.controller.signal.aborted) {
      scan.controller.abort(abortError());
    }
    return Promise.reject(signal.reason ?? abortError());
  }
  const waiter = Symbol("agent-scan-waiter");
  scan.waiters.add(waiter);
  return new Promise<AgentInfo[]>((resolve, reject) => {
    let finished = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      scan.waiters.delete(waiter);
      if (!scan.settled && scan.waiters.size === 0 && !scan.controller.signal.aborted) {
        scan.controller.abort(abortError());
      }
    };
    const finish = (result: AgentInfo[] | undefined, error?: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(result ?? []);
    };
    const onAbort = (): void => {
      finish(undefined, signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void scan.promise.then(
      (agents) => finish(agents),
      (error) => finish(undefined, error),
    );
  });
}

function currentAgentScan(): AgentScan | null {
  return inflight
    && !inflight.settled
    && !inflight.controller.signal.aborted
    ? inflight
    : null;
}

async function runCoordinatedAgentScan(
  deep: boolean,
  signal: AbortSignal | undefined,
  operation: (scanSignal: AbortSignal, scanId: number) => Promise<AgentInfo[]>,
): Promise<AgentInfo[]> {
  signal?.throwIfAborted();
  const current = currentAgentScan();
  if (current) {
    // A deep scan satisfies every shallow reader, and same-kind forced scans are
    // single-flight. A deep request arriving behind a shallow scan queues rather
    // than launching a second set of external CLIs.
    if (!deep || current.deep) return waitForAgentScan(current, signal);
    await waitForAgentScan(current, signal);
    return runCoordinatedAgentScan(deep, signal, operation);
  }
  return waitForAgentScan(startAgentScan(deep, operation), signal);
}

/** Cancel every daemon-owned agent scan. CodeBuddy readiness waits for its process group
 *  to terminate before the scan rejects, so callers can safely finish shutdown afterwards. */
export async function abortAgentScans(): Promise<void> {
  const scans = [...activeScans];
  for (const scan of scans) {
    if (!scan.controller.signal.aborted) scan.controller.abort(abortError());
  }
  const settled = await Promise.allSettled(scans.map((scan) => scan.promise));
  const cleanupFailure = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !isAbortError(result.reason),
  );
  if (cleanupFailure) throw cleanupFailure.reason;
}

function commitAgentScan(scanId: number, agents: AgentInfo[]): void {
  if (scanId !== latestStartedScanId) return;
  cache = agents;
  cacheNeedsRefresh = false;
  persist(agents);
}

/** Persist a scan — but only one that actually found an agent, so a transient empty or
 *  failed probe (e.g. a momentary PATH glitch) never clobbers a good saved list. */
function persist(agents: AgentInfo[]): void {
  if (!persistPath || !agents.some((a) => a.availability !== "not-installed")) return;
  try {
    writeFileSync(persistPath, JSON.stringify(agents));
  } catch {
    /* best-effort */
  }
}

function loadPersisted(): AgentInfo[] | null {
  if (!persistPath) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
    if (Array.isArray(data) && data.every((a) => a && typeof a.id === "string" && Array.isArray(a.models))) {
      return reconcilePersisted(data as AgentInfo[]);
    }
  } catch {
    /* none yet / unreadable */
  }
  return null;
}

function reconcilePersisted(agents: AgentInfo[]): AgentInfo[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return AGENT_PROVIDERS.map((provider) => {
    const cached = byId.get(provider.id);
    if (!cached) {
      return {
        id: provider.id,
        command: provider.command,
        available: false,
        availability: "not-installed",
        models: provider.seedModels,
      };
    }
    const models = cached.models.filter((model): model is string => typeof model === "string");
    const persistedAvailability = cached.availability;
    const availability: AgentAvailability =
      persistedAvailability === "ready"
        || persistedAvailability === "not-installed"
        || persistedAvailability === "authentication-required"
        || persistedAvailability === "verification-required"
        ? persistedAvailability
        : provider.id === "codebuddy" && cached.available === true
          ? "verification-required"
          : cached.available === true
            ? "ready"
            : "not-installed";
    return {
      id: provider.id,
      command: provider.command,
      available: availability === "ready",
      availability,
      unavailableReason: availability === "ready" || availability === "not-installed"
        ? undefined
        : typeof cached.unavailableReason === "string" && cached.unavailableReason.trim()
          ? cached.unavailableReason
          : "Agent sign-in couldn't be verified. Rescan agents to try again.",
      version: typeof cached.version === "string" ? cached.version : undefined,
      models: models.length ? models : provider.seedModels,
    };
  });
}

export async function getAgents(
  prober: AgentProber,
  force = false,
  signal?: AbortSignal,
): Promise<AgentInfo[]> {
  signal?.throwIfAborted();
  const current = currentAgentScan();
  if (current) {
    return runCoordinatedAgentScan(force, signal, async (scanSignal, scanId) => {
      const agents = await detectAgents(prober, force, scanSignal);
      if (!scanSignal.aborted) commitAgentScan(scanId, agents);
      return agents;
    });
  }
  if (cache && !force && !cacheNeedsRefresh) return cache;
  // A forced rescan does a deep probe (e.g. CodeBuddy's slow PTY `/model list` scrape).
  return runCoordinatedAgentScan(force, signal, async (scanSignal, scanId) => {
    const agents = await detectAgents(prober, force, scanSignal);
    if (!scanSignal.aborted) commitAgentScan(scanId, agents);
    return agents;
  });
}

/** At daemon start, load the persisted scan without launching external CLIs in a background
 *  task. The first list request performs live readiness verification before responding. */
export function warmAgents(_prober?: AgentProber, dataDir?: string): boolean {
  void abortAgentScans();
  latestStartedScanId = ++scanSequence;
  if (dataDir) persistPath = join(dataDir, "agents.json");
  const persisted = loadPersisted();
  cache = persisted;
  cacheNeedsRefresh = true;
  inflight = null;
  return persisted !== null;
}

export async function handleListAgents(
  res: ServerResponse,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  sendJson(res, 200, await getAgents(prober, false, signal));
}

export async function handleRescanAgents(
  res: ServerResponse,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  sendJson(res, 200, await getAgents(prober, true, signal));
}

export interface ScanProgress {
  id: string;
  label: string;
  /** Presence, non-generating sign-in readiness, or model discovery. */
  phase: "probe" | "readiness" | "models";
}

/**
 * Like detectAgents but sequential, reporting which agent it's on so the UI can show real
 * per-agent progress ("Scanning CodeBuddy…"). Updates + persists the cache like getAgents.
 */
export async function scanAgentsStreaming(
  prober: AgentProber,
  deep: boolean,
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<AgentInfo[]> {
  const results: AgentInfo[] = [];
  for (const p of AGENT_PROVIDERS) {
    signal?.throwIfAborted();
    results.push(await inspectAgent(p, prober, deep, (phase) => {
      onProgress({ id: p.id, label: p.label, phase });
    }, signal));
  }
  return results;
}

export async function handleScanAgentsStream(
  res: ServerResponse,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const sse = (event: unknown): void => {
    if (!signal?.aborted && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  try {
    const agents = await runCoordinatedAgentScan(true, signal, async (scanSignal, scanId) => {
      const agents = await scanAgentsStreaming(
        prober,
        true,
        (p) => sse({ type: "progress", ...p }),
        scanSignal,
      );
      if (!scanSignal.aborted) commitAgentScan(scanId, agents);
      return agents;
    });
    sse({ type: "done", agents });
  } catch (error) {
    rethrowCancellation(error, signal);
    sse({ type: "done", agents: cache ?? [] });
  }
  res.end();
}
