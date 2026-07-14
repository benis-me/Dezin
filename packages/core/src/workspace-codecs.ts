import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeWorkspaceGraphCommands,
  validateWorkspaceGraph,
  WorkspaceGraphValidationError,
} from "./workspace-graph.ts";
import type {
  ArtifactRevisionDependency,
  ArtifactRevisionDependencyInput,
  ArtifactRevisionResourcePin,
  ArtifactRevisionResourcePinInput,
  ArtifactKind,
  ArtifactPublicationExpectation,
  ArtifactQualityProfile,
  ApprovedProposalResult,
  ComponentPropagationOverrideResolution,
  ComponentPropagationProposalPayload,
  CreateWorkspaceProposalInput,
  CreateArtifactRevisionInput,
  CreateKernelRevisionInput,
  DesignNodeLocator,
  KernelImpactAnalysis,
  KernelPublicationExpectation,
  LegacyWorkspaceFacts,
  LegacyWorkspaceProjectFact,
  LegacyWorkspaceRunFact,
  LegacyWorkspaceSeed,
  LegacyWorkspaceVariantFact,
  ProjectWorkspace,
  SharedDesignKernelRevision,
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceGraphMutationInput,
  WorkspaceGenerationArtifactPlan,
  WorkspaceGenerationCapability,
  WorkspaceGenerationDependencyPlan,
  WorkspaceGenerationPayload,
  WorkspaceGenerationPrototypeIntent,
  WorkspaceGenerationResourceOperation,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutPatch,
  WorkspaceNode,
  WorkspaceSnapshot,
  WorkspaceSnapshotPublicationInput,
  WorkspaceSnapshotProvenance,
  WorkspaceProposal,
  WorkspaceProposalGeneration,
  WorkspaceProposalReview,
  UpdateWorkspaceProposalInput,
  GenerationPlan,
} from "./workspace-types.ts";
import type { Row } from "./store-codecs.ts";
import type { ProjectMode } from "./types.ts";

const OBJECT_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Object.prototype));
const ARRAY_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Array.prototype));

export function compareBinary(left: string, right: string): number {
  if (!isWellFormedUtf16(left) || !isWellFormedUtf16(right)) {
    throw new WorkspaceStoreCodecError("durable identifiers must contain well-formed Unicode");
  }
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function sortedUtf8ObjectKeys(value: Record<string, unknown>, label: string): string[] {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!isWellFormedUtf16(key)) {
      throw new WorkspaceStoreCodecError(`${label} keys must contain well-formed Unicode`);
    }
  }
  return keys.sort(compareBinary);
}

