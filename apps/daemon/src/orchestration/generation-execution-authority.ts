import { isDeepStrictEqual } from "node:util";

import { getProvider } from "../../../../packages/agent/src/index.ts";
import {
  assertWorkspaceGenerationExecutionAuthority,
  type Settings,
  type WorkspaceGenerationAgentSelection,
  type WorkspaceGenerationGeneratorExecutionAuthority,
  type WorkspaceGenerationPayload,
  type WorkspaceGenerationReviewerExecutionAuthority,
} from "../../../../packages/core/src/index.ts";
import { resolveAgentProviderCredential } from "../agent-provider-credential.ts";
import {
  assertWorkspaceMoodboardImageAuthorityMatchesSettings,
} from "./moodboard-image-execution-authority.ts";

export class GenerationExecutionAuthorityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GenerationExecutionAuthorityError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function credentialFreeBaseUrl(value: string, label: string): string {
  const raw = value.trim();
  if (raw.length === 0) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new GenerationExecutionAuthorityError(`${label} is invalid`, error);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0 || url.password.length > 0
    || url.search.length > 0 || url.hash.length > 0
    || (raw !== url.href && `${raw}/` !== url.href)) {
    throw new GenerationExecutionAuthorityError(
      `${label} must be canonical and credential-free`,
    );
  }
  return url.href;
}

function credentialProviderId(providerId: string): string {
  if (providerId === "codebuddy") return "codebuddy";
  if (providerId === "claude") return "anthropic";
  if (providerId === "codex" || providerId === "copilot") return "openai";
  return providerId;
}

function exactSelectionProvider(
  selection: WorkspaceGenerationAgentSelection,
  label: string,
): string {
  const providerId = getProvider(selection.command)?.id;
  if (providerId === undefined || providerId !== selection.providerId) {
    throw new GenerationExecutionAuthorityError(
      `${label} provider does not match its command identity`,
    );
  }
  return providerId;
}

/**
 * Captures the non-secret route for a generating Agent at Proposal time. The
 * generic Settings credential pair is usable only when it already belongs to
 * the selected provider; host-authenticated CLIs deliberately carry no BYOK
 * endpoint or credential requirement.
 */
export function workspaceGeneratorExecutionAuthority(
  settings: Settings,
  selection: WorkspaceGenerationAgentSelection,
): WorkspaceGenerationGeneratorExecutionAuthority {
  const providerId = exactSelectionProvider(selection, "Workspace generation Agent");
  const credentialProvider = credentialProviderId(providerId);
  if (providerId === "codebuddy" || providerId === "codex") {
    return Object.freeze({
      kind: "generator",
      baseUrl: "",
      organization: "",
      credentialProviderId: credentialProvider,
      credentialSource: "session",
      credentialRequired: false,
    });
  }
  const credential = resolveAgentProviderCredential(settings, providerId);
  return Object.freeze({
    kind: "generator",
    baseUrl: credential
      ? credentialFreeBaseUrl(
          credential.baseUrl,
          "Workspace generation Agent base URL",
        )
      : "",
    organization: credential?.organization ?? "",
    credentialProviderId: credentialProvider,
    credentialSource: credential?.source ?? "session",
    credentialRequired: credential?.credentialRequired ?? false,
  });
}

/**
 * Captures the independent structured reviewer's exact non-secret endpoint and
 * credential source. Secret rotation is allowed later only within this source.
 */
export function workspaceReviewerExecutionAuthority(
  settings: Settings,
  selection: WorkspaceGenerationAgentSelection,
  generatingAgent?: WorkspaceGenerationAgentSelection,
): WorkspaceGenerationReviewerExecutionAuthority {
  const providerId = exactSelectionProvider(selection, "Workspace generation reviewer");
  if (providerId !== "claude" && providerId !== "codebuddy" && providerId !== "codex") {
    throw new GenerationExecutionAuthorityError(
      "Workspace generation reviewer command is unsupported",
    );
  }
  if (providerId === "codebuddy" || providerId === "codex") {
    return Object.freeze({
      kind: "reviewer",
      baseUrl: "",
      credentialSource: "session",
      credentialRequired: false,
    });
  }
  const credential = resolveAgentProviderCredential(settings, "claude");
  if (credential?.source === "provider-profile") {
    return Object.freeze({
      kind: "reviewer",
      baseUrl: credentialFreeBaseUrl(
        credential.baseUrl,
        "Workspace generation reviewer base URL",
      ),
      credentialSource: "anthropic-profile",
      credentialRequired: credential.credentialRequired,
    });
  }
  const effectiveAgentProviderId = generatingAgent === undefined
    ? getProvider(settings.agentCommand.trim() || "claude")?.id
    : exactSelectionProvider(generatingAgent, "Workspace generating Agent");
  if (credential?.source === "agent" && effectiveAgentProviderId === "claude") {
    return Object.freeze({
      kind: "reviewer",
      baseUrl: credentialFreeBaseUrl(
        credential.baseUrl,
        "Workspace generation reviewer Agent base URL",
      ),
      credentialSource: "agent",
      credentialRequired: credential.credentialRequired,
    });
  }
  return Object.freeze({
    kind: "reviewer",
    baseUrl: "",
    credentialSource: "session",
    credentialRequired: false,
  });
}

