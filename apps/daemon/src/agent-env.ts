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

/**
 * The Visual QA process is always Claude. Prefer an enabled Anthropic profile;
 * otherwise forward the generic project credential only when that project
 * Agent is itself Claude. A different provider's key must never be relabeled.
 */
export function buildVisualReviewerEnv(settings: Settings): NodeJS.ProcessEnv {
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
 * Restores only the live credential that belongs to the immutable Claude
 * reviewer semantics. The returned Settings object is quality-process-only:
 * it must never be reused for the Page/Component builder process.
 */
export function hydrateVisualReviewerSettings(
  frozenSettings: Settings,
  liveSettings: Settings,
  reviewer: { readonly command: string; readonly model?: string | null },
): Settings {
  if (reviewer.command !== "claude") {
    throw new Error("Frozen visual reviewer must use the canonical Claude command");
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
    visualQaAgentCommand: "claude",
    visualQaModel: reviewer.model ?? "",
  };

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
