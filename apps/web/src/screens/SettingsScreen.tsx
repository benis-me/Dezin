import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Eye, Info, Palette, Puzzle, Server, SlidersHorizontal, Sun, Type } from "lucide-react";
import { Button, Picker, Textarea, Loading, Badge, ScrollArea, Switch, Input } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { DesignSystemCard, ExtensionCredential, Settings } from "../lib/api.ts";
import { agentLabel } from "../components/agent-logos.tsx";
import { publishSettingsUpdated } from "../lib/settings-events.ts";
import { AgentProviderSettings } from "../settings/AgentProviderSettings.tsx";
import { ModelProviderSettings } from "../settings/ModelProviderSettings.tsx";
import { SettingRow, SettingsGroup, SettingsPanel, SettingsRows } from "../settings/settings-ui.tsx";
import { IMAGE_ACTION_DEFAULTS, IMAGE_ACTION_MODEL_FIELDS, type ImageActionModelField } from "../lib/image-action-defaults.ts";
import { imageModelOptions } from "../moodboard/useMoodboardBoard.ts";

type SectionId = "appearance" | "provider" | "models" | "quality" | "defaults" | "instructions" | "extension" | "about";

const SECRET_SETTING_KEYS = ["apiKey", "imageApiKey", "videoApiKey"] as const;

