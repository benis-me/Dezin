import { createHash } from "node:crypto";
import {
  normalizeGenerationTaskIntent,
} from "./store-codecs.ts";
import { compareBinary } from "./workspace-codecs.ts";
import { applyWorkspaceGraphCommands } from "./workspace-graph.ts";
import type {
  ArtifactGenerationTaskPayloadV2,
  ArtifactQualityProfile,
  GenerationPlan,
  GenerationPlanGraph,
  GenerationTaskCapacityClass,
  GenerationTaskDependency,
  GenerationTaskIntent,
  GenerationTaskIntentInput,
  GenerationTaskKind,
  GenerationTaskResourceLimits,
  GenerationTaskTarget,
  ResourceKind,
  ResourceGenerationTaskPayloadV2,
  WorkspaceGenerationArtifactPlan,
  WorkspaceGenerationAgentSelection,
  WorkspaceGenerationCapability,
  WorkspaceGenerationDependencyPlan,
  WorkspaceGenerationPayload,
  WorkspaceGraph,
  WorkspaceProposal,
} from "./workspace-types.ts";

export type CompiledGenerationPlan = GenerationPlan & Pick<GenerationPlanGraph, "tasks" | "dependencies">;

export type GenerationPlanCompileErrorCode =
  | "shell-not-approved"
  | "proposal-not-approved"
  | "proposal-identity-mismatch"
  | "proposal-base-mismatch"
  | "unsupported-proposal"
  | "unsupported-resource-kind"
  | "duplicate-id"
  | "invalid-reference"
  | "cyclic-task-graph";

export class GenerationPlanCompileError extends Error {
  readonly code: GenerationPlanCompileErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GenerationPlanCompileErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GenerationPlanCompileError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

const NO_QA = deepFreeze<ArtifactQualityProfile>({
  requiredFrameIds: [],
  blockingSeverities: [],
  requireRuntimeChecks: false,
  requireVisualReview: false,
});

const RESOURCE_LIMITS: GenerationTaskResourceLimits = {
  timeoutMs: 180_000,
  maxAgentTurns: 12,
  maxRepairRounds: 1,
  maxOutputBytes: 8 * 1024 * 1024,
  capacityClasses: ["agent"],
};

const MOODBOARD_RESOURCE_LIMITS: GenerationTaskResourceLimits = {
  ...RESOURCE_LIMITS,
  // A Moodboard bundle owns several reviewed PNG assets encoded into one
  // immutable payload. The generic text-resource budget cannot hold even three
  // production images and previously failed before Components or Pages began.
  maxOutputBytes: 48 * 1024 * 1024,
};

const ARTIFACT_LIMITS: GenerationTaskResourceLimits = {
  timeoutMs: 360_000,
  maxAgentTurns: 20,
  // This is the immutable safety ceiling, not the user's effective policy.
  // Standard Artifact execution still clamps this through the frozen
  // auto-improve setting captured for the Attempt.
  maxRepairRounds: 8,
  maxOutputBytes: 24 * 1024 * 1024,
  capacityClasses: ["agent", "render-qa"],
};

/**
 * One immutable Resource Task deadline budget shared by every Agent provider.
 *
 * Moodboard is the worst-case Resource leaf: one structured Agent turn followed
 * by up to eight sequential image generations and eight independent reviews.
 * Keeping the arithmetic here makes the compiled outer Task deadline and every
 * daemon-owned inner call cap one auditable contract instead of unrelated
 * bootstrap constants.
 */
export const RESOURCE_GENERATION_DEADLINE_BUDGET = Object.freeze({
  agentCallTimeoutMs: 7 * 60_000,
  /** Minimum per-image reserve used to prove the fixed outer deadline before the draft cardinality is known. */
  imageCallTimeoutMs: 90_000,
  /** Runtime ceiling; the generator derives a smaller live cap after the Agent returns the exact Asset count. */
  maxImageCallTimeoutMs: 5 * 60_000,
  // Host-login reviewers (notably Codex) regularly need more than 30 seconds
  // even for a small schema-constrained verdict. Keep this an explicit,
  // immutable per-call cap and account for the larger reserve below.
  reviewCallTimeoutMs: 60_000,
  completionReserveMs: 2 * 60_000,
  maxMoodboardAssets: 8,
  taskTimeoutMs: (
    (7 * 60_000)
    + (8 * 90_000)
    + (8 * 60_000)
    + (2 * 60_000)
  ),
} as const);

const HOST_LOGIN_ARTIFACT_BASE_TIMEOUT_MS = 30 * 60_000;
const HOST_LOGIN_ARTIFACT_EXTRA_FRAME_TIMEOUT_MS = 5 * 60_000;
const HOST_LOGIN_ARTIFACT_MAX_TIMEOUT_MS = 45 * 60_000;
const MAX_ARTIFACT_VISUAL_QA_FRAMES = 16;

const VALIDATION_LIMITS: GenerationTaskResourceLimits = {
  timeoutMs: 180_000,
  maxAgentTurns: 1,
  maxRepairRounds: 0,
  maxOutputBytes: 4 * 1024 * 1024,
  capacityClasses: ["render-qa"],
};

const CHECKPOINT_LIMITS: GenerationTaskResourceLimits = {
  timeoutMs: 30_000,
  maxAgentTurns: 1,
  maxRepairRounds: 0,
  maxOutputBytes: 1024 * 1024,
  capacityClasses: [],
};

const AGENT_GENERATABLE_RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set([
  "research",
  "moodboard",
  "sharingan-capture",
]);

export function isAgentGeneratableResourceKind(kind: ResourceKind): boolean {
  return AGENT_GENERATABLE_RESOURCE_KINDS.has(kind);
}

function compileError(
  code: GenerationPlanCompileErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GenerationPlanCompileError(code, message, details);
}

function stableHash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`dezin:${domain}:v1\0`)
    .update(JSON.stringify(value))
    .digest("hex");
}

function stableTaskId(
  shell: GenerationPlan,
  kind: GenerationTaskKind,
  target: GenerationTaskTarget,
): string {
  return `gt_${stableHash("generation-task-id", {
    workspaceId: shell.workspaceId,
    planId: shell.id,
    kind,
    target,
  }).slice(0, 40)}`;
}

function assertUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const observed = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (observed.has(id)) {
      compileError("duplicate-id", `duplicate ${label} ${id}`, { label, id });
    }
    observed.add(id);
  }
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareBinary(key(left), key(right)));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertApprovedProposalRevision(shell: GenerationPlan, proposal: WorkspaceProposal): void {
  if (shell.status !== "approved" || shell.constructionSealed
    || shell.compileError !== null || shell.finishedAt !== null) {
    compileError("shell-not-approved", `Generation Plan ${shell.id} is not an approved compilation shell`, {
      planId: shell.id,
      status: shell.status,
      constructionSealed: shell.constructionSealed,
    });
  }
  if (proposal.status !== "approved" || proposal.review.kind !== "approved"
    || proposal.review.mode !== "generate") {
    compileError("proposal-not-approved", `Workspace Proposal ${proposal.id} is not approved for generation`, {
      proposalId: proposal.id,
      status: proposal.status,
      reviewKind: proposal.review.kind,
    });
  }
  if (shell.workspaceId !== proposal.workspaceId || shell.proposalId !== proposal.id
    || shell.proposalRevision !== proposal.revision) {
    compileError("proposal-identity-mismatch", "Generation Plan shell does not match the approved Proposal revision", {
      planId: shell.id,
      proposalId: proposal.id,
      proposalRevision: proposal.revision,
    });
  }
  if ((proposal.operations.length === 0 && shell.baseSnapshotId !== proposal.baseSnapshotId)
    || proposal.baseGraph.workspaceId !== proposal.workspaceId
    || proposal.baseGraph.revision !== proposal.baseGraphRevision
    || proposal.baseLayout.workspaceId !== proposal.workspaceId
    || proposal.baseLayout.layoutId !== proposal.layoutId
    || proposal.baseLayout.checksum !== proposal.baseLayoutChecksum) {
    compileError("proposal-base-mismatch", "Generation Plan shell and Proposal base Snapshot are inconsistent", {
      planId: shell.id,
      shellBaseSnapshotId: shell.baseSnapshotId,
      proposalBaseSnapshotId: proposal.baseSnapshotId,
    });
  }
  if (proposal.kind !== "workspace-generation" || proposal.generation.kind !== "workspace-generation") {
    compileError("unsupported-proposal", `Proposal kind ${proposal.kind} cannot compile as workspace-generation`, {
      proposalId: proposal.id,
      kind: proposal.kind,
    });
  }
}

function dependencyKey(dependency: WorkspaceGenerationDependencyPlan): string {
  return dependency.kind === "resource"
    ? JSON.stringify(["resource", dependency.ownerArtifactId, dependency.resourceId])
    : JSON.stringify(["component", dependency.ownerArtifactId, dependency.instanceId]);
}

function validateV2PrototypePlan(
  generation: WorkspaceGenerationPayload,
  proposal: WorkspaceProposal,
): void {
  if (generation.version !== 2) return;
  if (generation.prototypeIntents.length === 0) {
    compileError(
      "invalid-reference",
      "Workspace generation payload v2 requires at least one server-owned prototype intent",
    );
  }
  let resultingGraph: WorkspaceGraph;
  try {
    resultingGraph = proposal.operations.length === 0
      ? proposal.baseGraph
      : applyWorkspaceGraphCommands(proposal.baseGraph, proposal.operations);
  } catch (error) {
    compileError(
      "invalid-reference",
      `Workspace generation payload v2 cannot resolve its planned prototype graph: ${String(error)}`,
    );
  }
  const nodesById = new Map(resultingGraph.nodes.map((node) => [node.id, node] as const));
  const generatedPages = new Map(
    generation.artifactPlans
      .filter((plan) => plan.kind === "page")
      .map((plan) => [plan.artifactId, plan] as const),
  );
  const expectedEdges = resultingGraph.edges.filter((edge) => {
    if (edge.kind !== "prototype") return false;
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    return source?.kind === "page"
      && target?.kind === "page"
      && generatedPages.has(source.artifactId)
      && generatedPages.has(target.artifactId);
  });
  const expectedEdgesById = new Map(expectedEdges.map((edge) => [edge.id, edge] as const));
  const intentsByEdgeId = new Map(
    generation.prototypeIntents.map((intent) => [intent.edgeId, intent] as const),
  );
  for (const edge of expectedEdges) {
    if (!intentsByEdgeId.has(edge.id)) {
      compileError(
        "invalid-reference",
        `missing server-owned prototype intent for planned edge ${edge.id}`,
        { edgeId: edge.id },
      );
    }
  }
  for (const intent of generation.prototypeIntents) {
    const edge = expectedEdgesById.get(intent.edgeId);
    if (edge === undefined) {
      compileError(
        "invalid-reference",
        `foreign or missing planned prototype edge ${intent.edgeId}`,
        { edgeId: intent.edgeId },
      );
    }
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (source?.kind !== "page" || target?.kind !== "page"
      || source.artifactId !== intent.sourceArtifactId
      || target.artifactId !== intent.targetArtifactId) {
      compileError(
        "invalid-reference",
        `prototype intent endpoint drift for planned edge ${intent.edgeId}`,
        {
          edgeId: intent.edgeId,
          sourceArtifactId: intent.sourceArtifactId,
          targetArtifactId: intent.targetArtifactId,
        },
      );
    }
    if (intent.sourceMarkerId === undefined || intent.sourceLocator !== undefined) {
      compileError(
        "invalid-reference",
        `prototype intent ${intent.edgeId} must carry only a server-owned source marker`,
        { edgeId: intent.edgeId },
      );
    }
  }
  assertUnique(
    generation.prototypeIntents,
    (intent) => intent.sourceMarkerId!,
    "prototype source marker",
  );

  const outgoingByEdgeId = new Map<string, {
    ownerArtifactId: string;
    sourceMarkerId: string;
    trigger: string;
  }>();
  const incomingByEdgeId = new Map<string, {
    ownerArtifactId: string;
    sourceArtifactId: string;
    sourceMarkerId: string;
    targetState: string;
  }>();
  for (const plan of generation.artifactPlans) {
    const requirements = plan.prototypeRequirements;
    if (requirements === undefined) continue;
    assertUnique(
      requirements.outgoing,
      (requirement) => requirement.edgeId,
      `prototype source requirement for ${plan.artifactId}`,
    );
    assertUnique(
      requirements.incoming,
      (requirement) => requirement.edgeId,
      `prototype target requirement for ${plan.artifactId}`,
    );
    for (const requirement of requirements.outgoing) {
      if (outgoingByEdgeId.has(requirement.edgeId)) {
        compileError(
          "invalid-reference",
          `duplicate prototype source requirement for edge ${requirement.edgeId}`,
        );
      }
      outgoingByEdgeId.set(requirement.edgeId, {
        ownerArtifactId: plan.artifactId,
        sourceMarkerId: requirement.sourceMarkerId,
        trigger: requirement.trigger,
      });
    }
    for (const requirement of requirements.incoming) {
      if (incomingByEdgeId.has(requirement.edgeId)) {
        compileError(
          "invalid-reference",
          `duplicate prototype target requirement for edge ${requirement.edgeId}`,
        );
      }
      incomingByEdgeId.set(requirement.edgeId, {
        ownerArtifactId: plan.artifactId,
        sourceArtifactId: requirement.sourceArtifactId,
        sourceMarkerId: requirement.sourceMarkerId,
        targetState: requirement.targetState,
      });
    }
  }
  for (const intent of generation.prototypeIntents) {
    const outgoing = outgoingByEdgeId.get(intent.edgeId);
    if (outgoing === undefined
      || outgoing.ownerArtifactId !== intent.sourceArtifactId
      || outgoing.sourceMarkerId !== intent.sourceMarkerId
      || outgoing.trigger !== intent.trigger) {
      compileError(
        "invalid-reference",
        `prototype source marker requirement does not match intent ${intent.edgeId}`,
        { edgeId: intent.edgeId },
      );
    }
    const incoming = incomingByEdgeId.get(intent.edgeId);
    if (intent.targetState === undefined) {
      if (incoming !== undefined) {
        compileError(
          "invalid-reference",
          `prototype target requirement is foreign for stateless edge ${intent.edgeId}`,
          { edgeId: intent.edgeId },
        );
      }
    } else if (incoming === undefined
      || incoming.ownerArtifactId !== intent.targetArtifactId
      || incoming.sourceArtifactId !== intent.sourceArtifactId
      || incoming.sourceMarkerId !== intent.sourceMarkerId
      || incoming.targetState !== intent.targetState) {
      compileError(
        "invalid-reference",
        `prototype target-state requirement does not match intent ${intent.edgeId}`,
        { edgeId: intent.edgeId },
      );
    }
  }
  for (const edgeId of outgoingByEdgeId.keys()) {
    if (!intentsByEdgeId.has(edgeId)) {
      compileError("invalid-reference", `foreign prototype source requirement for edge ${edgeId}`);
    }
  }
  for (const edgeId of incomingByEdgeId.keys()) {
    if (!intentsByEdgeId.has(edgeId)) {
      compileError("invalid-reference", `foreign prototype target requirement for edge ${edgeId}`);
    }
  }
}

