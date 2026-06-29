import { useState } from "react";
import { Check, ChevronDown, RotateCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Spinner } from "./ui/index.ts";
import { AgentLogo, agentLabel } from "./agent-logos.tsx";
import { cn } from "../lib/utils.ts";
import type { AgentInfo } from "../lib/api.ts";

/**
 * Combined agent + model picker. The panel mirrors Settings → Provider: a grid of the
 * detected agents (logo cards) plus the selected agent's models, with a Rescan action.
 */
export function AgentModelSelect({
  agents,
  agent,
  model,
  onAgentChange,
  onModelChange,
  onRescan,
  dropUp = false,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescan: () => Promise<void>;
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  const available = agents.filter((a) => a.available);
  const current = agents.find((a) => a.command === agent);
  const models = current?.models ?? [];

  const rescan = async (): Promise<void> => {
    setScanning(true);
    try {
      await onRescan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        aria-label="Agent and model"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        {current ? <AgentLogo id={current.id} className="size-3.5" /> : null}
        <span className="max-w-[9rem] truncate font-medium text-foreground">{current ? agentLabel(current.id) : "Agent"}</span>
        {model ? <span className="max-w-[7rem] truncate text-muted-foreground">· {model}</span> : null}
        <ChevronDown size={13} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent side={dropUp ? "top" : "bottom"} align="start" className="w-72 p-2">
        <p className="label-mono px-0.5 pb-1.5">Agent</p>
        {available.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No agents detected.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {available.map((a) => {
              const selected = a.command === agent;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    onAgentChange(a.command);
                    onModelChange("");
                  }}
                  className={cn(
                    "relative flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors",
                    selected ? "border-ring bg-surface ring-1 ring-ring/30" : "border-border hover:bg-surface-2/60",
                  )}
                >
                  {selected ? <Check size={12} strokeWidth={2.5} className="absolute right-1.5 top-1.5 text-foreground" /> : null}
                  <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-foreground">
                    <AgentLogo id={a.id} className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium leading-tight">{agentLabel(a.id)}</span>
                    {a.version ? <span className="block truncate text-[10px] text-muted-foreground">{a.version.slice(0, 18)}</span> : null}
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
              {["", ...models].map((m) => (
                <button
                  key={m || "default"}
                  type="button"
                  onClick={() => onModelChange(m)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                    model === m ? "border-ring bg-surface text-foreground ring-1 ring-ring/30" : "border-border text-muted-foreground hover:bg-surface-2/60 hover:text-foreground",
                  )}
                >
                  {m || "Default"}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div className="mt-2.5 border-t border-border pt-1.5">
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={scanning}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {scanning ? <Spinner size={13} /> : <RotateCw size={13} strokeWidth={1.75} />}
            {scanning ? "Scanning…" : "Rescan agents"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
