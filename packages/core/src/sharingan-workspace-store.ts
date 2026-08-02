import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, posix } from "node:path";

import type {
  CreateSharinganResourceInput,
  CreateSharinganResourceResult,
  CreateSharinganResourceRevisionCandidateInput,
  SharinganResource,
  SharinganResourcePublicationExpectation,
  SharinganResourceRevision,
  SharinganResourceRevisionViewFacts,
  SharinganWorkspace,
  SharinganWorkspaceGraph,
  SharinganWorkspaceResourceNode,
  SharinganWorkspaceSnapshot,
  SharinganWorkspaceSnapshotProvenance,
} from "./sharingan-workspace-types.ts";

type Row = Record<string, unknown>;

export interface SharinganWorkspaceClock {
  now(): number;
  id(): string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const KERNEL_PAYLOAD = Object.freeze({ protocol: "dezin.sharingan-workspace-kernel.v1" });

export class WorkspaceGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGraphValidationError";
  }
}

export class WorkspaceRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Workspace graph Revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "WorkspaceRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspacePointerConflictError extends Error {
  readonly expectedId: string | null;
  readonly actualId: string | null;

  constructor(input: { pointer: string; expectedId: string | null; actualId: string | null }) {
    super(`${input.pointer} conflict: expected ${String(input.expectedId)}, found ${String(input.actualId)}`);
    this.name = "WorkspacePointerConflictError";
    this.expectedId = input.expectedId;
    this.actualId = input.actualId;
  }
}

export class WorkspaceResourceNotFoundError extends Error {
  constructor(resourceId: string, projectId: string) {
    super(`Resource ${resourceId} was not found for Project ${projectId}`);
    this.name = "WorkspaceResourceNotFoundError";
  }
}

export class WorkspaceResourceOwnershipError extends Error {
  readonly expectedProjectId: string;
  readonly actualProjectId: string;

  constructor(resourceId: string, expectedProjectId: string, actualProjectId: string) {
    super(`Resource ${resourceId} belongs to another Project`);
    this.name = "WorkspaceResourceOwnershipError";
    this.expectedProjectId = expectedProjectId;
    this.actualProjectId = actualProjectId;
  }
}

function fail(message: string): never {
  throw new WorkspaceGraphValidationError(message);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) return fail(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(`${label} is invalid`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(`${label} is invalid`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result < 1) return fail(`${label} is invalid`);
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || value.includes("\0")) return fail(`${label} is invalid`);
  return value;
}

function relativePath(value: unknown, label: string): string {
  const path = text(value, label, 4_096);
  if (isAbsolute(path) || path.includes("\\") || path.startsWith("/")
    || posix.normalize(path) !== path || path.split("/").some((segment) => segment === "..")) {
    return fail(`${label} is not a confined relative path`);
  }
  return path;
}

function checksum(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) return fail(`${label} is invalid`);
  return value;
}

