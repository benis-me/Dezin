import { useEffect, useState, type ReactNode } from "react";
import { Check, Info, KeyRound, Palette, Puzzle, RotateCw, Server, SlidersHorizontal, Sun, Type } from "lucide-react";
import { Button, Field, Input, Picker, Textarea, Loading, Spinner, Badge, ScrollArea } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { AgentLogo, agentLabel } from "../components/agent-logos.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import type { DesignSystemCard, Settings } from "../lib/api.ts";

type SectionId = "appearance" | "provider" | "connection" | "defaults" | "instructions" | "extension" | "about";

const SECTIONS: { id: SectionId; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "provider", label: "Provider", icon: Server },
  { id: "connection", label: "Connection", icon: KeyRound },
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
  const [section, setSection] = useState<SectionId>(
    SECTIONS.some((s) => s.id === initialSection) ? (initialSection as SectionId) : "appearance",
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

  const setLocal = (key: keyof Settings, value: string) => setSettings((s) => (s ? { ...s, [key]: value } : s));
  const save = (key: keyof Settings, value: string) => {
    setLocal(key, value);
    void api.updateSettings({ [key]: value }).catch(() => toast("Couldn't save settings.", { variant: "error" }));
  };

  const activeAgent = agents.find((a) => a.command === settings?.agentCommand);

  return (
    <div className="flex h-[clamp(460px,72vh,660px)]">
      {/* Sidebar */}
      <nav aria-label="Settings sections" className="flex w-60 shrink-0 flex-col border-r border-border bg-muted/40 p-2.5">
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
          <div className="mx-auto max-w-2xl p-8">
            {section === "appearance" && (
              <Panel title="Appearance" desc="How Dezin looks. Monochrome surfaces, borders over shadows, one near-black accent.">
                <Rows>
                  <SettingRow label="Theme" desc="Switch between light and dark.">
                    <Button variant="outline" size="sm" onClick={onToggleDark} className="gap-2">
                      <Sun size={14} strokeWidth={1.75} />
                      {dark ? "Dark" : "Light"}
                    </Button>
                  </SettingRow>
                </Rows>
              </Panel>
            )}

            {section === "provider" && (
              <Panel title="Provider" desc="Bring your own key. Dezin drives your local coding-agent CLI.">
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Agent</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">The CLI Dezin spawns. Pick one you have installed.</p>
                      </div>
                      {agentsLoading ? (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Spinner size={13} />
                          {scanStatus || "Scanning…"}
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void rescan().catch(() => toast("Couldn't rescan agents.", { variant: "error" }))}
                        >
                          <RotateCw size={13} strokeWidth={1.75} />
                          Rescan
                        </Button>
                      )}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {agentsLoading
                        ? Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="h-[78px] animate-pulse rounded-xl border border-border bg-surface-2/50" />
                          ))
                        : (agents.length
                            ? agents
                            : [{ id: settings.agentCommand, command: settings.agentCommand, available: false, version: undefined, models: [] }]
                          ).map((a) => {
                            const selected = a.command === settings.agentCommand;
                            return (
                              <button
                                key={a.id}
                                type="button"
                                aria-pressed={selected}
                                disabled={!a.available}
                                title={a.available ? undefined : `${agentLabel(a.id)} isn't installed`}
                                onClick={() => save("agentCommand", a.command)}
                                className={cn(
                                  "relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all",
                                  a.available && "active:scale-[0.99]",
                                  selected
                                    ? "border-ring bg-surface ring-2 ring-ring/25"
                                    : a.available
                                      ? "border-border hover:border-border-strong hover:bg-surface-2/50"
                                      : "cursor-not-allowed border-border opacity-50",
                                )}
                              >
                                {selected ? <Check size={14} strokeWidth={2.5} className="absolute right-2.5 top-2.5 text-foreground" /> : null}
                                <span className="grid size-9 place-items-center rounded-lg bg-surface-2 text-foreground">
                                  <AgentLogo id={a.id} />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">{agentLabel(a.id)}</span>
                                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <span
                                      className={cn("size-1.5 shrink-0 rounded-full", a.available ? "bg-[var(--success)]" : "bg-border-strong")}
                                    />
                                    <span className="truncate">{a.available ? (a.version?.slice(0, 16) ?? "Detected") : "Not found"}</span>
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                    </div>
                  </div>
                  <SettingRow label="Model" desc="Optional. Blank uses the agent default.">
                    {activeAgent && activeAgent.models.length > 0 ? (
                      <Picker
                        ariaLabel="Model"
                        className="w-44"
                        value={settings.model}
                        onChange={(v) => save("model", v)}
                        options={[{ value: "", label: "Default" }, ...activeAgent.models.map((m) => ({ value: m, label: m }))]}
                      />
                    ) : (
                      <Input
                        aria-label="Model"
                        className="w-44"
                        value={settings.model}
                        placeholder="default"
                        onChange={(e) => setLocal("model", e.target.value)}
                        onBlur={(e) => save("model", e.target.value)}
                      />
                    )}
                  </SettingRow>
                </div>
              </Panel>
            )}

            {section === "connection" && (
              <Panel title="Connection" desc="Optional BYOK endpoint. Stored locally; never leaves your machine.">
                <div className="space-y-4">
                  <Field label="API base URL">
                    <Input
                      aria-label="API base URL"
                      value={settings.apiBaseUrl}
                      placeholder="https://…"
                      onChange={(e) => setLocal("apiBaseUrl", e.target.value)}
                      onBlur={(e) => save("apiBaseUrl", e.target.value)}
                    />
                  </Field>
                  <Field label="API key">
                    <Input
                      aria-label="API key"
                      type="password"
                      value={settings.apiKey}
                      placeholder="sk-…"
                      onChange={(e) => setLocal("apiKey", e.target.value)}
                      onBlur={(e) => save("apiKey", e.target.value)}
                    />
                  </Field>

                  <div className="border-t border-border pt-4">
                    <div className="text-sm font-medium">Image generation</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Optional, OpenAI Images-compatible. The agent requests imagery; Dezin generates it into assets/.
                    </p>
                  </div>
                  <Field label="Image API base URL">
                    <Input
                      aria-label="Image API base URL"
                      value={settings.imageApiBaseUrl}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) => setLocal("imageApiBaseUrl", e.target.value)}
                      onBlur={(e) => save("imageApiBaseUrl", e.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Image API key">
                      <Input
                        aria-label="Image API key"
                        type="password"
                        value={settings.imageApiKey}
                        placeholder="sk-…"
                        onChange={(e) => setLocal("imageApiKey", e.target.value)}
                        onBlur={(e) => save("imageApiKey", e.target.value)}
                      />
                    </Field>
                    <Field label="Image model">
                      <Input
                        aria-label="Image model"
                        value={settings.imageModel}
                        placeholder="gpt-image-1"
                        onChange={(e) => setLocal("imageModel", e.target.value)}
                        onBlur={(e) => save("imageModel", e.target.value)}
                      />
                    </Field>
                  </div>
                </div>
              </Panel>
            )}

            {section === "defaults" && (
              <Panel title="Defaults" desc="Applied when a project pins no design system.">
                <Rows>
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
                </Rows>
              </Panel>
            )}

            {section === "instructions" && (
              <Panel title="Custom instructions" desc="Project-agnostic guidance injected into every generation.">
                <Textarea
                  aria-label="Custom instructions"
                  rows={6}
                  value={settings.customInstructions}
                  placeholder="e.g. Prefer dense layouts. Never use emoji. Match our voice: precise, calm."
                  onChange={(e) => setLocal("customInstructions", e.target.value)}
                  onBlur={(e) => save("customInstructions", e.target.value)}
                />
              </Panel>
            )}

            {section === "extension" && (
              <Panel title="Browser extension" desc="Capture cover art and shots from Pinterest, Behance & Dribbble straight into Dezin.">
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
              </Panel>
            )}

            {section === "about" && (
              <Panel title="About" desc="A tasteful, local-first design generator.">
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
              </Panel>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function Panel({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div>
      <div className="border-b border-border pb-5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {desc ? <p className="mt-1 text-sm text-muted-foreground">{desc}</p> : null}
      </div>
      <div className="pt-5">{children}</div>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc ? <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
