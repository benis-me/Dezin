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
import { copilotProvider } from "./copilot.ts";
import { qwenProvider } from "./qwen.ts";
import { opencodeProvider } from "./opencode.ts";
import { kimiProvider } from "./kimi.ts";
import { traeProvider } from "./trae.ts";
import { piProvider } from "./pi.ts";
import { hermesProvider } from "./hermes.ts";

// Order is the display/scan order (claude/codex/gemini lead).
export const AGENT_PROVIDERS: ReadonlyArray<AgentProvider> = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  codebuddyProvider,
  cursorAgentProvider,
  copilotProvider,
  qwenProvider,
  opencodeProvider,
  kimiProvider,
  traeProvider,
  piProvider,
  hermesProvider,
];

function commandBase(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

/** Resolve a provider by command (accepts a full path; matches id or command). */
export function getProvider(command: string): AgentProvider | undefined {
  const base = commandBase(command);
  return AGENT_PROVIDERS.find((p) => p.id === base || p.command === base);
}

/** The underlying model family that generated a run, for provider-fingerprint quality rules.
 *  Derived from the provider id, with the model name overriding when a provider is model-agnostic
 *  (e.g. cursor-agent running a GPT model). */
export function providerFamily(providerId?: string, model?: string): "gpt" | "gemini" | "claude" | "other" {
  const p = (providerId ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();
  if (p === "gemini" || /gemini/.test(m)) return "gemini";
  if (p === "claude" || /claude/.test(m)) return "claude";
  if (p === "codex" || p === "copilot" || /\bgpt|\bo1\b|\bo3\b|\bo4\b|codex/.test(m)) return "gpt";
  return "other";
}

/** Back-compat map of the generic (non-Claude) CLI argv configs, keyed by id. */
export const GENERIC_AGENTS: Record<string, GenericAgentConfig> = Object.fromEntries(
  AGENT_PROVIDERS.filter((p) => p.genericConfig).map((p) => [p.id, p.genericConfig!]),
);

export type { AgentProvider } from "./types.ts";
export { probeVersion, runCapture, augmentedPath, agentSpawnEnv, dedupModels, type VersionProbe } from "./cli.ts";