function plainJson(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail(`${label} must be a plain object`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fail(`${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) return fail(`${label} is too large`);
  const decoded = JSON.parse(encoded) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return fail(`${label} must remain a JSON object`);
  }
  return decoded as Record<string, unknown>;
}

function encodedJson(value: unknown, label: string): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) return fail(`${label} is too large`);
  return encoded;
}

function graphChecksum(nodesJson: string, edgesJson: string): string {
  return createHash("sha256").update(`${nodesJson}\n${edgesJson}`).digest("hex");
}

function asWorkspace(row: Row): SharinganWorkspace {
  if (row.mode !== "standard") return fail("Sharingan Workspace owner is not Standard");
  const activeSnapshotId = identifier(row.active_snapshot_id, "Sharingan Workspace active Snapshot id");
  const activeKernelRevisionId = identifier(
    row.active_kernel_revision_id,
    "Sharingan Workspace active Kernel id",
  );
  return {
    id: identifier(row.id, "Sharingan Workspace id"),
    projectId: identifier(row.project_id, "Sharingan Workspace Project id"),
    mode: "standard",
    graphRevision: nonNegativeInteger(row.graph_revision, "Sharingan Workspace graph Revision"),
    activeSnapshotId,
    activeKernelRevisionId,
    createdAt: timestamp(row.created_at, "Sharingan Workspace created_at"),
    updatedAt: timestamp(row.updated_at, "Sharingan Workspace updated_at"),
  };
}

function asResource(row: Row): SharinganResource {
  if (row.kind !== "sharingan-capture" || row.default_pin_policy !== "pin-current") {
    return fail("Sharingan Resource kind or pin policy is invalid");
  }
  return {
    id: identifier(row.id, "Sharingan Resource id"),
    workspaceId: identifier(row.workspace_id, "Sharingan Resource Workspace id"),
    kind: "sharingan-capture",
    title: text(row.title, "Sharingan Resource title", 500),
    headRevisionId: row.head_revision_id == null
      ? null
      : identifier(row.head_revision_id, "Sharingan Resource Head id"),
    defaultPinPolicy: "pin-current",
    archivedAt: row.archived_at == null
      ? null
      : timestamp(row.archived_at, "Sharingan Resource archived_at"),
    createdAt: timestamp(row.created_at, "Sharingan Resource created_at"),
    updatedAt: timestamp(row.updated_at, "Sharingan Resource updated_at"),
  };
}

function asRevision(row: Row): SharinganResourceRevision {
  let metadata: unknown;
  let provenance: unknown;
  try {
    metadata = JSON.parse(String(row.metadata_json));
    provenance = JSON.parse(String(row.provenance_json));
  } catch {
    return fail("Sharingan Resource Revision JSON is invalid");
  }
  return {
    id: identifier(row.id, "Sharingan Resource Revision id"),
    workspaceId: identifier(row.workspace_id, "Sharingan Resource Revision Workspace id"),
    resourceId: identifier(row.resource_id, "Sharingan Resource Revision Resource id"),
    sequence: positiveInteger(row.sequence, "Sharingan Resource Revision sequence"),
    parentRevisionId: row.parent_revision_id == null
      ? null
      : identifier(row.parent_revision_id, "Sharingan Resource Revision parent id"),
    manifestPath: relativePath(row.manifest_path, "Sharingan Resource Revision manifest path"),
    summary: text(row.summary, "Sharingan Resource Revision summary", 32_000),
    metadata: plainJson(metadata, "Sharingan Resource Revision metadata"),
    checksum: checksum(row.checksum, "Sharingan Resource Revision checksum"),
    provenance: plainJson(provenance, "Sharingan Resource Revision provenance"),
    createdAt: timestamp(row.created_at, "Sharingan Resource Revision created_at"),
  };
}

function asGraph(row: Row): SharinganWorkspaceGraph {
  let nodes: unknown;
  let edges: unknown;
  try {
    nodes = JSON.parse(String(row.nodes_json));
    edges = JSON.parse(String(row.edges_json));
  } catch {
    return fail("Sharingan Workspace graph JSON is invalid");
  }
  if (!Array.isArray(nodes) || !Array.isArray(edges) || edges.length !== 0
    || Object.keys(nodes).length !== nodes.length || Object.keys(edges).length !== 0) {
    return fail("Sharingan Workspace graph is invalid");
  }
  const workspaceId = identifier(row.workspace_id, "Sharingan Workspace graph Workspace id");
  const seenNodes = new Set<string>();
  const seenResources = new Set<string>();
  const normalizedNodes = nodes.map((raw, index): SharinganWorkspaceResourceNode => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`Sharingan Workspace graph node ${index} is invalid`);
    }
    const node = raw as Record<string, unknown>;
    const fields = Object.keys(node);
    if (fields.length !== 5
      || ["id", "workspaceId", "kind", "name", "resourceId"].some((field) => !Object.hasOwn(node, field))
      || node.kind !== "resource" || node.workspaceId !== workspaceId) {
      return fail(`Sharingan Workspace graph node ${index} shape is invalid`);
    }
    const id = identifier(node.id, `Sharingan Workspace graph node ${index} id`);
    const resourceId = identifier(
      node.resourceId,
      `Sharingan Workspace graph node ${index} Resource id`,
    );
    if (seenNodes.has(id) || seenResources.has(resourceId)) {
      return fail("Sharingan Workspace graph contains duplicate identities");
    }
    seenNodes.add(id);
    seenResources.add(resourceId);
    return {
      id,
      workspaceId,
      kind: "resource",
      name: text(node.name, `Sharingan Workspace graph node ${index} name`, 500),
      resourceId,
    };
  });
  const nodesJson = JSON.stringify(normalizedNodes);
  const edgesJson = "[]";
  if (row.nodes_json !== nodesJson || row.edges_json !== edgesJson
    || row.checksum !== graphChecksum(nodesJson, edgesJson)) {
    return fail("Sharingan Workspace graph checksum or canonical encoding is invalid");
  }
  return {
    workspaceId,
    revision: nonNegativeInteger(row.revision, "Sharingan Workspace graph Revision"),
    nodes: normalizedNodes,
    edges: [],
  };
}

function asProvenance(value: unknown): SharinganWorkspaceSnapshotProvenance {
  const provenance = plainJson(value, "Sharingan Workspace Snapshot provenance");
  if (provenance.kind === "workspace-created" && Object.keys(provenance).length === 1) {
    return { kind: "workspace-created" };
  }
  if (provenance.kind === "graph-command" && Object.keys(provenance).length === 2
    && Array.isArray(provenance.commandIds) && provenance.commandIds.length === 1) {
    return {
      kind: "graph-command",
      commandIds: [identifier(provenance.commandIds[0], "Sharingan graph command id")],
    };
  }
  if (provenance.kind === "resource-publication" && Object.keys(provenance).length === 2) {
    return {
      kind: "resource-publication",
      resourceRevisionId: identifier(
        provenance.resourceRevisionId,
        "Sharingan publication Revision id",
      ),
    };
  }
  return fail("Sharingan Workspace Snapshot provenance is unsupported");
}

export class SharinganWorkspaceStore {
  readonly #db: DatabaseSync;
  readonly #clock: SharinganWorkspaceClock;

  constructor(db: DatabaseSync, clock: SharinganWorkspaceClock) {
    this.#db = db;
    this.#clock = clock;
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the domain failure when SQLite already closed the transaction.
      }
      throw error;
    }
  }

  ensureSharinganWorkspaceFoundation(projectId: string): SharinganWorkspace {
    identifier(projectId, "Sharingan Project id");
    const project = this.#db.prepare(
      `SELECT mode, sharingan, source_url, archived_at
         FROM projects
        WHERE id = ?`,
    ).get(projectId) as Row | undefined;
    if (!project || project.mode !== "standard" || project.sharingan !== 1
      || typeof project.source_url !== "string" || project.source_url.length === 0
      || project.archived_at !== null) {
      return fail("Sharingan Workspace foundation requires one active Sharingan Project");
    }
    const existing = this.getWorkspace(projectId);
    if (existing) return existing;
    return this.#transaction(() => {
      const concurrent = this.getWorkspace(projectId);
      if (concurrent) return concurrent;
      const workspaceId = this.#clock.id();
      const kernelRevisionId = this.#clock.id();
      const snapshotId = this.#clock.id();
      const now = this.#clock.now();
      const nodesJson = "[]";
      const edgesJson = "[]";
      const kernelPayload = JSON.stringify(KERNEL_PAYLOAD);
      this.#db.prepare(
        `INSERT INTO project_workspaces (
           id, project_id, graph_revision, active_snapshot_id,
           active_kernel_revision_id, created_at, updated_at
         ) VALUES (?, ?, 0, NULL, NULL, ?, ?)`,
      ).run(workspaceId, projectId, now, now);
      this.#db.prepare(
        `INSERT INTO workspace_graph_revisions
           (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
         VALUES (?, 0, ?, ?, ?, ?)`,
      ).run(workspaceId, nodesJson, edgesJson, graphChecksum(nodesJson, edgesJson), now);
      this.#db.prepare(
        `INSERT INTO shared_design_kernel_revisions
           (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
         VALUES (?, ?, 1, NULL, ?, ?, ?)`,
      ).run(
        kernelRevisionId,
        workspaceId,
        kernelPayload,
        createHash("sha256").update(kernelPayload).digest("hex"),
        now,
      );
      this.#db.prepare(
        `INSERT INTO workspace_snapshots (
           id, workspace_id, sequence, parent_snapshot_id, graph_revision,
           kernel_revision_id, reason, provenance_json, created_at
         ) VALUES (?, ?, 1, NULL, 0, ?, ?, ?, ?)`,
      ).run(
        snapshotId,
        workspaceId,
        kernelRevisionId,
        "Sharingan Workspace created",
        JSON.stringify({ kind: "workspace-created" }),
        now,
      );
      this.#db.prepare(
        `UPDATE project_workspaces
            SET active_snapshot_id = ?, active_kernel_revision_id = ?
          WHERE id = ?`,
      ).run(snapshotId, kernelRevisionId, workspaceId);
      return this.#requireWorkspace(projectId);
    });
  }

  getWorkspace(projectId: string): SharinganWorkspace | null {
    const row = this.#db.prepare(
      `SELECT workspace.*, project.mode
         FROM project_workspaces workspace
         JOIN projects project ON project.id = workspace.project_id
        WHERE workspace.project_id = ?`,
    ).get(projectId) as Row | undefined;
    return row ? asWorkspace(row) : null;
  }

  #requireWorkspace(projectId: string): SharinganWorkspace {
    return this.getWorkspace(projectId) ?? fail(`Sharingan Workspace was not found for Project ${projectId}`);
  }

  getGraph(projectId: string): SharinganWorkspaceGraph {
    const workspace = this.#requireWorkspace(projectId);
    const row = this.#db.prepare(
      `SELECT * FROM workspace_graph_revisions
        WHERE workspace_id = ? AND revision = ?`,
    ).get(workspace.id, workspace.graphRevision) as Row | undefined;
    if (!row) return fail("Sharingan Workspace active graph Revision is missing");
    return asGraph(row);
  }

  #graph(workspaceId: string, revision: number): SharinganWorkspaceGraph {
    const row = this.#db.prepare(
      `SELECT * FROM workspace_graph_revisions
        WHERE workspace_id = ? AND revision = ?`,
    ).get(workspaceId, revision) as Row | undefined;
    if (!row) return fail("Sharingan Workspace graph Revision is missing");
    return asGraph(row);
  }

  listResources(projectId: string, options: { includeArchived?: boolean } = {}): SharinganResource[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.#db.prepare(
      `SELECT * FROM resources
        WHERE workspace_id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}
        ORDER BY created_at ASC, id COLLATE BINARY ASC`,
    ).all(workspace.id) as Row[];
    return rows.map(asResource);
  }

  getResourceForProject(projectId: string, resourceId: string): SharinganResource | null {
    const row = this.#db.prepare(
      `SELECT resource.*, workspace.project_id
         FROM resources resource
         JOIN project_workspaces workspace ON workspace.id = resource.workspace_id
        WHERE resource.id = ?`,
    ).get(resourceId) as Row | undefined;
    if (!row) return null;
    const actualProjectId = identifier(row.project_id, "Sharingan Resource owning Project id");
    if (actualProjectId !== projectId) {
      throw new WorkspaceResourceOwnershipError(resourceId, projectId, actualProjectId);
    }
    return asResource(row);
  }

  #requireResource(projectId: string, resourceId: string): SharinganResource {
    const resource = this.getResourceForProject(projectId, resourceId);
    if (!resource) throw new WorkspaceResourceNotFoundError(resourceId, projectId);
    return resource;
  }

  createResourceForProject(
    projectId: string,
    input: CreateSharinganResourceInput,
  ): CreateSharinganResourceResult {
    if (input.kind !== "sharingan-capture" || input.defaultPinPolicy !== "pin-current") {
      return fail("Sharingan Workspace accepts only a pin-current capture Resource");
    }
    const title = text(input.title, "Sharingan Resource title", 500);
    const baseGraphRevision = nonNegativeInteger(
      input.baseGraphRevision,
      "Sharingan Resource base graph Revision",
    );
    const expectedSnapshotId = identifier(
      input.expectedSnapshotId,
      "Sharingan Resource expected Snapshot id",
    );
    return this.#transaction(() => {
      const workspace = this.#requireWorkspace(projectId);
      if (workspace.graphRevision !== baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(baseGraphRevision, workspace.graphRevision);
      }
      if (workspace.activeSnapshotId !== expectedSnapshotId) {
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          expectedId: expectedSnapshotId,
          actualId: workspace.activeSnapshotId,
        });
      }
      const current = this.#graph(workspace.id, workspace.graphRevision);
      if (current.nodes.length !== 0 || this.listResources(projectId, { includeArchived: true }).length !== 0) {
        return fail("Sharingan Workspace already owns a capture Resource");
      }
      const resourceId = this.#clock.id();
      const nodeId = this.#clock.id();
      const commandId = this.#clock.id();
      const snapshotId = this.#clock.id();
      const now = this.#clock.now();
      const resource: SharinganResource = {
        id: resourceId,
        workspaceId: workspace.id,
        kind: "sharingan-capture",
        title,
        headRevisionId: null,
        defaultPinPolicy: "pin-current",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const node: SharinganWorkspaceResourceNode = {
        id: nodeId,
        workspaceId: workspace.id,
        kind: "resource",
        name: title,
        resourceId,
      };
      const graph: SharinganWorkspaceGraph = {
        workspaceId: workspace.id,
        revision: workspace.graphRevision + 1,
        nodes: [node],
        edges: [],
      };
      const nodesJson = JSON.stringify(graph.nodes);
      const edgesJson = "[]";
      this.#db.prepare(
        `INSERT INTO resources (
           id, workspace_id, kind, title, head_revision_id, default_pin_policy,
           archived_at, created_at, updated_at
         ) VALUES (?, ?, 'sharingan-capture', ?, NULL, 'pin-current', NULL, ?, ?)`,
      ).run(resourceId, workspace.id, title, now, now);
      this.#db.prepare(
        `INSERT INTO workspace_graph_revisions
           (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        workspace.id,
        graph.revision,
        nodesJson,
        edgesJson,
        graphChecksum(nodesJson, edgesJson),
        now,
      );
      this.#db.prepare(
        `INSERT INTO workspace_snapshots (
           id, workspace_id, sequence, parent_snapshot_id, graph_revision,
           kernel_revision_id, reason, provenance_json, created_at, sealed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        snapshotId,
        workspace.id,
        this.#nextSnapshotSequence(workspace.id),
        workspace.activeSnapshotId,
        graph.revision,
        workspace.activeKernelRevisionId,
        "Sharingan capture Resource created",
        JSON.stringify({ kind: "graph-command", commandIds: [commandId] }),
        now,
      );
      this.#copySnapshotResourcePins(workspace.id, workspace.activeSnapshotId, snapshotId);
      this.#db.prepare(
        "UPDATE workspace_snapshots SET sealed = 1 WHERE workspace_id = ? AND id = ?",
      ).run(workspace.id, snapshotId);
      this.#db.prepare(
        `UPDATE project_workspaces
            SET graph_revision = ?, active_snapshot_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(graph.revision, snapshotId, now, workspace.id);
      return {
        resource: this.#requireResource(projectId, resourceId),
        node,
        graph: this.getGraph(projectId),
        snapshot: this.#requireSnapshot(workspace.id, snapshotId),
      };
    });
  }

  getResourceRevisionForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): SharinganResourceRevision | null {
    const resource = this.#requireResource(projectId, resourceId);
    const row = this.#db.prepare(
      "SELECT * FROM resource_revisions WHERE id = ?",
    ).get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asRevision(row);
    if (revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id) {
      throw new WorkspaceResourceOwnershipError(resourceId, projectId, "foreign");
    }
    this.#validateRevisionParent(revision);
    return revision;
  }

  getResourceRevisionViewFactsForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): SharinganResourceRevisionViewFacts | null {
    const workspace = this.#requireWorkspace(projectId);
    const resource = this.#requireResource(projectId, resourceId);
    const revision = this.getResourceRevisionForProject(projectId, resourceId, revisionId);
    return revision ? { resource, revision, snapshotId: workspace.activeSnapshotId } : null;
  }

  listResourceRevisions(projectId: string, resourceId: string): SharinganResourceRevision[] {
    const resource = this.#requireResource(projectId, resourceId);
    const rows = this.#db.prepare(
      `SELECT * FROM resource_revisions
        WHERE workspace_id = ? AND resource_id = ?
        ORDER BY sequence ASC, id COLLATE BINARY ASC`,
    ).all(resource.workspaceId, resource.id) as Row[];
    const revisions = rows.map(asRevision);
    for (const revision of revisions) this.#validateRevisionParent(revision);
    return revisions;
  }

  createResourceRevisionCandidateForProject(
    projectId: string,
    resourceId: string,
    input: CreateSharinganResourceRevisionCandidateInput,
  ): SharinganResourceRevision {
    const revisionId = identifier(input.revisionId, "Sharingan Resource Revision id");
    const parentRevisionId = input.parentRevisionId === null
      ? null
      : identifier(input.parentRevisionId, "Sharingan Resource Revision parent id");
    const manifestPath = relativePath(input.manifestPath, "Sharingan Resource Revision manifest path");
    const summary = text(input.summary, "Sharingan Resource Revision summary", 32_000);
    const metadata = plainJson(input.metadata, "Sharingan Resource Revision metadata");
    const provenance = plainJson(input.provenance, "Sharingan Resource Revision provenance");
    const immutableChecksum = checksum(input.checksum, "Sharingan Resource Revision checksum");
    return this.#transaction(() => {
      const resource = this.#requireResource(projectId, resourceId);
      if (resource.archivedAt !== null) return fail("Sharingan capture Resource is archived");
      if (resource.headRevisionId !== parentRevisionId) {
        throw new WorkspacePointerConflictError({
          pointer: "resource-head",
          expectedId: parentRevisionId,
          actualId: resource.headRevisionId,
        });
      }
      if (this.#db.prepare("SELECT 1 FROM resource_revisions WHERE id = ?").get(revisionId)) {
        return fail(`Sharingan Resource Revision identity collision: ${revisionId}`);
      }
      const next = this.#db.prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM resource_revisions
          WHERE resource_id = ?`,
      ).get(resource.id) as { sequence: number };
      this.#db.prepare(
        `INSERT INTO resource_revisions (
           id, workspace_id, resource_id, sequence, parent_revision_id, manifest_path,
           summary, metadata_json, checksum, provenance_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        resource.workspaceId,
        resource.id,
        positiveInteger(next.sequence, "Sharingan Resource Revision sequence"),
        parentRevisionId,
        manifestPath,
        summary,
        encodedJson(metadata, "Sharingan Resource Revision metadata"),
        immutableChecksum,
        encodedJson(provenance, "Sharingan Resource Revision provenance"),
        this.#clock.now(),
      );
      return this.getResourceRevisionForProject(projectId, resourceId, revisionId)!;
    });
  }

  publishResourceRevisionForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
    expected: SharinganResourcePublicationExpectation,
  ): SharinganWorkspaceSnapshot {
    const expectedHeadRevisionId = expected.expectedHeadRevisionId === null
      ? null
      : identifier(expected.expectedHeadRevisionId, "Sharingan expected Resource Head id");
    const expectedSnapshotId = identifier(
      expected.expectedSnapshotId,
      "Sharingan expected Snapshot id",
    );
    const reason = text(expected.reason, "Sharingan publication reason", 4_096);
    return this.#transaction(() => {
      const resource = this.#requireResource(projectId, resourceId);
      const revision = this.getResourceRevisionForProject(projectId, resourceId, revisionId);
      if (!revision) return fail("Sharingan Resource Revision was not found");
      if (resource.headRevisionId !== expectedHeadRevisionId) {
        throw new WorkspacePointerConflictError({
          pointer: "resource-head",
          expectedId: expectedHeadRevisionId,
          actualId: resource.headRevisionId,
        });
      }
      if (revision.parentRevisionId !== expectedHeadRevisionId) {
        return fail("Sharingan Resource Revision parent does not match the expected Head");
      }
      const workspace = this.#requireWorkspace(projectId);
      if (workspace.activeSnapshotId !== expectedSnapshotId) {
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          expectedId: expectedSnapshotId,
          actualId: workspace.activeSnapshotId,
        });
      }
      const parent = this.#requireSnapshot(workspace.id, expectedSnapshotId);
      if ((parent.resourceRevisions[resource.id] ?? null) !== expectedHeadRevisionId) {
        return fail("Sharingan Resource Head and base Snapshot pin are incoherent");
      }
      if (!parent.graph.nodes.some((node) => node.resourceId === resource.id)) {
        return fail("Sharingan Resource publication requires an active graph node");
      }
      const snapshotId = this.#clock.id();
      const now = this.#clock.now();
      this.#db.prepare(
        `UPDATE resources SET head_revision_id = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      ).run(revision.id, now, resource.id, workspace.id);
      this.#db.prepare(
        `INSERT INTO workspace_snapshots (
           id, workspace_id, sequence, parent_snapshot_id, graph_revision,
           kernel_revision_id, reason, provenance_json, created_at, sealed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        snapshotId,
        workspace.id,
        this.#nextSnapshotSequence(workspace.id),
        parent.id,
        workspace.graphRevision,
        workspace.activeKernelRevisionId,
        reason,
        JSON.stringify({ kind: "resource-publication", resourceRevisionId: revision.id }),
        now,
      );
      this.#copySnapshotResourcePins(workspace.id, parent.id, snapshotId, resource.id);
      this.#db.prepare(
        `INSERT INTO workspace_snapshot_resources
           (workspace_id, snapshot_id, resource_id, revision_id)
         VALUES (?, ?, ?, ?)`,
      ).run(workspace.id, snapshotId, resource.id, revision.id);
      this.#db.prepare(
        "UPDATE workspace_snapshots SET sealed = 1 WHERE workspace_id = ? AND id = ?",
      ).run(workspace.id, snapshotId);
      this.#db.prepare(
        `UPDATE project_workspaces SET active_snapshot_id = ?, updated_at = ? WHERE id = ?`,
      ).run(snapshotId, now, workspace.id);
      return this.#requireSnapshot(workspace.id, snapshotId);
    });
  }

  listSnapshots(projectId: string): SharinganWorkspaceSnapshot[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.#db.prepare(
      `SELECT id FROM workspace_snapshots
        WHERE workspace_id = ?
        ORDER BY sequence ASC, id COLLATE BINARY ASC`,
    ).all(workspace.id) as Array<{ id: string }>;
    return rows.map((row) => this.#requireSnapshot(workspace.id, row.id));
  }

  #nextSnapshotSequence(workspaceId: string): number {
    const row = this.#db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
         FROM workspace_snapshots WHERE workspace_id = ?`,
    ).get(workspaceId) as { sequence: number };
    return positiveInteger(row.sequence, "Sharingan Workspace Snapshot sequence");
  }

  #copySnapshotResourcePins(
    workspaceId: string,
    sourceSnapshotId: string,
    destinationSnapshotId: string,
    excludedResourceId?: string,
  ): void {
    const rows = this.#db.prepare(
      `SELECT resource_id, revision_id
         FROM workspace_snapshot_resources
        WHERE workspace_id = ? AND snapshot_id = ?
        ORDER BY resource_id COLLATE BINARY ASC`,
    ).all(workspaceId, sourceSnapshotId) as Array<{ resource_id: string; revision_id: string }>;
    for (const row of rows) {
      if (row.resource_id === excludedResourceId) continue;
      this.#db.prepare(
        `INSERT INTO workspace_snapshot_resources
           (workspace_id, snapshot_id, resource_id, revision_id)
         VALUES (?, ?, ?, ?)`,
      ).run(workspaceId, destinationSnapshotId, row.resource_id, row.revision_id);
    }
  }

  #requireSnapshot(workspaceId: string, snapshotId: string): SharinganWorkspaceSnapshot {
    const row = this.#db.prepare(
      `SELECT * FROM workspace_snapshots WHERE workspace_id = ? AND id = ?`,
    ).get(workspaceId, snapshotId) as Row | undefined;
    if (!row) return fail(`Sharingan Workspace Snapshot was not found: ${snapshotId}`);
    let rawProvenance: unknown;
    try {
      rawProvenance = JSON.parse(String(row.provenance_json));
    } catch {
      return fail("Sharingan Workspace Snapshot provenance JSON is invalid");
    }
    const graph = this.#graph(
      workspaceId,
      nonNegativeInteger(row.graph_revision, "Sharingan Workspace Snapshot graph Revision"),
    );
    const pins = this.#db.prepare(
      `SELECT resource_id, revision_id
         FROM workspace_snapshot_resources
        WHERE workspace_id = ? AND snapshot_id = ?
        ORDER BY resource_id COLLATE BINARY ASC`,
    ).all(workspaceId, snapshotId) as Array<{ resource_id: string; revision_id: string }>;
    const resourceRevisions: Record<string, string> = {};
    for (const pin of pins) {
      const resourceId = identifier(pin.resource_id, "Sharingan Snapshot Resource id");
      resourceRevisions[resourceId] = identifier(pin.revision_id, "Sharingan Snapshot Revision id");
    }
    return {
      id: identifier(row.id, "Sharingan Workspace Snapshot id"),
      workspaceId: identifier(row.workspace_id, "Sharingan Workspace Snapshot Workspace id"),
      sequence: positiveInteger(row.sequence, "Sharingan Workspace Snapshot sequence"),
      parentSnapshotId: row.parent_snapshot_id == null
        ? null
        : identifier(row.parent_snapshot_id, "Sharingan Workspace Snapshot parent id"),
      graphRevision: graph.revision,
      kernelRevisionId: identifier(row.kernel_revision_id, "Sharingan Workspace Snapshot Kernel id"),
      reason: text(row.reason, "Sharingan Workspace Snapshot reason", 4_096),
      provenance: asProvenance(rawProvenance),
      createdAt: timestamp(row.created_at, "Sharingan Workspace Snapshot created_at"),
      graph,
      resourceRevisions,
    };
  }

  #validateRevisionParent(revision: SharinganResourceRevision): void {
    if (revision.parentRevisionId === null) {
      if (revision.sequence !== 1) return fail("Sharingan first Revision sequence is invalid");
      return;
    }
    const row = this.#db.prepare(
      `SELECT workspace_id, resource_id, sequence
         FROM resource_revisions WHERE id = ?`,
    ).get(revision.parentRevisionId) as Row | undefined;
    if (!row || row.workspace_id !== revision.workspaceId || row.resource_id !== revision.resourceId
      || Number(row.sequence) + 1 !== revision.sequence) {
      return fail("Sharingan Resource Revision ancestry is invalid");
    }
  }
}
