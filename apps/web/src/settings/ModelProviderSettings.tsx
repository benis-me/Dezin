import { useMemo, useState } from "react";
import type { Settings } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { ModelProviderDetail } from "./ModelProviderDetail.tsx";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";
import { MODEL_PROVIDERS, type ProviderPreset } from "./model-provider-registry.ts";
import { isModelCapability, serializeModelEntries } from "./model-provider-ui-utils.tsx";
import { enabledProviderIds, patchSelectedProviderProfile, providerProfile, setProviderEnabledPatch } from "./provider-profiles.ts";

const VISIBLE_MODEL_PROVIDERS = MODEL_PROVIDERS;

export function ModelProviderSettings({
  settings,
  onLocalPatch,
  onSavePatch,
}: {
  settings: Settings;
  onLocalPatch: (patch: Partial<Settings>) => void;
  onSavePatch: (patch: Partial<Settings>) => void;
}) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(settings.aiProviderId);
  const selected =
    VISIBLE_MODEL_PROVIDERS.find((provider) => provider.id === selectedId) ??
    VISIBLE_MODEL_PROVIDERS.find((provider) => provider.id === settings.aiProviderId) ??
    VISIBLE_MODEL_PROVIDERS[0]!;
  const providers = useMemo(
    () => VISIBLE_MODEL_PROVIDERS.filter((provider) => provider.name.toLowerCase().includes(query.trim().toLowerCase())),
    [query],
  );
  const profile = providerProfile(settings, selected);
  const detailSettings = { ...settings, aiProviderEnabled: profile.enabled, aiProviderModels: profile.models, aiProviderOrganization: profile.organization };
  const modelText = profile.models;
  const baseUrl = profile.baseUrl;
  const apiKey = settings.imageApiKey || settings.apiKey;
  const enabledIds = enabledProviderIds(settings, VISIBLE_MODEL_PROVIDERS);

  const patchModelSettings = (patch: Partial<Settings>, save = false) => {
    const nextPatch = patchSelectedProviderProfile(settings, selected, patch);
    onLocalPatch(nextPatch);
    if (save) onSavePatch(nextPatch);
  };

  const selectProvider = (provider: ProviderPreset) => {
    setStatus(null);
    setSelectedId(provider.id);
  };

  const testConnection = async () => {
    setStatus("Testing connection...");
    try {
      const result = await api.testModelProvider(selected.id);
      setStatus(result.message);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't test connection.");
    }
  };

  const loadLiveModels = async () => {
    setStatus("Loading models...");
    try {
      const result = await api.listModelProviderModels(selected.id);
      if (result.models.length === 0) {
        setStatus("No live models returned.");
        return;
      }
      const next = serializeModelEntries(
        result.models.map((model) => ({
          id: model.id,
          name: model.name,
          capabilities: model.capabilities?.filter(isModelCapability),
        })),
      );
      patchModelSettings({ aiProviderModels: next }, true);
      setStatus(`Loaded ${result.models.length} live ${result.models.length === 1 ? "model" : "models"}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't load model list.");
    }
  };

  return (
    <div className="flex h-full min-h-[560px] overflow-hidden">
      <ModelProviderSidebar
        providers={providers}
        selectedId={selected.id}
        enabledProviderIds={enabledIds}
        query={query}
        onQueryChange={setQuery}
        onSelect={selectProvider}
      />
      <ModelProviderDetail
        selected={selected}
        settings={detailSettings}
        apiKey={apiKey}
        baseUrl={baseUrl}
        modelText={modelText}
        status={status}
        onToggleEnabled={() => onSavePatch(setProviderEnabledPatch(settings, VISIBLE_MODEL_PROVIDERS, selected, !profile.enabled))}
        onPatchModelSettings={patchModelSettings}
        onTestConnection={() => void testConnection()}
        onLoadPresetModels={() => void loadLiveModels()}
      />
    </div>
  );
}
