import type { Settings } from "../../../packages/core/src/index.ts";
import {
  CODEBUDDY_CREDENTIAL_ENVIRONMENT_KEYS,
  getProvider,
} from "../../../packages/agent/src/index.ts";

function setIfPresent(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) env[key] = trimmed;
}

const CODEX_HOST_LOGIN_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
] as const;

export function buildAgentEnv(settings: Settings, command: string, daemonToken?: string): NodeJS.ProcessEnv {
  const providerId = getProvider(command)?.id;
  const env: NodeJS.ProcessEnv = {};

  if (providerId === "codebuddy") {
    // CodeBuddy uses only its official host login. Explicit tombstones override
    // Settings-derived and ambient daemon provider credentials when the child
    // environment is composed.
    for (const key of CODEBUDDY_CREDENTIAL_ENVIRONMENT_KEYS) env[key] = undefined;
  } else if (providerId === "claude") {
    setIfPresent(env, "ANTHROPIC_API_KEY", settings.apiKey);
    setIfPresent(env, "ANTHROPIC_BASE_URL", settings.apiBaseUrl);
  } else if (providerId === "codex") {
    // Codex is selected as a locally authenticated coding Agent. The project
    // model-provider settings serve image/reviewer APIs and must not replace
    // the CLI's host login or leak in from the daemon environment.
    for (const key of CODEX_HOST_LOGIN_ENVIRONMENT_KEYS) env[key] = undefined;
  } else if (providerId === "gemini") {
    setIfPresent(env, "GEMINI_API_KEY", settings.apiKey);
    setIfPresent(env, "GOOGLE_API_KEY", settings.apiKey);
  }

  // Lets the coding Agent authenticate to token-gated daemon endpoints (e.g. the
  // Sharingan browser-control probe routes) via the x-dezin-daemon-token header.
  setIfPresent(env, "DEZIN_DAEMON_TOKEN", daemonToken);

  return env;
}
