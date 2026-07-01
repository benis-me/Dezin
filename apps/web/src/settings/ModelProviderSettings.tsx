import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, RotateCw, Save, Search, Sparkles, TestTube2 } from "lucide-react";
import type { Settings } from "../lib/api.ts";
import { AgentLogo } from "../components/agent-logos.tsx";
import { Badge, Button, Field, Input, Textarea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { MODEL_PROVIDERS, type ModelCapability, type ProviderPreset } from "./model-provider-registry.ts";

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
    const models = modelText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
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
      <aside className="w-56 shrink-0 border-r border-border bg-muted/35 p-2.5">
        <label className="relative block">
          <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search model platform..."
            aria-label="Search model platform"
            className="h-8 pl-8 text-xs"
          />
        </label>
        <div className="mt-2 space-y-1">
          {providers.map((provider) => {
            const active = provider.id === selected.id;
            const configured = provider.id === settings.aiProviderId && Boolean(apiKey || provider.id === "mock" || provider.id === "ollama");
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => selectProvider(provider)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors",
                  active ? "border-border bg-background shadow-sm" : "border-transparent hover:bg-background/70",
                )}
              >
                <ProviderIcon id={provider.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{provider.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{provider.protocol}</span>
                </span>
                <span className={cn("size-1.5 shrink-0 rounded-full", configured ? "bg-[var(--success)]" : "bg-border-strong")} />
              </button>
            );
          })}
        </div>
      </aside>

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
            onClick={() => onSavePatch({ aiProviderEnabled: !settings.aiProviderEnabled })}
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
                onChange={(event) => patchModelSettings({ apiKey: event.target.value, imageApiKey: event.target.value, videoApiKey: event.target.value })}
                onBlur={(event) => patchModelSettings({ apiKey: event.target.value, imageApiKey: event.target.value, videoApiKey: event.target.value }, true)}
              />
            </Field>
            <Field label="Base URL">
              <Input
                value={baseUrl}
                placeholder={selected.baseUrl || "https://..."}
                aria-label="Provider base URL"
                onChange={(event) =>
                  patchModelSettings({ apiBaseUrl: event.target.value, imageApiBaseUrl: event.target.value, videoApiBaseUrl: event.target.value })
                }
                onBlur={(event) =>
                  patchModelSettings({ apiBaseUrl: event.target.value, imageApiBaseUrl: event.target.value, videoApiBaseUrl: event.target.value }, true)
                }
              />
            </Field>
            <p className="text-xs text-muted-foreground">OpenAI-compatible image generation uses this endpoint for Moodboard generator nodes.</p>
            <Field label="Organization">
              <Input
                value={settings.aiProviderOrganization}
                placeholder="optional"
                aria-label="Provider organization"
                onChange={(event) => patchModelSettings({ aiProviderOrganization: event.target.value })}
                onBlur={(event) => patchModelSettings({ aiProviderOrganization: event.target.value }, true)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={saveSelectedProvider}>
                <Save size={14} strokeWidth={1.75} />
                Save configuration
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setStatus(apiKey || selected.id === "mock" || selected.id === "ollama" ? "Looks configured locally." : "Missing API key.")}
              >
                <TestTube2 size={14} strokeWidth={1.75} />
                Test connection
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const next = selected.models.map((model) => model.id).join("\n");
                  patchModelSettings({ aiProviderModels: next }, true);
                  setStatus(`Loaded ${selected.models.length} preset models.`);
                }}
              >
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
              onChange={(event) => onLocalPatch({ aiProviderModels: event.target.value })}
              onBlur={(event) => onSavePatch({ aiProviderModels: event.target.value })}
              className="mt-3 min-h-28 resize-none font-mono text-xs"
            />
            <div className="mt-3 divide-y divide-border rounded-md border border-border">
              {modelText
                .split(/\n+/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((id) => {
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
    </div>
  );
}

function inferCapabilities(id: string): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  if (/image|flux|imagen|seedream|midjourney/i.test(id)) capabilities.push("Image");
  if (/video|veo|wan|sora/i.test(id)) capabilities.push("Video");
  if (/vision|gpt|claude|gemini/i.test(id)) capabilities.push("Vision");
  if (/gpt|claude|gemini|llama/i.test(id)) capabilities.push("Stream");
  return capabilities.length ? capabilities : ["Stream"];
}

function ProviderIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  if (id === "openai" || id === "openai-compatible" || id === "openrouter") return <AgentLogo id="codex" className={className} />;
  if (id === "anthropic") return <AgentLogo id="claude" className={className} />;
  if (id === "gemini" || id === "vertex-ai") return <AgentLogo id="gemini" className={className} />;
  if (id === "mock") return <CheckCircle2 className={className} strokeWidth={1.75} />;
  return <Sparkles className={className} strokeWidth={1.75} />;
}
