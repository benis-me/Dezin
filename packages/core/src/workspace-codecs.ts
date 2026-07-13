import { validateWorkspaceGraph, WorkspaceGraphValidationError } from "./workspace-graph.ts";
import type {
  ArtifactKind,
  ProjectWorkspace,
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceNode,
} from "./workspace-types.ts";
import type { Row } from "./store-codecs.ts";

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

export interface WorkspaceSnapshotBaseRecord {
  id: string;
  workspaceId: string;
  sequence: number;
  parentSnapshotId: string | null;
  graphRevision: number;
  kernelRevisionId: string;
  reason: string;
  provenance: Record<string, unknown>;
  createdByRunId: string | null;
  createdAt: number;
}

export interface WorkspaceSnapshotRecord extends WorkspaceSnapshotBaseRecord {
  graph: WorkspaceGraph;
  artifactTracks: Record<string, string>;
  artifactRevisions: Record<string, string | null>;
  resourceRevisions: Record<string, string>;
}

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
    provenance: jsonObject(row.provenance_json, "Workspace Snapshot provenance"),
    createdByRunId: nullableString(row.created_by_run_id, "Workspace Snapshot creating Run id"),
    createdAt: timestamp(row.created_at, "Workspace Snapshot created_at"),
  };
}
