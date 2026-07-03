import type { ApiClient, Settings } from "./api.ts";
import { publishSettingsUpdated } from "./settings-events.ts";

export type AgentModelDefaultsPatch = Pick<Settings, "agentCommand" | "model">;

export function persistAgentModelDefaults(
  api: ApiClient,
  patch: AgentModelDefaultsPatch,
  onError?: () => void,
): void {
  void Promise.resolve()
    .then(() => api.updateSettings(patch))
    .then(publishSettingsUpdated)
    .catch(() => onError?.());
}
