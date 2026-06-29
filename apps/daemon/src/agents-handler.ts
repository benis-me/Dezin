/**
 * GET /api/agents — detect which coding-agent CLIs are available and report their models.
 * The per-agent knowledge (command, models, discovery, runner) lives in the provider
 * registry (@dezin/agent providers); this file just drives the scan, caches it for the
 * daemon's lifetime, and serves the HTTP routes.
 */

import type { ServerResponse } from "node:http";
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

export async function detectAgents(prober: AgentProber): Promise<AgentInfo[]> {
  return Promise.all(
    AGENT_PROVIDERS.map(async (p) => {
      const probe = await prober(p.command);
      let models = p.seedModels;
      if (probe.available && p.discoverModels) {
        try {
          const real = await p.discoverModels(p.command);
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
// re-probe on an explicit rescan.
let cache: AgentInfo[] | null = null;
let inflight: Promise<AgentInfo[]> | null = null;

export async function getAgents(prober: AgentProber, force = false): Promise<AgentInfo[]> {
  if (cache && !force) return cache;
  if (!force && inflight) return inflight;
  inflight = detectAgents(prober).then((a) => {
    cache = a;
    inflight = null;
    return a;
  });
  return inflight;
}

/** Warm the cache in the background at daemon start so the first request is instant. */
export function warmAgents(prober: AgentProber = defaultAgentProber): void {
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