const GENERATOR_COMMAND_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  codebuddy: "codebuddy",
  "cursor-agent": "cursor-agent",
  copilot: "copilot",
  qwen: "qwen",
  opencode: "opencode",
  kimi: "kimi",
  trae: "trae",
  "trae-cli": "trae",
  pi: "pi",
  hermes: "hermes",
});

function commandProvider(command: string): string | null {
  const base = command.split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "") ?? command;
  return GENERATOR_COMMAND_PROVIDERS[base] ?? null;
}

function generatorCredentialProviderId(providerId: string): string {
  if (providerId === "codebuddy") return "codebuddy";
  if (providerId === "claude") return "anthropic";
  if (providerId === "codex" || providerId === "copilot") return "openai";
  return providerId;
}

function isCanonicalCredentialFreeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:")
    && url.username.length === 0
    && url.password.length === 0
    && url.search.length === 0
    && url.hash.length === 0
    && (value === url.href || `${value}/` === url.href);
}

function assertFrozenGeneratorAuthority(
  agent: WorkspaceGenerationAgentSelection | undefined,
  proposalId: string,
  label: string,
): string {
  if (agent === undefined) {
    compileError(
      "invalid-reference",
      `${label} must freeze one generating Agent and its exact non-secret execution authority. Historical Proposals without frozen authority cannot be approved for generate — ask the Workspace Agent for a new Proposal.`,
      { proposalId, historicalMissingAuthority: true },
    );
  }
  const providerId = commandProvider(agent.command);
  const authority = agent.executionAuthority;
  if (providerId === null || providerId !== agent.providerId
    || authority?.kind !== "generator"
    || !isCanonicalCredentialFreeUrl(authority.baseUrl)
    || typeof authority.organization !== "string"
    || typeof authority.credentialProviderId !== "string"
    || authority.credentialProviderId.length === 0
    || (authority.credentialSource !== "provider-profile"
      && authority.credentialSource !== "agent"
      && authority.credentialSource !== "session")
    || typeof authority.credentialRequired !== "boolean"
    || authority.credentialProviderId !== generatorCredentialProviderId(providerId)
    || (authority.credentialSource === "session"
      && (authority.baseUrl !== ""
        || authority.organization !== ""
        || authority.credentialRequired))
    || ((providerId === "codex" || providerId === "codebuddy")
      && authority.credentialSource !== "session")) {
    const historicalHint = authority === undefined
      ? " This Proposal predates frozen execution authority — ask the Workspace Agent for a new Proposal before approving generate."
      : "";
    compileError(
      "invalid-reference",
      `${label} must freeze a supported command/provider identity and its exact non-secret generator execution authority.${historicalHint}`,
      {
        proposalId,
        providerId: agent.providerId,
        command: agent.command,
        historicalMissingAuthority: authority === undefined,
      },
    );
  }
  return providerId;
}

