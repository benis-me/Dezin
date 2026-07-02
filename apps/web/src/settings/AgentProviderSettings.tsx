import { Check, RotateCw } from "lucide-react";
import type { AgentInfo, Settings } from "../lib/api.ts";
import { AgentLogo, agentLabel } from "../components/agent-logos.tsx";
import { Button, Input, Picker, Spinner } from "../components/ui/index.ts";
import { cn } from "../lib/utils.ts";
import { SettingRow, SettingsPanel } from "./settings-ui.tsx";

export function AgentProviderSettings({
  settings,
  agents,
  activeAgent,
  agentsLoading,
  scanStatus,
  onLocal,
  onSave,
  onRescan,
}: {
  settings: Settings;
  agents: AgentInfo[];
  activeAgent?: AgentInfo;
  agentsLoading: boolean;
  scanStatus: string | null;
  onLocal: (key: keyof Settings, value: string | boolean) => void;
  onSave: (key: keyof Settings, value: string | boolean) => void;
  onRescan: () => void;
}) {
  return (
    <SettingsPanel title="Agents" desc="Bring your own key. Dezin drives your local coding-agent CLI.">
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
                {scanStatus || "Scanning..."}
              </span>
            ) : (
              <Button variant="ghost" size="sm" onClick={onRescan}>
                <RotateCw size={13} strokeWidth={1.75} />
                Rescan
              </Button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {agentsLoading
              ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[78px] animate-pulse rounded-xl border border-border bg-surface-2/50" />)
              : (agents.length ? agents : [{ id: settings.agentCommand, command: settings.agentCommand, available: false, version: undefined, models: [] }]).map((agent) => {
                  const selected = agent.command === settings.agentCommand;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      aria-pressed={selected}
                      disabled={!agent.available}
                      title={agent.available ? undefined : `${agentLabel(agent.id)} isn't installed`}
                      onClick={() => onSave("agentCommand", agent.command)}
                      className={cn(
                        "relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all",
                        agent.available && "active:scale-[0.99]",
                        selected
                          ? "border-ring bg-surface ring-2 ring-ring/25"
                          : agent.available
                            ? "border-border hover:border-border-strong hover:bg-surface-2/50"
                            : "cursor-not-allowed border-border opacity-50",
                      )}
                    >
                      {selected ? <Check size={14} strokeWidth={2.5} className="absolute right-2.5 top-2.5 text-foreground" /> : null}
                      <span className="grid size-9 place-items-center rounded-lg bg-surface-2 text-foreground">
                        <AgentLogo id={agent.id} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{agentLabel(agent.id)}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className={cn("size-1.5 shrink-0 rounded-full", agent.available ? "bg-[var(--success)]" : "bg-border-strong")} />
                          <span className="truncate">{agent.available ? (agent.version?.slice(0, 16) ?? "Detected") : "Not found"}</span>
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
              onChange={(value) => onSave("model", value)}
              options={[{ value: "", label: "Default" }, ...activeAgent.models.map((model) => ({ value: model, label: model }))]}
            />
          ) : (
            <Input
              aria-label="Model"
              className="w-44"
              value={settings.model}
              placeholder="default"
              onChange={(event) => onLocal("model", event.target.value)}
              onBlur={(event) => onSave("model", event.target.value)}
            />
          )}
        </SettingRow>
      </div>
    </SettingsPanel>
  );
}
