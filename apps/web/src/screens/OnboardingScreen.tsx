import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, RotateCw } from "lucide-react";
import { Button, Spinner } from "../components/ui/index.ts";
import { AgentLogo, agentLabel } from "../components/agent-logos.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { cn } from "../lib/utils.ts";
import { native } from "../lib/native.ts";
import type { AgentInfo } from "../lib/api.ts";

/**
 * First-run welcome. Scans for installed coding-agent CLIs, lets the user pick the agent +
 * model Dezin should drive, and persists the choice. Shown until the user gets started.
 */
export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const { toast } = useToast();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null); // null = scanning
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);

  const scan = useCallback(
    async (fresh = false) => {
      setAgents(null);
      try {
        const [list, settings] = await Promise.all([
          fresh ? api.rescanAgents() : api.listAgents(),
          api.getSettings().catch(() => null),
        ]);
        setAgents(list);
        const avail = list.filter((a) => a.available);
        const preferred =
          settings?.agentCommand && avail.some((a) => a.command === settings.agentCommand)
            ? settings.agentCommand
            : (avail[0]?.command ?? "");
        setAgent(preferred);
        setModel("");
      } catch {
        setAgents([]);
      }
    },
    [api],
  );

  useEffect(() => {
    void scan();
  }, [scan]);

  const available = (agents ?? []).filter((a) => a.available);
  const current = available.find((a) => a.command === agent);
  const models = current?.models ?? [];

  const finish = async () => {
    setSaving(true);
    try {
      if (agent) await api.updateSettings({ agentCommand: agent, model: model || "" });
    } catch {
      toast("Couldn't save your choice — you can set it later in Settings.", { variant: "error" });
    } finally {
      setSaving(false);
      onDone();
    }
  };

  return (
    <div className="relative flex h-screen flex-col items-center overflow-auto bg-background text-foreground">
      {native?.isElectron ? <div className="app-drag absolute inset-x-0 top-0 z-10 h-9" aria-hidden /> : null}
      <div className="flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-12">
        <div className="mb-8 text-center">
          <span className="font-brand text-4xl tracking-tight">Dezin</span>
          <h1 className="mt-5 text-xl font-semibold tracking-tight">Welcome</h1>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Describe what you want and Dezin builds it with your own coding agent, then holds the result to a strict anti-slop bar. Pick the agent it should drive.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="label-mono">Agent</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              disabled={agents === null}
              onClick={() => void scan(true)}
            >
              <RotateCw size={13} strokeWidth={1.75} />
              Rescan
            </Button>
          </div>

          {agents === null ? (
            <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
              <Spinner size={20} />
              Scanning for installed agents…
            </div>
          ) : available.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No coding agents found</p>
              <p className="mx-auto mt-1.5 max-w-xs leading-relaxed">
                Install one — Claude Code, Codex, Gemini CLI, Cursor Agent, CodeBuddy, Copilot, Qwen, opencode, or Aider — and authenticate it, then Rescan.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {available.map((a) => {
                  const selected = a.command === agent;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setAgent(a.command);
                        setModel("");
                      }}
                      className={cn(
                        "relative flex flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-all active:scale-[0.99]",
                        selected ? "border-ring bg-surface ring-2 ring-ring/25" : "border-border hover:border-border-strong hover:bg-surface-2/50",
                      )}
                    >
                      {selected ? <Check size={13} strokeWidth={2.5} className="absolute right-2 top-2 text-foreground" /> : null}
                      <span className="grid size-8 place-items-center rounded-lg bg-surface-2 text-foreground">
                        <AgentLogo id={a.id} className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium leading-tight">{agentLabel(a.id)}</span>
                        {a.version ? <span className="block truncate text-[10px] text-muted-foreground">{a.version.slice(0, 16)}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>

              {models.length > 0 ? (
                <>
                  <p className="label-mono mb-2 mt-4">Model</p>
                  <div className="flex flex-wrap gap-1.5">
                    {["", ...models].map((m) => (
                      <button
                        key={m || "default"}
                        type="button"
                        onClick={() => setModel(m)}
                        className={cn(
                          "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                          model === m
                            ? "border-ring bg-surface text-foreground ring-1 ring-ring/30"
                            : "border-border text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
                        )}
                      >
                        {m || "Default"}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>

        <Button size="lg" className="mt-6 w-full gap-2" disabled={saving || agents === null} onClick={() => void finish()}>
          {saving ? <Spinner size={15} /> : null}
          {available.length === 0 ? "Continue anyway" : "Get started"}
          {!saving ? <ArrowRight size={16} strokeWidth={2} /> : null}
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">You can change this any time in Settings.</p>
      </div>
    </div>
  );
}
