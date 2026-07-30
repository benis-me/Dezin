import { getProvider } from "../../../packages/agent/src/index.ts";
import type { Settings } from "../../../packages/core/src/index.ts";
import {
  parseProviderProfiles,
  providerRuntimeConfig,
} from "./provider-profile-config.ts";

export type AgentProviderCredentialSource =
  | "provider-profile"
  | "agent"
  | "session";

export interface AgentProviderCredentialBinding {
  readonly agentProviderId: "claude" | "gemini";
  readonly credentialProviderId: "anthropic" | "gemini";
  readonly source: Exclude<AgentProviderCredentialSource, "session">;
  readonly baseUrl: string;
  readonly organization: string;
  readonly apiKey: string;
  readonly credentialRequired: boolean;
}

function credentialProviderId(
  agentProviderId: string,
): AgentProviderCredentialBinding["credentialProviderId"] | null {
  if (agentProviderId === "claude") return "anthropic";
  if (agentProviderId === "gemini") return "gemini";
  return null;
}

function validProviderProfileEnvelope(value: string | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Boolean(
      parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && Object.values(parsed).every((entry) => (
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
      )),
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the only credential binding a Claude/Gemini CLI may receive.
 *
 * Named profiles and a selected provider take precedence. The legacy
 * generic pair is accepted only while the profile envelope is truly absent,
 * no model provider claims it, and the configured Project Agent is
 * the same CLI principal. This makes Proposal freeze, Attempt hydration, and
 * process spawning agree on one provider/source boundary.
 */
export function resolveAgentProviderCredential(
  settings: Settings,
  agentProviderId: string,
): AgentProviderCredentialBinding | null {
  const exactCredentialProviderId = credentialProviderId(agentProviderId);
  if (exactCredentialProviderId === null) return null;

  const rawProfiles = settings.aiProviderProfiles?.trim() ?? "";
  if (!validProviderProfileEnvelope(rawProfiles)) return null;
  const profiles = parseProviderProfiles(rawProfiles);
  const exactProfile = profiles[exactCredentialProviderId];
  if (exactProfile !== undefined) {
    const runtime = providerRuntimeConfig(settings, exactCredentialProviderId);
    if (!runtime.enabled) return null;
    return Object.freeze({
      agentProviderId,
      credentialProviderId: exactCredentialProviderId,
      source: "provider-profile",
      baseUrl: agentProviderId === "claude" ? runtime.baseUrl.trim() : "",
      organization: agentProviderId === "claude" ? runtime.organization.trim() : "",
      apiKey: runtime.apiKey.trim(),
      credentialRequired: Boolean(runtime.apiKey.trim() || runtime.apiKeyConfigured),
    }) as AgentProviderCredentialBinding;
  }

  const selectedProviderId = (settings.aiProviderId ?? "").trim();
  if (selectedProviderId) {
    if (selectedProviderId !== exactCredentialProviderId) return null;
    const runtime = providerRuntimeConfig(settings, exactCredentialProviderId);
    if (!runtime.enabled) return null;
    return Object.freeze({
      agentProviderId,
      credentialProviderId: exactCredentialProviderId,
      source: "provider-profile",
      baseUrl: agentProviderId === "claude" ? runtime.baseUrl.trim() : "",
      organization: agentProviderId === "claude" ? runtime.organization.trim() : "",
      apiKey: runtime.apiKey.trim(),
      credentialRequired: Boolean(runtime.apiKey.trim() || runtime.apiKeyConfigured),
    }) as AgentProviderCredentialBinding;
  }

  // A non-empty profile envelope is an explicit credential namespace, even
  // when it has no profile for this CLI. Never relabel its generic key.
  if (rawProfiles) return null;
  const configuredAgentProviderId = getProvider(
    (settings.agentCommand ?? "").trim() || "claude",
  )?.id;
  if (configuredAgentProviderId !== agentProviderId) return null;
  const apiKey = (settings.apiKey ?? "").trim();
  const baseUrl = agentProviderId === "claude" ? (settings.apiBaseUrl ?? "").trim() : "";
  const organization = agentProviderId === "claude"
    ? (settings.aiProviderOrganization ?? "").trim()
    : "";
  const credentialRequired = Boolean(apiKey || settings.apiKeyConfigured);
  if (!apiKey && !baseUrl && !organization && !credentialRequired) return null;
  return Object.freeze({
    agentProviderId,
    credentialProviderId: exactCredentialProviderId,
    source: "agent",
    baseUrl,
    organization,
    apiKey,
    credentialRequired,
  }) as AgentProviderCredentialBinding;
}

/** Produces session-safe tombstones or one exclusive explicit credential binding. */
export function agentProviderCredentialEnvironment(
  agentProviderId: string,
  binding: AgentProviderCredentialBinding | null,
): NodeJS.ProcessEnv {
  if (agentProviderId === "claude") {
    const environment: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: binding?.apiKey || undefined,
      ANTHROPIC_BASE_URL: binding?.baseUrl || undefined,
    };
    if (binding !== null) {
      // agentSpawnEnv composes this over process.env. An explicit Claude
      // provider/profile must therefore erase every competing ambient auth
      // channel; otherwise Claude may prefer or combine a host OAuth/token
      // identity with the Attempt's frozen API credential.
      environment.ANTHROPIC_AUTH_TOKEN = undefined;
      environment.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    }
    return environment;
  }
  if (agentProviderId === "gemini") {
    return {
      GEMINI_API_KEY: binding?.apiKey || undefined,
      GOOGLE_API_KEY: binding?.apiKey || undefined,
    };
  }
  return {};
}

/** Binds an already-authorized Attempt directly, without re-reading Settings. */
export function agentProviderExecutionEnvironment(execution: {
  readonly providerId: string;
  readonly credentialProviderId: string;
  readonly credentialSource: AgentProviderCredentialSource;
  readonly baseUrl: string;
  readonly organization: string;
  readonly credentialRequired: boolean;
  readonly apiKey: string;
}): NodeJS.ProcessEnv {
  if (execution.providerId !== "claude" && execution.providerId !== "gemini") return {};
  if (execution.credentialSource === "session") {
    return agentProviderCredentialEnvironment(execution.providerId, null);
  }
  const expectedCredentialProviderId = credentialProviderId(execution.providerId);
  if (expectedCredentialProviderId === null
    || execution.credentialProviderId !== expectedCredentialProviderId) {
    return agentProviderCredentialEnvironment(execution.providerId, null);
  }
  return agentProviderCredentialEnvironment(execution.providerId, {
    agentProviderId: execution.providerId,
    credentialProviderId: expectedCredentialProviderId,
    source: execution.credentialSource,
    baseUrl: execution.baseUrl,
    organization: execution.organization,
    apiKey: execution.apiKey,
    credentialRequired: execution.credentialRequired,
  });
}
