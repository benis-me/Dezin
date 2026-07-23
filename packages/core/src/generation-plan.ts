import { createHash } from "node:crypto";
import {
  normalizeGenerationTaskIntent,
} from "./store-codecs.ts";
import { compareBinary } from "./workspace-codecs.ts";
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
  WorkspaceGenerationCapability,
  WorkspaceGenerationDependencyPlan,
  WorkspaceGenerationPayload,
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

const ARTIFACT_LIMITS: GenerationTaskResourceLimits = {
  timeoutMs: 360_000,
  maxAgentTurns: 20,
  maxRepairRounds: 3,
  maxOutputBytes: 24 * 1024 * 1024,
  capacityClasses: ["agent", "render-qa"],
};

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

function validateGenerationPayload(
  generation: WorkspaceGenerationPayload,
  proposal: WorkspaceProposal,
): void {
  assertUnique(generation.resourceOperations, (operation) => operation.resourceId, "Resource operation id");
  assertUnique(generation.artifactPlans, (plan) => plan.artifactId, "Artifact plan id");
  assertUnique(generation.artifactPlans, (plan) => plan.trackId, "Artifact Track id");
  assertUnique(generation.capabilities, (capability) => capability.id, "capability id");
  assertUnique(generation.responsiveFrames, (frame) => frame.id, "responsive Frame id");
  assertUnique(generation.prototypeIntents, (intent) => intent.edgeId, "prototype edge id");
  assertUnique(generation.dependencyPlans, dependencyKey, "dependency identity");

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
      if (selection.protocol !== "dezin.research-direction-selection.v1" || selection.version !== 1
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
  const artifactPlan = {
    ...plan,
    dependsOnArtifactIds: [...plan.dependsOnArtifactIds].sort(compareBinary),
    capabilityIds: [...plan.capabilityIds].sort(compareBinary),
    responsiveFrameIds: [...plan.responsiveFrameIds].sort(compareBinary),
  };
  return {
    version: 2,
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

function prototypeConnectedPlannedPageComponents(
  generation: WorkspaceGenerationPayload,
): string[][] {
  const plannedPages = new Set(generation.artifactPlans
    .filter((plan) => plan.kind === "page")
    .map((plan) => plan.artifactId));
  const adjacency = new Map<string, Set<string>>();
  const neighbors = (artifactId: string): Set<string> => {
    const current = adjacency.get(artifactId);
    if (current) return current;
    const created = new Set<string>();
    adjacency.set(artifactId, created);
    return created;
  };
  for (const intent of generation.prototypeIntents) {
    neighbors(intent.sourceArtifactId).add(intent.targetArtifactId);
    neighbors(intent.targetArtifactId).add(intent.sourceArtifactId);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of [...plannedPages].sort(compareBinary)) {
    if (visited.has(start)) continue;
    const pending = [start];
    const plannedMembers: string[] = [];
    visited.add(start);
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (plannedPages.has(current)) plannedMembers.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort(compareBinary)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    if (plannedMembers.length > 1) components.push(plannedMembers.sort(compareBinary));
  }
  return components;
}

function orderPrototypeConnectedPageTasks(
  tasks: readonly GenerationTaskIntent[],
  generation: WorkspaceGenerationPayload,
): GenerationTaskIntent[] {
  const topological = stableTopologicalTaskOrder(tasks);
  const position = new Map(topological.map((task, index) => [task.id, index]));
  const pageTaskByArtifactId = new Map(tasks.flatMap((task) => (
    task.kind === "page" && task.target.type === "artifact"
      ? [[task.target.id, task] as const]
      : []
  )));
  const addedDependencies = new Map<string, Set<string>>();
  for (const component of prototypeConnectedPlannedPageComponents(generation)) {
    const ordered = component
      .map((artifactId) => pageTaskByArtifactId.get(artifactId))
      .filter((task): task is GenerationTaskIntent => task !== undefined)
      .sort((left, right) => (position.get(left.id)! - position.get(right.id)!));
    for (let index = 1; index < ordered.length; index += 1) {
      const task = ordered[index]!;
      const previous = ordered[index - 1]!;
      const dependencies = addedDependencies.get(task.id) ?? new Set<string>();
      dependencies.add(previous.id);
      addedDependencies.set(task.id, dependencies);
    }
  }
  if (addedDependencies.size === 0) return [...tasks];
  const orderedTasks = tasks.map((task) => {
    const additions = addedDependencies.get(task.id);
    if (!additions || [...additions].every((dependencyId) => task.dependencyIds.includes(dependencyId))) {
      return task;
    }
    return deepFreeze(normalizeGenerationTaskIntent({
      id: task.id,
      ordinal: task.ordinal,
      workspaceId: task.workspaceId,
      planId: task.planId,
      kind: task.kind,
      target: task.target,
      dependencyIds: [...new Set([...task.dependencyIds, ...additions])].sort(compareBinary),
      payload: task.payload,
      capabilities: task.capabilities,
      qaProfile: task.qaProfile,
      resourceLimits: task.resourceLimits,
    }));
  });
  // The spanning order is a linear extension of the existing Task DAG, so it
  // cannot introduce a cycle. Keep the assertion here as a fail-closed fence.
  assertAcyclicTaskGraph(orderedTasks);
  return orderedTasks;
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
  const resourceTasks = generatedResourceOperations(generation).map((operation, ordinal) => {
    const target: GenerationTaskTarget = {
      type: "resource",
      workspaceId: input.shell.workspaceId,
      id: operation.resourceId,
    };
    const payload: ResourceGenerationTaskPayloadV2 = {
      version: 2,
      operation,
      brief: {
        ...proposalBrief(input.proposal),
        targetInstructions: {
          operation: operation.operation,
          kind: operation.kind,
          title: operation.title,
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
      dependencyIds: [],
      payload,
      capabilities: requiredCapabilityIds,
      qaProfile: NO_QA,
      resourceLimits: taskLimits(RESOURCE_LIMITS, requiredCapabilityIds, capabilitiesById),
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
      resourceLimits: taskLimits(ARTIFACT_LIMITS, plan.capabilityIds, capabilitiesById),
    });
  });

  const generatedTasks = orderPrototypeConnectedPageTasks(
    [...resourceTasks, ...artifactTasks],
    generation,
  );
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
      version: 1,
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