export interface WorkspaceArtifactRecord {
  id: string;
  workspaceId: string;
  kind: ArtifactKind;
  name: string;
  sourceRoot: string;
  legacyWrapped: boolean;
  activeTrackId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactTrackRecord {
  id: string;
  artifactId: string;
  name: string;
  headRevisionId: string | null;
  legacyVariantId: string | null;
  createdAt: number;
}

export interface ArtifactRevisionRecord {
  id: string;
  workspaceId: string;
  artifactId: string;
  trackId: string;
  sequence: number;
  parentRevisionId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  artifactRoot: string;
  kernelRevisionId: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  contextPackHash: string | null;
  producedByRunId: string | null;
  legacyRunId: string | null;
  createdAt: number;
}

export type ArtifactRevisionDependencyRecord = ArtifactRevisionDependency;
export type ArtifactRevisionResourcePinRecord = ArtifactRevisionResourcePin;

export interface WorkspaceSnapshotBaseRecord extends Omit<WorkspaceSnapshot, "graph" | "artifactTracks" | "artifactRevisions" | "resourceRevisions"> {
  id: string;
  workspaceId: string;
  sequence: number;
  parentSnapshotId: string | null;
  graphRevision: number;
  kernelRevisionId: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  createdByRunId: string | null;
  createdAt: number;
}

export interface WorkspaceSnapshotRecord extends WorkspaceSnapshot {}

export interface WorkspaceBundle {
  workspace: ProjectWorkspace;
  graph: WorkspaceGraph;
  activeSnapshot: WorkspaceSnapshotRecord;
  activeKernelRevision: SharedDesignKernelRevision;
  artifacts: WorkspaceArtifactRecord[];
  tracks: ArtifactTrackRecord[];
  revisions: ArtifactRevisionRecord[];
  snapshots: WorkspaceSnapshotRecord[];
}

export interface WorkspaceProposalRecord extends WorkspaceProposal {}
export interface GenerationPlanRecord extends GenerationPlan {}

export class WorkspaceStoreCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStoreCodecError";
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-empty string`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} must contain well-formed Unicode`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a positive safe integer`);
  }
  return value;
}

function sealedAggregate(value: unknown, label: string): void {
  if (value !== 1) throw new WorkspaceStoreCodecError(`${label} must be sealed before it can be read`);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new WorkspaceStoreCodecError(`${label} must be JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must contain valid JSON`);
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceStoreCodecError(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function boundaryRecord(value: unknown, label: string): Record<string, unknown> {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (typeof value !== "object" || value === null || isArray) {
    throw new WorkspaceStoreCodecError(`${label} must be an object`);
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceStoreCodecError(`${label} must be a plain object`);
  }
  if (prototype === Object.prototype) {
    let inheritedKeys: PropertyKey[];
    try {
      inheritedKeys = Reflect.ownKeys(prototype);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
    }
    if (inheritedKeys.some((key) => !OBJECT_PROTOTYPE_KEYS.has(key))) {
      throw new WorkspaceStoreCodecError(`${label} has an inherited field`);
    }
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new WorkspaceStoreCodecError(`${label} cannot contain symbol fields`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundaryArray(value: unknown, label: string): unknown[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (!isArray) throw new WorkspaceStoreCodecError(`${label} must be an array`);
  let prototype: object | null;
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value as object);
    keys = Reflect.ownKeys(value as object);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value as object, "length");
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (prototype !== Array.prototype) throw new WorkspaceStoreCodecError(`${label} must use the standard array prototype`);
  let inheritedKeys: PropertyKey[];
  try {
    inheritedKeys = Reflect.ownKeys(prototype);
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (inheritedKeys.some((key) => !ARRAY_PROTOTYPE_KEYS.has(key))) {
    throw new WorkspaceStoreCodecError(`${label} has an inherited field`);
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) {
    throw new WorkspaceStoreCodecError(`${label} length must be a non-negative safe integer data property`);
  }
  const length = lengthDescriptor.value;
  const source = value as unknown[];
  for (const key of keys) {
    if (typeof key !== "string") throw new WorkspaceStoreCodecError(`${label} cannot contain symbol fields`);
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= length) {
      throw new WorkspaceStoreCodecError(`${label} has unexpected field ${key}`);
    }
  }
  const result = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    } catch {
      throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} must be dense data`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

interface JsonBoundaryState {
  readonly ancestors: WeakSet<object>;
  count: number;
}

function canonicalJsonValue(
  value: unknown,
  label: string,
  state: JsonBoundaryState = { ancestors: new WeakSet<object>(), count: 0 },
  depth = 0,
): unknown {
  state.count += 1;
  if (state.count > 100_000 || depth > 64) {
    throw new WorkspaceStoreCodecError(`${label} exceeds the JSON boundary budget`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) {
      throw new WorkspaceStoreCodecError(`${label} strings must contain well-formed Unicode`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkspaceStoreCodecError(`${label} numbers must be finite`);
    return value;
  }
  if (typeof value !== "object") {
    throw new WorkspaceStoreCodecError(`${label} must contain only JSON values`);
  }
  if (state.ancestors.has(value)) throw new WorkspaceStoreCodecError(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    let isArray = false;
    try {
      isArray = Array.isArray(value);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
    }
    if (isArray) {
      const values = boundaryArray(value, label);
      return values.map((entry, index) => canonicalJsonValue(entry, `${label}[${index}]`, state, depth + 1));
    }
    const record = boundaryRecord(value, label);
    const result: Record<string, unknown> = {};
    for (const key of sortedUtf8ObjectKeys(record, label)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new WorkspaceStoreCodecError(`${label} contains unsafe field ${key}`);
      }
      result[key] = canonicalJsonValue(record[key], `${label}.${key}`, state, depth + 1);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalJsonObject(value: unknown, label: string): Record<string, unknown> {
  const result = canonicalJsonValue(value, label);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new WorkspaceStoreCodecError(`${label} must be a JSON object`);
  }
  return result as Record<string, unknown>;
}

function canonicalStringArray(value: unknown, label: string): string[] {
  return boundaryArray(value, label).map((entry, index) => canonicalString(entry, `${label}[${index}]`));
}

function nullableCanonicalString(value: unknown, label: string): string | null {
  return value === null ? null : canonicalString(value, label);
}

function optionalNullableCanonicalString(
  input: Record<string, unknown>,
  field: string,
  label: string,
): string | null | undefined {
  if (!Object.hasOwn(input, field)) return undefined;
  return nullableCanonicalString(input[field], label);
}

function normalizeDesignNodeLocatorInput(value: unknown, label: string): DesignNodeLocator {
  const locator = boundaryRecord(value, label);
  allowFields(locator, ["designNodeId", "sourcePath", "selector"], label);
  const sourcePath = Object.hasOwn(locator, "sourcePath")
    ? canonicalString(locator.sourcePath, `${label} sourcePath`)
    : undefined;
  const selector = Object.hasOwn(locator, "selector")
    ? canonicalString(locator.selector, `${label} selector`)
    : undefined;
  return {
    designNodeId: canonicalString(locator.designNodeId, `${label} designNodeId`),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(selector === undefined ? {} : { selector }),
  };
}

function normalizeArtifactDependencyInput(value: unknown, index: number): ArtifactRevisionDependencyInput {
  const label = `Artifact Revision dependency at index ${index}`;
  const dependency = boundaryRecord(value, label);
  allowFields(dependency, [
    "instanceId",
    "componentArtifactId",
    "componentRevisionId",
    "createInstanceIdentity",
    "variantKey",
    "stateKey",
    "sourceLocator",
    "overrides",
    "status",
  ], label);
  if (Object.hasOwn(dependency, "createInstanceIdentity") && dependency.createInstanceIdentity !== true) {
    throw new WorkspaceStoreCodecError(`${label} createInstanceIdentity must be true when present`);
  }
  if (dependency.status !== "linked" && dependency.status !== "detached") {
    throw new WorkspaceStoreCodecError(`${label} status must be linked or detached`);
  }
  const variantKey = optionalNullableCanonicalString(dependency, "variantKey", `${label} variantKey`);
  const stateKey = optionalNullableCanonicalString(dependency, "stateKey", `${label} stateKey`);
  return {
    instanceId: canonicalString(dependency.instanceId, `${label} instanceId`),
    componentArtifactId: canonicalString(dependency.componentArtifactId, `${label} componentArtifactId`),
    componentRevisionId: canonicalString(dependency.componentRevisionId, `${label} componentRevisionId`),
    ...(dependency.createInstanceIdentity === true ? { createInstanceIdentity: true } : {}),
    ...(variantKey == null ? {} : { variantKey }),
    ...(stateKey == null ? {} : { stateKey }),
    sourceLocator: normalizeDesignNodeLocatorInput(dependency.sourceLocator, `${label} sourceLocator`),
    overrides: canonicalJsonObject(dependency.overrides, `${label} overrides`),
    status: dependency.status,
  };
}

function normalizeArtifactResourcePinInput(value: unknown, index: number): ArtifactRevisionResourcePinInput {
  const label = `Artifact Revision Resource pin at index ${index}`;
  const pin = boundaryRecord(value, label);
  allowFields(pin, ["resourceId", "resourceRevisionId"], label);
  return {
    resourceId: canonicalString(pin.resourceId, `${label} resourceId`),
    resourceRevisionId: canonicalString(pin.resourceRevisionId, `${label} Resource Revision id`),
  };
}

export function normalizeCreateArtifactRevisionInput(value: unknown): CreateArtifactRevisionInput {
  const input = boundaryRecord(value, "create Artifact Revision input");
  allowFields(input, [
    "artifactId",
    "trackId",
    "parentRevisionId",
    "sourceCommitHash",
    "sourceTreeHash",
    "kernelRevisionId",
    "renderSpec",
    "quality",
    "contextPackHash",
    "producedByRunId",
    "dependencies",
    "resourcePins",
  ], "create Artifact Revision input");
  if (!Object.hasOwn(input, "parentRevisionId")) {
    throw new WorkspaceStoreCodecError("create Artifact Revision input requires parentRevisionId");
  }
  if (!Object.hasOwn(input, "dependencies") || !Object.hasOwn(input, "resourcePins")) {
    throw new WorkspaceStoreCodecError("create Artifact Revision input requires complete dependencies and resourcePins");
  }
  const dependencies = boundaryArray(input.dependencies, "Artifact Revision dependencies")
    .map(normalizeArtifactDependencyInput);
  const instanceIds = new Set<string>();
  for (const dependency of dependencies) {
    if (instanceIds.has(dependency.instanceId)) {
      throw new WorkspaceStoreCodecError(`duplicate Artifact Revision instance id ${dependency.instanceId}`);
    }
    instanceIds.add(dependency.instanceId);
  }
  dependencies.sort((left, right) => compareBinary(left.instanceId, right.instanceId));
  const resourcePins = boundaryArray(input.resourcePins, "Artifact Revision Resource pins")
    .map(normalizeArtifactResourcePinInput);
  const resourceIds = new Set<string>();
  for (const pin of resourcePins) {
    if (resourceIds.has(pin.resourceId)) {
      throw new WorkspaceStoreCodecError(`duplicate Artifact Revision Resource pin ${pin.resourceId}`);
    }
    resourceIds.add(pin.resourceId);
  }
  resourcePins.sort((left, right) => compareBinary(left.resourceId, right.resourceId));
  const contextPackHash = optionalNullableCanonicalString(input, "contextPackHash", "Context Pack hash");
  const producedByRunId = optionalNullableCanonicalString(input, "producedByRunId", "producing Run id");
  return {
    artifactId: canonicalString(input.artifactId, "Artifact id"),
    trackId: canonicalString(input.trackId, "Artifact Track id"),
    parentRevisionId: nullableCanonicalString(input.parentRevisionId, "parent Artifact Revision id"),
    sourceCommitHash: canonicalString(input.sourceCommitHash, "source commit hash"),
    sourceTreeHash: canonicalString(input.sourceTreeHash, "source tree hash"),
    kernelRevisionId: canonicalString(input.kernelRevisionId, "Kernel Revision id"),
    renderSpec: canonicalJsonObject(input.renderSpec, "Artifact Revision render spec"),
    quality: canonicalJsonObject(input.quality, "Artifact Revision quality"),
    ...(contextPackHash === undefined ? {} : { contextPackHash }),
    ...(producedByRunId === undefined ? {} : { producedByRunId }),
    dependencies,
    resourcePins,
  };
}

interface KernelPayload {
  tokens: Record<string, string | number>;
  typography: Record<string, unknown>;
  sharedAssetRevisionIds: string[];
  brief: string;
  terminology: Record<string, string>;
  exclusions: string[];
  responsiveFrames: SharedDesignKernelRevision["responsiveFrames"];
  qualityProfile: SharedDesignKernelRevision["qualityProfile"];
}

function normalizeKernelPayload(value: unknown, label: string): KernelPayload {
  const payload = boundaryRecord(value, label);
  allowFields(payload, [
    "tokens",
    "typography",
    "sharedAssetRevisionIds",
    "brief",
    "terminology",
    "exclusions",
    "responsiveFrames",
    "qualityProfile",
  ], label);
  const tokenInput = boundaryRecord(payload.tokens, `${label} tokens`);
  const tokens: Record<string, string | number> = {};
  for (const key of sortedUtf8ObjectKeys(tokenInput, `${label} tokens`)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new WorkspaceStoreCodecError(`${label} tokens contain unsafe field ${key}`);
    }
    const token = tokenInput[key];
    if (typeof token !== "string" && (typeof token !== "number" || !Number.isFinite(token))) {
      throw new WorkspaceStoreCodecError(`${label} token ${key} must be a string or finite number`);
    }
    if (typeof token === "string" && !isWellFormedUtf16(token)) {
      throw new WorkspaceStoreCodecError(`${label} token ${key} must contain well-formed Unicode`);
    }
    tokens[key] = token;
  }
  const terminologyInput = boundaryRecord(payload.terminology, `${label} terminology`);
  const terminology: Record<string, string> = {};
  for (const key of sortedUtf8ObjectKeys(terminologyInput, `${label} terminology`)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new WorkspaceStoreCodecError(`${label} terminology contains unsafe field ${key}`);
    }
    terminology[key] = canonicalString(terminologyInput[key], `${label} terminology ${key}`);
  }
  const responsiveFrames = boundaryArray(payload.responsiveFrames, `${label} responsiveFrames`).map((entry, index) => {
    const frameLabel = `${label} responsive frame at index ${index}`;
    const frame = boundaryRecord(entry, frameLabel);
    allowFields(frame, ["id", "name", "width", "height", "initialState", "fixture", "background"], frameLabel);
    const width = positiveNumber(frame.width, `${frameLabel} width`);
    const height = positiveNumber(frame.height, `${frameLabel} height`);
    const initialState = Object.hasOwn(frame, "initialState")
      ? canonicalString(frame.initialState, `${frameLabel} initialState`)
      : undefined;
    const background = Object.hasOwn(frame, "background")
      ? canonicalString(frame.background, `${frameLabel} background`)
      : undefined;
    const fixture = Object.hasOwn(frame, "fixture")
      ? canonicalJsonObject(frame.fixture, `${frameLabel} fixture`)
      : undefined;
    return {
      id: canonicalString(frame.id, `${frameLabel} id`),
      name: canonicalString(frame.name, `${frameLabel} name`),
      width,
      height,
      ...(initialState === undefined ? {} : { initialState }),
      ...(fixture === undefined ? {} : { fixture }),
      ...(background === undefined ? {} : { background }),
    };
  });
  const frameIds = new Set<string>();
  for (const frame of responsiveFrames) {
    if (frameIds.has(frame.id)) throw new WorkspaceStoreCodecError(`duplicate Kernel responsive frame ${frame.id}`);
    frameIds.add(frame.id);
  }
  const quality = boundaryRecord(payload.qualityProfile, `${label} qualityProfile`);
  allowFields(quality, [
    "requiredFrameIds",
    "blockingSeverities",
    "requireRuntimeChecks",
    "requireVisualReview",
  ], `${label} qualityProfile`);
  const requiredFrameIds = canonicalStringArray(quality.requiredFrameIds, `${label} requiredFrameIds`);
  for (const frameId of requiredFrameIds) {
    if (!frameIds.has(frameId)) throw new WorkspaceStoreCodecError(`Kernel required frame ${frameId} does not exist`);
  }
  const blockingSeverities = canonicalStringArray(quality.blockingSeverities, `${label} blockingSeverities`);
  if (blockingSeverities.some((severity) => severity !== "P0" && severity !== "P1" && severity !== "P2")) {
    throw new WorkspaceStoreCodecError("Kernel blocking severity must be P0, P1, or P2");
  }
  if (typeof quality.requireRuntimeChecks !== "boolean" || typeof quality.requireVisualReview !== "boolean") {
    throw new WorkspaceStoreCodecError("Kernel quality flags must be booleans");
  }
  if (typeof payload.brief !== "string") throw new WorkspaceStoreCodecError("Kernel brief must be a string");
  if (!isWellFormedUtf16(payload.brief)) {
    throw new WorkspaceStoreCodecError("Kernel brief must contain well-formed Unicode");
  }
  const sharedAssetRevisionIds = canonicalStringArray(
    payload.sharedAssetRevisionIds,
    `${label} sharedAssetRevisionIds`,
  );
  if (new Set(sharedAssetRevisionIds).size !== sharedAssetRevisionIds.length) {
    throw new WorkspaceStoreCodecError("Kernel shared Asset Revision ids must be unique");
  }
  sharedAssetRevisionIds.sort(compareBinary);
  if (new Set(requiredFrameIds).size !== requiredFrameIds.length) {
    throw new WorkspaceStoreCodecError("Kernel required frame ids must be unique");
  }
  if (new Set(blockingSeverities).size !== blockingSeverities.length) {
    throw new WorkspaceStoreCodecError("Kernel blocking severities must be unique");
  }
  return {
    tokens,
    typography: canonicalJsonObject(payload.typography, `${label} typography`),
    sharedAssetRevisionIds,
    brief: payload.brief,
    terminology,
    exclusions: canonicalStringArray(payload.exclusions, `${label} exclusions`),
    responsiveFrames,
    qualityProfile: {
      requiredFrameIds,
      blockingSeverities: blockingSeverities as SharedDesignKernelRevision["qualityProfile"]["blockingSeverities"],
      requireRuntimeChecks: quality.requireRuntimeChecks,
      requireVisualReview: quality.requireVisualReview,
    },
  };
}

export function normalizeCreateKernelRevisionInput(value: unknown): CreateKernelRevisionInput {
  const input = boundaryRecord(value, "create Kernel Revision input");
  allowFields(input, [
    "workspaceId",
    "parentRevisionId",
    "tokens",
    "typography",
    "sharedAssetRevisionIds",
    "brief",
    "terminology",
    "exclusions",
    "responsiveFrames",
    "qualityProfile",
  ], "create Kernel Revision input");
  const payload = normalizeKernelPayload({
    tokens: input.tokens,
    typography: input.typography,
    sharedAssetRevisionIds: input.sharedAssetRevisionIds,
    brief: input.brief,
    terminology: input.terminology,
    exclusions: input.exclusions,
    responsiveFrames: input.responsiveFrames,
    qualityProfile: input.qualityProfile,
  }, "Kernel Revision payload");
  return {
    workspaceId: canonicalString(input.workspaceId, "Kernel Workspace id"),
    parentRevisionId: canonicalString(input.parentRevisionId, "parent Kernel Revision id"),
    ...payload,
  };
}

function normalizeExpectedId(value: unknown, label: string, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  return canonicalString(value, label);
}

export function normalizeArtifactPublicationExpectation(value: unknown): ArtifactPublicationExpectation {
  const expected = boundaryRecord(value, "Artifact publication expectation");
  allowFields(expected, ["expectedHeadRevisionId", "expectedSnapshotId"], "Artifact publication expectation");
  return {
    expectedHeadRevisionId: normalizeExpectedId(expected.expectedHeadRevisionId, "expected Artifact Head Revision id", true),
    expectedSnapshotId: canonicalString(expected.expectedSnapshotId, "expected active Snapshot id"),
  };
}

export function normalizeKernelPublicationExpectation(value: unknown): KernelPublicationExpectation {
  const expected = boundaryRecord(value, "Kernel publication expectation");
  allowFields(expected, ["expectedKernelRevisionId", "expectedSnapshotId"], "Kernel publication expectation");
  return {
    expectedKernelRevisionId: canonicalString(expected.expectedKernelRevisionId, "expected active Kernel Revision id"),
    expectedSnapshotId: canonicalString(expected.expectedSnapshotId, "expected active Snapshot id"),
  };
}

export function normalizeWorkspaceSnapshotPublicationInput(value: unknown): WorkspaceSnapshotPublicationInput {
  const input = boundaryRecord(value, "Workspace Snapshot publication input");
  allowFields(input, ["expectedSnapshotId", "reason", "provenance", "createdByRunId"], "Workspace Snapshot publication input");
  const createdByRunId = optionalNullableCanonicalString(input, "createdByRunId", "Workspace Snapshot creating Run id");
  return {
    expectedSnapshotId: canonicalString(input.expectedSnapshotId, "expected active Snapshot id"),
    reason: canonicalString(input.reason, "Workspace Snapshot reason"),
    provenance: asWorkspaceSnapshotProvenance(input.provenance),
    ...(createdByRunId === undefined ? {} : { createdByRunId }),
  };
}

function normalizeLegacyProjectFact(value: unknown, requireStandard: boolean): LegacyWorkspaceProjectFact {
  const input = boundaryRecord(value, "legacy Workspace Project fact");
  allowFields(input, [
    "id",
    "name",
    "mode",
    "skillId",
    "designSystemId",
    "sharingan",
    "sourceUrl",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "activeVariantId",
  ], "legacy Workspace Project fact");
  if (requireStandard
    ? input.mode !== "standard"
    : input.mode !== "standard" && input.mode !== "prototype") {
    throw new WorkspaceStoreCodecError("legacy Workspace Project mode is unsupported");
  }
  if (typeof input.sharingan !== "boolean") {
    throw new WorkspaceStoreCodecError("legacy Workspace Project sharingan must be boolean");
  }
  const mode: ProjectMode = input.mode === "standard" ? "standard" : "prototype";
  const legacyText = (text: unknown, label: string, allowBlank = false): string => {
    if (typeof text !== "string" || (!allowBlank && text.trim().length === 0) || !isWellFormedUtf16(text)) {
      throw new WorkspaceStoreCodecError(`${label} is invalid`);
    }
    return text;
  };
  const nullableLegacyText = (text: unknown, label: string): string | null => (
    text === null ? null : legacyText(text, label, true)
  );
  return {
    id: canonicalString(input.id, "legacy Workspace Project id"),
    name: legacyText(input.name, "legacy Workspace Project name", true),
    mode,
    skillId: nullableLegacyText(input.skillId, "legacy Workspace Project skill id"),
    designSystemId: nullableLegacyText(input.designSystemId, "legacy Workspace Project design system id"),
    sharingan: input.sharingan,
    sourceUrl: nullableLegacyText(input.sourceUrl, "legacy Workspace Project source URL"),
    createdAt: timestamp(input.createdAt, "legacy Workspace Project created_at"),
    updatedAt: timestamp(input.updatedAt, "legacy Workspace Project updated_at"),
    archivedAt: input.archivedAt === null
      ? null
      : timestamp(input.archivedAt, "legacy Workspace Project archived_at"),
    activeVariantId: nullableCanonicalString(input.activeVariantId, "legacy Workspace active Variant id"),
  };
}

function normalizeLegacyVariantFact(value: unknown, index: number): LegacyWorkspaceVariantFact {
  const label = `legacy Workspace Variant fact at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, ["id", "projectId", "name", "createdAt"], label);
  return {
    id: canonicalString(input.id, `${label} id`),
    projectId: canonicalString(input.projectId, `${label} Project id`),
    name: typeof input.name === "string" && isWellFormedUtf16(input.name)
      ? input.name
      : (() => { throw new WorkspaceStoreCodecError(`${label} name is invalid`); })(),
    createdAt: timestamp(input.createdAt, `${label} created_at`),
  };
}

function normalizeLegacyRunFact(value: unknown, index: number): LegacyWorkspaceRunFact & { gitSnapshot: LegacyWorkspaceSeed["successfulRuns"][number]["gitSnapshot"] } {
  const label = `legacy Workspace successful Run fact at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, [
    "id",
    "projectId",
    "variantId",
    "status",
    "commitHash",
    "createdAt",
    "finishedAt",
    "gitSnapshot",
  ], label);
  if (input.status !== "succeeded") throw new WorkspaceStoreCodecError(`${label} must be succeeded`);
  const commitHash = input.commitHash === null
    ? null
    : typeof input.commitHash === "string" && isWellFormedUtf16(input.commitHash)
      ? input.commitHash
      : (() => { throw new WorkspaceStoreCodecError(`${label} commit hash is invalid`); })();
  const snapshot = boundaryRecord(input.gitSnapshot, `${label} Git snapshot`);
  let gitSnapshot: LegacyWorkspaceSeed["successfulRuns"][number]["gitSnapshot"];
  if (snapshot.status === "unavailable") {
    allowFields(snapshot, ["status"], `${label} Git snapshot`);
    gitSnapshot = { status: "unavailable" };
  } else if (snapshot.status === "verified") {
    allowFields(snapshot, ["status", "sourceCommitHash", "sourceTreeHash", "artifactRoot"], `${label} Git snapshot`);
    const sourceCommitHash = exactStoredString(snapshot.sourceCommitHash, `${label} source commit hash`);
    const sourceTreeHash = exactStoredString(snapshot.sourceTreeHash, `${label} source tree hash`);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommitHash)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceTreeHash)
      || sourceCommitHash.length !== sourceTreeHash.length
      || commitHash === null
      || !/^[0-9a-f]{7,64}$/i.test(commitHash)
      || !sourceCommitHash.startsWith(commitHash.toLowerCase())
      || snapshot.artifactRoot !== ".") {
      throw new WorkspaceStoreCodecError(`${label} verified Git snapshot is not canonical`);
    }
    gitSnapshot = { status: "verified", sourceCommitHash, sourceTreeHash, artifactRoot: "." };
  } else {
    throw new WorkspaceStoreCodecError(`${label} Git snapshot status is unsupported`);
  }
  return {
    id: canonicalString(input.id, `${label} id`),
    projectId: canonicalString(input.projectId, `${label} Project id`),
    variantId: nullableCanonicalString(input.variantId, `${label} Variant id`),
    status: "succeeded",
    commitHash,
    createdAt: timestamp(input.createdAt, `${label} created_at`),
    finishedAt: input.finishedAt === null ? null : timestamp(input.finishedAt, `${label} finished_at`),
    gitSnapshot,
  };
}

