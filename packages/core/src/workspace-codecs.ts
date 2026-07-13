import {
  normalizeWorkspaceGraphCommands,
  validateWorkspaceGraph,
  WorkspaceGraphValidationError,
} from "./workspace-graph.ts";
import type {
  ArtifactKind,
  ProjectWorkspace,
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceGraphMutationInput,
  WorkspaceLayoutCommand,
  WorkspaceLayoutPatch,
  WorkspaceNode,
  WorkspaceSnapshot,
  WorkspaceSnapshotProvenance,
} from "./workspace-types.ts";
import type { Row } from "./store-codecs.ts";

const OBJECT_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Object.prototype));
const ARRAY_PROTOTYPE_KEYS = new Set<PropertyKey>(Reflect.ownKeys(Array.prototype));

export interface WorkspaceArtifactRecord {
  id: string;
  workspaceId: string;
  kind: ArtifactKind;
  name: string;
  sourceRoot: string;
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

export function normalizeWorkspaceLayoutPatch(value: unknown): WorkspaceLayoutPatch & { layoutId: string } {
  const input = boundaryRecord(value, "workspace layout patch");
  allowFields(input, ["layoutId", "graphRevision", "commands"], "workspace layout patch");
  if (typeof input.graphRevision !== "number" || !Number.isSafeInteger(input.graphRevision) || input.graphRevision < 0) {
    throw new WorkspaceStoreCodecError("layout graphRevision must be a non-negative safe integer");
  }
  const commandInputs = boundaryArray(input.commands, "workspace layout commands");
  if (commandInputs.length === 0) {
    throw new WorkspaceStoreCodecError("workspace layout patch must contain at least one command");
  }
  const commands = commandInputs.map((command, index) => normalizeLayoutCommand(command, index));
  const addedGroups = new Set<string>();
  for (const command of commands) {
    if (command.type !== "add-group") continue;
    if (addedGroups.has(command.groupId)) {
      throw new WorkspaceStoreCodecError(`duplicate layout group id ${command.groupId}`);
    }
    addedGroups.add(command.groupId);
  }
  return {
    layoutId: input.layoutId === undefined ? "default" : canonicalString(input.layoutId, "layout id"),
    graphRevision: input.graphRevision,
    commands,
  };
}

export function normalizeWorkspaceLayoutId(value: unknown): string {
  return canonicalString(value, "layout id");
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
      allowFields(provenance, ["kind", "kernelRevisionId", "proposalId"], "kernel-publication provenance");
      const proposalId = optional("proposalId");
      return {
        kind,
        kernelRevisionId: exactStoredString(provenance.kernelRevisionId, "Kernel provenance Revision id"),
        ...(proposalId === undefined ? {} : { proposalId }),
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
  return {
    id: requiredString(row.id, "Artifact id"),
    workspaceId: requiredString(row.workspace_id, "Artifact workspace id"),
    kind: row.kind,
    name: requiredString(row.name, "Artifact name"),
    sourceRoot: requiredString(row.source_root, "Artifact source root"),
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
  return {
    id: requiredString(row.id, "Artifact Revision id"),
    workspaceId: requiredString(row.workspace_id, "Artifact Revision workspace id"),
    artifactId: requiredString(row.artifact_id, "Artifact Revision Artifact id"),
    trackId: requiredString(row.track_id, "Artifact Revision Track id"),
    sequence: nonNegativeInteger(row.sequence, "Artifact Revision sequence"),
    parentRevisionId: nullableString(row.parent_revision_id, "Artifact Revision parent id"),
    sourceCommitHash: requiredString(row.source_commit_hash, "Artifact Revision source commit hash"),
    sourceTreeHash: requiredString(row.source_tree_hash, "Artifact Revision source tree hash"),
    artifactRoot: requiredString(row.artifact_root, "Artifact Revision root"),
    kernelRevisionId: requiredString(row.kernel_revision_id, "Artifact Revision Kernel id"),
    renderSpec: jsonObject(row.render_spec_json, "Artifact Revision render spec"),
    quality: jsonObject(row.quality_json, "Artifact Revision quality"),
    contextPackHash: nullableString(row.context_pack_hash, "Artifact Revision Context Pack hash"),
    producedByRunId: nullableString(row.produced_by_run_id, "Artifact Revision producing Run id"),
    legacyRunId: nullableString(row.legacy_run_id, "Artifact Revision legacy Run id"),
    createdAt: timestamp(row.created_at, "Artifact Revision created_at"),
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
  return {
    id: requiredString(row.id, "Workspace Snapshot id"),
    workspaceId: requiredString(row.workspace_id, "Workspace Snapshot workspace id"),
    sequence: nonNegativeInteger(row.sequence, "Workspace Snapshot sequence"),
    parentSnapshotId: nullableString(row.parent_snapshot_id, "Workspace Snapshot parent id"),
    graphRevision: nonNegativeInteger(row.graph_revision, "Workspace Snapshot graph revision"),
    kernelRevisionId: requiredString(row.kernel_revision_id, "Workspace Snapshot Kernel id"),
    reason: requiredString(row.reason, "Workspace Snapshot reason"),
    provenance: asWorkspaceSnapshotProvenance(parseJson(row.provenance_json, "Workspace Snapshot provenance")),
    createdByRunId: nullableString(row.created_by_run_id, "Workspace Snapshot creating Run id"),
    createdAt: timestamp(row.created_at, "Workspace Snapshot created_at"),
  };
}
