import { isDeepStrictEqual } from "node:util";

import type {
  GenerationTask,
  GenerationTaskAttempt,
  WorkspaceGenerationPrototypeIntent,
} from "./workspace-types.ts";
import type {
  ArtifactRevisionRecord,
  WorkspaceSnapshotRecord,
} from "./workspace-codecs.ts";
import type { ResourceRevision } from "./workspace-types.ts";

export const GENERATION_TASK_PROTOTYPE_VALIDATION_PROTOCOL = "dezin-prototype-validation-v1";

export interface GenerationTaskPrototypeValidationResult {
  snapshotId: string;
  graphRevision: number;
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
  evidence: Record<string, unknown>;
}

export interface BuildGenerationTaskPrototypeValidationInput {
  task: GenerationTask;
  attempt: GenerationTaskAttempt;
  snapshot: WorkspaceSnapshotRecord;
  artifactRevisions: readonly ArtifactRevisionRecord[];
  resourceRevisions: readonly ResourceRevision[];
}

export interface GenerationTaskPrototypeValidationRevisionIds {
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
}

export class GenerationTaskPrototypeValidationError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GenerationTaskPrototypeValidationError";
    this.details = structuredClone(details);
  }
}

interface ValidationPayload {
  version: 1;
  prototypeIntents: WorkspaceGenerationPrototypeIntent[];
  responsiveFrames: Array<Record<string, unknown> & { id: string }>;
  artifactIds: string[];
}

interface ResolvedArtifact {
  revision: ArtifactRevisionRecord;
  frameIds: string[];
  states: Set<string>;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new GenerationTaskPrototypeValidationError(message, details);
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = record(value, label);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(result, key))
    || Object.keys(result).some((key) => !allowed.has(key))) {
    invalid(`${label} has an invalid field set`);
  }
  return result;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    invalid(`${label} must be a dense array`);
  }
  return value;
}

function exactStringSet(values: readonly string[], label: string): string[] {
  const sorted = values.map((value, index) => nonEmptyString(value, `${label}[${index}]`))
    .sort(compareBinary);
  if (new Set(sorted).size !== sorted.length) invalid(`${label} must be unique`);
  return sorted;
}

function locatorEvidence(value: unknown, label: string): Record<string, unknown> {
  const locator = exactObject(value, ["designNodeId"], ["sourcePath", "selector"], label);
  return {
    designNodeId: nonEmptyString(locator.designNodeId, `${label} design node id`),
    ...(locator.sourcePath === undefined
      ? {}
      : { sourcePath: nonEmptyString(locator.sourcePath, `${label} source path`) }),
    ...(locator.selector === undefined
      ? {}
      : { selector: nonEmptyString(locator.selector, `${label} selector`) }),
  };
}

function prototypeIntent(value: unknown, index: number): WorkspaceGenerationPrototypeIntent {
  const label = `Prototype validation intent[${index}]`;
  const intent = exactObject(
    value,
    ["edgeId", "sourceArtifactId", "targetArtifactId", "trigger"],
    ["sourceLocator", "targetState", "transition"],
    label,
  );
  const trigger = intent.trigger;
  if (trigger !== "click" && trigger !== "submit") invalid(`${label} trigger is unsupported`);
  let transition: WorkspaceGenerationPrototypeIntent["transition"];
  if (intent.transition !== undefined) {
    const candidate = exactObject(intent.transition, ["type"], ["durationMs", "easing"], `${label} transition`);
    if (candidate.type !== "none" && candidate.type !== "fade" && candidate.type !== "slide") {
      invalid(`${label} transition type is unsupported`);
    }
    if (candidate.durationMs !== undefined
      && (!Number.isSafeInteger(candidate.durationMs) || Number(candidate.durationMs) < 0)) {
      invalid(`${label} transition duration must be a non-negative safe integer`);
    }
    transition = {
      type: candidate.type,
      ...(candidate.durationMs === undefined ? {} : { durationMs: Number(candidate.durationMs) }),
      ...(candidate.easing === undefined
        ? {}
        : { easing: nonEmptyString(candidate.easing, `${label} transition easing`) }),
    };
  }
  return {
    edgeId: nonEmptyString(intent.edgeId, `${label} edge id`),
    sourceArtifactId: nonEmptyString(intent.sourceArtifactId, `${label} source Artifact id`),
    targetArtifactId: nonEmptyString(intent.targetArtifactId, `${label} target Artifact id`),
    ...(intent.sourceLocator === undefined
      ? {}
      : { sourceLocator: locatorEvidence(intent.sourceLocator, `${label} source locator`) as never }),
    trigger,
    ...(intent.targetState === undefined
      ? {}
      : { targetState: nonEmptyString(intent.targetState, `${label} target state`) }),
    ...(transition === undefined ? {} : { transition }),
  };
}

