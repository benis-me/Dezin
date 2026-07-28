import { useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/index.ts";
import { AgentLogo, agentLabel } from "./agent-logos.tsx";
import AgentModelSelectContent from "./AgentModelSelectContent.tsx";
import type { AgentInfo } from "../lib/api.ts";
import { agentAvailabilityReason, selectableAgents } from "../lib/agent-availability.ts";

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
  agentDisabledReason,
  dropUp = false,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescan: () => Promise<void>;
  agentDisabledReason?: (agent: AgentInfo) => string | null;
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectable = selectableAgents(agents);
  const current = agents.find((a) => a.command === agent);
  const currentUnavailableReason = current
    ? agentAvailabilityReason(current) ?? agentDisabledReason?.(current) ?? null
    : null;
  const models = current?.available && currentUnavailableReason === null ? current.models : [];
  const currentSelectionLabel = current
    ? `${agentLabel(current.id)}${model ? `, ${model}` : ""}`
    : "No Agent selected";

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger
        aria-label="Agent and model"
        aria-description={`Current Agent and model: ${currentSelectionLabel}`}
        title={currentUnavailableReason ?? undefined}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
      >
        {current ? <AgentLogo id={current.id} className="size-3.5" /> : null}
        <span className="max-w-[9rem] truncate font-medium text-foreground">{current ? agentLabel(current.id) : "Agent"}</span>
        {model ? <span className="max-w-[7rem] truncate text-muted-foreground">· {model}</span> : null}
        {currentUnavailableReason ? <CircleAlert aria-hidden size={13} className="text-destructive" /> : null}
        <ChevronDown size={13} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent
        side={dropUp ? "top" : "bottom"}
        align="start"
        aria-label="Choose Agent and model"
        className="w-80 max-w-[calc(100vw-16px)] overflow-y-auto p-2"
      >
        <AgentModelSelectContent
          agents={selectable}
          agent={agent}
          model={model}
          models={models}
          onAgentChange={onAgentChange}
          onModelChange={onModelChange}
          onRescan={onRescan}
          agentDisabledReason={agentDisabledReason}
        />
      </PopoverContent>
    </Popover>
  );
}
