import { useState } from "react";
import { Check, RotateCw } from "lucide-react";
import { Spinner } from "./ui/index.ts";
import { AgentLogo, agentLabel } from "./agent-logos.tsx";
import { cn } from "../lib/utils.ts";
import type { AgentInfo } from "../lib/api.ts";
import { agentAvailabilityReason } from "../lib/agent-availability.ts";

export default function AgentModelSelectContent({
  agents,
  agent,
  model,
  models,
  onAgentChange,
  onModelChange,
  onRescan,
  agentDisabledReason,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  models: string[];
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescan: () => Promise<void>;
  agentDisabledReason?: (agent: AgentInfo) => string | null;
}) {
  const [scanning, setScanning] = useState(false);

  const rescan = async (): Promise<void> => {
    setScanning(true);
    try {
      await onRescan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <p className="label-mono px-0.5 pb-1.5">Agent</p>
      {agents.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">No agents detected.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {agents.map((candidate) => {
            const selected = candidate.command === agent;
            const disabledReason = agentAvailabilityReason(candidate) ?? agentDisabledReason?.(candidate) ?? null;
            return (
              <button
                key={candidate.id}
                type="button"
                disabled={disabledReason !== null}
                aria-pressed={selected}
                title={disabledReason ?? undefined}
                onClick={() => {
                  onAgentChange(candidate.command);
                }}
                className={cn(
                  "relative flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors",
                  selected ? "border-ring bg-surface ring-1 ring-ring/30" : "border-border hover:bg-surface-2/60",
                  disabledReason && "cursor-not-allowed opacity-55 hover:bg-transparent",
                )}
              >
                {selected ? (
                  <Check
                    aria-hidden
                    size={12}
                    strokeWidth={2.5}
                    className="absolute right-1.5 top-1.5 text-foreground"
                  />
                ) : null}
                <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-foreground">
                  <AgentLogo id={candidate.id} className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium leading-tight">{agentLabel(candidate.id)}</span>
                  {candidate.version ? (
                    <span className="block truncate text-[11px] text-muted-foreground">{candidate.version.slice(0, 18)}</span>
                  ) : null}
                  {disabledReason ? (
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      {disabledReason}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {models.length > 0 ? (
        <>
          <p className="label-mono px-0.5 pb-1.5 pt-3">Model</p>
          <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto pr-0.5">
            {["", ...models].map((candidateModel) => (
              <button
                key={candidateModel || "default"}
                type="button"
                aria-pressed={model === candidateModel}
                onClick={() => onModelChange(candidateModel)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                  model === candidateModel
                    ? "border-ring bg-surface text-foreground ring-1 ring-inset ring-ring/30"
                    : "border-border text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
                )}
              >
                {candidateModel || "Default"}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-2.5 border-t border-border/60 pt-1.5">
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={scanning}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          {scanning ? <Spinner size={13} /> : <RotateCw aria-hidden size={13} strokeWidth={1.75} />}
          {scanning ? "Scanning…" : "Rescan agents"}
        </button>
      </div>
    </>
  );
}
