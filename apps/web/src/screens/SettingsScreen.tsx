import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Eye, Info, Palette, Puzzle, Server, SlidersHorizontal, Sun, Type } from "lucide-react";
import { Button, Picker, Textarea, Loading, Badge, ScrollArea, Switch, Input } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { DesignSystemCard, Settings } from "../lib/api.ts";
import { agentLabel } from "../components/agent-logos.tsx";
import { publishSettingsUpdated } from "../lib/settings-events.ts";
import { AgentProviderSettings } from "../settings/AgentProviderSettings.tsx";
import { ModelProviderSettings } from "../settings/ModelProviderSettings.tsx";
import { SettingRow, SettingsPanel, SettingsRows } from "../settings/settings-ui.tsx";
import { IMAGE_ACTION_DEFAULTS, IMAGE_ACTION_MODEL_FIELDS, type ImageActionModelField } from "../lib/image-action-defaults.ts";
import { imageModelOptions } from "../moodboard/useMoodboardBoard.ts";

type SectionId = "appearance" | "provider" | "models" | "quality" | "defaults" | "instructions" | "extension" | "about";

const SECRET_SETTING_KEYS = ["apiKey", "imageApiKey", "videoApiKey"] as const;

function mergeSettingsSaveResponse(current: Settings | null, next: Settings): Settings {
  const merged = { ...next };
  for (const key of SECRET_SETTING_KEYS) {
    if (current) merged[key] = current[key];
  }
  return merged;
}

// Grouped into related pairs; a divider is drawn between groups in the sidebar.
const SECTION_GROUPS: { id: SectionId; label: string; icon: typeof Palette }[][] = [
  [
    { id: "provider", label: "Agents", icon: Server },
    { id: "models", label: "Providers", icon: SlidersHorizontal },
  ],
  [
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "defaults", label: "Defaults", icon: SlidersHorizontal },
  ],
  [
    { id: "quality", label: "Quality", icon: Eye },
    { id: "instructions", label: "Custom instructions", icon: Type },
  ],
  [
    { id: "extension", label: "Browser extension", icon: Puzzle },
    { id: "about", label: "About", icon: Info },
  ],
];
const SECTIONS: { id: SectionId; label: string; icon: typeof Palette }[] = SECTION_GROUPS.flat();

function parseInitialSettingsTarget(initialSection?: string): { section: SectionId; focusTarget: ImageActionModelField | null } {
  const normalized = initialSection === "connection" || initialSection === "media" ? "models" : initialSection;
  if (!normalized) return { section: "appearance", focusTarget: null };
  const [sectionPart, focusPart] = normalized.split(":");
  const section = SECTIONS.some((s) => s.id === sectionPart) ? (sectionPart as SectionId) : "appearance";
  const focusTarget =
    section === "defaults" && IMAGE_ACTION_MODEL_FIELDS.includes(focusPart as ImageActionModelField) ? (focusPart as ImageActionModelField) : null;
  return { section, focusTarget };
}

