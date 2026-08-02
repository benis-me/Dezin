export type SharinganResourceKind = "sharingan-capture";
export type SharinganResourcePinPolicy = "pin-current";

export interface SharinganResource {
  id: string;
  workspaceId: string;
  kind: SharinganResourceKind;
  title: string;
  headRevisionId: string | null;
  defaultPinPolicy: SharinganResourcePinPolicy;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SharinganResourceRevision {
  id: string;
  workspaceId: string;
  resourceId: string;
  sequence: number;
  parentRevisionId: string | null;
  manifestPath: string;
  summary: string;
  metadata: Record<string, unknown>;
  checksum: string;
  provenance: Record<string, unknown>;
  createdAt: number;
}

export interface SharinganWorkspace {
  id: string;
  projectId: string;
  mode: "standard";
  graphRevision: number;
  activeSnapshotId: string;
  activeKernelRevisionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharinganWorkspaceResourceNode {
  id: string;
  workspaceId: string;
  kind: "resource";
  name: string;
  resourceId: string;
}

export interface SharinganWorkspaceGraph {
  workspaceId: string;
  revision: number;
  nodes: SharinganWorkspaceResourceNode[];
  edges: [];
}

export type SharinganWorkspaceSnapshotProvenance =
  | { kind: "workspace-created" }
  | { kind: "graph-command"; commandIds: string[] }
  | { kind: "resource-publication"; resourceRevisionId: string };

export interface SharinganWorkspaceSnapshot {
  id: string;
  workspaceId: string;
  sequence: number;
  parentSnapshotId: string | null;
  graphRevision: number;
  kernelRevisionId: string;
  reason: string;
  provenance: SharinganWorkspaceSnapshotProvenance;
  createdAt: number;
  graph: SharinganWorkspaceGraph;
  resourceRevisions: Record<string, string>;
}

export interface CreateSharinganResourceInput {
  kind: SharinganResourceKind;
  title: string;
  defaultPinPolicy: SharinganResourcePinPolicy;
  baseGraphRevision: number;
  expectedSnapshotId: string;
}

export interface CreateSharinganResourceResult {
  resource: SharinganResource;
  node: SharinganWorkspaceResourceNode;
  graph: SharinganWorkspaceGraph;
  snapshot: SharinganWorkspaceSnapshot;
}

export interface CreateSharinganResourceRevisionCandidateInput {
  revisionId: string;
  parentRevisionId: string | null;
  manifestPath: string;
  summary: string;
  metadata: Record<string, unknown>;
  checksum: string;
  provenance: Record<string, unknown>;
}

export interface SharinganResourcePublicationExpectation {
  expectedHeadRevisionId: string | null;
  expectedSnapshotId: string;
  reason: string;
}

export interface SharinganResourceRevisionViewFacts {
  resource: SharinganResource;
  revision: SharinganResourceRevision;
  snapshotId: string;
}

// Payload verification uses these short names at the Sharingan boundary.
export type Resource = SharinganResource;
export type ResourceRevision = SharinganResourceRevision;