function assertFrozenReviewerAuthority(
  generation: WorkspaceGenerationPayload,
  proposalId: string,
): string {
  const reviewer = generation.reviewerAgent;
  const reviewerProvider = reviewer === undefined ? null : commandProvider(reviewer.command);
  const reviewerAuthority = reviewer?.executionAuthority;
  const reviewerIdentityIsValid = reviewer !== undefined
    && (reviewerProvider === "claude"
      || reviewerProvider === "codebuddy"
      || reviewerProvider === "codex")
    && reviewerProvider === reviewer.providerId;
  const reviewerAuthorityIsValid = reviewerAuthority?.kind === "reviewer"
    && isCanonicalCredentialFreeUrl(reviewerAuthority.baseUrl)
    && typeof reviewerAuthority.credentialRequired === "boolean"
    && (reviewerAuthority.credentialSource === "anthropic-profile"
      || reviewerAuthority.credentialSource === "agent"
      || reviewerAuthority.credentialSource === "session")
    && (reviewerProvider === "claude"
      ? reviewerAuthority.credentialSource !== "agent"
        || (generation.agent?.providerId === "claude"
          && commandProvider(generation.agent.command) === "claude"
          && generation.agent.executionAuthority?.kind === "generator"
          && generation.agent.executionAuthority.credentialSource === "agent"
          && reviewerAuthority.baseUrl === generation.agent.executionAuthority.baseUrl
          && reviewerAuthority.credentialRequired
            === generation.agent.executionAuthority.credentialRequired)
      : reviewerAuthority.credentialSource === "session"
        && reviewerAuthority.baseUrl === ""
        && !reviewerAuthority.credentialRequired)
    && (reviewerAuthority.credentialSource !== "session"
      || (reviewerAuthority.baseUrl === "" && !reviewerAuthority.credentialRequired));
  if (!reviewerIdentityIsValid || !reviewerAuthorityIsValid) {
    const historicalHint = reviewer === undefined || reviewerAuthority === undefined
      ? " This Proposal predates frozen reviewer authority — ask the Workspace Agent for a new Proposal before approving generate."
      : "";
    compileError(
      "invalid-reference",
      `executable workspace generation must freeze one supported reviewer and its exact non-secret execution authority.${historicalHint}`,
      {
        proposalId,
        historicalMissingAuthority: reviewer === undefined || reviewerAuthority === undefined,
      },
    );
  }
  return reviewerProvider;
}

/**
 * Fail-closed authority preflight shared by HTTP approval and immutable Plan
 * compilation. Historical payloads remain decodable, but no executable work can
 * cross either boundary without exact generator and reviewer authority.
 */
export function assertWorkspaceGenerationExecutionAuthority(
  generation: WorkspaceGenerationPayload,
  proposalId: string,
): void {
  const hasExecutableAgentTask = generation.artifactPlans.length > 0
    || generation.resourceOperations.some((operation) => operation.revisionPolicy.kind === "generate");
  if (!hasExecutableAgentTask) return;
  assertFrozenGeneratorAuthority(generation.agent, proposalId, "Executable workspace generation");
  const reviewerProvider = assertFrozenReviewerAuthority(generation, proposalId);
  const hasGeneratedResearch = generation.resourceOperations.some((operation) => (
    operation.kind === "research" && operation.revisionPolicy.kind === "generate"
  ));
  if (hasGeneratedResearch) {
    if (generation.researchAgent === undefined || generation.reviewerAgent === undefined) {
      compileError(
        "invalid-reference",
        "generated Research split authority must freeze both its generator and independent reviewer",
        { proposalId },
      );
    }
    const researchCommandProvider = assertFrozenGeneratorAuthority(
      generation.researchAgent,
      proposalId,
      "Generated Research",
    );
    const researchAuthority = generation.researchAgent.executionAuthority;
    if (researchAuthority?.kind !== "generator") {
      compileError(
        "invalid-reference",
        "generated Research must freeze exact non-secret generator execution authority",
        { proposalId },
      );
    }
    // Host-authenticated CLIs freeze session authority. BYOK CLIs freeze their
    // exact provider credential route. Either is valid — Research is not locked
    // to Codex; Settings > Quality > Research agent remains the source of truth.
    const hostAuthenticatedResearch = researchCommandProvider === "codex"
      || researchCommandProvider === "codebuddy";
    if (hostAuthenticatedResearch) {
      if (researchAuthority.baseUrl !== ""
        || researchAuthority.organization !== ""
        || researchAuthority.credentialRequired
        || researchAuthority.credentialSource !== "session") {
        compileError(
          "invalid-reference",
          `generated Research must freeze ${researchCommandProvider} host-login execution authority without a substituted endpoint or credential source`,
          { proposalId },
        );
      }
    } else if (researchAuthority.credentialSource === "session"
      && (researchAuthority.baseUrl !== ""
        || researchAuthority.organization !== ""
        || researchAuthority.credentialRequired)) {
      compileError(
        "invalid-reference",
        "generated Research session authority cannot carry an endpoint or credential requirement",
        { proposalId },
      );
    }
    if (reviewerProvider === researchCommandProvider) {
      compileError(
        "invalid-reference",
        "generated Research reviewer must use a supported provider principal distinct from its generator",
        {
          proposalId,
          providerId: generation.reviewerAgent.providerId,
          command: generation.reviewerAgent.command,
        },
      );
    }
  }
  const hasGeneratedMoodboard = generation.resourceOperations.some((operation) => (
    operation.kind === "moodboard" && operation.revisionPolicy.kind === "generate"
  ));
  const imageAuthority = generation.moodboardImageAuthority;
  if (hasGeneratedMoodboard) {
    if (imageAuthority?.kind !== "moodboard-image"
      || imageAuthority.protocol !== "dezin.workspace-moodboard-image-authority.v1"
      || typeof imageAuthority.providerId !== "string"
      || imageAuthority.providerId.length === 0
      || imageAuthority.providerId.trim() !== imageAuthority.providerId
      || typeof imageAuthority.model !== "string"
      || imageAuthority.model.length === 0
      || imageAuthority.model.trim() !== imageAuthority.model
      || typeof imageAuthority.apiVersion !== "string"
      || imageAuthority.apiVersion.trim() !== imageAuthority.apiVersion
      || !isCanonicalCredentialFreeUrl(imageAuthority.baseUrl)
      || imageAuthority.baseUrl === ""
      || (imageAuthority.credentialSource !== "provider-profile"
        && imageAuthority.credentialSource !== "global-image")
      || imageAuthority.credentialRequired !== true) {
      compileError(
        "invalid-reference",
        "generated Moodboard must freeze one exact non-secret Moodboard image execution authority",
        { proposalId },
      );
    }
  } else if (imageAuthority !== undefined) {
    compileError(
      "invalid-reference",
      "Moodboard image execution authority is valid only for generated Moodboard work",
      { proposalId },
    );
  }
}

