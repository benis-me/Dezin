import type { AgentInfo, ProjectMode } from "./api.ts";

export type AgentCapabilityMode = ProjectMode | "design-workspace";

const STANDARD_AGENT_IDS = new Set(["claude", "codebuddy"]);

/**
 * Standard projects and their Design Workspace need agents that support the
 * structured multi-artifact generation contract. Prototype keeps the broader
 * ready-agent surface because it only produces a self-contained artifact.
 */
export function agentModeDisabledReason(
  agent: AgentInfo | undefined,
  mode: AgentCapabilityMode,
): string | null {
  if (!agent || mode === "prototype" || STANDARD_AGENT_IDS.has(agent.id)) return null;
  return mode === "standard"
    ? "Standard projects require Claude Code or CodeBuddy."
    : "Design Workspace generation requires Claude Code or CodeBuddy.";
}

export function agentAvailabilityReason(agent: AgentInfo | undefined): string | null {
  if (!agent) return "Choose an available Agent.";
  if (agent.available) return null;
  if (agent.unavailableReason?.trim()) return agent.unavailableReason.trim();
  if (agent.availability === "authentication-required") {
    return `Sign in to ${agent.id === "codebuddy" ? "CodeBuddy" : "this Agent"}, then rescan agents.`;
  }
  if (agent.availability === "verification-required") {
    return "Agent sign-in couldn't be verified. Rescan agents to try again.";
  }
  return "Agent not found. Install it or rescan agents.";
}

export function selectableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) =>
    agent.available
    || agent.availability === "authentication-required"
    || agent.availability === "verification-required");
}

/** Keep an explicit model only while the ready Agent still advertises it; "" means provider default. */
export function normalizeAgentModel(agent: AgentInfo | undefined, model: string): string {
  return agent?.available && agent.models.includes(model) ? model : "";
}
