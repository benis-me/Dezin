import type {
  CreateWorkspaceProposalInput,
  GenerationPlan,
  Settings,
  ScopedAgentTurnRequestFacts,
  Store,
  RenderFrameSpec,
  WorkspaceGenerationAgentSelection,
  WorkspaceGenerationDependencyPlan,
  WorkspaceGenerationPayload,
  WorkspaceGenerationResourceOperation,
} from "../../../../packages/core/src/index.ts";
import { getProvider } from "../../../../packages/agent/src/index.ts";
import {
  BlockedContextError,
  ContextIntegrityError,
  checksumBytes,
  stableStringify,
  type AgentTurnRequest,
  type ContextPack,
} from "../context/context-types.ts";
import type {
  ProductionScopedTaskEnqueueInput,
  ProductionScopedTaskEnqueueReceipt,
  ProductionScopedTaskReplayInput,
  ProductionScopedTaskQueuePort,
} from "./production-agent-orchestrator.ts";
import {
  researchAgentCommand,
  researchModel,
  reviewerAgentCommand,
  reviewerModel,
} from "../run-policy.ts";
import {
  freezeWorkspaceGeneratorAgentSelection,
  freezeWorkspaceReviewerAgentSelection,
} from "./generation-execution-authority.ts";
import {
  workspaceMoodboardImageAuthority,
} from "./moodboard-image-execution-authority.ts";

const GENERATED_RESOURCE_KINDS = new Set(["research", "moodboard", "sharingan-capture"]);
const SHA256 = /^[0-9a-f]{64}$/;

export interface ScopedGenerationPlanServicePort {
  compileAndEnqueueApprovedShell(planId: string): GenerationPlan;
}

export interface ProductionScopedAgentTaskQueueOptions {
  readonly store: Store;
  /** @deprecated Core now compiles the scoped turn atomically with its durable receipt. */
  readonly planService: ScopedGenerationPlanServicePort;
  readonly wakePlan: (planId: string) => void;
}

interface ScopedContextAnchor {
  readonly snapshotId: string;
  readonly layoutId: string;
  readonly layoutChecksum: string;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Scoped Agent Task enqueue aborted", "AbortError");
  }
}

