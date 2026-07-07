import type { Settings } from "../../../packages/core/src/index.ts";
import { getProvider } from "../../../packages/agent/src/index.ts";

function setIfPresent(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) env[key] = trimmed;
}

export function buildAgentEnv(settings: Settings, command: string, daemonToken?: string): NodeJS.ProcessEnv {
  const providerId = getProvider(command)?.id;
  const env: NodeJS.ProcessEnv = {};

  if (providerId === "claude" || providerId === "codebuddy") {
    setIfPresent(env, "ANTHROPIC_API_KEY", settings.apiKey);
    setIfPresent(env, "ANTHROPIC_BASE_URL", settings.apiBaseUrl);
  } else if (providerId === "codex") {
    setIfPresent(env, "OPENAI_API_KEY", settings.apiKey);
    setIfPresent(env, "OPENAI_BASE_URL", settings.apiBaseUrl);
    setIfPresent(env, "OPENAI_ORG_ID", settings.aiProviderOrganization);
  } else if (providerId === "gemini") {
    setIfPresent(env, "GEMINI_API_KEY", settings.apiKey);
    setIfPresent(env, "GOOGLE_API_KEY", settings.apiKey);
  }

  // Lets the coding Agent authenticate to token-gated daemon endpoints (e.g. the
  // Sharingan browser-control probe routes) via the x-dezin-daemon-token header.
  setIfPresent(env, "DEZIN_DAEMON_TOKEN", daemonToken);

  return env;
}