function validationPayload(task: GenerationTask, attempt: GenerationTaskAttempt): ValidationPayload {
  if (task.kind !== "prototype-validation"
    || task.target.type !== "workspace"
    || task.target.workspaceId !== task.workspaceId
    || task.target.id !== task.workspaceId
    || attempt.target.type !== "workspace"
    || task.id !== attempt.taskId
    || task.planId !== attempt.planId
    || task.workspaceId !== attempt.workspaceId
    || !isDeepStrictEqual(task.target, attempt.target)
    || !isDeepStrictEqual(task.payload, attempt.payload)) {
    invalid("Prototype validation Task and Attempt identity is inconsistent");
  }
  const payload = exactObject(
    task.payload,
    ["version", "prototypeIntents", "responsiveFrames", "artifactIds"],
    [],
    "Prototype validation Task payload",
  );
  if (payload.version !== 1) invalid("Prototype validation Task payload version is unsupported");
  const intents = denseArray(payload.prototypeIntents, "Prototype validation intents")
    .map(prototypeIntent);
  const intentIds = intents.map((intent) => intent.edgeId);
  if (!isDeepStrictEqual(intentIds, exactStringSet(intentIds, "Prototype validation intent ids"))) {
    invalid("Prototype validation intents must be unique and canonically ordered");
  }
  const frames = denseArray(payload.responsiveFrames, "Prototype validation Frames")
    .map((frame, index) => {
      const candidate = record(frame, `Prototype validation Frame[${index}]`);
      nonEmptyString(candidate.id, `Prototype validation Frame[${index}] id`);
      return structuredClone(candidate) as Record<string, unknown> & { id: string };
    });
  const frameIds = frames.map((frame) => frame.id);
  if (!isDeepStrictEqual(frameIds, exactStringSet(frameIds, "Prototype validation Frame ids"))) {
    invalid("Prototype validation Frames must be unique and canonically ordered");
  }
  const artifactIds = denseArray(payload.artifactIds, "Prototype validation Artifact ids")
    .map((value, index) => nonEmptyString(value, `Prototype validation Artifact ids[${index}]`));
  if (new Set(artifactIds).size !== artifactIds.length) {
    invalid("Prototype validation Artifact ids must be unique");
  }
  return { version: 1, prototypeIntents: intents, responsiveFrames: frames, artifactIds };
}

function dependencyEvidence(task: GenerationTask, attempt: GenerationTaskAttempt): {
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
  evidence: Array<Record<string, unknown>>;
} {
  const taskIds: string[] = [];
  const artifactRevisionIds: string[] = [];
  const resourceRevisionIds: string[] = [];
  const evidence = attempt.dependencyOutputs.map((output, index) => {
    if (output.ordinal !== index) invalid("Prototype dependency outputs are not canonically ordered");
    const taskId = nonEmptyString(output.taskId, `Prototype dependency output ${index} Task id`);
    const hasArtifact = output.resultRevisionId !== null;
    const hasResource = output.resultResourceRevisionId !== null;
    if (hasArtifact === hasResource || output.resultSnapshotId === null) {
      invalid(`Prototype dependency output ${taskId} must contain one exact Revision and Snapshot`);
    }
    const revisionId = nonEmptyString(
      hasArtifact ? output.resultRevisionId : output.resultResourceRevisionId,
      `Prototype dependency output ${taskId} Revision id`,
    );
    taskIds.push(taskId);
    if (hasArtifact) artifactRevisionIds.push(revisionId);
    else resourceRevisionIds.push(revisionId);
    return {
      ordinal: index,
      taskId,
      kind: hasArtifact ? "artifact" : "resource",
      revisionId,
      resultSnapshotId: nonEmptyString(
        output.resultSnapshotId,
        `Prototype dependency output ${taskId} Snapshot id`,
      ),
    };
  });
  if (!isDeepStrictEqual(
    exactStringSet(taskIds, "Prototype dependency output Task ids"),
    exactStringSet(task.dependencyIds, "Prototype dependency Task ids"),
  )) {
    invalid("Prototype dependency outputs do not match the immutable Task dependency set");
  }
  return {
    artifactRevisionIds: exactStringSet(artifactRevisionIds, "Prototype Artifact Revision ids"),
    resourceRevisionIds: exactStringSet(resourceRevisionIds, "Prototype Resource Revision ids"),
    evidence,
  };
}