function scopedTurnRequestFacts(request: AgentTurnRequest): ScopedAgentTurnRequestFacts {
  if (request.scope.type === "workspace" || request.turnId === undefined
    || request.baseRevisionId === undefined) {
    throw new ContextIntegrityError("Scoped Agent Task queue requires a canonical turnId and base Revision");
  }
  return {
    workspaceId: request.scope.workspaceId,
    scopeType: request.scope.type,
    scopeId: request.scope.id,
    intent: request.intent as "generate" | "edit" | "repair",
    agent: request.agent,
    message: request.message,
    graphRevision: request.graphRevision,
    baseRevisionId: request.baseRevisionId,
    requestContextHash: checksumBytes(stableStringify({
      explicitContext: request.explicitContext,
      selection: request.selection ?? null,
    })),
  };
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function frozenScopedGenerationAuthorities(input: {
  settings: Settings;
  taskAgent: AgentTurnRequest["agent"];
  hasGeneratedResearch: boolean;
  hasGeneratedMoodboard: boolean;
}): {
  agent: WorkspaceGenerationAgentSelection;
  reviewerAgent: WorkspaceGenerationAgentSelection;
  researchAgent?: WorkspaceGenerationAgentSelection;
  moodboardImageAuthority?: ReturnType<typeof workspaceMoodboardImageAuthority>;
} {
  const taskProvider = getProvider(input.taskAgent.command);
  if (!taskProvider || taskProvider.id !== input.taskAgent.providerId) {
    throw new ContextIntegrityError(
      "Scoped generation Agent selection is unavailable or does not match its provider",
    );
  }
  const taskSelection: WorkspaceGenerationAgentSelection = {
    providerId: taskProvider.id,
    command: input.taskAgent.command,
    model: input.taskAgent.model,
  };
  const reviewerCommand = reviewerAgentCommand(input.settings, input.taskAgent.command);
  const reviewerProvider = getProvider(reviewerCommand);
  if (!reviewerProvider
    || (reviewerProvider.id !== "claude"
      && reviewerProvider.id !== "codebuddy"
      && reviewerProvider.id !== "codex")) {
    throw new ContextIntegrityError(
      "Scoped generation reviewer must be Claude Code, CodeBuddy, or Codex",
    );
  }
  const reviewerSelection: WorkspaceGenerationAgentSelection = {
    providerId: reviewerProvider.id,
    command: reviewerCommand,
    model: reviewerModel(
      input.settings,
      input.taskAgent.model ?? undefined,
      input.taskAgent.command,
    ) ?? null,
  };
  let agent: WorkspaceGenerationAgentSelection;
  let reviewerAgent: WorkspaceGenerationAgentSelection;
  try {
    agent = freezeWorkspaceGeneratorAgentSelection(input.settings, taskSelection);
    reviewerAgent = freezeWorkspaceReviewerAgentSelection(
      input.settings,
      reviewerSelection,
      taskSelection,
    );
  } catch (error) {
    throw new ContextIntegrityError(
      `Scoped generation execution authority is invalid: ${String(error)}`,
    );
  }
  let moodboardImageAuthority: ReturnType<typeof workspaceMoodboardImageAuthority> | undefined;
  if (input.hasGeneratedMoodboard) {
    try {
      moodboardImageAuthority = workspaceMoodboardImageAuthority(input.settings);
    } catch (error) {
      throw new ContextIntegrityError(
        `Scoped Moodboard image execution authority is invalid; enable one image provider with an exact endpoint, model, and credential in Settings and submit again: ${String(error)}`,
      );
    }
  }
  if (!input.hasGeneratedResearch) {
    return {
      agent,
      reviewerAgent,
      ...(moodboardImageAuthority === undefined ? {} : { moodboardImageAuthority }),
    };
  }

  const researchCommand = researchAgentCommand(input.settings, input.taskAgent.command);
  const researchProvider = getProvider(researchCommand);
  if (!researchProvider) {
    throw new ContextIntegrityError(
      "Scoped Research generation Agent is unavailable",
    );
  }
  if (researchProvider.id === reviewerProvider.id) {
    throw new ContextIntegrityError(
      "Scoped Research generation requires a reviewer principal independent from its generator",
    );
  }
  const researchSelection: WorkspaceGenerationAgentSelection = {
    providerId: researchProvider.id,
    command: researchCommand,
    model: researchModel(
      input.settings,
      input.taskAgent.model ?? undefined,
      input.taskAgent.command,
    ) ?? null,
  };
  let researchAgent: WorkspaceGenerationAgentSelection;
  try {
    researchAgent = freezeWorkspaceGeneratorAgentSelection(input.settings, researchSelection);
  } catch (error) {
    throw new ContextIntegrityError(
      `Scoped Research execution authority is invalid: ${String(error)}`,
    );
  }
  return {
    agent,
    reviewerAgent,
    researchAgent,
    ...(moodboardImageAuthority === undefined ? {} : { moodboardImageAuthority }),
  };
}

function renderFrames(
  kernelFrames: readonly RenderFrameSpec[],
  renderSpec: Record<string, unknown> | null,
): RenderFrameSpec[] {
  if (kernelFrames.length > 0) return structuredClone([...kernelFrames]);
  const candidates = renderSpec && Array.isArray(renderSpec.frames) ? renderSpec.frames : [];
  const frames: RenderFrameSpec[] = [];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const frame = value as Record<string, unknown>;
    if (typeof frame.id !== "string" || frame.id.length === 0
      || typeof frame.width !== "number" || !Number.isSafeInteger(frame.width) || frame.width < 1
      || typeof frame.height !== "number" || !Number.isSafeInteger(frame.height) || frame.height < 1) continue;
    frames.push({
      id: frame.id,
      name: typeof frame.name === "string" && frame.name.length > 0 ? frame.name : frame.id,
      width: frame.width,
      height: frame.height,
      ...(typeof frame.initialState === "string" ? { initialState: frame.initialState } : {}),
      ...(frame.fixture && typeof frame.fixture === "object" && !Array.isArray(frame.fixture)
        ? { fixture: structuredClone(frame.fixture as Record<string, unknown>) }
        : {}),
      ...(typeof frame.background === "string" ? { background: frame.background } : {}),
    });
  }
  if (frames.length > 0) return frames.sort((left, right) => compareBinary(left.id, right.id));
  return [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }];
}

