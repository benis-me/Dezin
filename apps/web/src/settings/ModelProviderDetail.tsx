import { ExternalLink, KeyRound, RotateCw, Save, TestTube2 } from "lucide-react";
import type { Settings } from "../lib/api.ts";
import { Badge, Button, Field, Input, Textarea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import type { ProviderPreset } from "./model-provider-registry.ts";
import { inferCapabilities, modelTextToIds, ProviderIcon } from "./model-provider-ui-utils.tsx";

export function ModelProviderDetail({
  selected,
  settings,
  apiKey,
  baseUrl,
  modelText,
  status,
  onToggleEnabled,
  onPatchModelSettings,
  onSaveSelectedProvider,
  onTestConnection,
  onLoadPresetModels,
}: {
  selected: ProviderPreset;
  settings: Settings;
  apiKey: string;
  baseUrl: string;
  modelText: string;
  status: string | null;
  onToggleEnabled: () => void;
  onPatchModelSettings: (patch: Partial<Settings>, save?: boolean) => void;
  onSaveSelectedProvider: () => void;
  onTestConnection: () => void;
  onLoadPresetModels: () => void;
}) {
  return (
    <section className="min-w-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderIcon id={selected.id} className="size-5" />
            <h2 className="truncate text-base font-semibold tracking-tight">{selected.name}</h2>
            {selected.docsUrl ? (
              <a href={selected.docsUrl} target="_blank" rel="noreferrer" aria-label={`${selected.name} docs`} className="text-muted-foreground hover:text-foreground">
                <ExternalLink size={14} strokeWidth={1.75} />
              </a>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{selected.protocol}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={`Enable ${selected.name}`}
          aria-checked={settings.aiProviderEnabled}
          onClick={onToggleEnabled}
          className={cn(
            "relative h-6 w-10 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            settings.aiProviderEnabled ? "border-primary bg-primary" : "border-border bg-surface-2",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
              settings.aiProviderEnabled ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
      </div>

      <div className="space-y-6 p-5 pb-12">
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound size={15} strokeWidth={1.75} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Connection</h3>
          </div>
          <Field label="API Key *">
            <Input
              type="password"
              value={apiKey}
              placeholder={selected.keyPlaceholder}
              aria-label="Provider API key"
              onChange={(event) => onPatchModelSettings({ apiKey: event.target.value, imageApiKey: event.target.value, videoApiKey: event.target.value })}
              onBlur={(event) => onPatchModelSettings({ apiKey: event.target.value, imageApiKey: event.target.value, videoApiKey: event.target.value }, true)}
            />
          </Field>
          <Field label="Base URL">
            <Input
              value={baseUrl}
              placeholder={selected.baseUrl || "https://..."}
              aria-label="Provider base URL"
              onChange={(event) =>
                onPatchModelSettings({ apiBaseUrl: event.target.value, imageApiBaseUrl: event.target.value, videoApiBaseUrl: event.target.value })
              }
              onBlur={(event) =>
                onPatchModelSettings({ apiBaseUrl: event.target.value, imageApiBaseUrl: event.target.value, videoApiBaseUrl: event.target.value }, true)
              }
            />
          </Field>
          <p className="text-xs text-muted-foreground">OpenAI-compatible image generation uses this endpoint for Moodboard generator nodes.</p>
          <Field label="Organization">
            <Input
              value={settings.aiProviderOrganization}
              placeholder="optional"
              aria-label="Provider organization"
              onChange={(event) => onPatchModelSettings({ aiProviderOrganization: event.target.value })}
              onBlur={(event) => onPatchModelSettings({ aiProviderOrganization: event.target.value }, true)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onSaveSelectedProvider}>
              <Save size={14} strokeWidth={1.75} />
              Save configuration
            </Button>
            <Button size="sm" variant="outline" onClick={onTestConnection}>
              <TestTube2 size={14} strokeWidth={1.75} />
              Test connection
            </Button>
            <Button size="sm" variant="outline" onClick={onLoadPresetModels}>
              <RotateCw size={14} strokeWidth={1.75} />
              Get model list
            </Button>
            {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
          </div>
        </section>

        <section className="border-t border-border pt-5">
          <div>
            <h3 className="text-sm font-semibold">Models</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">One model id per line. Dezin uses image-capable models for Moodboard generation.</p>
          </div>
          <Textarea
            value={modelText}
            aria-label="Provider model ids"
            onChange={(event) => onPatchModelSettings({ aiProviderModels: event.target.value })}
            onBlur={(event) => onPatchModelSettings({ aiProviderModels: event.target.value }, true)}
            className="mt-3 min-h-28 resize-none font-mono text-xs"
          />
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {modelTextToIds(modelText).map((id) => {
              const preset = selected.models.find((model) => model.id === id);
              const capabilities = preset?.capabilities ?? inferCapabilities(id);
              return (
                <div key={id} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{id}</div>
                    {preset?.subtitle ? <div className="truncate text-xs text-muted-foreground">{preset.subtitle}</div> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {capabilities.map((capability) => (
                      <Badge key={capability} variant="outline" className="h-5 rounded-full px-2">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}
