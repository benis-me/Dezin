/**
 * GET /api/agents — detect which coding-agent CLIs are available (on an augmented PATH,
 * so agents in ~/.local/bin, /opt/homebrew/bin, nvm, etc. are found even when the daemon
 * has a minimal env) and report their models.
 *
 * Honest model discovery: most of these CLIs have NO headless "list models" command, so
 * we fall back to a curated seed per agent. CodeBuddy (a Claude-Code fork) is the exception
 * — it prints its real account model list in `--help` ("Currently supported: (id, id, …)"),
 * which we parse so the picker matches what the CLI actually offers. (Approach informed by
 * the vibeos provider scanner.)
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
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
  /** Models this agent offers — real (parsed from the CLI) when possible, else a seed. */
  models: string[];
}

interface KnownAgent {
  id: string;
  command: string;
  /** Best-effort default models (these CLIs mostly have no list command). */
  models: string[];
  /** Parse `--help` for a "Currently supported: (…)" model list (CodeBuddy and forks). */
  helpModels?: boolean;
}

const KNOWN: ReadonlyArray<KnownAgent> = [
  { id: "claude", command: "claude", models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"] },
  { id: "codex", command: "codex", models: ["gpt-5-codex", "gpt-5", "o3"] },
  { id: "gemini", command: "gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  // CodeBuddy is a Claude-Code fork; its real model list comes from --help at scan time.
  { id: "codebuddy", command: "codebuddy", models: ["claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"], helpModels: true },
  { id: "cursor-agent", command: "cursor-agent", models: ["gpt-5", "sonnet-4", "opus-4"] },
  { id: "opencode", command: "opencode", models: [] },
  { id: "aider", command: "aider", models: [] },
];

/** PATH augmented with well-known toolchain dirs so a minimal-env daemon still finds CLIs. */
function augmentedPath(): string {
  const home = homedir();
  const extra = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [process.env.PATH ?? "", ...extra].filter(Boolean).join(":");
}

/** Spawn `<command> <args>` on the augmented PATH and capture stdout+stderr (bounded). */
function runCapture(command: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: augmentedPath() } });
    } catch {
      return resolve(null);
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out });
    });
  });
}

/** Real prober: `<command> --version` on the augmented PATH, with a short timeout. */
export const defaultAgentProber: AgentProber = async (command) => {
  const r = await runCapture(command, ["--version"], 3000);
  if (!r || r.code !== 0) return { available: false };
  return { available: true, version: r.out.trim().split("\n")[0] || undefined };
};

/** Parse a CLI's `--help` for `Currently supported: (id, id, …)` (CodeBuddy lists models here). */
async function discoverHelpModels(command: string): Promise<string[]> {
  const r = await runCapture(command, ["--help"], 4000);
  if (!r) return [];
  const m = /Currently supported:\s*\(([^)]+)\)/i.exec(r.out);
  if (!m || !m[1]) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s));
}

export async function detectAgents(prober: AgentProber): Promise<AgentInfo[]> {
  return Promise.all(
    KNOWN.map(async (a) => {
      const probe = await prober(a.command);
      let models = a.models;
      if (probe.available && a.helpModels) {
        const real = await discoverHelpModels(a.command);
        if (real.length) models = real;
      }
      return { id: a.id, command: a.command, available: probe.available, version: probe.version, models };
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
