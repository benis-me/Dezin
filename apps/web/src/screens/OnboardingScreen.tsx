import { useEffect, useState } from "react";
import { ArrowRight, Check, RotateCw } from "lucide-react";
import { Button, Spinner } from "../components/ui/index.ts";
import { AgentLogo, agentLabel } from "../components/agent-logos.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { cn } from "../lib/utils.ts";
import { native } from "../lib/native.ts";

/**
 * First-run welcome. Runs the same deep scan as a manual Rescan (so CodeBuddy's live model
 * list etc. is accurate, not the fast-path seed), lets the user pick the agent + model Dezin
 * should drive, and persists it. Uses the shared agents context so the result is appwide.
 */
export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const { toast } = useToast();
  const { agents, loading, scanning, rescan } = useAgents();
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);

  const available = agents.filter((a) => a.available);

  // Default to the first available agent once the scan resolves.
  useEffect(() => {
    if (available.length && !available.some((a) => a.command === agent)) setAgent(available[0]!.command);
  }, [available, agent]);

  const current = available.find((a) => a.command === agent);
  const models = current?.models ?? [];
  // First run does the full (deep) scan and waits for it — a slower first cold start is fine,
  // and the results then match a manual Rescan instead of the fast-path seed.
  const busy = loading || scanning;
  const cbScanning = scanning && agents.some((a) => a.id === "codebuddy" && a.available);
  const status = loading
    ? "Detecting installed agents…"
    : cbScanning
      ? "Reading CodeBuddy's model list…"
      : scanning
        ? "Reading installed model lists…"
        : "";

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
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={busy} onClick={() => void rescan()}>
              <RotateCw size={13} strokeWidth={1.75} />
              Rescan
            </Button>
          </div>

          {busy ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
              <Spinner size={20} />
              {status}
              <span className="text-xs text-muted-foreground/70">
                {cbScanning ? "CodeBuddy's list comes from its interactive UI — about 30 seconds." : "This can take a moment the first time."}
              </span>
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
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-0.5">
                    {["", ...models].map((m) => (
                      <button
                        key={m || "default"}
                        type="button"
                        onClick={() => setModel(m)}
                        className={cn(
                          "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                          model === m
                            ? "border-ring bg-surface text-foreground ring-1 ring-inset ring-ring/30"
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

        <Button size="lg" className="mt-6 w-full gap-2" disabled={saving || busy} onClick={() => void finish()}>
          {saving ? <Spinner size={15} /> : null}
          {available.length === 0 ? "Continue anyway" : "Get started"}
          {!saving ? <ArrowRight size={16} strokeWidth={2} /> : null}
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">You can change this any time in Settings.</p>
      </div>
    </div>
  );
}
