import {
  GenericCliRunner,
  getProvider,
  type AgentRunner,
} from "@dezin/agent";
import type { Settings } from "@dezin/core";

/** Build a provider-backed Agent runner from the current local BYOK settings. */
export function buildAgentRunner(
  settings: Settings,
  override: { agentCommand?: string; model?: string } = {},
): AgentRunner {
  const command = override.agentCommand || settings.agentCommand || "claude";
  const model = override.model || settings.model || undefined;
  const provider = getProvider(command);
  if (provider) return provider.createRunner({ command, model, enforceArtifactUpdate: false });

  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return new GenericCliRunner({
    id: base,
    command,
    model,
    config: { buildArgs: (candidateModel, prompt) => [...(candidateModel ? ["--model", candidateModel] : []), prompt] },
    enforceArtifactUpdate: false,
  });
}
