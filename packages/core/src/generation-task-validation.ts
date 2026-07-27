import { createHash } from "node:crypto";
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
export const GENERATION_TASK_PROTOTYPE_FINALIZATION_PROTOCOL = "dezin-prototype-finalization-v2";

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

interface ValidationPayloadV1 {
  version: 1;
  prototypeIntents: WorkspaceGenerationPrototypeIntent[];
  responsiveFrames: Array<Record<string, unknown> & { id: string }>;
  artifactIds: string[];
}

interface PrototypeFinalizationIntent {
  edgeId: string;
  sourceArtifactId: string;
  targetArtifactId: string;
  trigger: "click" | "submit";
  sourceMarkerId: string;
  targetState?: string;
  transition?: WorkspaceGenerationPrototypeIntent["transition"];
}

interface ValidationPayloadV2 {
  version: 2;
  prototypeIntents: PrototypeFinalizationIntent[];
  responsiveFrames: Array<Record<string, unknown> & { id: string }>;
  artifactIds: string[];
}

type ValidationPayload = ValidationPayloadV1 | ValidationPayloadV2;

export interface GenerationTaskPrototypeMarkerProof {
  protocol: "dezin.artifact-element-selection-manifest.v1";
  workspaceId: string;
  artifactId: string;
  artifactRevisionId: string;
  assemblyHash: string;
  designNodeId: string;
  sourceArtifactId: string;
  sourceArtifactRevisionId: string;
  sourceCommitHash: string;
  sourceTreeHash: string;
  sourcePath: string;
  selectionManifestHash: string;
  runtimeProof: {
    protocol: "dezin.artifact-prototype-runtime-proof.v1";
    runtimeIdentityHash: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    assemblyHash: string;
    designNodeId: string;
    trigger: "click" | "submit";
    sourceTreeHash: string;
    dependencyLockHash: string;
    receiptNonce: string;
    frames: Array<{
      frameId: string;
      width: number;
      height: number;
      tagName: string;
      role: string | null;
      action: "button" | "link" | "input-control" | "semantic-control" | "summary"
        | "form" | "submit-control";
      visible: true;
    }>;
    receiptHash: string;
  };
}

export interface GenerationTaskPrototypeFinalizationRequirement {
  edgeId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceMarkerId: string;
  targetArtifactId: string;
  targetRevisionId: string;
  trigger: "click" | "submit";
  targetState?: string;
  transition?: WorkspaceGenerationPrototypeIntent["transition"];
}

export interface GenerationTaskPrototypeFinalizationPreparation {
  baseSnapshotId: string;
  baseGraphRevision: number;
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
  requirements: GenerationTaskPrototypeFinalizationRequirement[];
}

export interface GenerationTaskPrototypeFinalizationBinding {
  edgeId: string;
  binding: {
    sourceArtifactId: string;
    sourceRevisionId: string;
    sourceLocator: {
      designNodeId: string;
    };
    trigger: "click" | "submit";
    targetArtifactId: string;
    targetState?: string;
    transition?: WorkspaceGenerationPrototypeIntent["transition"];
  };
  markerProof: GenerationTaskPrototypeMarkerProof;
}

