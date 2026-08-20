import "./dezin-agent-primitives.css";

// Compatibility facade: product code keeps its established import path while
// the reusable implementation and public types live in capability-foundry.
export * from "@capability-foundry/agent-ui";

export {
  AgentApproval as DezinAgentApproval,
  AgentContext as DezinAgentContext,
  AgentInsights as DezinAgentInsights,
  AgentJobDisclosure as DezinAgentJobDisclosure,
  AgentLoadingState as DezinAgentLoadingState,
  AgentRecommendation as DezinAgentRecommendation,
  AgentStreamingText as DezinAgentStreamingText,
  AgentTaskRow as DezinAgentTaskRow,
  AgentThinking as DezinAgentThinking,
  AgentToolGroup as DezinAgentToolGroup,
  AgentToolRows as DezinAgentToolRows,
} from "@capability-foundry/agent-ui";

export type {
  AgentApprovalProps as DezinAgentApprovalProps,
  AgentContextProps as DezinAgentContextProps,
  AgentInsightsProps as DezinAgentInsightsProps,
  AgentJobDisclosureProps as DezinAgentJobDisclosureProps,
  AgentLoadingStateProps as DezinAgentLoadingStateProps,
  AgentRecommendationProps as DezinAgentRecommendationProps,
  AgentStreamingTextProps as DezinAgentStreamingTextProps,
  AgentTaskRowProps as DezinAgentTaskRowProps,
  AgentThinkingItem as DezinAgentThinkingItem,
  AgentThinkingProps as DezinAgentThinkingProps,
  AgentToolGroupProps as DezinAgentToolGroupProps,
  AgentToolRowsProps as DezinAgentToolRowsProps,
} from "@capability-foundry/agent-ui";
