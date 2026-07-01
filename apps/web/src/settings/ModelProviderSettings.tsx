import { useMemo, useState } from "react";
import type { Settings } from "../lib/api.ts";
import { ModelProviderDetail } from "./ModelProviderDetail.tsx";
import { ModelProviderSidebar } from "./ModelProviderSidebar.tsx";
import { MODEL_PROVIDERS, type ProviderPreset } from "./model-provider-registry.ts";
import { modelTextToIds } from "./model-provider-ui-utils.tsx";

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
  const modelText = settings.aiProviderModels || selected.models.map((model) => model.id).join("\n");
  const baseUrl = settings.imageApiBaseUrl || settings.apiBaseUrl || selected.baseUrl;
  const apiKey = settings.imageApiKey || settings.apiKey;

  const patchModelSettings = (patch: Partial<Settings>, save = false) => {
    onLocalPatch(patch);
    if (save) onSavePatch(patch);
  };

  const saveSelectedProvider = () => {
    const models = modelTextToIds(modelText);
    const firstImageModel = models.find((model) => /image|flux|imagen|seedream|midjourney/i.test(model)) ?? models[0] ?? "";
    const firstVideoModel = models.find((model) => /video|veo|wan|sora/i.test(model)) ?? "";
    onSavePatch({
      aiProviderId: selected.id,
      aiProviderEnabled: settings.aiProviderEnabled,
      aiProviderModels: models.join("\n"),
      aiProviderOrganization: settings.aiProviderOrganization,
      apiBaseUrl: baseUrl,
      apiKey,
      imageApiBaseUrl: baseUrl,
      imageApiKey: apiKey,
      imageModel: firstImageModel,
      videoApiBaseUrl: baseUrl,
      videoApiKey: apiKey,
      videoModel: firstVideoModel || settings.videoModel,
    });
    setStatus("Configuration saved.");
  };

  const selectProvider = (provider: ProviderPreset) => {
    setStatus(null);
    onSavePatch({
      aiProviderId: provider.id,
      aiProviderModels: provider.models.map((model) => model.id).join("\n"),
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
        onSaveSelectedProvider={saveSelectedProvider}
        onTestConnection={() => setStatus(apiKey || selected.id === "mock" || selected.id === "ollama" ? "Looks configured locally." : "Missing API key.")}
        onLoadPresetModels={() => {
          const next = selected.models.map((model) => model.id).join("\n");
          patchModelSettings({ aiProviderModels: next }, true);
          setStatus(`Loaded ${selected.models.length} preset models.`);
        }}
      />
    </div>
  );
}