export interface BuildGenerationTaskPrototypeFinalizationResultInput
  extends BuildGenerationTaskPrototypeValidationInput {
  finalSnapshot: WorkspaceSnapshotRecord;
  markerProofs: readonly GenerationTaskPrototypeMarkerProof[];
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

function prototypeTransition(
  value: unknown,
  label: string,
): WorkspaceGenerationPrototypeIntent["transition"] {
  let transition: WorkspaceGenerationPrototypeIntent["transition"];
  if (value !== undefined) {
    const candidate = exactObject(value, ["type"], ["durationMs", "easing"], `${label} transition`);
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
  return transition;
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
  const transition = prototypeTransition(intent.transition, label);
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

function prototypeFinalizationIntent(value: unknown, index: number): PrototypeFinalizationIntent {
  const label = `Prototype finalization intent[${index}]`;
  const intent = exactObject(
    value,
    ["edgeId", "sourceArtifactId", "targetArtifactId", "trigger", "sourceMarkerId"],
    ["targetState", "transition"],
    label,
  );
  if (intent.trigger !== "click" && intent.trigger !== "submit") {
    invalid(`${label} trigger is unsupported`);
  }
  const transition = prototypeTransition(intent.transition, label);
  return {
    edgeId: nonEmptyString(intent.edgeId, `${label} edge id`),
    sourceArtifactId: nonEmptyString(intent.sourceArtifactId, `${label} source Artifact id`),
    targetArtifactId: nonEmptyString(intent.targetArtifactId, `${label} target Artifact id`),
    trigger: intent.trigger,
    sourceMarkerId: nonEmptyString(intent.sourceMarkerId, `${label} source marker id`),
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
  if (payload.version !== 1 && payload.version !== 2) {
    invalid("Prototype validation Task payload version is unsupported");
  }
  const intents = denseArray(payload.prototypeIntents, "Prototype validation intents")
    .map(payload.version === 1 ? prototypeIntent : prototypeFinalizationIntent);
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
  if (payload.version === 2) {
    const markerIds = (intents as PrototypeFinalizationIntent[]).map((intent) => intent.sourceMarkerId);
    if (new Set(markerIds).size !== markerIds.length) {
      invalid("Prototype finalization source marker ids must be unique");
    }
    return {
      version: 2,
      prototypeIntents: intents as PrototypeFinalizationIntent[],
      responsiveFrames: frames,
      artifactIds,
    };
  }
  return {
    version: 1,
    prototypeIntents: intents as WorkspaceGenerationPrototypeIntent[],
    responsiveFrames: frames,
    artifactIds,
  };
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
  const plannedById = new Map(plannedFrames.map((frame) => [frame.id, frame]));
  const byId = new Map<string, Record<string, unknown>>();
  const states = new Set<string>();
  frames.forEach((value, index) => {
    const frame = record(value, `Artifact Revision ${revision.id} Frame ${index}`);
    const frameId = nonEmptyString(frame.id, `Artifact Revision ${revision.id} Frame ${index} id`);
    if (byId.has(frameId)) invalid(`Artifact Revision ${revision.id} has duplicate Frame ${frameId}`);
    const plannedFrame = plannedById.get(frameId);
    if (plannedFrame === undefined) {
      invalid(`Artifact Revision ${revision.id} Frame ${frameId} is absent from the immutable validation plan`);
    }
    if (!isDeepStrictEqual(frame, plannedFrame)) {
      invalid(`Artifact Revision ${revision.id} Frame ${frameId} is not the immutable planned Frame`);
    }
    byId.set(frameId, frame);
    if (frame.initialState !== undefined) {
      states.add(nonEmptyString(frame.initialState, `Artifact Revision ${revision.id} Frame ${frameId} state`));
    }
  });
  return { frameIds: [...byId.keys()].sort(compareBinary), states };
}

function resolveArtifacts(input: BuildGenerationTaskPrototypeValidationInput, payload: ValidationPayload, ids: string[]) {
  if (!isDeepStrictEqual(
    input.artifactRevisions.map((revision) => revision.id).sort(compareBinary),
    ids,
  )) {
    invalid("Prototype Artifact Revision records do not match the immutable dependency output set");
  }
  const result = new Map<string, ResolvedArtifact>();
  // Workspace-global neutral Frames may be shared by every Artifact. A set
  // validates complete coverage without rejecting that intentional overlap.
  const coveredFrameIds = new Set<string>();
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
    const resolvedFrames = revisionFrames(revision, payload.responsiveFrames);
    for (const frameId of resolvedFrames.frameIds) {
      coveredFrameIds.add(frameId);
    }
    result.set(revision.artifactId, {
      revision,
      ...resolvedFrames,
    });
  }
  if (!isDeepStrictEqual(
    [...result.keys()].sort(compareBinary),
    exactStringSet(payload.artifactIds, "Prototype payload Artifact ids"),
  )) {
    invalid("Prototype Artifact Revision set does not match the immutable payload Artifact set");
  }
  const plannedFrameIds = payload.responsiveFrames.map((frame) => frame.id).sort(compareBinary);
  // Empty approved generations retain a validation/checkpoint chain without
  // producing Artifact Revisions that could cover their Workspace Frames.
  if (payload.artifactIds.length > 0
    && !isDeepStrictEqual([...coveredFrameIds].sort(compareBinary), plannedFrameIds)) {
    invalid("Prototype Artifact Revision Frame union diverges from the immutable validation plan");
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
  payload: ValidationPayloadV1;
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalFlatRecord(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareBinary(left, right)),
  ));
}

function exactHash(value: unknown, label: string, lengths: readonly number[] = [64]): string {
  const hash = nonEmptyString(value, label);
  if (!lengths.includes(hash.length) || !/^[0-9a-f]+$/.test(hash)) {
    invalid(`${label} must be a lowercase hexadecimal hash`);
  }
  return hash;
}

function exactSourcePath(value: unknown, label: string): string {
  const sourcePath = nonEmptyString(value, label);
  if (sourcePath.length > 4_096
    || sourcePath.startsWith("/")
    || sourcePath.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(sourcePath)
    || sourcePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalid(`${label} must be a canonical Artifact-relative path`);
  }
  return sourcePath;
}

function prototypeRuntimeProof(
  value: unknown,
  label: string,
): GenerationTaskPrototypeMarkerProof["runtimeProof"] {
  const proof = exactObject(value, [
    "protocol",
    "runtimeIdentityHash",
    "workspaceId",
    "artifactId",
    "artifactRevisionId",
    "assemblyHash",
    "designNodeId",
    "trigger",
    "sourceTreeHash",
    "dependencyLockHash",
    "receiptNonce",
    "frames",
    "receiptHash",
  ], [], label);
  if (proof.protocol !== "dezin.artifact-prototype-runtime-proof.v1") {
    invalid(`${label} protocol is unsupported`);
  }
  if (proof.trigger !== "click" && proof.trigger !== "submit") {
    invalid(`${label} trigger is invalid`);
  }
  const trigger: "click" | "submit" = proof.trigger;
  const frames = denseArray(proof.frames, `${label} Frames`).map((value, index) => {
    const frameLabel = `${label} Frame[${index}]`;
    const frame = exactObject(value, [
      "frameId",
      "width",
      "height",
      "tagName",
      "role",
      "action",
      "visible",
    ], [], frameLabel);
    if (!Number.isSafeInteger(frame.width) || Number(frame.width) <= 0
      || !Number.isSafeInteger(frame.height) || Number(frame.height) <= 0) {
      invalid(`${frameLabel} viewport is invalid`);
    }
    if (frame.role !== null && (typeof frame.role !== "string" || frame.role.length === 0)) {
      invalid(`${frameLabel} role is invalid`);
    }
    if (frame.action !== "button" && frame.action !== "link" && frame.action !== "input-control"
      && frame.action !== "semantic-control" && frame.action !== "summary"
      && frame.action !== "form" && frame.action !== "submit-control") {
      invalid(`${frameLabel} action is invalid`);
    }
    const action: GenerationTaskPrototypeMarkerProof["runtimeProof"]["frames"][number]["action"] =
      frame.action;
    if (frame.visible !== true
      || (trigger === "click" && (action === "form" || action === "submit-control"))
      || (trigger === "submit" && action !== "form" && action !== "submit-control")) {
      invalid(`${frameLabel} is not trigger-compatible`);
    }
    return {
      frameId: nonEmptyString(frame.frameId, `${frameLabel} id`),
      width: Number(frame.width),
      height: Number(frame.height),
      tagName: nonEmptyString(frame.tagName, `${frameLabel} tag name`),
      role: frame.role as string | null,
      action,
      visible: true as const,
    };
  });
  const frameIds = frames.map((frame) => frame.frameId);
  if (new Set(frameIds).size !== frameIds.length
    || !isDeepStrictEqual(frameIds, [...frameIds].sort(compareBinary))) {
    invalid(`${label} Frames must be unique and canonically ordered`);
  }
  const normalized = {
    protocol: "dezin.artifact-prototype-runtime-proof.v1" as const,
    runtimeIdentityHash: exactHash(proof.runtimeIdentityHash, `${label} runtime identity hash`),
    workspaceId: nonEmptyString(proof.workspaceId, `${label} Workspace id`),
    artifactId: nonEmptyString(proof.artifactId, `${label} Artifact id`),
    artifactRevisionId: nonEmptyString(proof.artifactRevisionId, `${label} Artifact Revision id`),
    assemblyHash: exactHash(proof.assemblyHash, `${label} assembly hash`),
    designNodeId: nonEmptyString(proof.designNodeId, `${label} design node id`),
    trigger,
    sourceTreeHash: exactHash(proof.sourceTreeHash, `${label} source tree hash`, [40, 64]),
    dependencyLockHash: exactHash(proof.dependencyLockHash, `${label} dependency lock hash`),
    receiptNonce: exactHash(proof.receiptNonce, `${label} receipt nonce`),
    frames,
  };
  const expectedRuntimeIdentityHash = sha256(JSON.stringify({
    protocol: "dezin.artifact-preview-runtime-identity.v1",
    workspaceId: normalized.workspaceId,
    artifactId: normalized.artifactId,
    artifactRevisionId: normalized.artifactRevisionId,
    assemblyHash: normalized.assemblyHash,
    sourceTreeHash: normalized.sourceTreeHash,
    dependencyLockHash: normalized.dependencyLockHash,
  }));
  const receiptHash = exactHash(proof.receiptHash, `${label} receipt hash`);
  return {
    ...normalized,
    runtimeIdentityHash: expectedRuntimeIdentityHash === normalized.runtimeIdentityHash
      ? normalized.runtimeIdentityHash
      : invalid(`${label} runtime identity hash is inconsistent`),
    receiptHash: receiptHash === sha256(JSON.stringify(normalized))
      ? receiptHash
      : invalid(`${label} receipt hash is inconsistent`),
  };
}

function prototypeMarkerProof(
  value: unknown,
  index: number,
): GenerationTaskPrototypeMarkerProof {
  const label = `Prototype marker proof[${index}]`;
  const proof = exactObject(value, [
    "protocol",
    "workspaceId",
    "artifactId",
    "artifactRevisionId",
    "assemblyHash",
    "designNodeId",
    "sourceArtifactId",
    "sourceArtifactRevisionId",
    "sourceCommitHash",
    "sourceTreeHash",
    "sourcePath",
    "selectionManifestHash",
    "runtimeProof",
  ], [], label);
  if (proof.protocol !== "dezin.artifact-element-selection-manifest.v1") {
    invalid(`${label} protocol is unsupported`);
  }
  const manifest = {
    protocol: "dezin.artifact-element-selection-manifest.v1" as const,
    workspaceId: nonEmptyString(proof.workspaceId, `${label} Workspace id`),
    artifactId: nonEmptyString(proof.artifactId, `${label} Artifact id`),
    artifactRevisionId: nonEmptyString(proof.artifactRevisionId, `${label} Artifact Revision id`),
    assemblyHash: exactHash(proof.assemblyHash, `${label} assembly hash`),
    designNodeId: nonEmptyString(proof.designNodeId, `${label} design node id`),
    sourceArtifactId: nonEmptyString(proof.sourceArtifactId, `${label} source Artifact id`),
    sourceArtifactRevisionId: nonEmptyString(
      proof.sourceArtifactRevisionId,
      `${label} source Artifact Revision id`,
    ),
    sourceCommitHash: exactHash(proof.sourceCommitHash, `${label} source commit hash`, [40, 64]),
    sourceTreeHash: exactHash(proof.sourceTreeHash, `${label} source tree hash`, [40, 64]),
    sourcePath: exactSourcePath(proof.sourcePath, `${label} source path`),
  };
  const selectionManifestHash = exactHash(
    proof.selectionManifestHash,
    `${label} selection manifest hash`,
  );
  if (selectionManifestHash !== sha256(canonicalFlatRecord(manifest))) {
    invalid(`${label} selection manifest hash is inconsistent`);
  }
  return {
    ...manifest,
    selectionManifestHash,
    runtimeProof: prototypeRuntimeProof(proof.runtimeProof, `${label} runtime proof`),
  };
}

export function generationTaskPrototypeFinalizationCommandId(
  taskId: string,
  attempt: number,
  edgeId: string,
): string {
  nonEmptyString(taskId, "Prototype finalization Task id");
  nonEmptyString(edgeId, "Prototype finalization edge id");
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    invalid("Prototype finalization Attempt must be a positive safe integer");
  }
  return `prototype-finalization-${sha256(JSON.stringify([taskId, attempt, edgeId])).slice(0, 32)}`;
}

export function generationTaskPrototypeRuntimeReceiptNonce(
  taskId: string,
  attempt: number,
  edgeId: string,
  sourceMarkerId: string,
): string {
  nonEmptyString(taskId, "Prototype runtime receipt Task id");
  nonEmptyString(edgeId, "Prototype runtime receipt edge id");
  nonEmptyString(sourceMarkerId, "Prototype runtime receipt source marker id");
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    invalid("Prototype runtime receipt Attempt must be a positive safe integer");
  }
  return sha256(JSON.stringify([
    "dezin-prototype-runtime-receipt-nonce-v1",
    taskId,
    attempt,
    edgeId,
    sourceMarkerId,
  ]));
}

