import type { Settings } from "../lib/api.ts";
import type { ModelCapability, ProviderPreset } from "./model-provider-registry.ts";
import { inferCapabilities, parseModelEntries, serializeModelEntries } from "./model-provider-ui-utils.tsx";

export interface ProviderProfile {
  enabled?: boolean;
  baseUrl: string;
  models: string;
  organization: string;
}

type ProviderProfiles = Record<string, ProviderProfile>;
type ResolvedProviderProfile = ProviderProfile & { enabled: boolean };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseProviderProfiles(value: string | undefined): ProviderProfiles {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const profiles: ProviderProfiles = {};
    for (const [id, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const profile = raw as Record<string, unknown>;
      const enabled = booleanField(profile.enabled);
      profiles[id] = {
        ...(enabled === undefined ? {} : { enabled }),
        baseUrl: stringField(profile.baseUrl) ?? "",
        models: stringField(profile.models) ?? "",
        organization: stringField(profile.organization) ?? "",
      };
    }
    return profiles;
  } catch {
    return {};
  }
}

export function serializeProviderProfiles(profiles: ProviderProfiles): string {
  const clean: ProviderProfiles = {};
  for (const [id, profile] of Object.entries(profiles)) {
    clean[id] = {
      enabled: Boolean(profile.enabled),
      baseUrl: profile.baseUrl ?? "",
      models: profile.models ?? "",
      organization: profile.organization ?? "",
    };
  }
  return JSON.stringify(clean);
}

function defaultModels(provider: ProviderPreset): string {
  return serializeModelEntries(provider.models);
}

export function providerProfile(settings: Settings, provider: ProviderPreset): ResolvedProviderProfile {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  const stored = profiles[provider.id];
  const selected = settings.aiProviderId === provider.id;
  return {
    enabled: stored && hasOwn(stored, "enabled") ? Boolean(stored.enabled) : selected ? settings.aiProviderEnabled : false,
    baseUrl: stored && hasOwn(stored, "baseUrl") ? stored.baseUrl : selected ? settings.imageApiBaseUrl || settings.apiBaseUrl : provider.baseUrl,
    models: stored && hasOwn(stored, "models") ? stored.models : selected && settings.aiProviderModels ? settings.aiProviderModels : defaultModels(provider),
    organization:
      stored && hasOwn(stored, "organization") ? stored.organization : selected ? settings.aiProviderOrganization : "",
  };
}

function imageModelIds(modelsText: string, provider: ProviderPreset): string[] {
  const knownCapabilities = new Map<string, Set<ModelCapability>>();
  for (const model of provider.models) knownCapabilities.set(model.id, new Set(model.capabilities));
  const ids: string[] = [];
  for (const entry of parseModelEntries(modelsText)) {
    const known = knownCapabilities.get(entry.id);
    const capabilities = entry.capabilities ?? (known ? [...known] : inferCapabilities(entry.id));
    if (capabilities.includes("Image") && !capabilities.includes("Video")) ids.push(entry.id);
  }
  return ids;
}

export function preferredImageModel(modelsText: string, provider: ProviderPreset, current: string): string {
  const ids = imageModelIds(modelsText, provider);
  if (current && ids.includes(current)) return current;
  return ids[0] ?? current;
}

export function patchSelectedProviderProfile(
  settings: Settings,
  provider: ProviderPreset,
  patch: Partial<Settings>,
): Partial<Settings> {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  const current = providerProfile(settings, provider);
  const next: ProviderProfile = {
    enabled: patch.aiProviderEnabled ?? Boolean(current.enabled),
    baseUrl: patch.apiBaseUrl ?? patch.imageApiBaseUrl ?? current.baseUrl,
    models: patch.aiProviderModels ?? current.models,
    organization: patch.aiProviderOrganization ?? current.organization,
  };
  profiles[provider.id] = next;
  const active = settings.aiProviderId === provider.id;
  const globalPatch = active
    ? patch
    : Object.fromEntries(
        Object.entries(patch).filter(
          ([key]) => !["apiBaseUrl", "imageApiBaseUrl", "videoApiBaseUrl", "aiProviderModels", "aiProviderOrganization", "imageModel"].includes(key),
        ),
      );
  const syncedPatch: Partial<Settings> = { ...globalPatch, aiProviderProfiles: serializeProviderProfiles(profiles) };
  if (active && patch.aiProviderModels != null) {
    syncedPatch.imageModel = preferredImageModel(next.models, provider, settings.imageModel);
  }
  return syncedPatch;
}

function syncProviderToRuntime(settings: Settings, provider: ProviderPreset, profile: ProviderProfile): Partial<Settings> {
  return {
    aiProviderId: provider.id,
    aiProviderEnabled: Boolean(profile.enabled),
    aiProviderModels: profile.models,
    aiProviderOrganization: profile.organization,
    apiBaseUrl: profile.baseUrl,
    imageApiBaseUrl: profile.baseUrl,
    videoApiBaseUrl: profile.baseUrl,
    imageModel: preferredImageModel(profile.models, provider, settings.imageModel),
  };
}

export function enabledProviderIds(settings: Settings, providers: ProviderPreset[]): Set<string> {
  return new Set(providers.filter((provider) => providerProfile(settings, provider).enabled).map((provider) => provider.id));
}

export function setProviderEnabledPatch(
  settings: Settings,
  providers: ProviderPreset[],
  provider: ProviderPreset,
  enabled: boolean,
): Partial<Settings> {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  const nextProfile = { ...providerProfile(settings, provider), enabled };
  profiles[provider.id] = nextProfile;
  const nextProfiles = serializeProviderProfiles(profiles);
  const profileSettings = { ...settings, aiProviderProfiles: nextProfiles };
  const patch: Partial<Settings> = { aiProviderProfiles: nextProfiles };

  if (enabled) return { ...patch, ...syncProviderToRuntime(settings, provider, nextProfile), aiProviderProfiles: nextProfiles };

  if (settings.aiProviderId !== provider.id) return patch;

  const nextActive = providers.find((candidate) => candidate.id !== provider.id && providerProfile(profileSettings, candidate).enabled);
  if (!nextActive) return { ...patch, aiProviderEnabled: false, imageModel: "" };

  return {
    ...patch,
    ...syncProviderToRuntime(settings, nextActive, providerProfile(profileSettings, nextActive)),
    aiProviderProfiles: nextProfiles,
  };
}