export function normalizeLegacyWorkspaceSeed(value: unknown): LegacyWorkspaceSeed {
  const input = boundaryRecord(value, "legacy Workspace seed");
  allowFields(input, ["version", "project", "variants", "successfulRuns"], "legacy Workspace seed");
  if (input.version !== 1) throw new WorkspaceStoreCodecError("legacy Workspace seed version must be one");
  const project = normalizeLegacyProjectFact(input.project, true) as LegacyWorkspaceSeed["project"];
  const variants = boundaryArray(input.variants, "legacy Workspace Variants").map(normalizeLegacyVariantFact);
  const successfulRuns = boundaryArray(input.successfulRuns, "legacy Workspace successful Runs").map(normalizeLegacyRunFact);
  const variantIds = new Set<string>();
  for (const variant of variants) {
    if (variant.projectId !== project.id) throw new WorkspaceStoreCodecError("legacy Workspace Variant belongs to another Project");
    if (variantIds.has(variant.id)) throw new WorkspaceStoreCodecError(`duplicate legacy Workspace Variant ${variant.id}`);
    variantIds.add(variant.id);
  }
  const runIds = new Set<string>();
  for (const run of successfulRuns) {
    if (run.projectId !== project.id) throw new WorkspaceStoreCodecError("legacy Workspace Run belongs to another Project");
    if (runIds.has(run.id)) throw new WorkspaceStoreCodecError(`duplicate legacy Workspace Run ${run.id}`);
    runIds.add(run.id);
  }
  const byCreatedAtAndId = <T extends { createdAt: number; id: string }>(left: T, right: T): number => (
    left.createdAt - right.createdAt || compareBinary(left.id, right.id)
  );
  variants.sort(byCreatedAtAndId);
  successfulRuns.sort(byCreatedAtAndId);
  return { version: 1, project, variants, successfulRuns };
}

function allowFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new WorkspaceStoreCodecError(`unexpected field ${field} in ${label}`);
  }
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-empty string`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} must contain well-formed Unicode`);
  }
  return value.trim();
}