function assignSetting(target: Settings, key: keyof Settings, value: Settings[keyof Settings]): void {
  (target as unknown as Record<keyof Settings, Settings[keyof Settings]>)[key] = value;
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
  const confirmedSettingsRef = useRef<Settings | null>(null);
  const editEpochsRef = useRef(new Map<keyof Settings, number>());
  const mutationQueuesRef = useRef(new Map<keyof Settings, Promise<void>>());
  const { agents, loading: agentsInitial, scanning, status: scanStatus, rescan } = useAgents();
  const agentsLoading = agentsInitial || scanning;
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const [version, setVersion] = useState<string>("");
  const [extensionCredentials, setExtensionCredentials] = useState<ExtensionCredential[]>([]);
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [revokingCredentialId, setRevokingCredentialId] = useState<string | null>(null);
  const defaultsModelRefs = useRef<Partial<Record<ImageActionModelField, HTMLDivElement | null>>>({});
  const focusedDefaultsTargetRef = useRef<ImageActionModelField | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        confirmedSettingsRef.current = s;
        setSettings(s);
      })
      .catch(() => {});
    void api.listDesignSystems().then((d) => alive && setSystems(d)).catch(() => {});
    void api.getHealth().then((h) => alive && setVersion(h.version)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    let alive = true;
    let latestRequest = 0;
    const refreshExtensionCredentials = () => {
      const request = ++latestRequest;
      void api
        .listExtensionCredentials()
        .then((credentials) => {
          if (alive && request === latestRequest) setExtensionCredentials(credentials);
        })
        .catch(() => {});
    };
    refreshExtensionCredentials();
    window.addEventListener("focus", refreshExtensionCredentials);
    return () => {
      alive = false;
      window.removeEventListener("focus", refreshExtensionCredentials);
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

  const applyLocalPatch = (patch: Partial<Settings>): Map<keyof Settings, number> => {
    const epochs = new Map<keyof Settings, number>();
    for (const key of Object.keys(patch) as Array<keyof Settings>) {
      const epoch = (editEpochsRef.current.get(key) ?? 0) + 1;
      editEpochsRef.current.set(key, epoch);
      epochs.set(key, epoch);
    }
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, ...patch };
      publishSettingsUpdated(next);
      return next;
    });
    return epochs;
  };
  const setLocal = (key: keyof Settings, value: string | boolean | number) => {
    applyLocalPatch({ [key]: value } as Partial<Settings>);
  };
  const setLocalPatch = (patch: Partial<Settings>) => {
    applyLocalPatch(patch);
  };
  const mutateSettings = (patch: Partial<Settings>) => {
    const keys = Object.keys(patch) as Array<keyof Settings>;
    if (!keys.length) return;
    const savedEpochs = applyLocalPatch(patch);
    const predecessors = [
      ...new Set(keys.map((key) => mutationQueuesRef.current.get(key)).filter((pending): pending is Promise<void> => Boolean(pending))),
    ];
    let request: Promise<Settings>;
    try {
      request = predecessors.length ? Promise.all(predecessors).then(() => api.updateSettings(patch)) : Promise.resolve(api.updateSettings(patch));
    } catch (error) {
      request = Promise.reject(error);
    }
    const tail = request.then(
      () => undefined,
      () => undefined,
    );
    for (const key of keys) mutationQueuesRef.current.set(key, tail);
    void tail.then(() => {
      for (const key of keys) {
        if (mutationQueuesRef.current.get(key) === tail) mutationQueuesRef.current.delete(key);
      }
    });
    void request
      .then((next) => {
        const nextConfirmed = { ...(confirmedSettingsRef.current ?? next) };
        for (const key of keys) {
          const value = SECRET_SETTING_KEYS.includes(key as (typeof SECRET_SETTING_KEYS)[number]) ? patch[key] : next[key];
          if (value !== undefined) assignSetting(nextConfirmed, key, value);
        }
        confirmedSettingsRef.current = nextConfirmed;
        setSettings((current) => {
          if (!current) return current;
          const merged = { ...current };
          let changed = false;
          for (const key of keys) {
            if (editEpochsRef.current.get(key) !== savedEpochs.get(key)) continue;
            const value = SECRET_SETTING_KEYS.includes(key as (typeof SECRET_SETTING_KEYS)[number]) ? current[key] : nextConfirmed[key];
            assignSetting(merged, key, value);
            changed = true;
          }
          if (!changed) return current;
          publishSettingsUpdated(merged);
          return merged;
        });
      })
      .catch(() => {
        setSettings((current) => {
          if (!current) return current;
          const rolledBack = { ...current };
          let changed = false;
          for (const key of keys) {
            if (editEpochsRef.current.get(key) !== savedEpochs.get(key) || !confirmedSettingsRef.current) continue;
            assignSetting(rolledBack, key, confirmedSettingsRef.current[key]);
            changed = true;
          }
          if (!changed) return current;
          publishSettingsUpdated(rolledBack);
          return rolledBack;
        });
        toast("Couldn't save settings.", { variant: "error" });
      });
  };
  const save = (key: keyof Settings, value: string | boolean | number) => mutateSettings({ [key]: value } as Partial<Settings>);
  const savePatch = (patch: Partial<Settings>) => mutateSettings(patch);
  const generatePairingCode = async () => {
    setPairingBusy(true);
    try {
      setPairingCode(await api.createExtensionPairingCode());
    } catch {
      toast("Couldn't generate a pairing code. Try again.", { variant: "error" });
    } finally {
      setPairingBusy(false);
    }
  };
  const revokeExtension = async (credential: ExtensionCredential) => {
    setRevokingCredentialId(credential.id);
    try {
      await api.revokeExtensionCredential(credential.id);
      setExtensionCredentials((credentials) => credentials.filter((item) => item.id !== credential.id));
    } catch {
      toast("Couldn't revoke the extension. Try again.", { variant: "error" });
    } finally {
      setRevokingCredentialId(null);
    }
  };

  const activeAgent = agents.find((a) => a.command === settings?.agentCommand);
  const visualReviewAgent = agents.find((agent) => agent.id === "claude" && agent.command === "claude");
  const visualReviewerAvailable = visualReviewAgent?.available === true;
  const visualReviewModelSource = settings?.visualQaAgentCommand.trim() || settings?.agentCommand.trim() || "";
  const visualReviewModelValue = visualReviewModelSource === "claude" ? settings?.visualQaModel ?? "" : "";
  const visualReviewModelOptions = [
    { value: "", label: "Claude default" },
    ...((visualReviewAgent?.models ?? []).map((model) => ({ value: model, label: model }))),
  ];
  const researchAgent = settings?.researchAgentCommand ? agents.find((a) => a.command === settings.researchAgentCommand) : activeAgent;
  const researchAgentOptions = [
    { value: "", label: "Same as project agent" },
    ...agents
      .filter((agent) => agent.available || agent.command === settings?.researchAgentCommand)
      .map((agent) => ({ value: agent.command, label: agentLabel(agent.id) })),
  ];
  const researchModelOptions = [
    { value: "", label: "Same as project model" },
    ...((researchAgent?.models ?? []).map((model) => ({ value: model, label: model }))),
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
                <div className="space-y-8">
                  <SettingsGroup
                    title="Design research"
                    desc="Before designing, an Agent researches competitors, audience, and references into .research/, then builds from it. Adds time and uses the research Agent's tokens."
                  >
                    <SettingRow label="Enable" desc="Run the pre-design research phase before building.">
                      <Switch
                        aria-label="Design research"
                        checked={settings.researchEnabled}
                        onCheckedChange={(checked) => save("researchEnabled", checked)}
                      />
                    </SettingRow>
                    <SettingRow
                      label="Research agent"
                      desc="Blank inherits the project run Agent. Pick a vision-capable Agent so research can actually study reference images."
                    >
                      <Picker
                        ariaLabel="Research agent"
                        className="w-52"
                        value={settings.researchAgentCommand}
                        onChange={(value) => savePatch({ researchAgentCommand: value, researchModel: "" })}
                        options={researchAgentOptions}
                      />
                    </SettingRow>
                    <SettingRow label="Research model" desc="Blank inherits the model used for the current project run.">
                      {researchAgentOptions.length > 0 && researchModelOptions.length > 1 ? (
                        <Picker
                          ariaLabel="Research model"
                          className="w-52"
                          value={settings.researchModel}
                          onChange={(value) => save("researchModel", value)}
                          options={researchModelOptions}
                        />
                      ) : (
                        <Input
                          aria-label="Research model"
                          className="w-52"
                          value={settings.researchModel}
                          placeholder="Same as project model"
                          onChange={(event) => setLocal("researchModel", event.target.value)}
                          onBlur={(event) => save("researchModel", event.target.value)}
                        />
                      )}
                    </SettingRow>
                  </SettingsGroup>
                  <SettingsGroup
                    title="Visual review"
                    desc="After generation, a reviewer Agent/model inspects the screenshot, conversation, and runtime signals — and can auto-repair blocking issues."
                  >
                    <SettingRow label="Enable" desc="Review the rendered result after generation.">
                      <Switch
                        aria-label="Agent visual review"
                        checked={settings.visualQaEnabled}
                        disabled={agentsLoading || (!visualReviewerAvailable && !settings.visualQaEnabled)}
                        onCheckedChange={(checked) => savePatch({
                          visualQaEnabled: checked,
                          visualQaAgentCommand: "claude",
                          visualQaModel: visualReviewModelSource === "claude" ? settings.visualQaModel : "",
                        })}
                      />
                    </SettingRow>
                  <SettingRow
                    label="Review agent"
                    desc={visualReviewerAvailable
                      ? "Claude Code runs in an isolated no-tools mode; the project Agent can remain Codex, Gemini, or another provider."
                      : "Claude Code is required for isolated visual review. Install or sign in to Claude Code, then rescan Agents."}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Claude Code</span>
                      <Badge variant={agentsLoading ? "outline" : visualReviewerAvailable ? "secondary" : "destructive"}>
                        {agentsLoading ? "Checking…" : visualReviewerAvailable ? "Ready" : "Not available"}
                      </Badge>
                    </div>
                  </SettingRow>
                  <SettingRow label="Review model" desc="Blank uses Claude Code's own default; it never inherits a model from another provider.">
                    {!visualReviewerAvailable ? (
                      <span className="text-xs text-muted-foreground">Install Claude Code first</span>
                    ) : visualReviewModelOptions.length > 1 ? (
                      <Picker
                        ariaLabel="Visual review model"
                        className="w-52"
                        value={visualReviewModelValue}
                        onChange={(value) => savePatch({ visualQaAgentCommand: "claude", visualQaModel: value })}
                        options={visualReviewModelOptions}
                      />
                    ) : (
                      <Input
                        aria-label="Visual review model"
                        className="w-52"
                        value={visualReviewModelValue}
                        placeholder="Claude default"
                        onChange={(event) => setLocalPatch({ visualQaAgentCommand: "claude", visualQaModel: event.target.value })}
                        onBlur={(event) => savePatch({ visualQaAgentCommand: "claude", visualQaModel: event.target.value })}
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
                  </SettingsGroup>
                </div>
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
                  <div className="rounded-lg border border-border bg-surface-2/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-foreground">Pair this daemon</div>
                        <p className="mt-0.5 text-xs text-muted-foreground">Generate a one-time code, then enter it in the extension popup.</p>
                      </div>
                      <Button size="sm" onClick={() => void generatePairingCode()} disabled={pairingBusy}>
                        {pairingBusy ? "Generating…" : "Generate pairing code"}
                      </Button>
                    </div>
                    {pairingCode ? (
                      <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
                        <code className="font-mono text-xl font-semibold tracking-[0.2em] text-foreground">{pairingCode.code}</code>
                        <span className="text-xs text-muted-foreground">
                          Expires {new Date(pairingCode.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {extensionCredentials.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground">Paired extensions</div>
                      {extensionCredentials.map((credential) => (
                        <div key={credential.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-xs text-foreground">{credential.extensionId}</div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">Capture and image analysis</div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Revoke ${credential.extensionId}`}
                            disabled={revokingCredentialId === credential.id}
                            onClick={() => void revokeExtension(credential)}
                          >
                            {revokingCredentialId === credential.id ? "Revoking…" : "Revoke"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <ol className="space-y-2.5">
                    {[
                      <>Open <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">chrome://extensions</code> and turn on Developer mode.</>,
                      <>Click <b className="text-foreground">Load unpacked</b> and choose the <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">apps/extension</code> folder in this repo.</>,
                      <>Open the extension, set the <b className="text-foreground">Dezin URL</b>, and enter the pairing code above.</>,
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
