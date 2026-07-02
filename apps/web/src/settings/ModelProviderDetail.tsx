import { ExternalLink, KeyRound, Pencil, Plus, RotateCw, TestTube2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Settings } from "../lib/api.ts";
import { Badge, Button, Field, Input, Switch } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import type { ModelCapability, ProviderConfigFieldKey, ProviderPreset } from "./model-provider-registry.ts";
import {
  inferCapabilities,
  parseModelEntries,
  ProviderIcon,
  serializeModelEntries,
  type ModelProviderEntry,
} from "./model-provider-ui-utils.tsx";

const CAPABILITY_OPTIONS: ModelCapability[] = ["Stream", "Tools", "Vision", "Image", "Video", "Reasoning", "JSON", "Local"];

export function ModelProviderDetail({
  selected,
  settings,
  apiKey,
  baseUrl,
  modelText,
  status,
  onToggleEnabled,
  onPatchModelSettings,
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
  onTestConnection: () => void;
  onLoadPresetModels: () => void;
}) {
  const entries = useMemo(() => parseModelEntries(modelText), [modelText]);
  const presetById = useMemo(() => new Map(selected.models.map((model) => [model.id, model])), [selected.models]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(() => emptyDraft());
  const editing = editingId != null;
  const formOpen = editing || draft.open;

  useEffect(() => {
    setEditingId(null);
    setDraft(emptyDraft());
  }, [selected.id]);

  const setProviderField = (key: ProviderConfigFieldKey, value: string) => {
    if (key === "apiKey") {
      const configured = value.length > 0;
      onPatchModelSettings(
        {
          apiKey: value,
          apiKeyConfigured: configured,
          imageApiKey: value,
          imageApiKeyConfigured: configured,
          videoApiKey: value,
          videoApiKeyConfigured: configured,
        },
        true,
      );
      return;
    }
    if (key === "baseUrl") {
      onPatchModelSettings({ apiBaseUrl: value, imageApiBaseUrl: value, videoApiBaseUrl: value }, true);
      return;
    }
    onPatchModelSettings({ aiProviderOrganization: value }, true);
  };

  const saveEntries = (next: ModelProviderEntry[]) => {
    onPatchModelSettings({ aiProviderModels: serializeModelEntries(next) }, true);
  };

  const startAdd = () => {
    setEditingId(null);
    setDraft({ open: true, name: "", id: "", capabilities: ["Stream"] });
  };

  const startEdit = (entry: ModelProviderEntry) => {
    const preset = presetById.get(entry.id);
    setEditingId(entry.id);
    setDraft({
      open: true,
      name: entry.name ?? preset?.name ?? "",
      id: entry.id,
      capabilities: entry.capabilities ?? preset?.capabilities ?? inferCapabilities(entry.id),
    });
  };

  const cancelDraft = () => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const saveDraft = () => {
    const id = draft.id.trim();
    if (!id) return;
    const nextEntry: ModelProviderEntry = {
      id,
      name: draft.name.trim() || undefined,
      capabilities: draft.capabilities.length ? draft.capabilities : inferCapabilities(id),
    };
    if (editingId) {
      saveEntries(entries.map((entry) => (entry.id === editingId ? nextEntry : entry)).filter((entry, index, next) => next.findIndex((item) => item.id === entry.id) === index));
    } else {
      saveEntries([...entries.filter((entry) => entry.id !== id), nextEntry]);
    }
    cancelDraft();
  };

  return (
    <section className="min-w-0 flex-1 overflow-auto bg-background">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
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
        <Switch aria-label={`Enable ${selected.name}`} checked={settings.aiProviderEnabled} onCheckedChange={() => onToggleEnabled()} />
      </div>

      <div className="mx-auto max-w-3xl space-y-6 p-6 pb-12">
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound size={15} strokeWidth={1.75} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Connection</h3>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {selected.fields.map((field, index) => (
              <FieldRow key={field.key} last={index === selected.fields.length - 1}>
                <Field label={`${field.label}${field.required ? " *" : ""}`}>
                  <Input
                    type={field.secret ? "password" : "text"}
                    value={providerFieldValue(field.key, { apiKey, baseUrl, organization: settings.aiProviderOrganization })}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                    onChange={(event) => setProviderField(field.key, event.target.value)}
                  />
                  {field.help ? <p className="mt-1 text-xs text-muted-foreground">{field.help}</p> : null}
                </Field>
              </FieldRow>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Models · {entries.length}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{selected.modelHelp ?? "Dezin uses image-capable models for Moodboard generation."}</p>
            </div>
            <Button size="sm" variant="outline" onClick={onLoadPresetModels}>
              <RotateCw size={14} strokeWidth={1.75} />
              Presets
            </Button>
          </div>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {entries.map((entry) => {
              const preset = presetById.get(entry.id);
              const capabilities = entry.capabilities ?? preset?.capabilities ?? inferCapabilities(entry.id);
              return (
                <div key={entry.id} className="flex min-h-[3.25rem] items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{entry.name ?? preset?.name ?? titleFromModelId(entry.id)}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{entry.id}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden flex-wrap justify-end gap-1 sm:flex">
                      {capabilities.map((capability) => (
                        <CapabilityBadge key={capability} capability={capability} />
                      ))}
                    </div>
                    <button
                      type="button"
                      aria-label={`Edit ${entry.id}`}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                      onClick={() => startEdit(entry)}
                    >
                      <Pencil size={13} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${entry.id}`}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                      onClick={() => saveEntries(entries.filter((item) => item.id !== entry.id))}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              );
            })}
            {entries.length === 0 ? <div className="px-3 py-6 text-center text-xs text-muted-foreground">No models configured.</div> : null}
          </div>

          {formOpen ? (
            <div className="mt-3 rounded-lg border border-border bg-card p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">{editing ? "Edit model" : "Add model"}</h4>
                <button type="button" aria-label="Cancel model edit" className="text-muted-foreground hover:text-foreground" onClick={cancelDraft}>
                  <X size={15} strokeWidth={1.75} />
                </button>
              </div>
              <div className="space-y-3">
                <Field label="Model name">
                  <Input value={draft.name} placeholder="Model name" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </Field>
                <Field label="Model ID">
                  <Input value={draft.id} placeholder="provider/model-id" onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} />
                </Field>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Capabilities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITY_OPTIONS.map((capability) => {
                      const active = draft.capabilities.includes(capability);
                      return (
                        <button
                          key={capability}
                          type="button"
                          aria-pressed={active}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs font-medium transition-colors",
                            active ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:bg-surface-2 hover:text-foreground",
                          )}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              capabilities: active ? current.capabilities.filter((item) => item !== capability) : [...current.capabilities, capability],
                            }))
                          }
                        >
                          {capabilityLabel(capability)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={cancelDraft}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDraft} disabled={!draft.id.trim()}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-foreground"
              onClick={startAdd}
            >
              <Plus size={14} strokeWidth={1.75} />
              Add model
            </button>
          )}
        </section>
      </div>
    </section>
  );
}

interface ModelDraft {
  open: boolean;
  name: string;
  id: string;
  capabilities: ModelCapability[];
}

function emptyDraft(): ModelDraft {
  return { open: false, name: "", id: "", capabilities: ["Stream"] };
}

function FieldRow({ children, last }: { children: ReactNode; last: boolean }) {
  return <div className={cn("px-3 py-3", !last && "border-b border-border")}>{children}</div>;
}

function providerFieldValue(
  key: ProviderConfigFieldKey,
  values: { apiKey: string; baseUrl: string; organization: string },
): string {
  if (key === "apiKey") return values.apiKey;
  if (key === "baseUrl") return values.baseUrl;
  return values.organization;
}

function CapabilityBadge({ capability }: { capability: ModelCapability }) {
  return (
    <Badge variant="outline" className="h-5 rounded-full px-2 text-[10px]">
      {capabilityLabel(capability)}
    </Badge>
  );
}

function capabilityLabel(capability: ModelCapability): string {
  if (capability === "Stream") return "Text";
  return capability;
}

function titleFromModelId(id: string): string {
  return id
    .split(/[/:_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