function contextAnchor(request: AgentTurnRequest, pack: ContextPack): ScopedContextAnchor {
  const target = pack.items.filter((item) => item.contextClass === "target"
    && item.ref.id === request.scope.id);
  if (target.length !== 1) {
    throw new ContextIntegrityError("Scoped Agent Context Pack has no unique target anchor");
  }
  const provenance = target[0]!.provenance;
  const snapshotId = provenance.snapshotId;
  const layoutId = provenance.layoutId;
  const layoutChecksum = provenance.layoutChecksum;
  if (provenance.workspaceId !== request.scope.workspaceId
    || provenance.graphRevision !== request.graphRevision
    || typeof snapshotId !== "string" || snapshotId.length === 0
    || typeof layoutId !== "string" || layoutId.length === 0
    || typeof layoutChecksum !== "string" || !SHA256.test(layoutChecksum)) {
    throw new ContextIntegrityError("Scoped Agent Context Pack target anchor is invalid or substituted");
  }
  return { snapshotId, layoutId, layoutChecksum };
}

function resourceOperationForPin(
  store: Store,
  projectId: string,
  graph: ReturnType<Store["workspace"]["getGraph"]>,
  resourceId: string,
  resourceRevisionId: string,
): WorkspaceGenerationResourceOperation {
  const resource = store.workspace.getResourceForProject(projectId, resourceId);
  const node = graph.nodes.find((candidate) => candidate.kind === "resource"
    && candidate.resourceId === resourceId);
  if (!resource || resource.archivedAt !== null || !node) {
    throw new BlockedContextError([resourceId], `Pinned Resource ${resourceId} is unavailable on the canvas`);
  }
  return {
    operation: "reuse",
    nodeId: node.id,
    resourceId: resource.id,
    kind: resource.kind,
    title: resource.title,
    revisionPolicy: { kind: "exact", resourceRevisionId },
  };
}

function artifactGeneration(
  store: Store,
  projectId: string,
  request: AgentTurnRequest,
  dispatchContextPackId: string,
): WorkspaceGenerationPayload {
  const bundle = store.workspace.getCompactBundleByProjectId(projectId);
  if (!bundle) throw new ContextIntegrityError("Scoped Artifact has no Workspace bundle");
  const artifact = bundle.artifacts.find((candidate) => candidate.id === request.scope.id);
  const node = bundle.graph.nodes.find((candidate) => candidate.kind !== "resource"
    && candidate.artifactId === request.scope.id);
  if (!artifact || artifact.archivedAt !== null || artifact.activeTrackId === null
    || !node || node.kind !== artifact.kind) {
    throw new BlockedContextError([request.scope.id], "Scoped Artifact is unavailable or mismatched on the canvas");
  }
  const baseRevisionId = bundle.activeSnapshot.artifactRevisions[artifact.id] ?? null;
  if (request.baseRevisionId !== undefined && request.baseRevisionId !== baseRevisionId) {
    throw new BlockedContextError([request.baseRevisionId], "Scoped Artifact Head changed before Task enqueue");
  }
  if (baseRevisionId === null) {
    throw new BlockedContextError(
      [artifact.id],
      "Scoped Artifact generation requires an existing published base Revision; create the initial design from a reviewed Workspace Proposal",
    );
  }
  const dependencyPlans: WorkspaceGenerationDependencyPlan[] = [];
  const resourceOperations: WorkspaceGenerationResourceOperation[] = [];
  if (baseRevisionId !== null) {
    for (const dependency of store.workspace.listArtifactRevisionDependencies(baseRevisionId)) {
      dependencyPlans.push({
        kind: "component-instance",
        ownerArtifactId: artifact.id,
        instanceId: dependency.instanceId,
        componentArtifactId: dependency.componentArtifactId,
        componentRevisionId: dependency.componentRevisionId,
        ...(dependency.variantKey === null ? {} : { variantKey: dependency.variantKey }),
        ...(dependency.stateKey === null ? {} : { stateKey: dependency.stateKey }),
        sourceLocator: dependency.sourceLocator,
        overrides: dependency.overrides,
        status: dependency.status,
      });
    }
    for (const pin of store.workspace.listArtifactRevisionResourcePins(baseRevisionId)) {
      dependencyPlans.push({ kind: "resource", ownerArtifactId: artifact.id, resourceId: pin.resourceId });
      resourceOperations.push(resourceOperationForPin(
        store,
        projectId,
        bundle.graph,
        pin.resourceId,
        pin.resourceRevisionId,
      ));
    }
  }
  const baseRevision = bundle.revisions.find((revision) => revision.id === baseRevisionId) ?? null;
  if (baseRevision === null) {
    throw new ContextIntegrityError(`Scoped Artifact base Revision ${baseRevisionId} is unavailable`);
  }
  const frames = renderFrames(bundle.activeKernelRevision.responsiveFrames, baseRevision.renderSpec)
    .sort((left, right) => compareBinary(left.id, right.id));
  const qualityProfile = structuredClone(bundle.activeKernelRevision.qualityProfile);
  const visualCapability = qualityProfile.requireVisualReview
    ? [{ id: "scoped-visual-qa", kind: "visual-qa" as const, required: true }]
    : [];
  return {
    kind: "workspace-generation",
    agent: request.agent,
    resourceOperations: resourceOperations.sort((left, right) => compareBinary(left.resourceId, right.resourceId)),
    artifactPlans: [{
      operation: "revise",
      nodeId: node.id,
      artifactId: artifact.id,
      kind: artifact.kind,
      name: artifact.name,
      trackId: artifact.activeTrackId,
      baseRevisionId,
      dependsOnArtifactIds: [],
      capabilityIds: visualCapability.map((capability) => capability.id),
      responsiveFrameIds: frames.map((frame) => frame.id),
      dispatchContextPackId,
    }],
    dependencyPlans: dependencyPlans.sort((left, right) => compareBinary(
      left.kind === "resource" ? `resource:${left.resourceId}` : `component:${left.instanceId}`,
      right.kind === "resource" ? `resource:${right.resourceId}` : `component:${right.instanceId}`,
    )),
    prototypeIntents: [],
    capabilities: visualCapability,
    responsiveFrames: frames,
    qualityProfile,
  };
}