/**
 * Performs the Task/Attempt-only preflight and returns the immutable Revision
 * identities a read-only executor must resolve before invoking the full builder.
 */
export function getGenerationTaskPrototypeValidationRevisionIds(
  task: GenerationTask,
  attempt: GenerationTaskAttempt,
): GenerationTaskPrototypeValidationRevisionIds {
  validationPayload(task, attempt);
  const dependencies = dependencyEvidence(task, attempt);
  return {
    artifactRevisionIds: dependencies.artifactRevisionIds,
    resourceRevisionIds: dependencies.resourceRevisionIds,
  };
}

function artifactNode(snapshot: WorkspaceSnapshotRecord, artifactId: string) {
  const matches = snapshot.graph.nodes.filter(
    (node) => node.kind !== "resource" && node.artifactId === artifactId,
  );
  if (matches.length !== 1) invalid(`Snapshot must contain one exact Artifact node ${artifactId}`);
  return matches[0]!;
}

function resourceNode(snapshot: WorkspaceSnapshotRecord, resourceId: string) {
  const matches = snapshot.graph.nodes.filter(
    (node) => node.kind === "resource" && node.resourceId === resourceId,
  );
  if (matches.length !== 1) invalid(`Snapshot must contain one exact Resource node ${resourceId}`);
  return matches[0]!;
}

function revisionFrames(
  revision: ArtifactRevisionRecord,
  plannedFrames: ValidationPayload["responsiveFrames"],
): { frameIds: string[]; states: Set<string> } {
  const frames = revision.renderSpec.frames;
  if (!Array.isArray(frames)) invalid(`Artifact Revision ${revision.id} has no resolvable RenderSpec Frames`);
  const byId = new Map<string, Record<string, unknown>>();
  const states = new Set<string>();
  frames.forEach((value, index) => {
    const frame = record(value, `Artifact Revision ${revision.id} Frame ${index}`);
    const frameId = nonEmptyString(frame.id, `Artifact Revision ${revision.id} Frame ${index} id`);
    if (byId.has(frameId)) invalid(`Artifact Revision ${revision.id} has duplicate Frame ${frameId}`);
    byId.set(frameId, frame);
    if (frame.initialState !== undefined) {
      states.add(nonEmptyString(frame.initialState, `Artifact Revision ${revision.id} Frame ${frameId} state`));
    }
  });
  const plannedFrameIds = plannedFrames.map((frame) => frame.id);
  if (!isDeepStrictEqual([...byId.keys()].sort(compareBinary), [...plannedFrameIds].sort(compareBinary))) {
    invalid(`Artifact Revision ${revision.id} Frame set diverges from the immutable validation plan`);
  }
  for (const plannedFrame of plannedFrames) {
    if (!isDeepStrictEqual(byId.get(plannedFrame.id), plannedFrame)) {
      invalid(`Artifact Revision ${revision.id} Frame ${plannedFrame.id} is not the immutable planned Frame`);
    }
  }
  return { frameIds: [...plannedFrameIds].sort(compareBinary), states };
}

