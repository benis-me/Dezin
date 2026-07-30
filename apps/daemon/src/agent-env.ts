import type { Settings } from "../../../packages/core/src/index.ts";
import {
  CODEBUDDY_CREDENTIAL_ENVIRONMENT_KEYS,
  getProvider,
} from "../../../packages/agent/src/index.ts";
import {
  parseProviderProfiles,
  providerRuntimeConfig,
  serializeProviderProfiles,
} from "./provider-profile-config.ts";
import {
  agentProviderCredentialEnvironment,
  resolveAgentProviderCredential,
} from "./agent-provider-credential.ts";

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
  } else if (providerId === "claude" || providerId === "gemini") {
    Object.assign(
      env,
      agentProviderCredentialEnvironment(
        providerId,
        resolveAgentProviderCredential(settings, providerId),
      ),
    );
  } else if (providerId === "codex") {
    // Codex is selected as a locally authenticated coding Agent. The project
    // model-provider settings serve image/reviewer APIs and must not replace
    // the CLI's host login or leak in from the daemon environment.
    for (const key of CODEX_HOST_LOGIN_ENVIRONMENT_KEYS) env[key] = undefined;
  }

  // Lets the coding Agent authenticate to token-gated daemon endpoints (e.g. the
  // Sharingan browser-control probe routes) via the x-dezin-daemon-token header.
  setIfPresent(env, "DEZIN_DAEMON_TOKEN", daemonToken);

  return env;
}

/**
 * Builds credentials only for a frozen Claude Visual QA reviewer. CodeBuddy
 * and Codex reviewers authenticate through their official host login and therefore
 * receive no provider credentials here. A different provider's key must never
 * be relabeled.
 */
export function buildVisualReviewerEnv(
  settings: Settings,
  reviewerCommand: string = "claude",
): NodeJS.ProcessEnv {
  if (getProvider(reviewerCommand)?.id !== "claude") return {};
  const credential = resolveAgentProviderCredential(settings, "claude");
  if (credential?.credentialRequired && !credential.apiKey) {
    throw new Error(
      credential.source === "provider-profile"
        ? "Current credential for the frozen Anthropic visual reviewer is unavailable"
        : "Current credential for the frozen Claude visual reviewer is unavailable",
    );
  }
  return agentProviderCredentialEnvironment("claude", credential);
}

function sameEndpoint(left: string | undefined, right: string | undefined): boolean {
  const canonical = (value: string | undefined): string | null => {
    const raw = (value ?? "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if ((url.protocol !== "http:" && url.protocol !== "https:")
        || url.username || url.password || url.search || url.hash) return null;
      return url.href;
    } catch {
      return null;
    }
  };
  const leftEndpoint = canonical(left);
  return leftEndpoint !== null && leftEndpoint === canonical(right);
}

/**
 * Restores only the live credential that belongs to an immutable Claude,
 * CodeBuddy, or Codex reviewer selection. The returned Settings object is
 * quality-process-only; it must never be reused for the Page/Component builder.
 */
export function hydrateVisualReviewerSettings(
  frozenSettings: Settings,
  liveSettings: Settings,
  reviewer: { readonly command: string; readonly model?: string | null },
): Settings {
  const reviewerProviderId = getProvider(reviewer.command)?.id;
  if (reviewerProviderId !== "claude"
    && reviewerProviderId !== "codebuddy"
    && reviewerProviderId !== "codex") {
    throw new Error("Frozen visual reviewer must use a built-in structured-output command");
  }

  const frozenProfiles = parseProviderProfiles(frozenSettings.aiProviderProfiles);
  const liveProfiles = parseProviderProfiles(liveSettings.aiProviderProfiles);
  for (const profile of Object.values(frozenProfiles)) profile.apiKey = "";

  const quality: Settings = {
    ...structuredClone(frozenSettings),
    apiKey: "",
    apiKeyConfigured: false,
    imageApiKey: "",
    videoApiKey: "",
    aiProviderProfiles: (frozenSettings.aiProviderProfiles ?? "").trim()
      ? serializeProviderProfiles(frozenProfiles)
      : "",
    visualQaAgentCommand: reviewerProviderId,
    visualQaModel: reviewer.model ?? "",
  };
  if (reviewerProviderId === "codebuddy" || reviewerProviderId === "codex") return quality;

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
  const frozenCredential = resolveAgentProviderCredential(frozenSettings, "claude");
  const liveCredential = resolveAgentProviderCredential(liveSettings, "claude");
  if (frozenCredential?.source === "agent") {
    const liveStillMatches = liveCredential?.source === "agent"
      && sameEndpoint(frozenCredential.baseUrl, liveCredential.baseUrl);
    // Source or endpoint drift is an authority failure even when the frozen
    // snapshot used a host/session credential instead of an API key. Preserve
    // the frozen endpoint but force the existing spawn guard to fail closed.
    quality.apiKeyConfigured = liveStillMatches
      ? Boolean(frozenCredential.credentialRequired || liveCredential.credentialRequired)
      : true;
    if (liveStillMatches) {
      quality.apiKey = liveCredential.apiKey;
    }
  }
  return quality;
}
