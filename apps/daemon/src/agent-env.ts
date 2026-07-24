import type { Settings } from "../../../packages/core/src/index.ts";
import { getProvider } from "../../../packages/agent/src/index.ts";
import {
  parseProviderProfiles,
  providerRuntimeConfig,
  serializeProviderProfiles,
} from "./provider-profile-config.ts";

function setIfPresent(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) env[key] = trimmed;
}

const CODEBUDDY_PROVIDER_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEBUDDY_API_KEY",
  "CODEBUDDY_AUTH_TOKEN",
  "CODEBUDDY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
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
    for (const key of CODEBUDDY_PROVIDER_ENVIRONMENT_KEYS) env[key] = undefined;
  } else if (providerId === "claude") {
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

/**
 * Builds credentials only for a frozen Claude Visual QA reviewer. CodeBuddy
 * reviewers authenticate through their official host login and therefore
 * receive no provider credentials here. A different provider's key must never
 * be relabeled.
 */
export function buildVisualReviewerEnv(
  settings: Settings,
  reviewerCommand: string = "claude",
): NodeJS.ProcessEnv {
  if (getProvider(reviewerCommand)?.id !== "claude") return {};
  const profile = providerRuntimeConfig(settings, "anthropic");
  if (profile.enabled) {
    if (profile.apiKeyConfigured && !profile.apiKey.trim()) {
      throw new Error("Current credential for the frozen Anthropic visual reviewer is unavailable");
    }
    const env: NodeJS.ProcessEnv = {};
    setIfPresent(env, "ANTHROPIC_API_KEY", profile.apiKey);
    setIfPresent(env, "ANTHROPIC_BASE_URL", profile.baseUrl);
    return env;
  }
  if (getProvider(settings.agentCommand)?.id !== "claude") return {};
  if (settings.apiKeyConfigured && !settings.apiKey.trim()) {
    throw new Error("Current credential for the frozen Claude visual reviewer is unavailable");
  }
  return buildAgentEnv(settings, "claude");
}

function sameEndpoint(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").trim() === (right ?? "").trim();
}

/**
 * Restores only the live credential that belongs to an immutable Claude or
 * CodeBuddy reviewer selection. The returned Settings object is
 * quality-process-only; it must never be reused for the Page/Component builder.
 */
export function hydrateVisualReviewerSettings(
  frozenSettings: Settings,
  liveSettings: Settings,
  reviewer: { readonly command: string; readonly model?: string | null },
): Settings {
  const reviewerProviderId = getProvider(reviewer.command)?.id;
  if (reviewerProviderId !== "claude" && reviewerProviderId !== "codebuddy") {
    throw new Error("Frozen visual reviewer must use a built-in structured-output command");
  }

  const frozenProfiles = parseProviderProfiles(frozenSettings.aiProviderProfiles);
  const liveProfiles = parseProviderProfiles(liveSettings.aiProviderProfiles);
  for (const profile of Object.values(frozenProfiles)) profile.apiKey = "";

  const quality: Settings = {
    ...structuredClone(frozenSettings),
    apiKey: "",
    imageApiKey: "",
    videoApiKey: "",
    aiProviderProfiles: serializeProviderProfiles(frozenProfiles),
    visualQaAgentCommand: reviewerProviderId,
    visualQaModel: reviewer.model ?? "",
  };
  if (reviewerProviderId === "codebuddy") return quality;

  // A frozen explicit profile is authoritative. Live endpoint/model/org
  // changes cannot enter the Attempt; only its exact provider credential can.
  const frozenAnthropic = frozenProfiles.anthropic;
  if (frozenAnthropic?.enabled) {
    const liveAnthropic = liveProfiles.anthropic;
    if (
      liveAnthropic?.enabled
      && sameEndpoint(frozenAnthropic.baseUrl, liveAnthropic.baseUrl)
    ) {
      frozenAnthropic.apiKey = liveAnthropic.apiKey.trim();
    }
    quality.aiProviderProfiles = serializeProviderProfiles(frozenProfiles);
    return quality;
  }

  // Legacy global-provider settings may select Anthropic without a serialized
  // profile. Bind its key only while the live provider and endpoint still
  // identify that same frozen reviewer service.
  if (
    !frozenAnthropic
    && frozenSettings.aiProviderId === "anthropic"
    && frozenSettings.aiProviderEnabled
  ) {
    const frozenRuntime = providerRuntimeConfig(quality, "anthropic");
    const liveRuntime = providerRuntimeConfig(liveSettings, "anthropic");
    const liveStillMatches = liveSettings.aiProviderId === "anthropic"
      && liveSettings.aiProviderEnabled
      && liveRuntime.enabled
      && sameEndpoint(frozenRuntime.baseUrl, liveRuntime.baseUrl);
    if (liveStillMatches) quality.apiKey = liveRuntime.apiKey.trim();
    quality.apiKeyConfigured = Boolean(
      frozenRuntime.apiKeyConfigured
      || (liveSettings.aiProviderId === "anthropic" && liveRuntime.apiKeyConfigured),
    );
    return quality;
  }

  // The generic BYOK pair belongs to the project Agent. It is a valid Claude
  // reviewer credential only if both snapshots still identify Claude and the
  // immutable endpoint did not drift.
  const frozenAgentIsClaude = getProvider(frozenSettings.agentCommand)?.id === "claude";
  const liveAgentIsClaude = getProvider(liveSettings.agentCommand)?.id === "claude";
  if (frozenAgentIsClaude && liveAgentIsClaude) {
    quality.apiKeyConfigured = Boolean(
      frozenSettings.apiKeyConfigured
      || liveSettings.apiKeyConfigured
      || liveSettings.apiKey.trim(),
    );
    if (sameEndpoint(frozenSettings.apiBaseUrl, liveSettings.apiBaseUrl)) {
      quality.apiKey = liveSettings.apiKey.trim();
    }
  }
  return quality;
}
