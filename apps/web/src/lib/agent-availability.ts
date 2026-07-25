import type { AgentInfo } from "./api.ts";

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