function resourceGeneration(
  store: Store,
  projectId: string,
  request: AgentTurnRequest,
  dispatchContextPackId: string,
): WorkspaceGenerationPayload {
  const bundle = store.workspace.getCompactBundleByProjectId(projectId);
  if (!bundle) throw new ContextIntegrityError("Scoped Resource has no Workspace bundle");
  const resource = store.workspace.getResourceForProject(projectId, request.scope.id);
  const node = bundle.graph.nodes.find((candidate) => candidate.kind === "resource"
    && candidate.resourceId === request.scope.id);
  if (!resource || resource.archivedAt !== null || !node) {
    throw new BlockedContextError([request.scope.id], "Scoped Resource is unavailable on the canvas");
  }
  if (!GENERATED_RESOURCE_KINDS.has(resource.kind)) {
    throw new BlockedContextError(
      [resource.id],
      `${resource.kind} Resources are imported immutably and cannot be regenerated by the Resource Agent`,
    );
  }
  const baseRevisionId = bundle.activeSnapshot.resourceRevisions[resource.id] ?? null;
  if (request.baseRevisionId !== undefined && request.baseRevisionId !== baseRevisionId) {
    throw new BlockedContextError([request.baseRevisionId], "Scoped Resource Head changed before Task enqueue");
  }
  if (baseRevisionId === null) {
    throw new BlockedContextError(
      [resource.id],
      "Scoped Resource generation requires an existing published base Revision; create the initial Resource from a reviewed Workspace Proposal",
    );
  }
  return {
    kind: "workspace-generation",
    agent: request.agent,
    resourceOperations: [{
      operation: "revise",
      nodeId: node.id,
      resourceId: resource.id,
      kind: resource.kind,
      title: resource.title,
      revisionPolicy: { kind: "generate" },
      dispatchContextPackId,
    }],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [...bundle.activeKernelRevision.responsiveFrames],
    qualityProfile: structuredClone(bundle.activeKernelRevision.qualityProfile),
  };
}

