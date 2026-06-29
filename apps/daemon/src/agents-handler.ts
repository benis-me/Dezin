/**
 * GET /api/agents — detect which coding-agent CLIs are available on PATH, so the
 * Settings UI can show usable providers. The probe is injectable for tests.
 */

import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
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
  /** Curated known models for this agent (the latest first). */
  models: string[];
}

const KNOWN: ReadonlyArray<{ id: string; command: string; models: string[] }> = [
  { id: "claude", command: "claude", models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"] },
  { id: "codex", command: "codex", models: ["gpt-5-codex", "gpt-5", "o4-mini"] },
  { id: "gemini", command: "gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "cursor-agent", command: "cursor-agent", models: [] },
  { id: "opencode", command: "opencode", models: [] },
  { id: "aider", command: "aider", models: [] },
];

/** Real prober: `<command> --version`, with a short timeout. */
export const defaultAgentProber: AgentProber = (command) =>
  new Promise<AgentProbe>((resolve) => {
    let done = false;
    const finish = (probe: AgentProbe): void => {
      if (done) return;
      done = true;
      resolve(probe);
    };
    let child;
    try {
      child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish({ available: false });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      finish({ available: false });
    }, 3000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.on("error", () => {
      clearTimeout(timer);
      finish({ available: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ available: true, version: stdout.trim().split("\n")[0] || undefined });
      else finish({ available: false });
    });
  });

export async function detectAgents(prober: AgentProber): Promise<AgentInfo[]> {
  return Promise.all(
    KNOWN.map(async (a) => {
      const probe = await prober(a.command);
      return { id: a.id, command: a.command, available: probe.available, version: probe.version, models: a.models };
    }),
  );
}

// Probing every CLI's --version is slow, so cache the result for the daemon's lifetime
// and only re-probe on an explicit rescan.
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