function validateGenerationPayload(
  generation: WorkspaceGenerationPayload,
  proposal: WorkspaceProposal,
): void {
  assertWorkspaceGenerationExecutionAuthority(generation, proposal.id);
  assertUnique(generation.resourceOperations, (operation) => operation.resourceId, "Resource operation id");
  assertUnique(generation.artifactPlans, (plan) => plan.artifactId, "Artifact plan id");
  assertUnique(generation.artifactPlans, (plan) => plan.trackId, "Artifact Track id");
  assertUnique(generation.capabilities, (capability) => capability.id, "capability id");
  assertUnique(generation.responsiveFrames, (frame) => frame.id, "responsive Frame id");
  assertUnique(generation.prototypeIntents, (intent) => intent.edgeId, "prototype edge id");
  assertUnique(generation.dependencyPlans, dependencyKey, "dependency identity");
  validateV2PrototypePlan(generation, proposal);

  for (const operation of generation.resourceOperations) {
    if (operation.revisionPolicy.kind === "generate"
      && !isAgentGeneratableResourceKind(operation.kind)) {
      compileError(
        "unsupported-resource-kind",
        `generation Resource kind ${operation.kind} requires an explicit owned source and cannot be Agent-generated`,
        { resourceId: operation.resourceId, resourceKind: operation.kind },
      );
    }
  }

  const operations = new Set(generation.resourceOperations.map((operation) => operation.resourceId));
  const operationsByResourceId = new Map(
    generation.resourceOperations.map((operation) => [operation.resourceId, operation] as const),
  );
  const artifactPlans = new Map(generation.artifactPlans.map((plan) => [plan.artifactId, plan]));
  const availableArtifacts = new Map<string, "component" | "page">();
  for (const node of proposal.baseGraph.nodes) {
    if (node.kind !== "resource") availableArtifacts.set(node.artifactId, node.kind);
  }
  for (const plan of generation.artifactPlans) availableArtifacts.set(plan.artifactId, plan.kind);
  const capabilities = new Set(generation.capabilities.map((capability) => capability.id));
  const frames = new Set(generation.responsiveFrames.map((frame) => frame.id));
  for (const requiredFrameId of generation.qualityProfile.requiredFrameIds) {
    if (!frames.has(requiredFrameId)) {
      compileError("invalid-reference", `missing generation responsive Frame ${requiredFrameId}`, {
        frameId: requiredFrameId,
      });
    }
  }
  for (const plan of generation.artifactPlans) {
    assertUnique(plan.dependsOnArtifactIds, (id) => id, `Artifact dependency for ${plan.artifactId}`);
    assertUnique(plan.capabilityIds, (id) => id, `capability for ${plan.artifactId}`);
    assertUnique(plan.responsiveFrameIds, (id) => id, `responsive Frame for ${plan.artifactId}`);
    if (plan.responsiveFrameIds.length === 0) {
      compileError(
        "invalid-reference",
        `generation Artifact ${plan.artifactId} must include at least one responsive Frame`,
        { artifactId: plan.artifactId },
      );
    }
    if (generation.qualityProfile.requireVisualReview
      && plan.responsiveFrameIds.length > MAX_ARTIFACT_VISUAL_QA_FRAMES) {
      compileError(
        "invalid-reference",
        `generation Artifact ${plan.artifactId} may require visual QA for at most `
          + `${MAX_ARTIFACT_VISUAL_QA_FRAMES} responsive Frames`,
        {
          artifactId: plan.artifactId,
          frameCount: plan.responsiveFrameIds.length,
          maxFrameCount: MAX_ARTIFACT_VISUAL_QA_FRAMES,
        },
      );
    }
    const artifactFrameIds = new Set(plan.responsiveFrameIds);
    for (const requiredFrameId of generation.qualityProfile.requiredFrameIds) {
      if (!artifactFrameIds.has(requiredFrameId)) {
        compileError(
          "invalid-reference",
          `generation Artifact ${plan.artifactId} is missing required responsive Frame ${requiredFrameId}`,
          { artifactId: plan.artifactId, frameId: requiredFrameId },
        );
      }
    }
    for (const dependencyArtifactId of plan.dependsOnArtifactIds) {
      if (dependencyArtifactId === plan.artifactId) {
        compileError("cyclic-task-graph", `generation Artifact ${plan.artifactId} cannot depend on itself`, {
          artifactId: plan.artifactId,
        });
      }
      if (!availableArtifacts.has(dependencyArtifactId)) {
        compileError(
          "invalid-reference",
          `missing generation dependency Artifact ${dependencyArtifactId}`,
          { artifactId: plan.artifactId, dependencyArtifactId },
        );
      }
    }
    for (const capabilityId of plan.capabilityIds) {
      if (!capabilities.has(capabilityId)) {
        compileError("invalid-reference", `missing generation capability ${capabilityId}`, { capabilityId });
      }
    }
    for (const frameId of plan.responsiveFrameIds) {
      if (!frames.has(frameId)) {
        compileError("invalid-reference", `missing generation responsive Frame ${frameId}`, { frameId });
      }
    }
    const selection = plan.researchDirectionSelection;
    if (selection !== undefined) {
      const selectedOperation = operationsByResourceId.get(selection.resourceId);
      const ownsSelectedResearch = generation.dependencyPlans.some((dependency) => (
        dependency.kind === "resource"
        && dependency.ownerArtifactId === plan.artifactId
        && dependency.resourceId === selection.resourceId
      ));
      const directionIds = selection.directionIds;
      const hasValidDirectionSet = directionIds === undefined || (
        Array.isArray(directionIds)
        && directionIds.length >= 2
        && directionIds.length <= 16
        && directionIds.every((directionId) => (
          typeof directionId === "string"
          && directionId.length > 0
          && directionId === directionId.trim()
        ))
        && new Set(directionIds).size === directionIds.length
        && directionIds[0] === selection.directionId
      );
      if (selection.protocol !== "dezin.research-direction-selection.v1" || selection.version !== 1
        || !hasValidDirectionSet
        || selectedOperation?.kind !== "research" || selectedOperation.operation !== "reuse"
        || selectedOperation.revisionPolicy.kind !== "exact"
        || selectedOperation.revisionPolicy.resourceRevisionId !== selection.revisionId
        || !ownsSelectedResearch) {
        compileError(
          "invalid-reference",
          `generation Artifact ${plan.artifactId} selected Research direction must reference its exact existing Revision dependency`,
          {
            artifactId: plan.artifactId,
            resourceId: selection.resourceId,
            revisionId: selection.revisionId,
            directionId: selection.directionId,
          },
        );
      }
    }
  }
  for (const dependency of generation.dependencyPlans) {
    if (!artifactPlans.has(dependency.ownerArtifactId)) {
      compileError("invalid-reference", `missing generation dependency owner ${dependency.ownerArtifactId}`, {
        ownerArtifactId: dependency.ownerArtifactId,
      });
    }
    if (dependency.kind === "resource" && !operations.has(dependency.resourceId)) {
      compileError("invalid-reference", `missing generation dependency Resource ${dependency.resourceId}`, {
        resourceId: dependency.resourceId,
      });
    }
    if (dependency.kind === "component-instance" && dependency.componentRevisionId === null) {
      if (dependency.ownerArtifactId === dependency.componentArtifactId) {
        compileError(
          "cyclic-task-graph",
          `generation Artifact ${dependency.ownerArtifactId} cannot depend on itself`,
          { artifactId: dependency.ownerArtifactId, instanceId: dependency.instanceId },
        );
      }
      const componentPlan = artifactPlans.get(dependency.componentArtifactId);
      if (!componentPlan || componentPlan.kind !== "component") {
        compileError(
          "invalid-reference",
          `generation dependency Component ${dependency.componentArtifactId} has no planned Revision result`,
          { componentArtifactId: dependency.componentArtifactId },
        );
      }
    } else if (dependency.kind === "component-instance"
      && availableArtifacts.get(dependency.componentArtifactId) !== "component") {
      compileError("invalid-reference", `missing generation dependency Component ${dependency.componentArtifactId}`, {
        componentArtifactId: dependency.componentArtifactId,
      });
    }
  }
  for (const intent of generation.prototypeIntents) {
    if (availableArtifacts.get(intent.sourceArtifactId) !== "page"
      || availableArtifacts.get(intent.targetArtifactId) !== "page") {
      compileError("invalid-reference", `missing generation prototype Artifact for edge ${intent.edgeId}`, {
        edgeId: intent.edgeId,
        sourceArtifactId: intent.sourceArtifactId,
        targetArtifactId: intent.targetArtifactId,
      });
    }
  }
}