function proposalInput(
  store: Store,
  projectId: string,
  request: AgentTurnRequest,
  pack: ContextPack,
): CreateWorkspaceProposalInput {
  const workspace = store.workspace.getWorkspace(projectId);
  if (!workspace || workspace.id !== request.scope.workspaceId
    || workspace.graphRevision !== request.graphRevision) {
    throw new BlockedContextError(
      [`graph-revision:${request.graphRevision}`],
      "Workspace changed before the scoped Agent Task could be queued",
    );
  }
  const anchor = contextAnchor(request, pack);
  const layout = store.workspace.getLayout(projectId, anchor.layoutId);
  if (workspace.activeSnapshotId !== anchor.snapshotId || layout.checksum !== anchor.layoutChecksum) {
    throw new BlockedContextError(
      [`workspace-snapshot:${anchor.snapshotId}`, `workspace-layout:${anchor.layoutId}`],
      "Workspace Snapshot or layout changed before the scoped Agent Task could be queued",
    );
  }
  const plannedGeneration = request.scope.type === "artifact"
    ? artifactGeneration(store, projectId, request, pack.id)
    : resourceGeneration(store, projectId, request, pack.id);
  const authorities = frozenScopedGenerationAuthorities({
    settings: store.getSettings(),
    taskAgent: request.agent,
    hasGeneratedResearch: plannedGeneration.resourceOperations.some((operation) => (
      operation.kind === "research" && operation.revisionPolicy.kind === "generate"
    )),
    hasGeneratedMoodboard: plannedGeneration.resourceOperations.some((operation) => (
      operation.kind === "moodboard" && operation.revisionPolicy.kind === "generate"
    )),
  });
  const generation: WorkspaceGenerationPayload = {
    ...plannedGeneration,
    ...authorities,
  };
  return {
    projectId,
    kind: "workspace-generation",
    baseGraphRevision: request.graphRevision,
    baseSnapshotId: anchor.snapshotId,
    layoutId: anchor.layoutId,
    baseLayoutChecksum: anchor.layoutChecksum,
    operations: [],
    layoutOperations: [],
    generation,
    rationale: request.message,
    assumptions: [
      `Scoped ${request.intent} request for ${request.scope.type} ${request.scope.id}.`,
      `Dispatch Context Pack: ${pack.id}.`,
    ],
    createdByRunId: null,
  };
}

export class ProductionScopedAgentTaskQueue implements ProductionScopedTaskQueuePort {
  readonly #options: ProductionScopedAgentTaskQueueOptions;

  constructor(options: ProductionScopedAgentTaskQueueOptions) {
    this.#options = options;
  }

  async replay(
    input: ProductionScopedTaskReplayInput,
    signal: AbortSignal,
  ): Promise<ProductionScopedTaskEnqueueReceipt | null> {
    checkAbort(signal);
    const turnId = input.request.turnId;
    if (turnId === undefined) {
      throw new ContextIntegrityError("Scoped Agent Task replay requires a canonical turnId");
    }
    const receipt = this.#options.store.workspace.getScopedAgentTurnReceiptForProject(
      input.projectId,
      turnId,
      scopedTurnRequestFacts(input.request),
    );
    checkAbort(signal);
    return receipt === null ? null : { task: receipt.task, contextPackId: receipt.contextPackId };
  }

  async enqueue(
    input: ProductionScopedTaskEnqueueInput,
    signal: AbortSignal,
  ): Promise<ProductionScopedTaskEnqueueReceipt> {
    checkAbort(signal);
    if (input.request.scope.type === "workspace") {
      throw new ContextIntegrityError("Workspace Agent cannot use the scoped Task queue");
    }
    const turnId = input.request.turnId;
    if (turnId === undefined) {
      throw new ContextIntegrityError("Scoped Agent Task enqueue requires a canonical turnId");
    }
    const request = scopedTurnRequestFacts(input.request);
    const replay = this.#options.store.workspace.getScopedAgentTurnReceiptForProject(
      input.projectId,
      turnId,
      request,
    );
    if (replay !== null) {
      return { task: replay.task, contextPackId: replay.contextPackId };
    }
    // Core owns the immediate transaction spanning the unique turn fence,
    // Proposal approval, Plan compilation, and exact receipt insertion.
    const result = this.#options.store.workspace.enqueueScopedAgentTurnForProject({
      projectId: input.projectId,
      turnId,
      request,
      contextPackId: input.contextPack.id,
      proposal: proposalInput(
        this.#options.store,
        input.projectId,
        input.request,
        input.contextPack,
      ),
    });
    if (result.created) this.#options.wakePlan(result.receipt.planId);
    return { task: result.receipt.task, contextPackId: result.receipt.contextPackId };
  }
}

export function createProductionScopedAgentTaskQueue(
  options: ProductionScopedAgentTaskQueueOptions,
): ProductionScopedAgentTaskQueue {
  return new ProductionScopedAgentTaskQueue(options);
}
