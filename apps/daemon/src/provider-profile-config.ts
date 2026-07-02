import type { Settings } from "../../../packages/core/src/index.ts";

export interface ProviderProfileConfig {
  enabled?: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  models: string;
  organization: string;
}

export type ProviderProfilesConfig = Record<string, ProviderProfileConfig>;

export interface ProviderRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  models: string;
  organization: string;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseProviderProfiles(value: string | undefined): ProviderProfilesConfig {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const profiles: ProviderProfilesConfig = {};
    for (const [id, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const profile = raw as Record<string, unknown>;
      const enabled = booleanField(profile.enabled);
      const apiKey = stringField(profile.apiKey) ?? "";
      profiles[id] = {
        ...(enabled === undefined ? {} : { enabled }),
        baseUrl: stringField(profile.baseUrl) ?? "",
        apiKey,
        apiKeyConfigured: booleanField(profile.apiKeyConfigured) ?? Boolean(apiKey.trim()),
        models: stringField(profile.models) ?? "",
        organization: stringField(profile.organization) ?? "",
      };
    }
    return profiles;
  } catch {
    return {};
  }
}

export function serializeProviderProfiles(profiles: ProviderProfilesConfig): string {
  const clean: ProviderProfilesConfig = {};
  for (const [id, profile] of Object.entries(profiles)) {
    clean[id] = {
      enabled: Boolean(profile.enabled),
      baseUrl: profile.baseUrl ?? "",
      apiKey: profile.apiKey ?? "",
      apiKeyConfigured: Boolean(profile.apiKey?.trim() || profile.apiKeyConfigured),
      models: profile.models ?? "",
      organization: profile.organization ?? "",
    };
  }
  return JSON.stringify(clean);
}

export function redactProviderProfiles(value: string | undefined): string {
  const profiles = parseProviderProfiles(value);
  for (const profile of Object.values(profiles)) {
    profile.apiKeyConfigured = Boolean(profile.apiKey.trim() || profile.apiKeyConfigured);
    profile.apiKey = "";
  }
  return serializeProviderProfiles(profiles);
}

export function mergeProviderProfilesForUpdate(currentValue: string | undefined, incomingValue: string): string {
  const current = parseProviderProfiles(currentValue);
  const incoming = parseProviderProfiles(incomingValue);
  const merged: ProviderProfilesConfig = {};
  for (const [id, profile] of Object.entries(incoming)) {
    const incomingKey = profile.apiKey.trim();
    const currentKey = current[id]?.apiKey?.trim() ?? "";
    const shouldPreserveCurrentKey = !incomingKey && Boolean(profile.apiKeyConfigured) && Boolean(currentKey);
    const apiKey = incomingKey || (shouldPreserveCurrentKey ? currentKey : "");
    merged[id] = {
      ...profile,
      apiKey,
      apiKeyConfigured: Boolean(apiKey || profile.apiKeyConfigured),
    };
  }
  return serializeProviderProfiles(merged);
}

export function providerRuntimeConfig(settings: Settings, providerId: string, defaultBaseUrl = ""): ProviderRuntimeConfig {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  const profile = profiles[providerId];
  const selected = settings.aiProviderId === providerId;
  const hasProfile = Boolean(profile);
  const profileHasApiKey = Boolean(profile && hasOwn(profile, "apiKey"));
  const apiKey = profile?.apiKey?.trim() || (!profileHasApiKey && selected ? (settings.imageApiKey || settings.apiKey).trim() : "");

  return {
    enabled: profile && hasOwn(profile, "enabled") ? Boolean(profile.enabled) : selected ? settings.aiProviderEnabled : false,
    baseUrl:
      profile && hasOwn(profile, "baseUrl")
        ? profile.baseUrl.trim()
        : selected
          ? (settings.imageApiBaseUrl || settings.apiBaseUrl || defaultBaseUrl).trim()
          : defaultBaseUrl.trim(),
    apiKey,
    apiKeyConfigured: Boolean(apiKey || profile?.apiKeyConfigured || (selected && (settings.imageApiKeyConfigured || settings.apiKeyConfigured))),
    models: profile && hasOwn(profile, "models") ? profile.models : selected ? settings.aiProviderModels : "",
    organization:
      hasProfile && profile && hasOwn(profile, "organization")
        ? profile.organization.trim()
        : selected
          ? settings.aiProviderOrganization.trim()
          : "",
  };
}
