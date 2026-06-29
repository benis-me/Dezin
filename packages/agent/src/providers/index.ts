/**
 * The agent provider registry — the single source of truth for every coding-agent CLI
 * Dezin supports. The daemon's scan, the run loop's runner pick, and the image analyzer
 * all read from here; adding an agent means adding one provider file + one line below.
 */

import type { GenericAgentConfig } from "../generic-runner.ts";
import type { AgentProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { geminiProvider } from "./gemini.ts";
import { codebuddyProvider } from "./codebuddy.ts";
import { cursorAgentProvider } from "./cursor-agent.ts";
import { opencodeProvider } from "./opencode.ts";
import { aiderProvider } from "./aider.ts";

// Order is the display/scan order (claude/codex/gemini lead).
export const AGENT_PROVIDERS: ReadonlyArray<AgentProvider> = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  codebuddyProvider,
  cursorAgentProvider,
  opencodeProvider,
  aiderProvider,
];

/** Resolve a provider by command (accepts a full path; matches id or command). */
export function getProvider(command: string): AgentProvider | undefined {
  const base = command.split("/").pop() ?? command;
  return AGENT_PROVIDERS.find((p) => p.id === base || p.command === base);
}

/** Back-compat map of the generic (non-Claude) CLI argv configs, keyed by id. */
export const GENERIC_AGENTS: Record<string, GenericAgentConfig> = Object.fromEntries(
  AGENT_PROVIDERS.filter((p) => p.genericConfig).map((p) => [p.id, p.genericConfig!]),
);

export type { AgentProvider } from "./types.ts";
export { probeVersion, runCapture, augmentedPath, dedupModels, type VersionProbe } from "./cli.ts";