function resolveArtifacts(input: BuildGenerationTaskPrototypeValidationInput, payload: ValidationPayload, ids: string[]) {
  if (!isDeepStrictEqual(
    input.artifactRevisions.map((revision) => revision.id).sort(compareBinary),
    ids,
  )) {
    invalid("Prototype Artifact Revision records do not match the immutable dependency output set");
  }
  const result = new Map<string, ResolvedArtifact>();
  for (const revision of input.artifactRevisions) {
    if (revision.workspaceId !== input.task.workspaceId
      || revision.kernelRevisionId !== input.attempt.kernelRevisionId
      || input.snapshot.artifactRevisions[revision.artifactId] !== revision.id
      || input.snapshot.artifactTracks[revision.artifactId] !== revision.trackId) {
      invalid(`Artifact Revision ${revision.id} is not the exact immutable Snapshot Revision`);
    }
    artifactNode(input.snapshot, revision.artifactId);
    if (result.has(revision.artifactId)) {
      invalid(`Prototype dependency outputs contain duplicate Artifact ${revision.artifactId}`);
    }
    result.set(revision.artifactId, {
      revision,
      ...revisionFrames(revision, payload.responsiveFrames),
    });
  }
  if (!isDeepStrictEqual(
    [...result.keys()].sort(compareBinary),
    exactStringSet(payload.artifactIds, "Prototype payload Artifact ids"),
  )) {
    invalid("Prototype Artifact Revision set does not match the immutable payload Artifact set");
  }
  return result;
}

function resolveResources(input: BuildGenerationTaskPrototypeValidationInput, ids: string[]) {
  if (!isDeepStrictEqual(
    input.resourceRevisions.map((revision) => revision.id).sort(compareBinary),
    ids,
  )) {
    invalid("Prototype Resource Revision records do not match the immutable dependency output set");
  }
  const result = new Map<string, ResourceRevision>();
  for (const revision of input.resourceRevisions) {
    if (revision.workspaceId !== input.task.workspaceId
      || input.snapshot.resourceRevisions[revision.resourceId] !== revision.id) {
      invalid(`Resource Revision ${revision.id} is not the exact immutable Snapshot Revision`);
    }
    resourceNode(input.snapshot, revision.resourceId);
    if (result.has(revision.resourceId)) {
      invalid(`Prototype dependency outputs contain duplicate Resource ${revision.resourceId}`);
    }
    result.set(revision.resourceId, revision);
  }
  return result;
}

function validateSnapshotAuthority(input: BuildGenerationTaskPrototypeValidationInput): void {
  const { task, attempt, snapshot } = input;
  if (snapshot.id !== attempt.expectedSnapshotId
    || snapshot.workspaceId !== task.workspaceId
    || snapshot.kernelRevisionId !== attempt.kernelRevisionId
    || snapshot.graph.workspaceId !== snapshot.workspaceId
    || snapshot.graphRevision !== snapshot.graph.revision
    || !Number.isSafeInteger(snapshot.graphRevision)
    || snapshot.graphRevision < 0
    || !Array.isArray(snapshot.graph.nodes)
    || !Array.isArray(snapshot.graph.edges)) {
    invalid("Immutable prototype validation Snapshot authority is inconsistent", {
      snapshotId: attempt.expectedSnapshotId,
    });
  }
}

