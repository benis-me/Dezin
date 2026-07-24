import type { ApiClient, Settings } from "./api.ts";
import { publishSettingsUpdated } from "./settings-events.ts";

export type AgentModelDefaultsPatch = Pick<Settings, "agentCommand" | "model">;

function updateAgentModelDefaults(
  api: ApiClient,
  patch: AgentModelDefaultsPatch,
): Promise<void> {
  return Promise.resolve()
    .then(() => api.updateSettings(patch))
    .then((settings) => {
      publishSettingsUpdated(settings);
    });
}

export function persistAgentModelDefaults(
  api: ApiClient,
  patch: AgentModelDefaultsPatch,
  onError?: () => void,
): Promise<void> {
  return updateAgentModelDefaults(api, patch)
    .catch(() => onError?.());
}

export function persistAgentModelDefaultsStrict(
  api: ApiClient,
  patch: AgentModelDefaultsPatch,
  onError?: () => void,
): Promise<void> {
  return updateAgentModelDefaults(api, patch)
    .catch((error) => {
      onError?.();
      throw error;
    });
}
