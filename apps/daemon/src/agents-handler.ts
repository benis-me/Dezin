/**
 * GET /api/agents — detect which coding-agent CLIs are available (on an augmented PATH,
 * so agents in ~/.local/bin, /opt/homebrew/bin, nvm, etc. are found even when the daemon
 * has a minimal env) and report their models.
 *
 * Model discovery probes each CLI the way it actually exposes models (approach informed by
 * the vibeos provider scanner):
 *   - codex:     `codex debug models` → JSON (uses the CLI's own login, no API key)
 *   - codebuddy: `--help` lists "Currently supported: (id, …)" (a Claude-Code fork)
 *   - gemini:    the Generative Language API /models, if GEMINI_API_KEY/GOOGLE_API_KEY is set
 *   - claude:    no list command → its stable aliases (opus/sonnet/haiku resolve to latest)
 *   - others:    a curated seed
 * Discovery falls back to the seed whenever the probe yields nothing.
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
  /** Models this agent offers — real (probed from the CLI/API) when possible, else a seed. */
  models: string[];
}

interface KnownAgent {
  id: string;
  command: string;
  /** Best-effort default models, used when live discovery yields nothing. */
  models: string[];
  /** Probe the CLI for its real model list (returns [] if unavailable). */
  discover?: (command: string) => Promise<string[]>;
}

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

const dedup = (ids: string[]): string[] => [...new Set(ids.filter((s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s)))];

/** Codex: `codex debug models` prints JSON of the account's models (no API key needed). */
async function discoverCodexModels(command: string): Promise<string[]> {
  const r = await runCapture(command, ["debug", "models"], 10_000);
  if (!r) return [];
  const start = r.out.indexOf("{");
  if (start === -1) return [];
  try {
    const json = JSON.parse(r.out.slice(start)) as { models?: Array<{ slug?: string; visibility?: string }> };
    const models = Array.isArray(json.models) ? json.models : [];
    return dedup(models.filter((m) => m.slug && m.visibility !== "hide" && m.visibility !== "hidden").map((m) => m.slug!));
  } catch {
    return [];
  }
}

/** CodeBuddy (and forks): `--help` lists models as "Currently supported: (id, id, …)". */
async function discoverHelpModels(command: string): Promise<string[]> {
  const r = await runCapture(command, ["--help"], 4000);
  if (!r) return [];
  const m = /Currently supported:\s*\(([^)]+)\)/i.exec(r.out);
  if (!m || !m[1]) return [];
  return dedup(m[1].split(",").map((s) => s.trim()));
}

/** Gemini: the CLI has no list command, but its API does — used only if a key is present. */
async function discoverGeminiModels(): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return dedup((json.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, "")).filter((n) => /gemini|gemma/i.test(n)));
  } catch {
    return [];
  }
}

const KNOWN: ReadonlyArray<KnownAgent> = [
  // Claude has no list command; offer its stable aliases (resolve to the latest model).
  { id: "claude", command: "claude", models: ["opus", "sonnet", "haiku"] },
  { id: "codex", command: "codex", models: ["gpt-5-codex", "gpt-5", "o3"], discover: discoverCodexModels },
  { id: "gemini", command: "gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"], discover: discoverGeminiModels },
  // CodeBuddy is a Claude-Code fork; its real model list comes from --help at scan time.
  { id: "codebuddy", command: "codebuddy", models: ["claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"], discover: discoverHelpModels },
  { id: "cursor-agent", command: "cursor-agent", models: ["gpt-5", "sonnet-4", "opus-4"] },
  { id: "opencode", command: "opencode", models: [] },
  { id: "aider", command: "aider", models: [] },
];

/** Real prober: `<command> --version` on the augmented PATH, with a short timeout. */
export const defaultAgentProber: AgentProber = async (command) => {
  const r = await runCapture(command, ["--version"], 3000);
  if (!r || r.code !== 0) return { available: false };
  return { available: true, version: r.out.trim().split("\n")[0] || undefined };
};

export async function detectAgents(prober: AgentProber): Promise<AgentInfo[]> {
  return Promise.all(
    KNOWN.map(async (a) => {
      const probe = await prober(a.command);
      let models = a.models;
      if (probe.available && a.discover) {
        try {
          const real = await a.discover(a.command);
          if (real.length) models = real;
        } catch {
          /* keep the seed on any discovery failure */
        }
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