function PreferenceSuggestion({ onApply }: { onApply: (lines: string) => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const { suggestion, signals } = await api.suggestPreferences();
      if (signals === 0) toast("No feedback yet — rate a few results with 👍/👎 first.");
      else if (!suggestion.trim()) toast("Not enough feedback for a confident suggestion yet.");
      setSuggestion(suggestion.trim() || null);
    } catch {
      toast("Couldn't reflect on your feedback.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Distill durable preferences from the results you've rated 👍/👎.</p>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
          {busy ? "Reflecting…" : "Suggest from my feedback"}
        </Button>
      </div>
      {suggestion ? (
        <div className="rounded-md border border-border bg-surface-2/40 p-2.5">
          <pre className="whitespace-pre-wrap font-sans text-xs text-foreground">{suggestion}</pre>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                onApply(suggestion);
                setSuggestion(null);
              }}
            >
              Add to instructions
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsScreen({
  dark,
  onToggleDark,
  initialSection,
}: {
  dark: boolean;
  onToggleDark: () => void;
  initialSection?: string;
}) {
  const api = useApi();
  const { toast } = useToast();
  const initialTarget = parseInitialSettingsTarget(initialSection);
  const [section, setSection] = useState<SectionId>(initialTarget.section);
  const [defaultsFocusTarget, setDefaultsFocusTarget] = useState<ImageActionModelField | null>(initialTarget.focusTarget);
  const [settings, setSettings] = useState<Settings | null>(null);
  const { agents, loading: agentsInitial, scanning, status: scanStatus, rescan } = useAgents();
  const agentsLoading = agentsInitial || scanning;
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const [version, setVersion] = useState<string>("");
  const defaultsModelRefs = useRef<Partial<Record<ImageActionModelField, HTMLDivElement | null>>>({});
  const focusedDefaultsTargetRef = useRef<ImageActionModelField | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => alive && setSettings(s)).catch(() => {});
    void api.listDesignSystems().then((d) => alive && setSystems(d)).catch(() => {});
    void api.getHealth().then((h) => alive && setVersion(h.version)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    const next = parseInitialSettingsTarget(initialSection);
    setSection(next.section);
    setDefaultsFocusTarget(next.focusTarget);
    focusedDefaultsTargetRef.current = null;
  }, [initialSection]);

  useEffect(() => {
    if (!defaultsFocusTarget || section !== "defaults" || !settings) return;
    if (focusedDefaultsTargetRef.current === defaultsFocusTarget) return;
    const control = defaultsModelRefs.current[defaultsFocusTarget]?.querySelector<HTMLElement>("[role='combobox'], button, input, select, textarea");
    if (!control) return;
    focusedDefaultsTargetRef.current = defaultsFocusTarget;
    control.focus();
    control.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [defaultsFocusTarget, section, settings]);

  const setLocal = (key: keyof Settings, value: string | boolean | number) =>
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, [key]: value };
      publishSettingsUpdated(next);
      return next;
    });
  const setLocalPatch = (patch: Partial<Settings>) =>
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, ...patch };
      publishSettingsUpdated(next);
      return next;
    });
  const save = (key: keyof Settings, value: string | boolean | number) => {
    setLocal(key, value);
    void api.updateSettings({ [key]: value } as Partial<Settings>).catch(() => toast("Couldn't save settings.", { variant: "error" }));
  };
  const savePatch = (patch: Partial<Settings>) => {
    setLocalPatch(patch);
    void api
      .updateSettings(patch)
      .then((next) =>
        setSettings((current) => {
          const merged = mergeSettingsSaveResponse(current, next);
          publishSettingsUpdated(merged);
          return merged;
        }),
      )
      .catch(() => toast("Couldn't save settings.", { variant: "error" }));
  };

  const activeAgent = agents.find((a) => a.command === settings?.agentCommand);
  const visualReviewAgent = settings?.visualQaAgentCommand
    ? agents.find((a) => a.command === settings.visualQaAgentCommand)
    : activeAgent;
  const visualReviewAgentOptions = [
    { value: "", label: "Same as project agent" },
    ...agents
      .filter((agent) => agent.available || agent.command === settings?.visualQaAgentCommand)
      .map((agent) => ({ value: agent.command, label: agentLabel(agent.id) })),
  ];
  const visualReviewModelOptions = [
    { value: "", label: "Same as project model" },
    ...((visualReviewAgent?.models ?? []).map((model) => ({ value: model, label: model }))),
  ];
  const imageActionModelOptions = useMemo(() => {
    if (!settings) return [{ value: "", label: "None" }];
    const models = new Set(imageModelOptions(settings));
    const configuredImageModel = settings.imageModel.trim();
    if (configuredImageModel) models.add(configuredImageModel);
    for (const item of IMAGE_ACTION_DEFAULTS) {
      const configured = settings[item.field].trim();
      if (configured) models.add(configured);
    }
    return [{ value: "", label: "None" }, ...[...models].map((model) => ({ value: model, label: model }))];
  }, [settings]);
  const clampRounds = (value: string | number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(20, Math.trunc(n))) : 0;
  };

  return (
    <div className="flex h-[clamp(460px,72vh,660px)]">
      {/* Sidebar */}
      <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/40 p-2.5">
        <div className="px-2 py-2">
          <div className="truncate text-sm font-semibold leading-tight">Settings</div>
          <div className="truncate text-[11px] text-muted-foreground">Local workspace</div>
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {SECTION_GROUPS.map((group, gi) => (
            <Fragment key={gi}>
              {gi > 0 ? <div className="my-1.5 border-t border-border" /> : null}
              {group.map((s) => {
                const Icon = s.icon;
                const active = section === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-background text-foreground ring-1 ring-border"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                    )}
                  >
                    <Icon size={15} strokeWidth={1.75} className={active ? "text-primary" : ""} />
                    {s.label}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className="mt-auto px-2 pt-3 text-[11px] text-muted-foreground">
          {version ? `Daemon v${version}` : "Local-first · no telemetry"}
        </div>
      </nav>

      {/* Panel */}
      <ScrollArea className="flex-1">
        {settings === null ? (
          <Loading label="Loading settings…" />
        ) : (
          <div className={cn(section === "models" ? "h-full" : "mx-auto max-w-2xl p-8")}>
            {section === "appearance" && (
              <SettingsPanel title="Appearance" desc="How Dezin looks. Monochrome surfaces, borders over shadows, one near-black accent.">
                <SettingsRows>
                  <SettingRow label="Theme" desc="Switch between light and dark.">
                    <Button variant="outline" size="sm" onClick={onToggleDark} className="gap-2">
                      <Sun size={14} strokeWidth={1.75} />
                      {dark ? "Dark" : "Light"}
                    </Button>
                  </SettingRow>
                </SettingsRows>
              </SettingsPanel>
            )}

            {section === "provider" && (
              <AgentProviderSettings
                settings={settings}
                agents={agents}
                activeAgent={activeAgent}
                agentsLoading={agentsLoading}
                scanStatus={scanStatus}
                onLocal={setLocal}
                onSave={save}
                onRescan={() => void rescan().catch(() => toast("Couldn't rescan agents.", { variant: "error" }))}
              />
            )}
            {section === "models" && <ModelProviderSettings settings={settings} onLocalPatch={setLocalPatch} onSavePatch={savePatch} />}

            {section === "quality" && (
              <SettingsPanel title="Quality" desc="How Dezin generates: optional research before designing, plus checks on the finished result.">
                <SettingsRows>
                  <SettingRow
                    label="Design research"
                    desc="Before designing, the Agent researches competitors, audience, and references into .research/, then builds from it. Adds time and uses your agent's tokens."
                  >
                    <Switch
                      aria-label="Design research"
                      checked={settings.researchEnabled}
                      onCheckedChange={(checked) => save("researchEnabled", checked)}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Agent visual review"
                    desc="After generation, a reviewer Agent/model inspects the screenshot, conversation, and runtime signals."
                  >
                    <Switch
                      aria-label="Agent visual review"
                      checked={settings.visualQaEnabled}
                      onCheckedChange={(checked) => save("visualQaEnabled", checked)}
                    />
                  </SettingRow>
                  <SettingRow label="Review agent" desc="Blank inherits the Agent used for the current project run.">
                    <Picker
                      ariaLabel="Visual review agent"
                      className="w-52"
                      value={settings.visualQaAgentCommand}
                      onChange={(value) => savePatch({ visualQaAgentCommand: value, visualQaModel: "" })}
                      options={visualReviewAgentOptions}
                    />
                  </SettingRow>
                  <SettingRow label="Review model" desc="Blank inherits the model used for the current project run.">
                    {visualReviewAgentOptions.length > 0 && visualReviewModelOptions.length > 1 ? (
                      <Picker
                        ariaLabel="Visual review model"
                        className="w-52"
                        value={settings.visualQaModel}
                        onChange={(value) => save("visualQaModel", value)}
                        options={visualReviewModelOptions}
                      />
                    ) : (
                      <Input
                        aria-label="Visual review model"
                        className="w-52"
                        value={settings.visualQaModel}
                        placeholder="Same as project model"
                        onChange={(event) => setLocal("visualQaModel", event.target.value)}
                        onBlur={(event) => save("visualQaModel", event.target.value)}
                      />
                    )}
                  </SettingRow>
                  <SettingRow
                    label="Auto-improve after review"
                    desc="When quality checks find P0/P1 issues, Dezin sends a repair prompt back to the project Agent automatically."
                  >
                    <Switch
                      aria-label="Auto-improve after review"
                      checked={settings.autoImproveEnabled}
                      onCheckedChange={(checked) => save("autoImproveEnabled", checked)}
                    />
                  </SettingRow>
                  <SettingRow label="Max rounds" desc="Maximum automatic repair turns after the initial generation.">
                    <Input
                      aria-label="Max auto-improve rounds"
                      className="w-24"
                      type="number"
                      min={0}
                      max={20}
                      value={settings.autoImproveMaxRounds}
                      onChange={(event) => setLocal("autoImproveMaxRounds", clampRounds(event.target.value))}
                      onBlur={(event) => save("autoImproveMaxRounds", clampRounds(event.target.value))}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Auto-fix live preview errors"
                    desc="Automatically send a repair run when the live preview crashes."
                  >
                    <Switch
                      aria-label="Auto-fix live preview errors"
                      checked={settings.autoFixLiveRuntimeErrors}
                      onCheckedChange={(checked) => save("autoFixLiveRuntimeErrors", checked)}
                    />
                  </SettingRow>
                </SettingsRows>
              </SettingsPanel>
            )}

            {section === "defaults" && (
              <SettingsPanel title="Defaults" desc="Applied when projects and moodboard tools do not override their own defaults.">
                <SettingsRows>
                  <SettingRow label="Design system" desc="The brand new projects start from.">
                    <Picker
                      ariaLabel="Default design system"
                      className="w-44"
                      value={settings.defaultDesignSystemId}
                      onChange={(v) => save("defaultDesignSystemId", v)}
                      options={(systems.length
                        ? systems
                        : [{ id: settings.defaultDesignSystemId, name: settings.defaultDesignSystemId, category: "", summary: "" }]
                      ).map((s) => ({ value: s.id, label: s.name }))}
                    />
                  </SettingRow>
                  {IMAGE_ACTION_DEFAULTS.map((item) => (
                    <SettingRow key={item.field} label={item.label} desc={item.desc}>
                      <div
                        ref={(node) => {
                          defaultsModelRefs.current[item.field] = node;
                        }}
                      >
                        <Picker
                          ariaLabel={item.label}
                          className="w-56"
                          value={settings[item.field]}
                          onChange={(value) => save(item.field, value)}
                          options={imageActionModelOptions}
                        />
                      </div>
                    </SettingRow>
                  ))}
                </SettingsRows>
              </SettingsPanel>
            )}

            {section === "instructions" && (
              <SettingsPanel title="Custom instructions" desc="Project-agnostic guidance injected into every generation.">
                <Textarea
                  aria-label="Custom instructions"
                  rows={6}
                  value={settings.customInstructions}
                  placeholder="e.g. Prefer dense layouts. Never use emoji. Match our voice: precise, calm."
                  onChange={(e) => setLocal("customInstructions", e.target.value)}
                  onBlur={(e) => save("customInstructions", e.target.value)}
                />
                <PreferenceSuggestion
                  onApply={(lines) => {
                    const next = settings.customInstructions.trim() ? `${settings.customInstructions.trim()}\n${lines}` : lines;
                    setLocal("customInstructions", next);
                    save("customInstructions", next);
                  }}
                />
              </SettingsPanel>
            )}

            {section === "extension" && (
              <SettingsPanel title="Browser extension" desc="Capture cover art and shots from Pinterest, Behance & Dribbble straight into Dezin.">
                <div className="space-y-4 text-sm leading-relaxed text-foreground-2">
                  <ol className="space-y-2.5">
                    {[
                      <>Open <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">chrome://extensions</code> and turn on Developer mode.</>,
                      <>Click <b className="text-foreground">Load unpacked</b> and choose the <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">apps/extension</code> folder in this repo.</>,
                      <>Open the extension and set the <b className="text-foreground">Dezin URL</b> to this app's address.</>,
                    ].map((step, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-foreground">
                          {i + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-muted-foreground">
                    A <span className="font-medium text-foreground">✦ Capture</span> button then appears on images and videos —
                    click it to send a reference into the home composer.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText("apps/extension");
                        toast("Folder path copied.");
                      }}
                    >
                      Copy folder path
                    </Button>
                    <span className="text-xs text-muted-foreground">Pinterest · Behance · Dribbble</span>
                  </div>
                </div>
              </SettingsPanel>
            )}

            {section === "about" && (
              <SettingsPanel title="About" desc="A tasteful, local-first design generator.">
                <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <p>
                    Dezin runs entirely on your machine — no telemetry, no analytics. It drives your own coding-agent CLI and
                    lints every artifact against an anti-AI-slop quality kernel.
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Daemon {version ? `v${version}` : "—"}</Badge>
                    <Badge variant="outline">Local-first</Badge>
                  </div>
                </div>
              </SettingsPanel>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