function capacityClassesFor(
  base: readonly GenerationTaskCapacityClass[],
  capabilityIds: readonly string[],
  capabilitiesById: ReadonlyMap<string, WorkspaceGenerationCapability>,
): GenerationTaskCapacityClass[] {
  const result = new Set(base);
  if (capabilityIds.some((id) => capabilitiesById.get(id)?.kind === "image")) result.add("image");
  return [...result].sort(compareBinary);
}

function taskLimits(
  base: GenerationTaskResourceLimits,
  capabilityIds: readonly string[],
  capabilitiesById: ReadonlyMap<string, WorkspaceGenerationCapability>,
): GenerationTaskResourceLimits {
  return {
    ...base,
    capacityClasses: capacityClassesFor(base.capacityClasses, capabilityIds, capabilitiesById),
  };
}

function usesLongRunningHostLoginBudget(generation: WorkspaceGenerationPayload): boolean {
  return generation.agent?.providerId === "codebuddy"
    || generation.agent?.providerId === "codex";
}

function resourceTaskLimits(
  generation: WorkspaceGenerationPayload,
  resourceKind: ResourceKind,
): GenerationTaskResourceLimits {
  // Resource generation may delegate image work to a second provider, so the
  // complete outer budget cannot depend only on the selected Agent CLI.
  return {
    ...(resourceKind === "moodboard" ? MOODBOARD_RESOURCE_LIMITS : RESOURCE_LIMITS),
    timeoutMs: RESOURCE_GENERATION_DEADLINE_BUDGET.taskTimeoutMs,
  };
}

function artifactTaskLimits(
  generation: WorkspaceGenerationPayload,
  plan: WorkspaceGenerationArtifactPlan,
): GenerationTaskResourceLimits {
  if (!usesLongRunningHostLoginBudget(generation)) return ARTIFACT_LIMITS;
  // Host-login coding CLIs have explicit per-turn and per-Frame critic caps.
  // Scale the frozen outer deadline only with immutable Frame count and retain
  // one finite hard ceiling.
  const extraFrames = Math.max(0, plan.responsiveFrameIds.length - 1);
  return {
    ...ARTIFACT_LIMITS,
    timeoutMs: Math.min(
      HOST_LOGIN_ARTIFACT_MAX_TIMEOUT_MS,
      HOST_LOGIN_ARTIFACT_BASE_TIMEOUT_MS
        + extraFrames * HOST_LOGIN_ARTIFACT_EXTRA_FRAME_TIMEOUT_MS,
    ),
  };
}

function buildTask(
  shell: GenerationPlan,
  input: Omit<GenerationTaskIntentInput, "id" | "workspaceId" | "planId">,
): GenerationTaskIntent {
  const task = normalizeGenerationTaskIntent({
    ...input,
    id: stableTaskId(shell, input.kind, input.target),
    workspaceId: shell.workspaceId,
    planId: shell.id,
  });
  return deepFreeze(task);
}

function generatedResourceOperations(
  generation: WorkspaceGenerationPayload,
): Array<ResourceGenerationTaskPayloadV2["operation"]> {
  return sorted(
    generation.resourceOperations.filter(
      (operation): operation is ResourceGenerationTaskPayloadV2["operation"] => (
        operation.revisionPolicy.kind === "generate"
      ),
    ),
    (operation) => operation.resourceId,
  );
}

function relevantDependencies(
  generation: WorkspaceGenerationPayload,
  artifactId: string,
): WorkspaceGenerationDependencyPlan[] {
  return sorted(
    generation.dependencyPlans.filter((dependency) => dependency.ownerArtifactId === artifactId),
    dependencyKey,
  );
}

function capabilityDescriptorsFor(
  capabilityIds: readonly string[],
  capabilitiesById: ReadonlyMap<string, WorkspaceGenerationCapability>,
): WorkspaceGenerationCapability[] {
  return [...capabilityIds]
    .sort(compareBinary)
    .map((capabilityId) => {
      const capability = capabilitiesById.get(capabilityId);
      if (!capability) {
        compileError("invalid-reference", `missing generation capability ${capabilityId}`, { capabilityId });
      }
      return { ...capability };
    });
}

