/**
 * GET /api/agents — detect which coding-agent CLIs are available and report their models.
 * The per-agent knowledge (command, models, discovery, runner) lives in the provider
 * registry (@dezin/agent providers); this file just drives the scan, caches it for the
 * daemon's lifetime, and serves the HTTP routes.
 */

import type { ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PROVIDERS, probeVersion } from "../../../packages/agent/src/index.ts";
import { sendJson } from "./http-util.ts";
import type { AppDeps } from "./app.ts";

export interface AgentProbe {
  available: boolean;
  version?: string;
}

export type AgentProber = (command: string) => Promise<AgentProbe>;

export interface AgentInfo {
  id: string;
  command: string;
  available: boolean;
  version?: string;
  /** Models this agent offers — real (probed from the CLI/API) when possible, else a seed. */
  models: string[];
}

/** Real prober: `<command> --version` on the augmented PATH, with a short timeout. */
export const defaultAgentProber: AgentProber = (command) => probeVersion(command);

export async function detectAgents(prober: AgentProber, deep = false): Promise<AgentInfo[]> {
  return Promise.all(
    AGENT_PROVIDERS.map(async (p) => {
      const probe = await prober(p.command);
      let models = p.seedModels;
      if (probe.available && p.discoverModels) {
        try {
          const real = await p.discoverModels(p.command, deep);
          if (real.length) models = real;
        } catch {
          /* keep the seed on any discovery failure */
        }
      }
      return { id: p.id, command: p.command, available: probe.available, version: probe.version, models };
    }),
  );
}

// Probing every CLI is slow, so cache the result for the daemon's lifetime and only
// re-probe on an explicit rescan. The cache is also persisted to disk and reloaded at
// startup, so a restart shows the last (deep) scan instantly instead of re-probing.
let cache: AgentInfo[] | null = null;
let inflight: Promise<AgentInfo[]> | null = null;
let persistPath: string | null = null;

/** Persist a scan — but only one that actually found an agent, so a transient empty or
 *  failed probe (e.g. a momentary PATH glitch) never clobbers a good saved list. */
function persist(agents: AgentInfo[]): void {
  if (!persistPath || !agents.some((a) => a.available)) return;
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
        models: provider.seedModels,
      };
    }
    const models = cached.models.filter((model): model is string => typeof model === "string");
    return {
      id: provider.id,
      command: provider.command,
      available: cached.available === true,
      version: typeof cached.version === "string" ? cached.version : undefined,
      models: models.length ? models : provider.seedModels,
    };
  });
}

export async function getAgents(prober: AgentProber, force = false): Promise<AgentInfo[]> {
  if (cache && !force) return cache;
  if (!force && inflight) return inflight;
  // A forced rescan does a deep probe (e.g. CodeBuddy's slow PTY `/model list` scrape).
  inflight = detectAgents(prober, force).then((a) => {
    cache = a;
    inflight = null;
    persist(a);
    return a;
  });
  return inflight;
}

/** At daemon start, reload the last persisted scan so the first request is instant and
 *  accurate (survives restarts). Only probe from scratch if there's nothing saved yet. */
export function warmAgents(prober: AgentProber = defaultAgentProber, dataDir?: string): void {
  if (dataDir) persistPath = join(dataDir, "agents.json");
  const persisted = loadPersisted();
  if (persisted) {
    cache = persisted;
    return;
  }
  void getAgents(prober).catch(() => {});
}

export async function handleListAgents(res: ServerResponse, deps: AppDeps): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  sendJson(res, 200, await getAgents(prober));
}

export async function handleRescanAgents(res: ServerResponse, deps: AppDeps): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  sendJson(res, 200, await getAgents(prober, true));
}

export interface ScanProgress {
  id: string;
  label: string;
  /** "probe" = checking if the CLI exists; "models" = reading its model list (the slow bit). */
  phase: "probe" | "models";
}

/**
 * Like detectAgents but sequential, reporting which agent it's on so the UI can show real
 * per-agent progress ("Scanning CodeBuddy…"). Updates + persists the cache like getAgents.
 */
export async function scanAgentsStreaming(prober: AgentProber, deep: boolean, onProgress: (p: ScanProgress) => void): Promise<AgentInfo[]> {
  const results: AgentInfo[] = [];
  for (const p of AGENT_PROVIDERS) {
    onProgress({ id: p.id, label: p.label, phase: "probe" });
    const probe = await prober(p.command);
    let models = p.seedModels;
    if (probe.available && p.discoverModels) {
      onProgress({ id: p.id, label: p.label, phase: "models" });
      try {
        const real = await p.discoverModels(p.command, deep);
        if (real.length) models = real;
      } catch {
        /* keep the seed on any discovery failure */
      }
    }
    results.push({ id: p.id, command: p.command, available: probe.available, version: probe.version, models });
  }
  cache = results;
  inflight = null;
  persist(results);
  return results;
}

export async function handleScanAgentsStream(res: ServerResponse, deps: AppDeps): Promise<void> {
  const prober = deps.agentProber ?? defaultAgentProber;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const sse = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const agents = await scanAgentsStreaming(prober, true, (p) => sse({ type: "progress", ...p }));
    sse({ type: "done", agents });
  } catch {
    sse({ type: "done", agents: cache ?? [] });
  }
  res.end();
}