function exactStoredString(value: unknown, label: string): string {
  const result = canonicalString(value, label);
  if (result !== value) throw new WorkspaceStoreCodecError(`${label} must be canonical`);
  return result;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be a finite number`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new WorkspaceStoreCodecError(`${label} must be positive`);
  return result;
}

export function normalizeWorkspaceGraphMutationInput(value: unknown): WorkspaceGraphMutationInput {
  const input = boundaryRecord(value, "workspace graph mutation input");
  allowFields(input, ["baseGraphRevision", "expectedSnapshotId", "commands"], "workspace graph mutation input");
  if (typeof input.baseGraphRevision !== "number"
    || !Number.isSafeInteger(input.baseGraphRevision)
    || input.baseGraphRevision < 0) {
    throw new WorkspaceStoreCodecError("baseGraphRevision must be a non-negative safe integer");
  }
  return {
    baseGraphRevision: input.baseGraphRevision,
    expectedSnapshotId: canonicalString(input.expectedSnapshotId, "expectedSnapshotId"),
    commands: normalizeWorkspaceGraphCommands(input.commands),
  };
}

function normalizeLayoutCommand(value: unknown, index: number): WorkspaceLayoutCommand {
  const command = boundaryRecord(value, `layout command at index ${index}`);
  const type = canonicalString(command.type, "layout command type");
  switch (type) {
    case "add-group": {
      allowFields(command, ["type", "groupId", "label", "bounds"], "add-group layout command");
      const bounds = boundaryRecord(command.bounds, "layout group bounds");
      allowFields(bounds, ["x", "y", "width", "height"], "layout group bounds");
      return {
        type,
        groupId: canonicalString(command.groupId, "layout group id"),
        label: canonicalString(command.label, "layout group label"),
        bounds: {
          x: finiteNumber(bounds.x, "layout group x"),
          y: finiteNumber(bounds.y, "layout group y"),
          width: positiveNumber(bounds.width, "layout group width"),
          height: positiveNumber(bounds.height, "layout group height"),
        },
      };
    }
    case "rename-group":
      allowFields(command, ["type", "groupId", "label"], "rename-group layout command");
      return {
        type,
        groupId: canonicalString(command.groupId, "layout group id"),
        label: canonicalString(command.label, "layout group label"),
      };
    case "delete-group":
      allowFields(command, ["type", "groupId", "ungroupChildren"], "delete-group layout command");
      if (command.ungroupChildren !== true) {
        throw new WorkspaceStoreCodecError("delete-group requires ungroupChildren: true");
      }
      return { type, groupId: canonicalString(command.groupId, "layout group id"), ungroupChildren: true };
    case "set-parent": {
      allowFields(command, ["type", "objectId", "parentGroupId"], "set-parent layout command");
      const parentGroupId = command.parentGroupId === null
        ? null
        : canonicalString(command.parentGroupId, "layout parent group id");
      return { type, objectId: canonicalString(command.objectId, "layout object id"), parentGroupId };
    }
    case "move":
      allowFields(command, ["type", "objectId", "x", "y"], "move layout command");
      return {
        type,
        objectId: canonicalString(command.objectId, "layout object id"),
        x: finiteNumber(command.x, "layout object x"),
        y: finiteNumber(command.y, "layout object y"),
      };
    case "resize-group":
      allowFields(command, ["type", "groupId", "width", "height"], "resize-group layout command");
      return {
        type,
        groupId: canonicalString(command.groupId, "layout group id"),
        width: positiveNumber(command.width, "layout group width"),
        height: positiveNumber(command.height, "layout group height"),
      };
    case "set-collapsed":
      allowFields(command, ["type", "groupId", "collapsed"], "set-collapsed layout command");
      if (typeof command.collapsed !== "boolean") {
        throw new WorkspaceStoreCodecError("layout collapsed must be a boolean");
      }
      return {
        type,
        groupId: canonicalString(command.groupId, "layout group id"),
        collapsed: command.collapsed,
      };
    case "set-viewport": {
      allowFields(command, ["type", "viewport"], "set-viewport layout command");
      const viewport = boundaryRecord(command.viewport, "workspace viewport");
      allowFields(viewport, ["x", "y", "zoom"], "workspace viewport");
      return {
        type,
        viewport: {
          x: finiteNumber(viewport.x, "workspace viewport x"),
          y: finiteNumber(viewport.y, "workspace viewport y"),
          zoom: positiveNumber(viewport.zoom, "workspace viewport zoom"),
        },
      };
    }
    default:
      throw new WorkspaceStoreCodecError(`unsupported layout command type ${type}`);
  }
}

export function normalizeWorkspaceLayoutCommands(value: unknown, label = "workspace layout commands"): WorkspaceLayoutCommand[] {
  const commandInputs = boundaryArray(value, label);
  const commands = commandInputs.map((command, index) => normalizeLayoutCommand(command, index));
  const addedGroups = new Set<string>();
  for (const command of commands) {
    if (command.type !== "add-group") continue;
    if (addedGroups.has(command.groupId)) {
      throw new WorkspaceStoreCodecError(`duplicate layout group id ${command.groupId}`);
    }
    addedGroups.add(command.groupId);
  }
  return commands;
}

export function normalizeWorkspaceLayoutPatch(value: unknown): WorkspaceLayoutPatch & { layoutId: string } {
  const input = boundaryRecord(value, "workspace layout patch");
  allowFields(input, ["layoutId", "graphRevision", "baseLayoutChecksum", "commands"], "workspace layout patch");
  if (typeof input.graphRevision !== "number" || !Number.isSafeInteger(input.graphRevision) || input.graphRevision < 0) {
    throw new WorkspaceStoreCodecError("layout graphRevision must be a non-negative safe integer");
  }
  const commands = normalizeWorkspaceLayoutCommands(input.commands);
  if (commands.length === 0) {
    throw new WorkspaceStoreCodecError("workspace layout patch must contain at least one command");
  }
  return {
    layoutId: input.layoutId === undefined ? "default" : canonicalString(input.layoutId, "layout id"),
    graphRevision: input.graphRevision,
    baseLayoutChecksum: canonicalString(input.baseLayoutChecksum, "base layout checksum"),
    commands,
  };
}

export function normalizeWorkspaceLayoutId(value: unknown): string {
  return canonicalString(value, "layout id");
}

function uniqueCanonicalStrings(value: unknown, label: string): string[] {
  const result = canonicalStringArray(value, label);
  if (new Set(result).size !== result.length) {
    throw new WorkspaceStoreCodecError(`${label} must be unique`);
  }
  return result;
}

function normalizeProposalGraphCommands(value: unknown): WorkspaceGraphCommand[] {
  const commands = boundaryArray(value, "Workspace Proposal graph operations");
  return commands.length === 0 ? [] : normalizeWorkspaceGraphCommands(commands);
}

function normalizeResourceRevisionPolicy(value: unknown, label: string): WorkspaceGenerationResourceOperation["revisionPolicy"] {
  const policy = boundaryRecord(value, label);
  const kind = canonicalString(policy.kind, `${label} kind`);
  if (kind === "exact") {
    allowFields(policy, ["kind", "resourceRevisionId"], label);
    return { kind, resourceRevisionId: canonicalString(policy.resourceRevisionId, `${label} Resource Revision id`) };
  }
  if (kind === "base-snapshot" || kind === "generate") {
    allowFields(policy, ["kind"], label);
    return { kind };
  }
  throw new WorkspaceStoreCodecError(`${label} kind is unsupported`);
}

function normalizeGenerationResourceOperation(value: unknown, index: number): WorkspaceGenerationResourceOperation {
  const label = `Workspace generation Resource operation at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, ["operation", "nodeId", "resourceId", "kind", "title", "revisionPolicy"], label);
  if (input.operation !== "create" && input.operation !== "revise" && input.operation !== "reuse") {
    throw new WorkspaceStoreCodecError(`${label} operation is unsupported`);
  }
  if (input.kind !== "research" && input.kind !== "moodboard" && input.kind !== "sharingan-capture"
    && input.kind !== "file" && input.kind !== "asset" && input.kind !== "effect"
    && input.kind !== "external-reference") {
    throw new WorkspaceStoreCodecError(`${label} Resource kind is unsupported`);
  }
  return {
    operation: input.operation,
    nodeId: canonicalString(input.nodeId, `${label} node id`),
    resourceId: canonicalString(input.resourceId, `${label} Resource id`),
    kind: input.kind,
    title: canonicalString(input.title, `${label} title`),
    revisionPolicy: normalizeResourceRevisionPolicy(input.revisionPolicy, `${label} revision policy`),
  };
}

function normalizeGenerationArtifactPlan(value: unknown, index: number): WorkspaceGenerationArtifactPlan {
  const label = `Workspace generation Artifact plan at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, [
    "operation", "nodeId", "artifactId", "kind", "name", "trackId", "baseRevisionId",
    "dependsOnArtifactIds", "capabilityIds", "responsiveFrameIds",
  ], label);
  if (input.operation !== "create" && input.operation !== "revise") {
    throw new WorkspaceStoreCodecError(`${label} operation is unsupported`);
  }
  if (input.kind !== "page" && input.kind !== "component") {
    throw new WorkspaceStoreCodecError(`${label} Artifact kind is unsupported`);
  }
  return {
    operation: input.operation,
    nodeId: canonicalString(input.nodeId, `${label} node id`),
    artifactId: canonicalString(input.artifactId, `${label} Artifact id`),
    kind: input.kind,
    name: canonicalString(input.name, `${label} name`),
    trackId: canonicalString(input.trackId, `${label} Track id`),
    baseRevisionId: nullableCanonicalString(input.baseRevisionId, `${label} base Revision id`),
    dependsOnArtifactIds: uniqueCanonicalStrings(input.dependsOnArtifactIds, `${label} dependency Artifact ids`),
    capabilityIds: uniqueCanonicalStrings(input.capabilityIds, `${label} capability ids`),
    responsiveFrameIds: uniqueCanonicalStrings(input.responsiveFrameIds, `${label} responsive frame ids`),
  };
}

function normalizeGenerationDependencyPlan(value: unknown, index: number): WorkspaceGenerationDependencyPlan {
  const label = `Workspace generation dependency plan at index ${index}`;
  const input = boundaryRecord(value, label);
  const kind = canonicalString(input.kind, `${label} kind`);
  if (kind === "resource") {
    allowFields(input, ["kind", "ownerArtifactId", "resourceId"], label);
    return {
      kind,
      ownerArtifactId: canonicalString(input.ownerArtifactId, `${label} owner Artifact id`),
      resourceId: canonicalString(input.resourceId, `${label} Resource id`),
    };
  }
  if (kind !== "component-instance") {
    throw new WorkspaceStoreCodecError(`${label} kind is unsupported`);
  }
  allowFields(input, [
    "kind", "ownerArtifactId", "instanceId", "componentArtifactId", "componentRevisionId",
    "variantKey", "stateKey", "sourceLocator", "overrides", "status",
  ], label);
  if (input.status !== "linked" && input.status !== "detached") {
    throw new WorkspaceStoreCodecError(`${label} status must be linked or detached`);
  }
  const variantKey = optionalNullableCanonicalString(input, "variantKey", `${label} variant key`);
  const stateKey = optionalNullableCanonicalString(input, "stateKey", `${label} state key`);
  return {
    kind,
    ownerArtifactId: canonicalString(input.ownerArtifactId, `${label} owner Artifact id`),
    instanceId: canonicalString(input.instanceId, `${label} instance id`),
    componentArtifactId: canonicalString(input.componentArtifactId, `${label} Component Artifact id`),
    componentRevisionId: nullableCanonicalString(input.componentRevisionId, `${label} Component Revision id`),
    ...(variantKey == null ? {} : { variantKey }),
    ...(stateKey == null ? {} : { stateKey }),
    sourceLocator: normalizeDesignNodeLocatorInput(input.sourceLocator, `${label} source locator`),
    overrides: canonicalJsonObject(input.overrides, `${label} overrides`),
    status: input.status,
  };
}

function normalizePrototypeTransition(value: unknown, label: string): WorkspaceGenerationPrototypeIntent["transition"] {
  const transition = boundaryRecord(value, label);
  allowFields(transition, ["type", "durationMs", "easing"], label);
  if (transition.type !== "none" && transition.type !== "fade" && transition.type !== "slide") {
    throw new WorkspaceStoreCodecError(`${label} type is unsupported`);
  }
  const durationMs = Object.hasOwn(transition, "durationMs")
    ? nonNegativeInteger(transition.durationMs, `${label} duration`)
    : undefined;
  const easing = Object.hasOwn(transition, "easing")
    ? canonicalString(transition.easing, `${label} easing`)
    : undefined;
  return {
    type: transition.type,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(easing === undefined ? {} : { easing }),
  };
}

function normalizeGenerationPrototypeIntent(value: unknown, index: number): WorkspaceGenerationPrototypeIntent {
  const label = `Workspace generation prototype intent at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, [
    "edgeId", "sourceArtifactId", "targetArtifactId", "sourceLocator", "trigger", "targetState", "transition",
  ], label);
  if (input.trigger !== "click" && input.trigger !== "submit") {
    throw new WorkspaceStoreCodecError(`${label} trigger is unsupported`);
  }
  const sourceLocator = Object.hasOwn(input, "sourceLocator")
    ? normalizeDesignNodeLocatorInput(input.sourceLocator, `${label} source locator`)
    : undefined;
  const targetState = Object.hasOwn(input, "targetState")
    ? canonicalString(input.targetState, `${label} target state`)
    : undefined;
  const transition = Object.hasOwn(input, "transition")
    ? normalizePrototypeTransition(input.transition, `${label} transition`)
    : undefined;
  return {
    edgeId: canonicalString(input.edgeId, `${label} edge id`),
    sourceArtifactId: canonicalString(input.sourceArtifactId, `${label} source Artifact id`),
    targetArtifactId: canonicalString(input.targetArtifactId, `${label} target Artifact id`),
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
    trigger: input.trigger,
    ...(targetState === undefined ? {} : { targetState }),
    ...(transition === undefined ? {} : { transition }),
  };
}

