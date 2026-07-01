import { useMemo, useState } from "react";
import type { Settings } from "../lib/api.ts";
import { ModelProviderDetail } from "./ModelProviderDetail.tsx";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";
import { MODEL_PROVIDERS, type ProviderPreset } from "./model-provider-registry.ts";
import { serializeModelEntries } from "./model-provider-ui-utils.tsx";

export function ModelProviderSettings({
  settings,
  onLocalPatch,
  onSavePatch,
}: {
  settings: Settings;
  onLocalPatch: (patch: Partial<Settings>) => void;
  onSavePatch: (patch: Partial<Settings>) => void;
}) {
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

  return (
    <div className="flex h-full min-h-[560px] overflow-hidden">
      <ModelProviderSidebar
        providers={providers}
        selectedId={selected.id}
        activeProviderId={settings.aiProviderId}
        enabled={settings.aiProviderEnabled}
        apiKey={apiKey}
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
        onTestConnection={() => setStatus(apiKey || selected.id === "mock" || selected.id === "ollama" ? "Looks configured locally." : "Missing API key.")}
        onLoadPresetModels={() => {
          const next = serializeModelEntries(selected.models);
          patchModelSettings({ aiProviderModels: next }, true);
          setStatus(`Loaded ${selected.models.length} preset models.`);
        }}
      />
    </div>
  );
}
