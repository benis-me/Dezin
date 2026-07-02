import type { Settings } from "../lib/api.ts";
import type { ModelCapability, ProviderPreset } from "./model-provider-registry.ts";
import { inferCapabilities, parseModelEntries, serializeModelEntries } from "./model-provider-ui-utils.tsx";

export interface ProviderProfile {
  baseUrl: string;
  models: string;
  organization: string;
}

type ProviderProfiles = Record<string, ProviderProfile>;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
      profiles[id] = {
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

export function providerProfile(settings: Settings, provider: ProviderPreset): ProviderProfile {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  const stored = profiles[provider.id];
  const selected = settings.aiProviderId === provider.id;
  return {
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
    baseUrl: patch.apiBaseUrl ?? patch.imageApiBaseUrl ?? current.baseUrl,
    models: patch.aiProviderModels ?? current.models,
    organization: patch.aiProviderOrganization ?? current.organization,
  };
  profiles[provider.id] = next;
  const syncedPatch: Partial<Settings> = { ...patch, aiProviderProfiles: serializeProviderProfiles(profiles) };
  if (patch.aiProviderModels != null) {
    syncedPatch.imageModel = preferredImageModel(next.models, provider, settings.imageModel);
  }
  return syncedPatch;
}

export function selectProviderProfilePatch(
  settings: Settings,
  currentProvider: ProviderPreset,
  nextProvider: ProviderPreset,
): Partial<Settings> {
  const profiles = parseProviderProfiles(settings.aiProviderProfiles);
  profiles[currentProvider.id] = providerProfile(settings, currentProvider);
  const settingsWithCurrentProfile = { ...settings, aiProviderProfiles: serializeProviderProfiles(profiles) };
  const next = providerProfile(settingsWithCurrentProfile, nextProvider);
  profiles[nextProvider.id] = next;
  return {
    aiProviderId: nextProvider.id,
    aiProviderModels: next.models,
    aiProviderOrganization: next.organization,
    apiBaseUrl: next.baseUrl,
    imageApiBaseUrl: next.baseUrl,
    videoApiBaseUrl: next.baseUrl,
    imageModel: preferredImageModel(next.models, nextProvider, settings.imageModel),
    aiProviderProfiles: serializeProviderProfiles(profiles),
  };
}