function normalizeGenerationCapability(value: unknown, index: number): WorkspaceGenerationCapability {
  const label = `Workspace generation capability at index ${index}`;
  const input = boundaryRecord(value, label);
  allowFields(input, ["id", "kind", "required"], label);
  if (input.kind !== "text" && input.kind !== "image" && input.kind !== "video"
    && input.kind !== "browser" && input.kind !== "visual-qa") {
    throw new WorkspaceStoreCodecError(`${label} kind is unsupported`);
  }
  if (typeof input.required !== "boolean") throw new WorkspaceStoreCodecError(`${label} required must be boolean`);
  return { id: canonicalString(input.id, `${label} id`), kind: input.kind, required: input.required };
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new WorkspaceStoreCodecError(`duplicate ${label} ${id}`);
    seen.add(id);
  }
}

function normalizeWorkspaceGenerationPayload(value: unknown): WorkspaceGenerationPayload {
  const label = "Workspace generation payload";
  const input = boundaryRecord(value, label);
  allowFields(input, [
    "kind", "resourceOperations", "artifactPlans", "dependencyPlans", "prototypeIntents",
    "capabilities", "responsiveFrames", "qualityProfile",
  ], label);
  if (input.kind !== "workspace-generation") {
    throw new WorkspaceStoreCodecError("Workspace generation payload kind must be workspace-generation");
  }
  const resourceOperations = boundaryArray(input.resourceOperations, `${label} Resource operations`)
    .map(normalizeGenerationResourceOperation);
  const artifactPlans = boundaryArray(input.artifactPlans, `${label} Artifact plans`)
    .map(normalizeGenerationArtifactPlan);
  const dependencyPlans = boundaryArray(input.dependencyPlans, `${label} dependency plans`)
    .map(normalizeGenerationDependencyPlan);
  const prototypeIntents = boundaryArray(input.prototypeIntents, `${label} prototype intents`)
    .map(normalizeGenerationPrototypeIntent);
  const capabilities = boundaryArray(input.capabilities, `${label} capabilities`)
    .map(normalizeGenerationCapability);
  uniqueBy(resourceOperations, (operation) => operation.resourceId, "Workspace generation Resource");
  uniqueBy(artifactPlans, (plan) => plan.artifactId, "Workspace generation Artifact");
  uniqueBy(prototypeIntents, (intent) => intent.edgeId, "Workspace generation prototype edge");
  uniqueBy(capabilities, (capability) => capability.id, "Workspace generation capability");
  const kernelShape = normalizeKernelPayload({
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "",
    terminology: {},
    exclusions: [],
    responsiveFrames: input.responsiveFrames,
    qualityProfile: input.qualityProfile,
  }, label);
  return {
    kind: input.kind,
    resourceOperations,
    artifactPlans,
    dependencyPlans,
    prototypeIntents,
    capabilities,
    responsiveFrames: kernelShape.responsiveFrames,
    qualityProfile: kernelShape.qualityProfile,
  };
}

function normalizeComponentPropagationPayload(value: unknown): ComponentPropagationProposalPayload {
  const label = "Component propagation Proposal payload";
  const input = boundaryRecord(value, label);
  allowFields(input, [
    "kind", "impactAnalysisId", "componentArtifactId", "fromRevisionId", "toRevisionId",
    "selectedInstanceIds", "overrideResolutions", "requiredQaFrameIds",
  ], label);
  if (input.kind !== "component-propagation") {
    throw new WorkspaceStoreCodecError(`${label} kind must be component-propagation`);
  }
  const overrideResolutions = boundaryArray(input.overrideResolutions, `${label} override resolutions`)
    .map<ComponentPropagationOverrideResolution>((value, index) => {
    const resolutionLabel = `${label} override resolution at index ${index}`;
    const resolution = boundaryRecord(value, resolutionLabel);
    allowFields(resolution, ["instanceId", "resolution", "overrides"], resolutionLabel);
    if (resolution.resolution !== "preserve" && resolution.resolution !== "accept-component"
      && resolution.resolution !== "manual") {
      throw new WorkspaceStoreCodecError(`${resolutionLabel} resolution is unsupported`);
    }
      return {
        instanceId: canonicalString(resolution.instanceId, `${resolutionLabel} instance id`),
        resolution: resolution.resolution,
        overrides: canonicalJsonObject(resolution.overrides, `${resolutionLabel} overrides`),
      };
    });
  uniqueBy(overrideResolutions, (resolution) => resolution.instanceId, "Component propagation override instance");
  return {
    kind: input.kind,
    impactAnalysisId: canonicalString(input.impactAnalysisId, `${label} Impact Analysis id`),
    componentArtifactId: canonicalString(input.componentArtifactId, `${label} Component Artifact id`),
    fromRevisionId: canonicalString(input.fromRevisionId, `${label} from Revision id`),
    toRevisionId: canonicalString(input.toRevisionId, `${label} to Revision id`),
    selectedInstanceIds: uniqueCanonicalStrings(input.selectedInstanceIds, `${label} selected instance ids`),
    overrideResolutions,
    requiredQaFrameIds: uniqueCanonicalStrings(input.requiredQaFrameIds, `${label} required QA frame ids`),
  };
}

export function normalizeWorkspaceProposalGeneration(value: unknown): WorkspaceProposalGeneration {
  const input = boundaryRecord(value, "Workspace Proposal generation payload");
  return input.kind === "workspace-generation"
    ? normalizeWorkspaceGenerationPayload(input)
    : normalizeComponentPropagationPayload(input);
}

export function normalizeCreateWorkspaceProposalInput(value: unknown): CreateWorkspaceProposalInput & { layoutId: string; layoutOperations: WorkspaceLayoutCommand[]; createdByRunId: string | null } {
  const input = boundaryRecord(value, "create Workspace Proposal input");
  allowFields(input, [
    "projectId", "kind", "baseGraphRevision", "baseSnapshotId", "layoutId", "baseLayoutChecksum",
    "operations", "layoutOperations", "generation", "rationale", "assumptions", "createdByRunId",
  ], "create Workspace Proposal input");
  if (input.kind !== "workspace-generation" && input.kind !== "component-propagation") {
    throw new WorkspaceStoreCodecError("Workspace Proposal kind is unsupported");
  }
  const generation = normalizeWorkspaceProposalGeneration(input.generation);
  if (generation.kind !== input.kind) throw new WorkspaceStoreCodecError("Workspace Proposal kind does not match generation payload");
  const baseGraphRevision = nonNegativeInteger(input.baseGraphRevision, "Workspace Proposal base graph revision");
  const createdByRunId = Object.hasOwn(input, "createdByRunId")
    ? nullableCanonicalString(input.createdByRunId, "Workspace Proposal creating Run id")
    : null;
  return {
    projectId: canonicalString(input.projectId, "Workspace Proposal Project id"),
    kind: input.kind,
    baseGraphRevision,
    baseSnapshotId: canonicalString(input.baseSnapshotId, "Workspace Proposal base Snapshot id"),
    layoutId: input.layoutId === undefined ? "default" : canonicalString(input.layoutId, "Workspace Proposal layout id"),
    baseLayoutChecksum: canonicalString(input.baseLayoutChecksum, "Workspace Proposal base layout checksum"),
    operations: normalizeProposalGraphCommands(input.operations),
    layoutOperations: input.layoutOperations === undefined
      ? []
      : normalizeWorkspaceLayoutCommands(input.layoutOperations, "Workspace Proposal layout operations"),
    generation,
    rationale: canonicalString(input.rationale, "Workspace Proposal rationale"),
    assumptions: canonicalStringArray(input.assumptions, "Workspace Proposal assumptions"),
    createdByRunId,
  };
}

export function normalizeUpdateWorkspaceProposalInput(value: unknown): UpdateWorkspaceProposalInput {
  const input = boundaryRecord(value, "update Workspace Proposal input");
  allowFields(input, [
    "expectedProposalRevision", "operations", "layoutOperations", "generation", "rationale", "assumptions",
  ], "update Workspace Proposal input");
  return {
    expectedProposalRevision: positiveInteger(input.expectedProposalRevision, "expected Workspace Proposal revision"),
    operations: normalizeProposalGraphCommands(input.operations),
    layoutOperations: normalizeWorkspaceLayoutCommands(input.layoutOperations, "Workspace Proposal layout operations"),
    generation: normalizeWorkspaceProposalGeneration(input.generation),
    rationale: canonicalString(input.rationale, "Workspace Proposal rationale"),
    assumptions: canonicalStringArray(input.assumptions, "Workspace Proposal assumptions"),
  };
}