function prototypeEdgeEvidence(input: {
  snapshot: WorkspaceSnapshotRecord;
  payload: ValidationPayload;
  artifacts: Map<string, ResolvedArtifact>;
}): Array<Record<string, unknown>> {
  const edgeIds = new Set<string>();
  for (const edge of input.snapshot.graph.edges) {
    if (edgeIds.has(edge.id)) invalid(`Snapshot graph contains duplicate edge ${edge.id}`);
    edgeIds.add(edge.id);
  }
  const frameIds = input.payload.responsiveFrames.map((frame) => frame.id).sort(compareBinary);
  return input.payload.prototypeIntents.map((intent) => {
    const edge = input.snapshot.graph.edges.find((candidate) => candidate.id === intent.edgeId);
    if (!edge || edge.kind !== "prototype" || edge.prototype.status !== "interactive") {
      return invalid(`Prototype edge ${intent.edgeId} is not interactive in the immutable Snapshot`);
    }
    const sourceNode = artifactNode(input.snapshot, intent.sourceArtifactId);
    const targetNode = artifactNode(input.snapshot, intent.targetArtifactId);
    const source = input.artifacts.get(intent.sourceArtifactId);
    const target = input.artifacts.get(intent.targetArtifactId);
    if (sourceNode.kind !== "page" || targetNode.kind !== "page"
      || edge.sourceNodeId !== sourceNode.id || edge.targetNodeId !== targetNode.id
      || source === undefined || target === undefined) {
      return invalid(`Prototype edge ${intent.edgeId} source or target is not exactly resolvable`);
    }
    const binding = edge.prototype.binding;
    const sourceLocator = locatorEvidence(binding.sourceLocator, `Prototype edge ${intent.edgeId} source locator`);
    if (binding.sourceArtifactId !== intent.sourceArtifactId
      || binding.targetArtifactId !== intent.targetArtifactId
      || binding.sourceRevisionId !== source.revision.id
      || binding.trigger !== intent.trigger
      || (intent.sourceLocator !== undefined && !isDeepStrictEqual(sourceLocator, intent.sourceLocator))
      || binding.targetState !== intent.targetState
      || !isDeepStrictEqual(binding.transition, intent.transition)) {
      return invalid(`Prototype edge ${intent.edgeId} binding diverges from its immutable intent`);
    }
    if (intent.targetState !== undefined && !target.states.has(intent.targetState)) {
      return invalid(`Prototype edge ${intent.edgeId} target state ${intent.targetState} is not resolvable`);
    }
    return {
      edgeId: intent.edgeId,
      sourceArtifactId: intent.sourceArtifactId,
      sourceRevisionId: source.revision.id,
      sourceLocator,
      targetArtifactId: intent.targetArtifactId,
      targetRevisionId: target.revision.id,
      trigger: intent.trigger,
      targetState: intent.targetState ?? null,
      transition: intent.transition === undefined ? null : structuredClone(intent.transition),
      frameIds,
    };
  }).sort((left, right) => compareBinary(String(left.edgeId), String(right.edgeId)));
}

/**
 * Recomputes the complete v1 prototype validation result from immutable Core
 * records. Callers must compare this authoritative value to untrusted executor
 * output rather than validating selected evidence fields independently.
 */
export function buildGenerationTaskPrototypeValidationResult(
  input: BuildGenerationTaskPrototypeValidationInput,
): GenerationTaskPrototypeValidationResult {
  const payload = validationPayload(input.task, input.attempt);
  validateSnapshotAuthority(input);
  const dependencies = dependencyEvidence(input.task, input.attempt);
  const artifacts = resolveArtifacts(input, payload, dependencies.artifactRevisionIds);
  const resources = resolveResources(input, dependencies.resourceRevisionIds);
  const prototypeEdges = prototypeEdgeEvidence({ snapshot: input.snapshot, payload, artifacts });
  return {
    snapshotId: input.snapshot.id,
    graphRevision: input.snapshot.graphRevision,
    artifactRevisionIds: dependencies.artifactRevisionIds,
    resourceRevisionIds: dependencies.resourceRevisionIds,
    evidence: {
      protocol: GENERATION_TASK_PROTOTYPE_VALIDATION_PROTOCOL,
      snapshot: {
        id: input.snapshot.id,
        graphRevision: input.snapshot.graphRevision,
        kernelRevisionId: input.snapshot.kernelRevisionId,
      },
      dependencies: dependencies.evidence,
      artifacts: [...artifacts.values()]
        .map(({ revision, frameIds }) => ({
          artifactId: revision.artifactId,
          revisionId: revision.id,
          trackId: revision.trackId,
          frameIds,
        }))
        .sort((left, right) => compareBinary(left.artifactId, right.artifactId)),
      resources: [...resources.values()]
        .map((revision) => ({ resourceId: revision.resourceId, revisionId: revision.id }))
        .sort((left, right) => compareBinary(left.resourceId, right.resourceId)),
      prototypeEdges,
      frames: payload.responsiveFrames.map((frame) => structuredClone(frame)),
    },
  };
}