export function buildGenerationTaskPrototypeFinalizationPreparation(
  input: BuildGenerationTaskPrototypeValidationInput,
): GenerationTaskPrototypeFinalizationPreparation {
  const payload = validationPayload(input.task, input.attempt);
  if (payload.version !== 2) invalid("Prototype finalization preparation requires a v2 payload");
  validateSnapshotAuthority(input);
  const dependencies = dependencyEvidence(input.task, input.attempt);
  const artifacts = resolveArtifacts(input, payload, dependencies.artifactRevisionIds);
  resolveResources(input, dependencies.resourceRevisionIds);
  const edgeIds = new Set<string>();
  for (const edge of input.snapshot.graph.edges) {
    if (edgeIds.has(edge.id)) invalid(`Snapshot graph contains duplicate edge ${edge.id}`);
    edgeIds.add(edge.id);
  }
  const requirements = payload.prototypeIntents.map((intent) => {
    const edge = input.snapshot.graph.edges.find((candidate) => candidate.id === intent.edgeId);
    if (!edge || edge.kind !== "prototype" || edge.prototype.status !== "planned") {
      return invalid(`Prototype edge ${intent.edgeId} is not planned in the immutable base Snapshot`);
    }
    const sourceNode = artifactNode(input.snapshot, intent.sourceArtifactId);
    const targetNode = artifactNode(input.snapshot, intent.targetArtifactId);
    const source = artifacts.get(intent.sourceArtifactId);
    const target = artifacts.get(intent.targetArtifactId);
    if (sourceNode.kind !== "page" || targetNode.kind !== "page"
      || edge.sourceNodeId !== sourceNode.id || edge.targetNodeId !== targetNode.id
      || source === undefined || target === undefined) {
      return invalid(`Prototype edge ${intent.edgeId} source or target is not exactly resolvable`);
    }
    if (intent.targetState !== undefined && !target.states.has(intent.targetState)) {
      return invalid(`Prototype edge ${intent.edgeId} target state ${intent.targetState} is not resolvable`);
    }
    return {
      edgeId: intent.edgeId,
      sourceArtifactId: intent.sourceArtifactId,
      sourceRevisionId: source.revision.id,
      sourceMarkerId: intent.sourceMarkerId,
      targetArtifactId: intent.targetArtifactId,
      targetRevisionId: target.revision.id,
      trigger: intent.trigger,
      ...(intent.targetState === undefined ? {} : { targetState: intent.targetState }),
      ...(intent.transition === undefined ? {} : { transition: structuredClone(intent.transition) }),
    };
  });
  return {
    baseSnapshotId: input.snapshot.id,
    baseGraphRevision: input.snapshot.graphRevision,
    artifactRevisionIds: dependencies.artifactRevisionIds,
    resourceRevisionIds: dependencies.resourceRevisionIds,
    requirements,
  };
}