function proposalBrief(proposal: WorkspaceProposal): Pick<
  ArtifactGenerationTaskPayloadV2["brief"],
  "proposalRationale" | "assumptions"
> {
  return {
    proposalRationale: proposal.rationale,
    assumptions: [...proposal.assumptions],
  };
}

function taskPayloadForArtifact(
  proposal: WorkspaceProposal,
  generation: WorkspaceGenerationPayload,
  plan: WorkspaceGenerationArtifactPlan,
  capabilitiesById: ReadonlyMap<string, WorkspaceGenerationCapability>,
): ArtifactGenerationTaskPayloadV2 {
  const frameIds = new Set(plan.responsiveFrameIds);
  const prototypeRequirements = plan.prototypeRequirements === undefined
    ? undefined
    : {
        outgoing: sorted(plan.prototypeRequirements.outgoing, (requirement) => requirement.edgeId),
        incoming: sorted(plan.prototypeRequirements.incoming, (requirement) => requirement.edgeId),
      };
  const artifactPlan = {
    ...plan,
    dependsOnArtifactIds: [...plan.dependsOnArtifactIds].sort(compareBinary),
    capabilityIds: [...plan.capabilityIds].sort(compareBinary),
    responsiveFrameIds: [...plan.responsiveFrameIds].sort(compareBinary),
    ...(prototypeRequirements === undefined ? {} : { prototypeRequirements }),
  };
  return {
    version: 2,
    ...(generation.agent === undefined ? {} : { agent: { ...generation.agent } }),
    ...(generation.reviewerAgent === undefined
      ? {}
      : { reviewer: { ...generation.reviewerAgent } }),
    artifactPlan,
    dependencyPlans: relevantDependencies(generation, plan.artifactId),
    responsiveFrames: sorted(
      generation.responsiveFrames.filter((frame) => frameIds.has(frame.id)),
      (frame) => frame.id,
    ),
    brief: {
      ...proposalBrief(proposal),
      targetInstructions: {
        operation: plan.operation,
        kind: plan.kind,
        name: plan.name,
        ...(plan.instructions === undefined ? {} : { instructions: plan.instructions }),
      },
    },
    capabilityDescriptors: capabilityDescriptorsFor(plan.capabilityIds, capabilitiesById),
  };
}

export function assertAcyclicTaskGraph(tasks: readonly GenerationTaskIntent[]): void {
  stableTopologicalTaskOrder(tasks);
}

function taskOrderKey(task: GenerationTaskIntent): string {
  const targetKind = task.target.type === "artifact"
    ? `artifact:${task.target.id}`
    : task.target.type === "resource"
      ? `resource:${task.target.id}`
      : `workspace:${task.target.id}`;
  return `${targetKind}\0${task.kind}\0${task.id}`;
}

function stableTopologicalTaskOrder(
  tasks: readonly GenerationTaskIntent[],
): GenerationTaskIntent[] {
  const taskById = new Map<string, GenerationTaskIntent>();
  for (const task of tasks) {
    if (taskById.has(task.id)) {
      compileError("duplicate-id", `duplicate Generation Task id ${task.id}`, { taskId: task.id });
    }
    taskById.set(task.id, task);
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    assertUnique(task.dependencyIds, (id) => id, `dependency Task id for ${task.id}`);
    indegree.set(task.id, task.dependencyIds.length);
    for (const dependencyId of task.dependencyIds) {
      if (!taskById.has(dependencyId)) {
        compileError("invalid-reference", `Generation Task ${task.id} depends on missing Task ${dependencyId}`, {
          taskId: task.id,
          dependencyTaskId: dependencyId,
        });
      }
      const values = dependents.get(dependencyId) ?? [];
      values.push(task.id);
      dependents.set(dependencyId, values);
    }
  }
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const result: GenerationTaskIntent[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => compareBinary(
      taskOrderKey(taskById.get(left)!),
      taskOrderKey(taskById.get(right)!),
    ));
    const taskId = ready.shift()!;
    result.push(taskById.get(taskId)!);
    for (const dependentId of (dependents.get(taskId) ?? []).sort(compareBinary)) {
      const degree = indegree.get(dependentId)! - 1;
      indegree.set(dependentId, degree);
      if (degree === 0) ready.push(dependentId);
    }
  }
  if (result.length !== tasks.length) {
    const cyclicTaskIds = [...indegree]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id)
      .sort(compareBinary);
    compileError("cyclic-task-graph", "Generation Task dependencies cannot form a cycle", { cyclicTaskIds });
  }
  return result;
}

function normalizedDependencyRows(
  planId: string,
  tasks: readonly GenerationTaskIntent[],
): GenerationTaskDependency[] {
  return tasks.flatMap((task) => task.dependencyIds.map((dependencyTaskId, ordinal) => ({
    planId,
    taskId: task.id,
    dependencyTaskId,
    ordinal,
  })));
}

