import { useMemo, useState } from "react";
import type { Settings } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { ModelProviderDetail } from "./ModelProviderDetail.tsx";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";
import { MODEL_PROVIDERS, type ProviderPreset } from "./model-provider-registry.ts";
import { isModelCapability, serializeModelEntries } from "./model-provider-ui-utils.tsx";

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
  const selected = MODEL_PROVIDERS.find((provider) => provider.id === settings.aiProviderId) ?? MODEL_PROVIDERS[0]!;
  const providers = useMemo(
    () => MODEL_PROVIDERS.filter((provider) => provider.name.toLowerCase().includes(query.trim().toLowerCase())),
    [query],
  );
  const modelText = settings.aiProviderModels || serializeModelEntries(selected.models);
  const baseUrl = settings.imageApiBaseUrl || settings.apiBaseUrl || selected.baseUrl;
  const apiKey = settings.imageApiKey || settings.apiKey;
  const apiKeyConfigured = Boolean(apiKey || settings.imageApiKeyConfigured || settings.apiKeyConfigured);

  const patchModelSettings = (patch: Partial<Settings>, save = false) => {
    onLocalPatch(patch);
    if (save) onSavePatch(patch);
  };

  const selectProvider = (provider: ProviderPreset) => {
    setStatus(null);
    onSavePatch({
      aiProviderId: provider.id,
      aiProviderModels: serializeModelEntries(provider.models),
      apiBaseUrl: provider.baseUrl,
      imageApiBaseUrl: provider.baseUrl,
      videoApiBaseUrl: provider.baseUrl,
    });
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
        activeProviderId={settings.aiProviderId}
        enabled={settings.aiProviderEnabled}
        apiKey={apiKey}
        apiKeyConfigured={apiKeyConfigured}
        query={query}
        onQueryChange={setQuery}
        onSelect={selectProvider}
      />
      <ModelProviderDetail
        selected={selected}
        settings={settings}
        apiKey={apiKey}
        baseUrl={baseUrl}
        modelText={modelText}
        status={status}
        onToggleEnabled={() => onSavePatch({ aiProviderEnabled: !settings.aiProviderEnabled })}
        onPatchModelSettings={patchModelSettings}
        onTestConnection={() => void testConnection()}
        onLoadPresetModels={() => void loadLiveModels()}
      />
    </div>
  );
}