export function buildGenerationTaskPrototypeFinalizationBindings(
  input: BuildGenerationTaskPrototypeValidationInput & {
    markerProofs: readonly GenerationTaskPrototypeMarkerProof[];
  },
): {
  preparation: GenerationTaskPrototypeFinalizationPreparation;
  bindings: GenerationTaskPrototypeFinalizationBinding[];
} {
  const preparation = buildGenerationTaskPrototypeFinalizationPreparation(input);
  if (input.markerProofs.length !== preparation.requirements.length) {
    invalid("Prototype marker proof set does not match the immutable intent set");
  }
  const artifacts = new Map(input.artifactRevisions.map((revision) => [revision.id, revision]));
  const bindings = preparation.requirements.map((requirement, index) => {
    const proof = prototypeMarkerProof(input.markerProofs[index], index);
    const sourceRevision = artifacts.get(requirement.sourceRevisionId);
    if (sourceRevision === undefined
      || proof.workspaceId !== input.task.workspaceId
      || proof.artifactId !== requirement.sourceArtifactId
      || proof.artifactRevisionId !== requirement.sourceRevisionId
      || proof.designNodeId !== requirement.sourceMarkerId
      || proof.sourceArtifactId !== requirement.sourceArtifactId
      || proof.sourceArtifactRevisionId !== requirement.sourceRevisionId
      || proof.sourceCommitHash !== sourceRevision.sourceCommitHash
      || proof.sourceTreeHash !== sourceRevision.sourceTreeHash
      || proof.runtimeProof.workspaceId !== proof.workspaceId
      || proof.runtimeProof.artifactId !== proof.artifactId
      || proof.runtimeProof.artifactRevisionId !== proof.artifactRevisionId
      || proof.runtimeProof.assemblyHash !== proof.assemblyHash
      || proof.runtimeProof.designNodeId !== proof.designNodeId
      || proof.runtimeProof.trigger !== requirement.trigger
      || proof.runtimeProof.sourceTreeHash !== proof.sourceTreeHash
      || proof.runtimeProof.receiptNonce !== generationTaskPrototypeRuntimeReceiptNonce(
        input.task.id,
        input.attempt.attempt,
        requirement.edgeId,
        requirement.sourceMarkerId,
      )) {
      invalid(`Prototype marker proof ${requirement.sourceMarkerId} is not bound to its exact source Revision`);
    }
    const expectedRuntimeFrames = denseArray(
      sourceRevision.renderSpec.frames,
      `Prototype source Revision ${sourceRevision.id} Frames`,
    ).map((value, frameIndex) => {
      const frame = record(value, `Prototype source Revision ${sourceRevision.id} Frame[${frameIndex}]`);
      if (!Number.isSafeInteger(frame.width) || Number(frame.width) <= 0
        || !Number.isSafeInteger(frame.height) || Number(frame.height) <= 0) {
        invalid(`Prototype source Revision ${sourceRevision.id} Frame viewport is invalid`);
      }
      return {
        frameId: nonEmptyString(
          frame.id,
          `Prototype source Revision ${sourceRevision.id} Frame[${frameIndex}] id`,
        ),
        width: Number(frame.width),
        height: Number(frame.height),
      };
    }).sort((left, right) => compareBinary(left.frameId, right.frameId));
    if (!isDeepStrictEqual(
      proof.runtimeProof.frames.map(({ frameId, width, height }) => ({ frameId, width, height })),
      expectedRuntimeFrames,
    )) {
      invalid(`Prototype marker proof ${requirement.sourceMarkerId} does not cover every exact source Frame`);
    }
    return {
      edgeId: requirement.edgeId,
      binding: {
        sourceArtifactId: requirement.sourceArtifactId,
        sourceRevisionId: requirement.sourceRevisionId,
        sourceLocator: {
          designNodeId: requirement.sourceMarkerId,
        },
        trigger: requirement.trigger,
        targetArtifactId: requirement.targetArtifactId,
        ...(requirement.targetState === undefined ? {} : { targetState: requirement.targetState }),
        ...(requirement.transition === undefined
          ? {}
          : { transition: structuredClone(requirement.transition) }),
      },
      markerProof: proof,
    };
  });
  return { preparation, bindings };
}