export function compileGenerationPlan(input: {
  shell: GenerationPlan;
  proposal: WorkspaceProposal;
}): CompiledGenerationPlan {
  assertApprovedProposalRevision(input.shell, input.proposal);
  const generation = input.proposal.generation as WorkspaceGenerationPayload;
  validateGenerationPayload(generation, input.proposal);

  const capabilitiesById = new Map(generation.capabilities.map((capability) => [capability.id, capability]));
  const requiredCapabilityIds = generation.capabilities
    .filter((capability) => capability.required)
    .map((capability) => capability.id)
    .sort(compareBinary);
  const visualQaCapabilityIds = generation.capabilities
    .filter((capability) => capability.kind === "visual-qa")
    .map((capability) => capability.id)
    .sort(compareBinary);
  const generatedResourceTaskInputs = generatedResourceOperations(generation).map((operation) => {
    const target: GenerationTaskTarget = {
      type: "resource",
      workspaceId: input.shell.workspaceId,
      id: operation.resourceId,
    };
    return { operation, target };
  });
  const generatedResearchTaskIds = generatedResourceTaskInputs
    .filter(({ operation }) => operation.kind === "research")
    .map(({ target }) => stableTaskId(input.shell, "resource", target))
    .sort(compareBinary);
  const resourceTasks = generatedResourceTaskInputs.map(({ operation, target }, ordinal) => {
    const frozenAgent = operation.kind === "research"
      ? generation.researchAgent ?? generation.agent
      : generation.agent;
    const payload: ResourceGenerationTaskPayloadV2 = {
      version: 2,
      ...(frozenAgent === undefined ? {} : { agent: { ...frozenAgent } }),
      ...(operation.kind === "research" && generation.agent !== undefined
        ? { reviewerAuthorityAgent: { ...generation.agent } }
        : {}),
      ...(generation.reviewerAgent === undefined
        ? {}
        : { reviewer: { ...generation.reviewerAgent } }),
      ...(operation.kind === "moodboard"
        ? { moodboardImageAuthority: { ...generation.moodboardImageAuthority! } }
        : {}),
      operation,
      brief: {
        ...proposalBrief(input.proposal),
        targetInstructions: {
          operation: operation.operation,
          kind: operation.kind,
          title: operation.title,
          ...(operation.instructions === undefined
            ? {}
            : { instructions: operation.instructions }),
        },
      },
      capabilityDescriptors: capabilityDescriptorsFor(requiredCapabilityIds, capabilitiesById),
      adapter: {
        id: `dezin.resource-adapter.${operation.kind}`,
        version: 1,
        kind: operation.kind,
      },
    };
    return buildTask(input.shell, {
      kind: "resource",
      ordinal,
      target,
      dependencyIds: operation.kind === "moodboard" ? generatedResearchTaskIds : [],
      payload,
      capabilities: requiredCapabilityIds,
      qaProfile: NO_QA,
      resourceLimits: taskLimits(
        resourceTaskLimits(generation, operation.kind),
        requiredCapabilityIds,
        capabilitiesById,
      ),
    });
  });
  const resourceTaskById = new Map(resourceTasks.map((task) => [task.target.id, task]));

  const componentPlans = sorted(
    generation.artifactPlans.filter((plan) => plan.kind === "component"),
    (plan) => plan.artifactId,
  );
  const pagePlans = sorted(
    generation.artifactPlans.filter((plan) => plan.kind === "page"),
    (plan) => plan.artifactId,
  );
  const artifactPlans = [...componentPlans, ...pagePlans];
  const artifactTaskIds = new Map(artifactPlans.map((plan) => {
    const target: GenerationTaskTarget = {
      type: "artifact",
      workspaceId: input.shell.workspaceId,
      id: plan.artifactId,
      trackId: plan.trackId,
    };
    return [plan.artifactId, stableTaskId(input.shell, plan.kind, target)] as const;
  }));
  const artifactTasks = artifactPlans.map((plan, index) => {
    const dependencyIds = new Set<string>();
    for (const artifactId of plan.dependsOnArtifactIds) {
      const dependencyTaskId = artifactTaskIds.get(artifactId);
      if (dependencyTaskId) dependencyIds.add(dependencyTaskId);
    }
    for (const dependency of relevantDependencies(generation, plan.artifactId)) {
      if (dependency.kind === "resource") {
        const resourceTask = resourceTaskById.get(dependency.resourceId);
        if (resourceTask) dependencyIds.add(resourceTask.id);
      } else if (dependency.componentRevisionId === null) {
        const componentTaskId = artifactTaskIds.get(dependency.componentArtifactId);
        if (!componentTaskId) {
          compileError(
            "invalid-reference",
            `generation dependency Component ${dependency.componentArtifactId} has no Task`,
            { componentArtifactId: dependency.componentArtifactId },
          );
        }
        dependencyIds.add(componentTaskId);
      }
    }
    const target: GenerationTaskTarget = {
      type: "artifact",
      workspaceId: input.shell.workspaceId,
      id: plan.artifactId,
      trackId: plan.trackId,
    };
    return buildTask(input.shell, {
      kind: plan.kind,
      ordinal: resourceTasks.length + index,
      target,
      dependencyIds: [...dependencyIds].sort(compareBinary),
      payload: taskPayloadForArtifact(input.proposal, generation, plan, capabilitiesById),
      capabilities: plan.capabilityIds,
      qaProfile: generation.qualityProfile,
      resourceLimits: taskLimits(
        artifactTaskLimits(generation, plan),
        plan.capabilityIds,
        capabilitiesById,
      ),
    });
  });

  // Prototype edges describe navigation and validation, not publication
  // prerequisites. Keep failure propagation limited to the explicit Artifact,
  // Component Instance, and generated Resource dependencies compiled above.
  const generatedTasks = [...resourceTasks, ...artifactTasks];
  const workspaceTarget: GenerationTaskTarget = {
    type: "workspace",
    workspaceId: input.shell.workspaceId,
    id: input.shell.workspaceId,
  };
  const validationTask = buildTask(input.shell, {
    kind: "prototype-validation",
    ordinal: generatedTasks.length,
    target: workspaceTarget,
    dependencyIds: generatedTasks.map((task) => task.id).sort(compareBinary),
    payload: {
      version: generation.version === 2 ? 2 : 1,
      prototypeIntents: sorted(generation.prototypeIntents, (intent) => intent.edgeId),
      responsiveFrames: sorted(generation.responsiveFrames, (frame) => frame.id),
      artifactIds: artifactPlans.map((plan) => plan.artifactId),
    },
    capabilities: visualQaCapabilityIds,
    qaProfile: generation.qualityProfile,
    resourceLimits: VALIDATION_LIMITS,
  });
  const checkpointTask = buildTask(input.shell, {
    kind: "checkpoint",
    ordinal: generatedTasks.length + 1,
    target: workspaceTarget,
    dependencyIds: [validationTask.id],
    payload: {
      version: 1,
      proposalId: input.proposal.id,
      proposalRevision: input.proposal.revision,
      baseSnapshotId: input.shell.baseSnapshotId,
    },
    capabilities: [],
    qaProfile: NO_QA,
    resourceLimits: CHECKPOINT_LIMITS,
  });
  const tasks = [...generatedTasks, validationTask, checkpointTask];
  assertAcyclicTaskGraph(tasks);
  const dependencies = normalizedDependencyRows(input.shell.id, tasks);
  return deepFreeze({ ...input.shell, tasks, dependencies });
}