/** Freezes one generating principal together with the exact non-secret route it is allowed to use. */
export function freezeWorkspaceGeneratorAgentSelection(
  settings: Settings,
  selection: WorkspaceGenerationAgentSelection,
): WorkspaceGenerationAgentSelection {
  return Object.freeze({
    providerId: selection.providerId,
    command: selection.command,
    model: selection.model,
    executionAuthority: workspaceGeneratorExecutionAuthority(settings, selection),
  });
}

/** Freezes one review principal together with its exact non-secret credential source. */
export function freezeWorkspaceReviewerAgentSelection(
  settings: Settings,
  selection: WorkspaceGenerationAgentSelection,
  generatingAgent?: WorkspaceGenerationAgentSelection,
): WorkspaceGenerationAgentSelection {
  return Object.freeze({
    providerId: selection.providerId,
    command: selection.command,
    model: selection.model,
    executionAuthority: workspaceReviewerExecutionAuthority(
      settings,
      selection,
      generatingAgent,
    ),
  });
}

/**
 * Approval-time live preflight. Recomputes every frozen non-secret route from
 * the current Settings snapshot, so a caller cannot submit a structurally
 * valid but forged endpoint/source and defer failure until materialization.
 */
export function assertWorkspaceGenerationExecutionAuthorityMatchesSettings(
  settings: Settings,
  generation: WorkspaceGenerationPayload,
  proposalId: string,
): void {
  assertWorkspaceGenerationExecutionAuthority(generation, proposalId);
  const hasExecutableAgentTask = generation.artifactPlans.length > 0
    || generation.resourceOperations.some((operation) => operation.revisionPolicy.kind === "generate");
  if (!hasExecutableAgentTask) return;
  const agent = generation.agent!;
  const reviewer = generation.reviewerAgent!;
  let currentAgent: WorkspaceGenerationGeneratorExecutionAuthority;
  let currentReviewer: WorkspaceGenerationReviewerExecutionAuthority;
  try {
    currentAgent = workspaceGeneratorExecutionAuthority(settings, agent);
    currentReviewer = workspaceReviewerExecutionAuthority(settings, reviewer, agent);
  } catch (error) {
    throw new GenerationExecutionAuthorityError(
      "Current Settings cannot resolve the frozen workspace generation execution authority",
      error,
    );
  }
  if (!isDeepStrictEqual(currentAgent, agent.executionAuthority)) {
    throw new GenerationExecutionAuthorityError(
      "Current Settings do not match the frozen workspace generation Agent endpoint, organization, credential provider, or credential requirement",
    );
  }
  if (!isDeepStrictEqual(currentReviewer, reviewer.executionAuthority)) {
    throw new GenerationExecutionAuthorityError(
      "Current Settings do not match the frozen workspace generation reviewer endpoint, credential source, or credential requirement",
    );
  }
  const hasGeneratedResearch = generation.resourceOperations.some((operation) => (
    operation.kind === "research" && operation.revisionPolicy.kind === "generate"
  ));
  if (hasGeneratedResearch) {
    const researchAgent = generation.researchAgent!;
    let currentResearch: WorkspaceGenerationGeneratorExecutionAuthority;
    try {
      currentResearch = workspaceGeneratorExecutionAuthority(settings, researchAgent);
    } catch (error) {
      throw new GenerationExecutionAuthorityError(
        "Current Settings cannot resolve the frozen Research execution authority",
        error,
      );
    }
    if (!isDeepStrictEqual(currentResearch, researchAgent.executionAuthority)) {
      throw new GenerationExecutionAuthorityError(
        "Current Settings do not match the frozen Research endpoint, organization, credential provider, or credential requirement",
      );
    }
  }
  const hasGeneratedMoodboard = generation.resourceOperations.some((operation) => (
    operation.kind === "moodboard" && operation.revisionPolicy.kind === "generate"
  ));
  if (hasGeneratedMoodboard) {
    try {
      assertWorkspaceMoodboardImageAuthorityMatchesSettings(
        settings,
        generation.moodboardImageAuthority!,
      );
    } catch (error) {
      throw new GenerationExecutionAuthorityError(
        "Current Settings do not match the frozen Moodboard image execution authority",
        error,
      );
    }
  }
}
