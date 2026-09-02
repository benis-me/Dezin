import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentInfo } from "../lib/api.ts";
import { isDesignAgentCommand } from "./api.ts";
import type { CanvasAgentSelection } from "./FloatingNodeAgent.tsx";

/**
 * Which installed Design Agent (and model) the canvas panels drive. Follows the
 * Settings defaults until the user picks explicitly, then persists that choice.
 */
export function useCanvasAgentSelection({
  agents,
  initialAgentCommand,
  initialModel,
  onAgentDefaultsChange,
}: {
  agents: readonly AgentInfo[];
  initialAgentCommand: string | undefined;
  initialModel: string | undefined;
  onAgentDefaultsChange?: (selection: CanvasAgentSelection) => Promise<void>;
}) {
  const [mainAgentSelection, setMainAgentSelection] = useState<CanvasAgentSelection>(() => ({
    agentCommand: isDesignAgentCommand(initialAgentCommand) ? initialAgentCommand : "",
    model: isDesignAgentCommand(initialAgentCommand) ? initialModel ?? "" : "",
  }));
  const touchedRef = useRef(false);
  const updateMainAgentSelection = useCallback((selection: CanvasAgentSelection) => {
    touchedRef.current = true;
    setMainAgentSelection(selection);
    void onAgentDefaultsChange?.(selection).catch(() => undefined);
  }, [onAgentDefaultsChange]);
  const availableDesignAgents = useMemo(
    () => agents.filter((agent) => isDesignAgentCommand(agent.command) && agent.available),
    [agents],
  );

  useEffect(() => {
    setMainAgentSelection((current) => {
      const settingsAgent = isDesignAgentCommand(initialAgentCommand)
        ? availableDesignAgents.find((agent) => agent.command === initialAgentCommand) ?? null
        : null;
      if (!touchedRef.current && settingsAgent) {
        const settingsModel = initialModel && settingsAgent.models.includes(initialModel) ? initialModel : "";
        if (current.agentCommand === settingsAgent.command && current.model === settingsModel) return current;
        return { agentCommand: settingsAgent.command, model: settingsModel };
      }
      const active = availableDesignAgents.find((agent) => agent.command === current.agentCommand) ?? null;
      if (active && (!current.model || active.models.includes(current.model))) return current;
      const preferred = settingsAgent ?? availableDesignAgents[0] ?? null;
      if (!preferred) return current.agentCommand || current.model ? { agentCommand: "", model: "" } : current;
      const preferredModel = preferred.command === initialAgentCommand
        && initialModel
        && preferred.models.includes(initialModel)
        ? initialModel
        : "";
      return { agentCommand: preferred.command, model: preferredModel };
    });
  }, [availableDesignAgents, initialAgentCommand, initialModel]);

  return { availableDesignAgents, mainAgentSelection, updateMainAgentSelection };
}
