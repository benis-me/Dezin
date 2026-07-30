import { isDeepStrictEqual } from "node:util";
import type {
  Settings,
  WorkspaceGenerationMoodboardImageAuthority,
} from "../../../../packages/core/src/index.ts";
import {
  parseProviderProfiles,
  providerRuntimeConfig,
} from "../provider-profile-config.ts";
import { ContextIntegrityError } from "../context/context-types.ts";

export const WORKSPACE_MOODBOARD_IMAGE_AUTHORITY_PROTOCOL =
  "dezin.workspace-moodboard-image-authority.v1" as const;

const DEFAULT_IMAGE_PROVIDER_BASE_URLS = Object.freeze({
  fal: "https://fal.run",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  vertex: "https://aiplatform.googleapis.com/v1/publishers/google",
} as const);
const DEFAULT_AZURE_OPENAI_IMAGE_API_VERSION = "2025-04-01-preview";

function canonicalCredentialFreeBaseUrl(value: string, providerId: string): string {
  const configured = value.trim();
  const raw = configured || DEFAULT_IMAGE_PROVIDER_BASE_URLS[
    providerId as keyof typeof DEFAULT_IMAGE_PROVIDER_BASE_URLS
  ];
  if (!raw) {
    throw new ContextIntegrityError(
      `Moodboard image provider ${providerId} requires an explicit base URL`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ContextIntegrityError(
      `Moodboard image provider base URL is invalid: ${String(error)}`,
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0
    || url.search.length > 0 || url.hash.length > 0
    || (raw !== url.href && `${raw}/` !== url.href)) {
    throw new ContextIntegrityError(
      "Moodboard image provider base URL must be canonical and credential-free",
    );
  }
  if (providerId === "azure-openai" || url.hostname.endsWith(".openai.azure.com")) {
    const path = url.pathname.replace(/\/+$/, "");
    const openaiIndex = path.indexOf("/openai");
    url.pathname = openaiIndex >= 0
      ? path.slice(0, openaiIndex + "/openai".length)
      : `${path}/openai`;
  } else if (providerId === "gemini") {
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/openai$/, "");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolves the single credential source and every non-secret image semantic at
 * Proposal time. Provider-profile credentials have deterministic precedence.
 */
export function workspaceMoodboardImageAuthority(
  settings: Settings,
): WorkspaceGenerationMoodboardImageAuthority {
  const providerId = settings.aiProviderId.trim();
  if (!providerId) {
    throw new ContextIntegrityError("Moodboard image generation requires a selected provider");
  }
  const runtime = providerRuntimeConfig(settings, providerId);
  if (!runtime.enabled) {
    throw new ContextIntegrityError(
      `Moodboard image provider ${providerId} must be enabled`,
    );
  }
  const profile = parseProviderProfiles(settings.aiProviderProfiles)[providerId];
  const profileKey = profile?.apiKey.trim() ?? "";
  const globalKey = settings.imageApiKey.trim();
  const credentialSource = profileKey || profile?.apiKeyConfigured
    ? "provider-profile" as const
    : globalKey || settings.imageApiKeyConfigured
      ? "global-image" as const
      : null;
  if (credentialSource === null) {
    throw new ContextIntegrityError(
      `Moodboard image provider ${providerId} requires a configured credential`,
    );
  }
  const model = settings.imageModel.trim();
  if (!model) {
    throw new ContextIntegrityError("Moodboard image generation requires an image model");
  }
  const baseUrl = canonicalCredentialFreeBaseUrl(
    runtime.baseUrl || settings.imageApiBaseUrl,
    providerId,
  );
  const azureOpenAi = providerId === "azure-openai"
    || new URL(baseUrl).hostname.endsWith(".openai.azure.com");
  const configuredApiVersion = (runtime.organization || settings.aiProviderOrganization).trim();
  return Object.freeze({
    kind: "moodboard-image",
    protocol: WORKSPACE_MOODBOARD_IMAGE_AUTHORITY_PROTOCOL,
    providerId,
    baseUrl,
    model,
    apiVersion: configuredApiVersion
      || (azureOpenAi ? DEFAULT_AZURE_OPENAI_IMAGE_API_VERSION : ""),
    credentialSource,
    credentialRequired: true,
  });
}

export function assertWorkspaceMoodboardImageAuthorityMatchesSettings(
  settings: Settings,
  frozen: WorkspaceGenerationMoodboardImageAuthority,
): void {
  let current: WorkspaceGenerationMoodboardImageAuthority;
  try {
    current = workspaceMoodboardImageAuthority(settings);
  } catch (error) {
    throw new ContextIntegrityError(
      `Current Settings cannot resolve the frozen Moodboard image execution authority: ${String(error)}`,
    );
  }
  if (!isDeepStrictEqual(current, frozen)) {
    throw new ContextIntegrityError(
      "Current Settings do not match the frozen Moodboard image provider, endpoint, model, API version, credential source, or credential requirement",
    );
  }
}

export function hydrateWorkspaceMoodboardImageAuthority(
  settings: Settings,
  frozen: WorkspaceGenerationMoodboardImageAuthority,
): WorkspaceGenerationMoodboardImageAuthority & { readonly apiKey: string } {
  assertWorkspaceMoodboardImageAuthorityMatchesSettings(settings, frozen);
  const apiKey = frozen.credentialSource === "provider-profile"
    ? parseProviderProfiles(settings.aiProviderProfiles)[frozen.providerId]?.apiKey.trim() ?? ""
    : settings.aiProviderId.trim() === frozen.providerId
      ? settings.imageApiKey.trim()
      : "";
  if (frozen.credentialRequired && !apiKey) {
    throw new ContextIntegrityError(
      "Current credential for the frozen Moodboard image authority is unavailable",
    );
  }
  return Object.freeze({ ...frozen, apiKey });
}
