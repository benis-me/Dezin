/**
 * AgentProvider — one self-contained definition per coding-agent CLI: how it's named,
 * which models it offers (seed + live discovery), how it's spawned for generation, and
 * how it's invoked for a one-shot prompt (image analysis). The registry in ./index.ts
 * lists them; the daemon's scan, run loop, and analyzer all read from it.
 */

import type { AgentRunner } from "../types.ts";
import type { GenericAgentConfig } from "../generic-runner.ts";

export interface AgentProvider {
  /** Stable id (matches the UI's logo/label keys). */
  id: string;
  /** Default binary on PATH. */
  command: string;
  /** Human label. */
  label: string;
  /** Best-effort default models, used when live discovery yields nothing. */
  seedModels: string[];
  /** A fast, non-thinking model for quick passes (image analysis). */
  fastModel?: string;
  /** Generic CLI argv config (non-Claude agents); absent for the stream-json runner. */
  genericConfig?: GenericAgentConfig;
  /** Probe the CLI/API for its real model list (returns [] when unavailable). `deep` permits
   *  slow methods (e.g. a PTY scrape) that should only run on an explicit rescan, not at boot. */
  discoverModels?(command: string, deep?: boolean): Promise<string[]>;
  /** Build the generation runner. */
  createRunner(opts: { command: string; model?: string }): AgentRunner;
  /** Argv for a one-shot prompt that reads files in cwd (used by the image analyzer). */
  oneShotArgs(model: string | undefined, prompt: string): string[];
}