export function normalizeWorkspaceProposalApprovalMode(value: unknown): "structure-only" | "generate" {
  if (value !== "structure-only" && value !== "generate") {
    throw new WorkspaceStoreCodecError("Workspace Proposal approval mode must be structure-only or generate");
  }
  return value;
}

export function workspaceLayoutChecksum(layout: Omit<WorkspaceLayout, "checksum">): string {
  return createHash("sha256").update(`workspace-layout-v1\0${JSON.stringify(layout)}`).digest("hex");
}

export function asWorkspaceLayoutValue(value: unknown): WorkspaceLayout {
  const layout = boundaryRecord(value, "Workspace layout");
  allowFields(layout, ["workspaceId", "layoutId", "objects", "viewport", "checksum"], "Workspace layout");
  const objects = boundaryArray(layout.objects, "Workspace layout objects").map((value, index) => {
    const label = `Workspace layout object at index ${index}`;
    const object = boundaryRecord(value, label);
    const id = exactStoredString(object.id, `${label} id`);
    const x = finiteNumber(object.x, `${label} x`);
    const y = finiteNumber(object.y, `${label} y`);
    const parentGroupId = object.parentGroupId === null
      ? null
      : exactStoredString(object.parentGroupId, `${label} parent group id`);
    if (object.kind === "node") {
      allowFields(object, ["id", "kind", "x", "y", "parentGroupId"], label);
      return { id, kind: "node" as const, x, y, parentGroupId };
    }
    if (object.kind !== "group") throw new WorkspaceStoreCodecError(`${label} kind is unsupported`);
    allowFields(object, [
      "id", "kind", "x", "y", "width", "height", "parentGroupId", "label", "collapsed",
    ], label);
    if (typeof object.collapsed !== "boolean") throw new WorkspaceStoreCodecError(`${label} collapsed must be boolean`);
    return {
      id,
      kind: "group" as const,
      x,
      y,
      width: positiveNumber(object.width, `${label} width`),
      height: positiveNumber(object.height, `${label} height`),
      parentGroupId,
      label: exactStoredString(object.label, `${label} label`),
      collapsed: object.collapsed,
    };
  });
  const viewportInput = boundaryRecord(layout.viewport, "Workspace layout viewport");
  allowFields(viewportInput, ["x", "y", "zoom"], "Workspace layout viewport");
  const withoutChecksum = {
    workspaceId: exactStoredString(layout.workspaceId, "Workspace layout Workspace id"),
    layoutId: exactStoredString(layout.layoutId, "Workspace layout id"),
    objects,
    viewport: {
      x: finiteNumber(viewportInput.x, "Workspace layout viewport x"),
      y: finiteNumber(viewportInput.y, "Workspace layout viewport y"),
      zoom: positiveNumber(viewportInput.zoom, "Workspace layout viewport zoom"),
    },
  };
  const storedChecksum = exactStoredString(layout.checksum, "Workspace layout checksum");
  if (workspaceLayoutChecksum(withoutChecksum) !== storedChecksum) {
    throw new WorkspaceStoreCodecError("Workspace layout checksum does not match its immutable payload");
  }
  return { ...withoutChecksum, checksum: storedChecksum };
}

function asWorkspaceProposalReview(value: unknown): WorkspaceProposalReview {
  const review = boundaryRecord(value, "Workspace Proposal review");
  const kind = exactStoredString(review.kind, "Workspace Proposal review kind");
  if (kind === "none" || kind === "rejected") {
    allowFields(review, ["kind"], "Workspace Proposal review");
    return { kind };
  }
  if (kind === "approved") {
    allowFields(review, ["kind", "mode"], "Workspace Proposal review");
    return { kind, mode: normalizeWorkspaceProposalApprovalMode(review.mode) };
  }
  if (kind !== "conflict") throw new WorkspaceStoreCodecError("Workspace Proposal review kind is unsupported");
  allowFields(review, [
    "kind", "expectedGraphRevision", "actualGraphRevision", "expectedSnapshotId", "actualSnapshotId",
    "expectedLayoutChecksum", "actualLayoutChecksum", "graphChanged", "snapshotChanged", "layoutChanged",
  ], "Workspace Proposal conflict review");
  if (typeof review.graphChanged !== "boolean" || typeof review.snapshotChanged !== "boolean"
    || typeof review.layoutChanged !== "boolean") {
    throw new WorkspaceStoreCodecError("Workspace Proposal conflict flags must be boolean");
  }
  return {
    kind,
    expectedGraphRevision: nonNegativeInteger(review.expectedGraphRevision, "Workspace Proposal expected graph revision"),
    actualGraphRevision: nonNegativeInteger(review.actualGraphRevision, "Workspace Proposal actual graph revision"),
    expectedSnapshotId: exactStoredString(review.expectedSnapshotId, "Workspace Proposal expected Snapshot id"),
    actualSnapshotId: exactStoredString(review.actualSnapshotId, "Workspace Proposal actual Snapshot id"),
    expectedLayoutChecksum: exactStoredString(review.expectedLayoutChecksum, "Workspace Proposal expected layout checksum"),
    actualLayoutChecksum: exactStoredString(review.actualLayoutChecksum, "Workspace Proposal actual layout checksum"),
    graphChanged: review.graphChanged,
    snapshotChanged: review.snapshotChanged,
    layoutChanged: review.layoutChanged,
  };
}

export function asWorkspaceProposalValue(value: unknown): WorkspaceProposalRecord {
  const input = boundaryRecord(value, "Workspace Proposal");
  allowFields(input, [
    "id", "workspaceId", "revision", "kind", "baseGraphRevision", "baseSnapshotId", "baseGraph",
    "layoutId", "baseLayoutChecksum", "baseLayout", "status", "operations", "layoutOperations",
    "rationale", "assumptions", "generation", "review", "createdByRunId", "createdAt", "updatedAt",
  ], "Workspace Proposal");
  if (input.kind !== "workspace-generation" && input.kind !== "component-propagation") {
    throw new WorkspaceStoreCodecError("Workspace Proposal kind is unsupported");
  }
  if (input.status !== "draft" && input.status !== "approved" && input.status !== "rejected"
    && input.status !== "superseded" && input.status !== "conflicted") {
    throw new WorkspaceStoreCodecError("Workspace Proposal status is unsupported");
  }
  const baseGraph = canonicalJsonValue(input.baseGraph, "Workspace Proposal base graph") as unknown;
  validateWorkspaceGraph(baseGraph);
  const baseLayout = asWorkspaceLayoutValue(input.baseLayout);
  const generation = normalizeWorkspaceProposalGeneration(input.generation);
  if (generation.kind !== input.kind) throw new WorkspaceStoreCodecError("Workspace Proposal kind does not match generation payload");
  const proposal: WorkspaceProposalRecord = {
    id: exactStoredString(input.id, "Workspace Proposal id"),
    workspaceId: exactStoredString(input.workspaceId, "Workspace Proposal Workspace id"),
    revision: positiveInteger(input.revision, "Workspace Proposal revision"),
    kind: input.kind,
    baseGraphRevision: nonNegativeInteger(input.baseGraphRevision, "Workspace Proposal base graph revision"),
    baseSnapshotId: exactStoredString(input.baseSnapshotId, "Workspace Proposal base Snapshot id"),
    baseGraph,
    layoutId: exactStoredString(input.layoutId, "Workspace Proposal layout id"),
    baseLayoutChecksum: exactStoredString(input.baseLayoutChecksum, "Workspace Proposal base layout checksum"),
    baseLayout,
    status: input.status,
    operations: normalizeProposalGraphCommands(input.operations),
    layoutOperations: normalizeWorkspaceLayoutCommands(input.layoutOperations, "Workspace Proposal layout operations"),
    rationale: exactStoredString(input.rationale, "Workspace Proposal rationale"),
    assumptions: boundaryArray(input.assumptions, "Workspace Proposal assumptions")
      .map((assumption) => exactStoredString(assumption, "Workspace Proposal assumption")),
    generation,
    review: asWorkspaceProposalReview(input.review),
    createdByRunId: input.createdByRunId === null
      ? null
      : exactStoredString(input.createdByRunId, "Workspace Proposal creating Run id"),
    createdAt: timestamp(input.createdAt, "Workspace Proposal created_at"),
    updatedAt: timestamp(input.updatedAt, "Workspace Proposal updated_at"),
  };
  if (proposal.baseGraph.workspaceId !== proposal.workspaceId
    || proposal.baseGraph.revision !== proposal.baseGraphRevision
    || proposal.baseLayout.workspaceId !== proposal.workspaceId
    || proposal.baseLayout.layoutId !== proposal.layoutId
    || proposal.baseLayout.checksum !== proposal.baseLayoutChecksum) {
    throw new WorkspaceStoreCodecError("Workspace Proposal immutable base state is inconsistent");
  }
  return proposal;
}