export function buildGenerationTaskPrototypeFinalizationResult(
  input: BuildGenerationTaskPrototypeFinalizationResultInput,
): GenerationTaskPrototypeValidationResult {
  const payload = validationPayload(input.task, input.attempt);
  if (payload.version !== 2) invalid("Prototype finalization result requires a v2 payload");
  const { preparation, bindings } = buildGenerationTaskPrototypeFinalizationBindings(input);
  const expectedGraphRevision = preparation.baseGraphRevision + 1;
  if (!Number.isSafeInteger(expectedGraphRevision)
    || input.finalSnapshot.id === input.snapshot.id
    || input.finalSnapshot.workspaceId !== input.snapshot.workspaceId
    || input.finalSnapshot.parentSnapshotId !== input.snapshot.id
    || input.finalSnapshot.graphRevision !== expectedGraphRevision
    || input.finalSnapshot.graph.workspaceId !== input.snapshot.graph.workspaceId
    || input.finalSnapshot.graph.revision !== expectedGraphRevision
    || input.finalSnapshot.kernelRevisionId !== input.snapshot.kernelRevisionId
    || !isDeepStrictEqual(input.finalSnapshot.artifactTracks, input.snapshot.artifactTracks)
    || !isDeepStrictEqual(input.finalSnapshot.artifactRevisions, input.snapshot.artifactRevisions)
    || !isDeepStrictEqual(input.finalSnapshot.resourceRevisions, input.snapshot.resourceRevisions)) {
    invalid("Prototype finalization Snapshot authority is inconsistent");
  }
  const commandIds = bindings.map((binding) => generationTaskPrototypeFinalizationCommandId(
    input.task.id,
    input.attempt.attempt,
    binding.edgeId,
  ));
  if (!isDeepStrictEqual(input.finalSnapshot.provenance, { kind: "graph-command", commandIds })) {
    invalid("Prototype finalization Snapshot provenance is inconsistent");
  }
  const bindingsByEdgeId = new Map(bindings.map((binding) => [binding.edgeId, binding.binding]));
  const expectedGraph = {
    ...structuredClone(input.snapshot.graph),
    revision: expectedGraphRevision,
    edges: input.snapshot.graph.edges.map((edge) => {
      const binding = bindingsByEdgeId.get(edge.id);
      if (binding === undefined) return structuredClone(edge);
      if (edge.kind !== "prototype" || edge.prototype.status !== "planned") {
        return invalid(`Prototype edge ${edge.id} changed before finalization`);
      }
      return {
        ...structuredClone(edge),
        prototype: {
          status: "interactive" as const,
          binding: structuredClone(binding),
        },
      };
    }),
  };
  if (!isDeepStrictEqual(input.finalSnapshot.graph, expectedGraph)) {
    invalid("Prototype finalization graph diverges from its immutable bindings");
  }
  const dependencies = dependencyEvidence(input.task, input.attempt);
  const artifacts = resolveArtifacts(input, payload, dependencies.artifactRevisionIds);
  const resources = resolveResources(input, dependencies.resourceRevisionIds);
  const requirementsByEdgeId = new Map(preparation.requirements.map((requirement) => [
    requirement.edgeId,
    requirement,
  ]));
  return {
    snapshotId: input.finalSnapshot.id,
    graphRevision: input.finalSnapshot.graphRevision,
    artifactRevisionIds: dependencies.artifactRevisionIds,
    resourceRevisionIds: dependencies.resourceRevisionIds,
    evidence: {
      protocol: GENERATION_TASK_PROTOTYPE_FINALIZATION_PROTOCOL,
      baseSnapshot: {
        id: input.snapshot.id,
        graphRevision: input.snapshot.graphRevision,
        kernelRevisionId: input.snapshot.kernelRevisionId,
      },
      snapshot: {
        id: input.finalSnapshot.id,
        graphRevision: input.finalSnapshot.graphRevision,
        kernelRevisionId: input.finalSnapshot.kernelRevisionId,
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
      prototypeEdges: bindings.map(({ edgeId, binding, markerProof }) => {
        const requirement = requirementsByEdgeId.get(edgeId)!;
        const source = artifacts.get(requirement.sourceArtifactId)!;
        return {
          edgeId,
          sourceArtifactId: binding.sourceArtifactId,
          sourceRevisionId: binding.sourceRevisionId,
          sourceMarkerId: binding.sourceLocator.designNodeId,
          sourceLocator: structuredClone(binding.sourceLocator),
          markerProof: structuredClone(markerProof),
          targetArtifactId: binding.targetArtifactId,
          targetRevisionId: requirement.targetRevisionId,
          trigger: binding.trigger,
          targetState: binding.targetState ?? null,
          transition: binding.transition === undefined ? null : structuredClone(binding.transition),
          frameIds: source.frameIds,
        };
      }),
      frames: payload.responsiveFrames.map((frame) => structuredClone(frame)),
    },
  };
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
  if (payload.version !== 1) {
    invalid("Prototype finalization v2 requires the atomic finalization builder");
  }
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
