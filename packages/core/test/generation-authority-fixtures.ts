import type {
  WorkspaceGenerationAgentSelection,
  WorkspaceGenerationMoodboardImageAuthority,
} from "../src/index.ts";

export function codebuddyGeneratorAgent(
  model: string | null = "gpt-5.6-sol",
): WorkspaceGenerationAgentSelection {
  return {
    providerId: "codebuddy",
    command: "codebuddy",
    model,
    executionAuthority: {
      kind: "generator",
      baseUrl: "",
      organization: "",
      credentialProviderId: "codebuddy",
      credentialSource: "session",
      credentialRequired: false,
    },
  };
}

export function codexResearchGeneratorAgent(
  model: string | null = "gpt-5.4-mini",
): WorkspaceGenerationAgentSelection {
  return {
    providerId: "codex",
    command: "codex",
    model,
    executionAuthority: {
      kind: "generator",
      baseUrl: "",
      organization: "",
      credentialProviderId: "openai",
      credentialSource: "session",
      credentialRequired: false,
    },
  };
}

export function claudeSessionReviewerAgent(
  model: string | null = null,
): WorkspaceGenerationAgentSelection {
  return {
    providerId: "claude",
    command: "claude",
    model,
    executionAuthority: {
      kind: "reviewer",
      baseUrl: "",
      credentialSource: "session",
      credentialRequired: false,
    },
  };
}

export function azureMoodboardImageAuthority(): WorkspaceGenerationMoodboardImageAuthority {
  return {
    kind: "moodboard-image",
    protocol: "dezin.workspace-moodboard-image-authority.v1",
    providerId: "azure-openai",
    baseUrl: "https://example.openai.azure.com/openai",
    model: "gpt-image-2",
    apiVersion: "2025-04-01-preview",
    credentialSource: "provider-profile",
    credentialRequired: true,
  };
}