export function asWorkspaceProposal(
  row: Row,
  baseGraph: WorkspaceGraph,
  baseLayout: WorkspaceLayout,
): WorkspaceProposalRecord {
  return asWorkspaceProposalValue({
    id: row.id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    kind: row.kind,
    baseGraphRevision: row.base_graph_revision,
    baseSnapshotId: row.base_snapshot_id,
    baseGraph,
    layoutId: row.layout_id,
    baseLayoutChecksum: row.base_layout_checksum,
    baseLayout,
    status: row.status,
    operations: parseJson(row.operations_json, "Workspace Proposal operations"),
    layoutOperations: parseJson(row.layout_operations_json, "Workspace Proposal layout operations"),
    rationale: row.rationale,
    assumptions: parseJson(row.assumptions_json, "Workspace Proposal assumptions"),
    generation: parseJson(row.generation_payload_json, "Workspace Proposal generation payload"),
    review: parseJson(row.review_json, "Workspace Proposal review"),
    createdByRunId: row.created_by_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function asWorkspaceProposalAudit(row: Row): WorkspaceProposalRecord {
  const proposal = asWorkspaceProposalValue(parseJson(row.payload_json, "Workspace Proposal audit payload"));
  const proposalId = requiredString(row.proposal_id, "Workspace Proposal audit Proposal id");
  const revision = positiveInteger(row.revision, "Workspace Proposal audit revision");
  const createdAt = timestamp(row.created_at, "Workspace Proposal audit created_at");
  if (proposal.id !== proposalId) {
    throw new WorkspaceStoreCodecError("Workspace Proposal audit row Proposal id does not match its payload");
  }
  if (proposal.revision !== revision) {
    throw new WorkspaceStoreCodecError("Workspace Proposal audit row revision does not match its payload");
  }
  if (proposal.updatedAt !== createdAt) {
    throw new WorkspaceStoreCodecError("Workspace Proposal audit row created_at does not match its payload");
  }
  if (proposal.status !== "draft" || proposal.review.kind !== "none") {
    throw new WorkspaceStoreCodecError("Workspace Proposal audit payload must capture an unreviewed draft revision");
  }
  return proposal;
}

export function asGenerationPlan(row: Row): GenerationPlanRecord {
  if (row.status !== "approved" && row.status !== "queued" && row.status !== "running"
    && row.status !== "succeeded" && row.status !== "failed" && row.status !== "compile-failed"
    && row.status !== "requires-new-impact" && row.status !== "cancelled") {
    throw new WorkspaceStoreCodecError("Generation Plan status is unsupported");
  }
  return {
    id: requiredString(row.id, "Generation Plan id"),
    workspaceId: requiredString(row.workspace_id, "Generation Plan Workspace id"),
    proposalId: requiredString(row.proposal_id, "Generation Plan Proposal id"),
    proposalRevision: positiveInteger(row.proposal_revision, "Generation Plan Proposal revision"),
    baseSnapshotId: requiredString(row.base_snapshot_id, "Generation Plan base Snapshot id"),
    status: row.status,
    compileError: row.compile_error_json == null
      ? null
      : jsonObject(row.compile_error_json, "Generation Plan compile error"),
    createdAt: timestamp(row.created_at, "Generation Plan created_at"),
    finishedAt: row.finished_at == null ? null : timestamp(row.finished_at, "Generation Plan finished_at"),
  };
}

function optionalStoredString(value: Record<string, unknown>, field: string, label: string): string | undefined {
  return Object.hasOwn(value, field) ? exactStoredString(value[field], label) : undefined;
}

export function asWorkspaceSnapshotProvenance(value: unknown): WorkspaceSnapshotProvenance {
  const provenance = boundaryRecord(value, "Workspace Snapshot provenance");
  const kind = exactStoredString(provenance.kind, "Workspace Snapshot provenance kind");
  const optional = (field: string) => optionalStoredString(provenance, field, `Workspace Snapshot provenance ${field}`);
  switch (kind) {
    case "workspace-created":
      allowFields(provenance, ["kind"], "workspace-created provenance");
      return { kind };
    case "graph-command": {
      allowFields(provenance, ["kind", "commandIds"], "graph-command provenance");
      const values = boundaryArray(provenance.commandIds, "graph-command provenance commandIds");
      if (values.length === 0) throw new WorkspaceStoreCodecError("graph-command provenance requires commandIds");
      const commandIds = values.map((commandId) => exactStoredString(commandId, "graph-command provenance command id"));
      if (new Set(commandIds).size !== commandIds.length) {
        throw new WorkspaceStoreCodecError("graph-command provenance commandIds must be unique");
      }
      return { kind, commandIds };
    }
    case "proposal-approval": {
      allowFields(provenance, ["kind", "proposalId", "proposalRevision", "planId"], "proposal-approval provenance");
      if (typeof provenance.proposalRevision !== "number"
        || !Number.isSafeInteger(provenance.proposalRevision)
        || provenance.proposalRevision < 0) {
        throw new WorkspaceStoreCodecError("proposal provenance revision must be a non-negative safe integer");
      }
      const planId = optional("planId");
      return {
        kind,
        proposalId: exactStoredString(provenance.proposalId, "proposal provenance id"),
        proposalRevision: provenance.proposalRevision,
        ...(planId === undefined ? {} : { planId }),
      };
    }
    case "artifact-publication": {
      allowFields(provenance, ["kind", "revisionId", "runId", "planId", "taskId"], "artifact-publication provenance");
      const runId = optional("runId");
      const planId = optional("planId");
      const taskId = optional("taskId");
      return {
        kind,
        revisionId: exactStoredString(provenance.revisionId, "artifact provenance revision id"),
        ...(runId === undefined ? {} : { runId }),
        ...(planId === undefined ? {} : { planId }),
        ...(taskId === undefined ? {} : { taskId }),
      };
    }
    case "resource-publication": {
      allowFields(provenance, ["kind", "resourceRevisionId", "runId", "planId", "taskId"], "resource-publication provenance");
      const runId = optional("runId");
      const planId = optional("planId");
      const taskId = optional("taskId");
      return {
        kind,
        resourceRevisionId: exactStoredString(provenance.resourceRevisionId, "Resource provenance Revision id"),
        ...(runId === undefined ? {} : { runId }),
        ...(planId === undefined ? {} : { planId }),
        ...(taskId === undefined ? {} : { taskId }),
      };
    }
    case "kernel-publication": {
      allowFields(provenance, ["kind", "kernelRevisionId", "proposalId", "impact"], "kernel-publication provenance");
      const proposalId = optional("proposalId");
      const kernelRevisionId = exactStoredString(provenance.kernelRevisionId, "Kernel provenance Revision id");
      const impact = Object.hasOwn(provenance, "impact")
        ? asKernelImpactAnalysis(provenance.impact)
        : undefined;
      if (impact !== undefined && impact.toKernelRevisionId !== kernelRevisionId) {
        throw new WorkspaceStoreCodecError("Kernel provenance impact target must match its Revision id");
      }
      return {
        kind,
        kernelRevisionId,
        ...(proposalId === undefined ? {} : { proposalId }),
        ...(impact === undefined ? {} : { impact }),
      };
    }
    case "propagation":
      allowFields(provenance, ["kind", "proposalId", "batchId"], "propagation provenance");
      return {
        kind,
        proposalId: exactStoredString(provenance.proposalId, "propagation proposal id"),
        batchId: exactStoredString(provenance.batchId, "propagation batch id"),
      };
    case "plan-checkpoint":
      allowFields(provenance, ["kind", "proposalId", "planId", "checkpointId"], "plan-checkpoint provenance");
      return {
        kind,
        proposalId: exactStoredString(provenance.proposalId, "checkpoint proposal id"),
        planId: exactStoredString(provenance.planId, "checkpoint plan id"),
        checkpointId: exactStoredString(provenance.checkpointId, "checkpoint id"),
      };
    case "restore": {
      allowFields(provenance, ["kind", "restoredSnapshotId", "restoredRevisionId"], "restore provenance");
      const restoredSnapshotId = optional("restoredSnapshotId");
      const restoredRevisionId = optional("restoredRevisionId");
      if (restoredSnapshotId === undefined && restoredRevisionId === undefined) {
        throw new WorkspaceStoreCodecError("restore provenance requires a restored Snapshot or Revision id");
      }
      return {
        kind,
        ...(restoredSnapshotId === undefined ? {} : { restoredSnapshotId }),
        ...(restoredRevisionId === undefined ? {} : { restoredRevisionId }),
      };
    }
    case "legacy-migration":
      allowFields(provenance, ["kind", "migration"], "legacy-migration provenance");
      return { kind, migration: exactStoredString(provenance.migration, "legacy migration name") };
    default:
      throw new WorkspaceStoreCodecError(`unsupported Workspace Snapshot provenance kind ${kind}`);
  }
}

function asKernelImpactAnalysis(value: unknown): KernelImpactAnalysis {
  const impact = boundaryRecord(value, "Kernel impact analysis");
  allowFields(
    impact,
    ["workspaceId", "baseSnapshotId", "fromKernelRevisionId", "toKernelRevisionId", "affectedArtifactRevisions"],
    "Kernel impact analysis",
  );
  const affected = boundaryArray(
    impact.affectedArtifactRevisions,
    "Kernel impact affected Artifact Revisions",
  ).map((entry, index) => {
    const record = boundaryRecord(entry, `Kernel impact affected Artifact Revision ${index}`);
    allowFields(
      record,
      ["artifactId", "revisionId", "pinnedKernelRevisionId"],
      `Kernel impact affected Artifact Revision ${index}`,
    );
    return {
      artifactId: exactStoredString(record.artifactId, "Kernel impact Artifact id"),
      revisionId: exactStoredString(record.revisionId, "Kernel impact Artifact Revision id"),
      pinnedKernelRevisionId: exactStoredString(
        record.pinnedKernelRevisionId,
        "Kernel impact pinned Kernel Revision id",
      ),
    };
  });
  for (let index = 1; index < affected.length; index += 1) {
    const previous = affected[index - 1];
    const current = affected[index];
    if (!previous || !current || compareBinary(previous.artifactId, current.artifactId) >= 0) {
      throw new WorkspaceStoreCodecError("Kernel impact affected Artifact Revisions must be unique and sorted");
    }
  }
  return {
    workspaceId: exactStoredString(impact.workspaceId, "Kernel impact Workspace id"),
    baseSnapshotId: exactStoredString(impact.baseSnapshotId, "Kernel impact base Snapshot id"),
    fromKernelRevisionId: exactStoredString(
      impact.fromKernelRevisionId,
      "Kernel impact source Kernel Revision id",
    ),
    toKernelRevisionId: exactStoredString(impact.toKernelRevisionId, "Kernel impact target Kernel Revision id"),
    affectedArtifactRevisions: affected,
  };
}

function canonicalEmptyJsonObject(value: unknown, label: string): void {
  const parsed = jsonObject(value, label);
  if (Object.keys(parsed).length !== 0 || value !== "{}") {
    throw new WorkspaceStoreCodecError(`${label} must contain the canonical empty object {}`);
  }
}

export function asProjectWorkspace(row: Row): ProjectWorkspace {
  if (row.mode !== "standard" && row.mode !== "prototype") {
    throw new WorkspaceStoreCodecError(`workspace project mode must be standard or prototype`);
  }
  return {
    id: requiredString(row.id, "workspace id"),
    projectId: requiredString(row.project_id, "workspace project id"),
    mode: row.mode,
    graphRevision: nonNegativeInteger(row.graph_revision, "workspace graph revision"),
    activeSnapshotId: requiredString(row.active_snapshot_id, "workspace active snapshot id"),
    activeKernelRevisionId: requiredString(row.active_kernel_revision_id, "workspace active Kernel revision id"),
    createdAt: timestamp(row.created_at, "workspace created_at"),
    updatedAt: timestamp(row.updated_at, "workspace updated_at"),
  };
}

export function asWorkspaceArtifact(row: Row): WorkspaceArtifactRecord {
  if (row.kind !== "page" && row.kind !== "component") {
    throw new WorkspaceStoreCodecError(`unsupported workspace Artifact kind ${String(row.kind)}`);
  }
  if (row.legacy_wrapped !== 0 && row.legacy_wrapped !== 1) {
    throw new WorkspaceStoreCodecError("Artifact legacy-wrapped marker must be zero or one");
  }
  const sourceRoot = requiredString(row.source_root, "Artifact source root");
  const legacyWrapped = row.legacy_wrapped === 1;
  if ((legacyWrapped && (row.kind !== "page" || sourceRoot !== "."))
    || (!legacyWrapped && sourceRoot === ".")) {
    throw new WorkspaceStoreCodecError("Artifact legacy-wrapped marker does not match its kind and source root");
  }
  return {
    id: requiredString(row.id, "Artifact id"),
    workspaceId: requiredString(row.workspace_id, "Artifact workspace id"),
    kind: row.kind,
    name: requiredString(row.name, "Artifact name"),
    sourceRoot,
    legacyWrapped,
    activeTrackId: nullableString(row.active_track_id, "Artifact active Track id"),
    archivedAt: row.archived_at == null ? null : timestamp(row.archived_at, "Artifact archived_at"),
    createdAt: timestamp(row.created_at, "Artifact created_at"),
    updatedAt: timestamp(row.updated_at, "Artifact updated_at"),
  };
}

export function asArtifactTrack(row: Row): ArtifactTrackRecord {
  return {
    id: requiredString(row.id, "Artifact Track id"),
    artifactId: requiredString(row.artifact_id, "Artifact Track Artifact id"),
    name: requiredString(row.name, "Artifact Track name"),
    headRevisionId: nullableString(row.head_revision_id, "Artifact Track Head Revision id"),
    legacyVariantId: nullableString(row.legacy_variant_id, "Artifact Track legacy Variant id"),
    createdAt: timestamp(row.created_at, "Artifact Track created_at"),
  };
}

export function asArtifactRevision(row: Row): ArtifactRevisionRecord {
  sealedAggregate(row.sealed, "Artifact Revision");
  return {
    id: requiredString(row.id, "Artifact Revision id"),
    workspaceId: requiredString(row.workspace_id, "Artifact Revision workspace id"),
    artifactId: requiredString(row.artifact_id, "Artifact Revision Artifact id"),
    trackId: requiredString(row.track_id, "Artifact Revision Track id"),
    sequence: positiveInteger(row.sequence, "Artifact Revision sequence"),
    parentRevisionId: nullableString(row.parent_revision_id, "Artifact Revision parent id"),
    sourceCommitHash: requiredString(row.source_commit_hash, "Artifact Revision source commit hash"),
    sourceTreeHash: requiredString(row.source_tree_hash, "Artifact Revision source tree hash"),
    artifactRoot: requiredString(row.artifact_root, "Artifact Revision root"),
    kernelRevisionId: requiredString(row.kernel_revision_id, "Artifact Revision Kernel id"),
    renderSpec: canonicalJsonObject(
      parseJson(row.render_spec_json, "Artifact Revision render spec"),
      "Artifact Revision render spec",
    ),
    quality: canonicalJsonObject(
      parseJson(row.quality_json, "Artifact Revision quality"),
      "Artifact Revision quality",
    ),
    contextPackHash: nullableString(row.context_pack_hash, "Artifact Revision Context Pack hash"),
    producedByRunId: nullableString(row.produced_by_run_id, "Artifact Revision producing Run id"),
    legacyRunId: nullableString(row.legacy_run_id, "Artifact Revision legacy Run id"),
    createdAt: timestamp(row.created_at, "Artifact Revision created_at"),
  };
}

export function asSharedDesignKernelRevision(row: Row): SharedDesignKernelRevision {
  const payloadText = requiredString(row.payload_json, "Kernel Revision payload");
  const storedChecksum = requiredString(row.checksum, "Kernel Revision checksum");
  const actualChecksum = createHash("sha256").update(payloadText).digest("hex");
  if (storedChecksum !== actualChecksum) {
    throw new WorkspaceStoreCodecError("Kernel Revision checksum does not match its immutable payload");
  }
  const storedPayload = parseJson(payloadText, "Kernel Revision payload");
  const payload = normalizeKernelPayload(storedPayload, "Kernel Revision payload");
  if (!isDeepStrictEqual(storedPayload, payload)) {
    throw new WorkspaceStoreCodecError("Kernel Revision payload must already be canonical");
  }
  return {
    id: requiredString(row.id, "Kernel Revision id"),
    workspaceId: requiredString(row.workspace_id, "Kernel Revision workspace id"),
    sequence: positiveInteger(row.sequence, "Kernel Revision sequence"),
    parentRevisionId: nullableString(row.parent_revision_id, "Kernel Revision parent id"),
    ...payload,
    checksum: storedChecksum,
    createdAt: timestamp(row.created_at, "Kernel Revision created_at"),
  };
}

export function asArtifactRevisionDependency(row: Row): ArtifactRevisionDependencyRecord {
  if (row.status !== "linked" && row.status !== "detached") {
    throw new WorkspaceStoreCodecError("Artifact Revision dependency status must be linked or detached");
  }
  const designNodeId = exactStoredString(row.design_node_id, "Artifact Revision dependency design node id");
  const storedSourceLocator = parseJson(
    row.source_locator_json,
    "Artifact Revision dependency source locator",
  );
  const sourceLocator = normalizeDesignNodeLocatorInput(
    storedSourceLocator,
    "Artifact Revision dependency source locator",
  );
  if (!isDeepStrictEqual(storedSourceLocator, sourceLocator)) {
    throw new WorkspaceStoreCodecError(
      "Artifact Revision dependency source locator must already be canonical",
    );
  }
  if (sourceLocator.designNodeId !== designNodeId) {
    throw new WorkspaceStoreCodecError(
      "Artifact Revision dependency design node id must match its immutable source locator",
    );
  }
  return {
    workspaceId: exactStoredString(row.workspace_id, "Artifact Revision dependency workspace id"),
    ownerArtifactId: exactStoredString(row.owner_artifact_id, "Artifact Revision dependency owner Artifact id"),
    revisionId: exactStoredString(row.revision_id, "Artifact Revision dependency Revision id"),
    instanceId: exactStoredString(row.instance_id, "Artifact Revision dependency instance id"),
    componentArtifactId: exactStoredString(row.component_artifact_id, "Artifact Revision dependency Component id"),
    componentRevisionId: exactStoredString(row.component_revision_id, "Artifact Revision dependency Component Revision id"),
    variantKey: nullableString(row.variant_key, "Artifact Revision dependency variant key"),
    stateKey: nullableString(row.state_key, "Artifact Revision dependency state key"),
    sourceLocator,
    overrides: canonicalJsonObject(
      parseJson(row.overrides_json, "Artifact Revision dependency overrides"),
      "Artifact Revision dependency overrides",
    ),
    status: row.status,
  };
}

export function asArtifactRevisionResourcePin(row: Row): ArtifactRevisionResourcePinRecord {
  return {
    workspaceId: exactStoredString(row.workspace_id, "Artifact Revision Resource pin workspace id"),
    ownerArtifactId: exactStoredString(row.owner_artifact_id, "Artifact Revision Resource pin owner Artifact id"),
    revisionId: exactStoredString(row.revision_id, "Artifact Revision Resource pin Revision id"),
    resourceId: exactStoredString(row.resource_id, "Artifact Revision Resource pin Resource id"),
    resourceRevisionId: exactStoredString(row.resource_revision_id, "Artifact Revision pinned Resource Revision id"),
  };
}

export function asWorkspaceNode(row: Row): WorkspaceNode {
  const base = {
    id: requiredString(row.id, "workspace node id"),
    workspaceId: requiredString(row.workspace_id, "workspace node workspace id"),
    name: requiredString(row.name, "workspace node name"),
  };
  if (row.kind === "page" || row.kind === "component") {
    return {
      ...base,
      kind: row.kind,
      artifactId: requiredString(row.artifact_id, "workspace node Artifact id"),
    };
  }
  if (row.kind === "resource") {
    return {
      ...base,
      kind: "resource",
      resourceId: requiredString(row.resource_id, "workspace node Resource id"),
    };
  }
  throw new WorkspaceStoreCodecError(`unsupported workspace node kind ${String(row.kind)}`);
}

export function asWorkspaceEdge(row: Row): WorkspaceEdge {
  const base = {
    id: requiredString(row.id, "workspace edge id"),
    workspaceId: requiredString(row.workspace_id, "workspace edge workspace id"),
    sourceNodeId: requiredString(row.source_node_id, "workspace edge source node id"),
    targetNodeId: requiredString(row.target_node_id, "workspace edge target node id"),
  };
  if (row.kind === "prototype") {
    return { ...base, kind: "prototype", prototype: parseJson(row.payload_json, "prototype edge payload") as never };
  }
  if (row.kind === "uses" || row.kind === "informs" || row.kind === "derives-from") {
    canonicalEmptyJsonObject(row.payload_json, `${row.kind} edge payload`);
    return { ...base, kind: row.kind };
  }
  throw new WorkspaceStoreCodecError(`unsupported workspace edge kind ${String(row.kind)}`);
}

export function asWorkspaceGraphRevision(row: Row): WorkspaceGraph {
  let nodes: unknown;
  let edges: unknown;
  try {
    nodes = parseJson(row.nodes_json, "workspace graph nodes");
    edges = parseJson(row.edges_json, "workspace graph edges");
  } catch (error) {
    if (error instanceof WorkspaceStoreCodecError) {
      throw new WorkspaceGraphValidationError(error.message);
    }
    throw error;
  }
  const nodesJson = requiredString(row.nodes_json, "workspace graph nodes JSON");
  const edgesJson = requiredString(row.edges_json, "workspace graph edges JSON");
  const expectedChecksum = createHash("sha256").update(`${nodesJson}\n${edgesJson}`).digest("hex");
  if (requiredString(row.checksum, "workspace graph checksum") !== expectedChecksum) {
    throw new WorkspaceGraphValidationError("workspace graph checksum does not match its immutable payload");
  }
  const graph: unknown = {
    workspaceId: requiredString(row.workspace_id, "workspace graph workspace id"),
    revision: nonNegativeInteger(row.revision, "workspace graph revision"),
    nodes,
    edges,
  };
  validateWorkspaceGraph(graph);
  return graph;
}

export function asWorkspaceSnapshotBase(row: Row): WorkspaceSnapshotBaseRecord {
  sealedAggregate(row.sealed, "Workspace Snapshot");
  return {
    id: requiredString(row.id, "Workspace Snapshot id"),
    workspaceId: requiredString(row.workspace_id, "Workspace Snapshot workspace id"),
    sequence: positiveInteger(row.sequence, "Workspace Snapshot sequence"),
    parentSnapshotId: nullableString(row.parent_snapshot_id, "Workspace Snapshot parent id"),
    graphRevision: nonNegativeInteger(row.graph_revision, "Workspace Snapshot graph revision"),
    kernelRevisionId: requiredString(row.kernel_revision_id, "Workspace Snapshot Kernel id"),
    reason: requiredString(row.reason, "Workspace Snapshot reason"),
    provenance: asWorkspaceSnapshotProvenance(parseJson(row.provenance_json, "Workspace Snapshot provenance")),
    createdByRunId: nullableString(row.created_by_run_id, "Workspace Snapshot creating Run id"),
    createdAt: timestamp(row.created_at, "Workspace Snapshot created_at"),
  };
}
