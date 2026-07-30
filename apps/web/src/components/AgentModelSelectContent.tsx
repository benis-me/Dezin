import { useState } from "react";
import { Check, RotateCw } from "lucide-react";
import { Spinner } from "./ui/index.ts";
import { AgentLogo, agentLabel } from "./agent-logos.tsx";
import type { AgentInfo } from "../lib/api.ts";
import { agentAvailabilityReason } from "../lib/agent-availability.ts";
import { AGENT_SCAN_ERROR } from "../lib/agents-context.tsx";

export default function AgentModelSelectContent({
  agents,
  agent,
  model,
  models,
  onAgentChange,
  onModelChange,
  onRescan,
  error = null,
  agentDisabledReason,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  models: string[];
  onAgentChange: (command: string) => void;
  onModelChange: (model: string) => void;
  onRescan: () => Promise<unknown>;
  error?: string | null;
  agentDisabledReason?: (agent: AgentInfo) => string | null;
}) {
  const [scanning, setScanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);

  const rescan = async (): Promise<void> => {
    setScanning(true);
    setRescanError(null);
    try {
      const succeeded = await onRescan();
      if (succeeded === false) setRescanError(AGENT_SCAN_ERROR);
    } catch {
      setRescanError(AGENT_SCAN_ERROR);
    } finally {
      setScanning(false);
    }
  };
  const visibleError = scanning ? null : rescanError ?? error;

  return (
    <div className="dezin-agent-picker__body">
      <p className="label-mono dezin-agent-picker__label">Agent</p>
      {visibleError ? (
        <p role="alert" className="dezin-agent-picker__empty text-destructive">
          {visibleError}
        </p>
      ) : null}
      {agents.length === 0 && !visibleError ? (
        <p className="dezin-agent-picker__empty">{scanning ? "Scanning for agents…" : "No agents detected."}</p>
      ) : agents.length > 0 ? (
        <div className="dezin-agent-picker__agents">
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
                data-selected={selected || undefined}
                data-unavailable={disabledReason !== null || undefined}
                onClick={() => {
                  onAgentChange(candidate.command);
                }}
                className="dezin-agent-picker__agent"
              >
                {selected ? (
                  <Check
                    aria-hidden
                    size={12}
                    strokeWidth={2.5}
                    className="dezin-agent-picker__selected"
                  />
                ) : null}
                <span className="dezin-agent-picker__agent-logo">
                  <AgentLogo id={candidate.id} />
                </span>
                <span className="dezin-agent-picker__agent-copy">
                  <span className="dezin-agent-picker__agent-name">{agentLabel(candidate.id)}</span>
                  {candidate.version ? (
                    <span className="dezin-agent-picker__agent-version">{candidate.version.slice(0, 18)}</span>
                  ) : null}
                  {disabledReason ? (
                    <span className="dezin-agent-picker__agent-reason">
                      {disabledReason}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {models.length > 0 ? (
        <>
          <p className="label-mono dezin-agent-picker__label dezin-agent-picker__label--models">Model</p>
          <div className="dezin-agent-picker__models">
            {["", ...models].map((candidateModel) => (
              <button
                key={candidateModel || "default"}
                type="button"
                aria-pressed={model === candidateModel}
                data-selected={model === candidateModel || undefined}
                onClick={() => onModelChange(candidateModel)}
                className="dezin-agent-picker__model"
              >
                {candidateModel || "Default"}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="dezin-agent-picker__rescan-row">
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={scanning}
          className="dezin-agent-picker__rescan"
        >
          {scanning ? <Spinner size={13} /> : <RotateCw aria-hidden size={13} strokeWidth={1.75} />}
          {scanning ? "Scanning…" : "Rescan agents"}
        </button>
      </div>
    </div>
  );
}
