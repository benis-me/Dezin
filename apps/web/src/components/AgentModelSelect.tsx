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
  error = null,
  agentDisabledReason,
  dropUp = false,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescan: () => Promise<unknown>;
  error?: string | null;
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
        className="dezin-agent-picker__trigger"
      >
        {current ? <AgentLogo id={current.id} className="dezin-agent-picker__trigger-logo" /> : null}
        <span className="dezin-agent-picker__trigger-agent">{current ? agentLabel(current.id) : "Agent"}</span>
        {model ? <span className="dezin-agent-picker__trigger-model">· {model}</span> : null}
        {currentUnavailableReason ? <CircleAlert aria-hidden size={13} className="dezin-agent-picker__warning" /> : null}
        <ChevronDown size={13} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent
        side={dropUp ? "top" : "bottom"}
        align="start"
        aria-label="Choose Agent and model"
        className="dezin-agent-picker__content"
      >
        <AgentModelSelectContent
          agents={selectable}
          agent={agent}
          model={model}
          models={models}
          onAgentChange={onAgentChange}
          onModelChange={onModelChange}
          onRescan={onRescan}
          error={error}
          agentDisabledReason={agentDisabledReason}
        />
      </PopoverContent>
    </Popover>
  );
}
