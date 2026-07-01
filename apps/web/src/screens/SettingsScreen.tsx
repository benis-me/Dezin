import { useEffect, useState } from "react";
import { Eye, Info, Palette, Puzzle, Server, SlidersHorizontal, Sun, Type } from "lucide-react";
import { Button, Picker, Textarea, Loading, Badge, ScrollArea, Switch } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { DesignSystemCard, Settings } from "../lib/api.ts";
import { AgentProviderSettings } from "../settings/AgentProviderSettings.tsx";
import { ModelProviderSettings } from "../settings/ModelProviderSettings.tsx";
import { SettingRow, SettingsPanel, SettingsRows } from "../settings/settings-ui.tsx";

type SectionId = "appearance" | "provider" | "models" | "quality" | "defaults" | "instructions" | "extension" | "about";

const SECTIONS: { id: SectionId; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "provider", label: "Provider", icon: Server },
  { id: "models", label: "Models", icon: SlidersHorizontal },
  { id: "quality", label: "Quality", icon: Eye },
  { id: "defaults", label: "Defaults", icon: SlidersHorizontal },
  { id: "instructions", label: "Custom instructions", icon: Type },
  { id: "extension", label: "Browser extension", icon: Puzzle },
  { id: "about", label: "About", icon: Info },
];

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
  const normalizedInitialSection = initialSection === "connection" || initialSection === "media" ? "models" : initialSection;
  const [section, setSection] = useState<SectionId>(
    SECTIONS.some((s) => s.id === normalizedInitialSection) ? (normalizedInitialSection as SectionId) : "appearance",
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const { agents, loading: agentsInitial, scanning, status: scanStatus, rescan } = useAgents();
  const agentsLoading = agentsInitial || scanning;
  const [systems, setSystems] = useState<DesignSystemCard[]>([]);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => alive && setSettings(s)).catch(() => {});
    void api.listDesignSystems().then((d) => alive && setSystems(d)).catch(() => {});
    void api.getHealth().then((h) => alive && setVersion(h.version)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const setLocal = (key: keyof Settings, value: string | boolean) => setSettings((s) => (s ? { ...s, [key]: value } : s));
  const setLocalPatch = (patch: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...patch } : s));
  const save = (key: keyof Settings, value: string | boolean) => {
    setLocal(key, value);
    void api.updateSettings({ [key]: value } as Partial<Settings>).catch(() => toast("Couldn't save settings.", { variant: "error" }));
  };
  const savePatch = (patch: Partial<Settings>) => {
    setLocalPatch(patch);
    void api.updateSettings(patch).then((next) => setSettings(next)).catch(() => toast("Couldn't save settings.", { variant: "error" }));
  };

  const activeAgent = agents.find((a) => a.command === settings?.agentCommand);

  return (
    <div className="flex h-[clamp(460px,72vh,660px)]">
      {/* Sidebar */}
      <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/40 p-2.5">
        <div className="px-2 py-2">
          <div className="truncate text-sm font-semibold leading-tight">Settings</div>
          <div className="truncate text-[11px] text-muted-foreground">Local workspace</div>
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
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
              <SettingsPanel title="Quality" desc="Checks the finished prototype against visible layout problems.">
                <SettingsRows>
                  <SettingRow
                    label="Agent visual review"
                    desc="After generation, the selected Agent/model reviews the screenshot with the full current conversation context."
                  >
                    <Switch
                      aria-label="Agent visual review"
                      checked={settings.visualQaEnabled}
                      onCheckedChange={(checked) => save("visualQaEnabled", checked)}
                    />
                  </SettingRow>
                </SettingsRows>
              </SettingsPanel>
            )}

            {section === "defaults" && (
              <SettingsPanel title="Defaults" desc="Applied when a project pins no design system.">
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
