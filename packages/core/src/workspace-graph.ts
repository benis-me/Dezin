import type {
  NewWorkspaceEdge,
  NewWorkspaceNode,
  PrototypeBinding,
  ResourceKind,
  ResourcePinPolicy,
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceNode,
} from "./workspace-types.ts";

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
    super(`workspace graph revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = "WorkspaceRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function invalid(message: string): never {
  throw new WorkspaceGraphValidationError(message);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${label} must be a non-empty string`);
  return value.trim();
}

function requireNode(graph: WorkspaceGraph, nodeId: string): WorkspaceNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) invalid(`node ${nodeId} does not exist`);
  return node;
}

function requireEdge(graph: WorkspaceGraph, edgeId: string): WorkspaceEdge {
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) invalid(`edge ${edgeId} does not exist`);
  return edge;
}

function isArtifactNode(node: WorkspaceNode): node is Extract<WorkspaceNode, { kind: "page" | "component" }> {
  return node.kind === "page" || node.kind === "component";
}

function validateNode(node: WorkspaceNode, graph: WorkspaceGraph): void {
  const runtimeNode = node as unknown as { artifactId?: unknown; resourceId?: unknown };
  nonEmpty(node.id, "node id");
  if (node.workspaceId !== graph.workspaceId) {
    invalid(`node ${node.id} belongs to workspace ${node.workspaceId}, not ${graph.workspaceId}`);
  }
  nonEmpty(node.name, `node ${node.id} name`);

  if (node.kind === "page" || node.kind === "component") {
    nonEmpty(node.artifactId, `${node.kind} node ${node.id} artifactId`);
    if (runtimeNode.resourceId !== undefined) {
      invalid(`${node.kind} node ${node.id} cannot reference resourceId`);
    }
    return;
  }
  if (node.kind === "resource") {
    nonEmpty(node.resourceId, `resource node ${node.id} resourceId`);
    if (runtimeNode.artifactId !== undefined) {
      invalid(`resource node ${node.id} must reference resourceId only`);
    }
    return;
  }
  invalid(`node ${node.id} has unsupported kind ${String((node as { kind?: unknown }).kind)}`);
}

function validateBinding(binding: PrototypeBinding, source: WorkspaceNode, target: WorkspaceNode): void {
  if (!isArtifactNode(source) || source.kind !== "page" || !isArtifactNode(target) || target.kind !== "page") {
    invalid("prototype bindings require page to page nodes");
  }
  if (binding.sourceArtifactId !== source.artifactId) {
    invalid("prototype binding source artifact does not match edge source");
  }
  if (binding.targetArtifactId !== target.artifactId) {
    invalid("prototype binding target artifact does not match edge target");
  }
  nonEmpty(binding.sourceRevisionId, "prototype source revision id");
  nonEmpty(binding.sourceLocator?.designNodeId, "prototype source locator design node id");
  if (binding.trigger !== "click" && binding.trigger !== "submit") {
    invalid(`unsupported prototype trigger ${String(binding.trigger)}`);
  }
  if (binding.transition) {
    if (!(["none", "fade", "slide"] as const).includes(binding.transition.type)) {
      invalid(`unsupported prototype transition ${String(binding.transition.type)}`);
    }
    if (binding.transition.durationMs !== undefined && (!Number.isFinite(binding.transition.durationMs) || binding.transition.durationMs < 0)) {
      invalid("prototype transition duration must be a non-negative number");
    }
  }
}

function validateEdge(edge: WorkspaceEdge, graph: WorkspaceGraph, nodesById: ReadonlyMap<string, WorkspaceNode>): void {
  nonEmpty(edge.id, "edge id");
  if (edge.workspaceId !== graph.workspaceId) {
    invalid(`edge ${edge.id} belongs to workspace ${edge.workspaceId}, not ${graph.workspaceId}`);
  }
  const source = nodesById.get(edge.sourceNodeId);
  if (!source) invalid(`edge ${edge.id} source node ${edge.sourceNodeId} does not exist`);
  const target = nodesById.get(edge.targetNodeId);
  if (!target) invalid(`edge ${edge.id} target node ${edge.targetNodeId} does not exist`);

  switch (edge.kind) {
    case "prototype": {
      if (source.kind !== "page" || target.kind !== "page") invalid(`prototype edge ${edge.id} must connect page to page`);
      const status = edge.prototype?.status;
      if (status !== "planned" && status !== "interactive" && status !== "broken") {
        invalid(`prototype edge ${edge.id} has invalid status`);
      }
      if (status === "interactive" && !edge.prototype?.binding) {
        invalid(`interactive prototype edge ${edge.id} requires a binding`);
      }
      if (edge.prototype?.binding) validateBinding(edge.prototype.binding, source, target);
      return;
    }
    case "uses":
      if (!isArtifactNode(source) || target.kind !== "component") {
        invalid(`uses edge ${edge.id} must connect page or component to component`);
      }
      return;
    case "informs":
      if (source.kind !== "resource" || !isArtifactNode(target)) {
        invalid(`informs edge ${edge.id} must connect resource to page or component`);
      }
      return;
    case "derives-from":
      if (!isArtifactNode(source) || target.kind !== "resource") {
        invalid(`derives-from edge ${edge.id} must connect page or component to resource`);
      }
      return;
    default:
      invalid(`edge ${edge.id} has unsupported kind ${String((edge as { kind?: unknown }).kind)}`);
  }
}

function validateComponentDependencies(graph: WorkspaceGraph, nodesById: ReadonlyMap<string, WorkspaceNode>): void {
  const dependencies = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "component") dependencies.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "uses") continue;
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (source?.kind === "component" && target?.kind === "component") {
      dependencies.get(source.id)?.push(target.id);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) invalid(`component dependency cycle includes ${nodeId}`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of dependencies.get(nodeId) ?? []) visit(dependencyId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of dependencies.keys()) visit(nodeId);
}

export function validateWorkspaceGraph(graph: WorkspaceGraph): void {
  nonEmpty(graph.workspaceId, "workspace id");
  if (!Number.isInteger(graph.revision) || graph.revision < 0) invalid("workspace graph revision must be a non-negative integer");
  if (!Array.isArray(graph.nodes)) invalid("workspace graph nodes must be an array");
  if (!Array.isArray(graph.edges)) invalid("workspace graph edges must be an array");

  const nodesById = new Map<string, WorkspaceNode>();
  const artifactIds = new Set<string>();
  const resourceIds = new Set<string>();
  for (const node of graph.nodes) {
    validateNode(node, graph);
    if (nodesById.has(node.id)) invalid(`duplicate node id ${node.id}`);
    nodesById.set(node.id, node);
    if (isArtifactNode(node)) {
      if (artifactIds.has(node.artifactId)) invalid(`duplicate artifact identity ${node.artifactId}`);
      artifactIds.add(node.artifactId);
    } else {
      if (resourceIds.has(node.resourceId)) invalid(`duplicate resource identity ${node.resourceId}`);
      resourceIds.add(node.resourceId);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) invalid(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    validateEdge(edge, graph, nodesById);
  }
  validateComponentDependencies(graph, nodesById);
}

function validateIdentityCreation(node: NewWorkspaceNode): void {
  if (!node.createIdentity) return;
  if (node.kind === "page" || node.kind === "component") {
    nonEmpty(node.createIdentity.initialTrackId, "initial track id");
    return;
  }
  const resourceKinds: readonly ResourceKind[] = [
    "research",
    "moodboard",
    "sharingan-capture",
    "file",
    "asset",
    "effect",
    "external-reference",
  ];
  const pinPolicies: readonly ResourcePinPolicy[] = ["follow-head", "pin-current", "manual"];
  const identity = node.createIdentity as { resourceKind: ResourceKind; defaultPinPolicy: ResourcePinPolicy };
  if (!resourceKinds.includes(identity.resourceKind)) invalid("unsupported resource identity kind");
  if (!pinPolicies.includes(identity.defaultPinPolicy)) invalid("unsupported resource pin policy");
}

function addNode(graph: WorkspaceGraph, node: NewWorkspaceNode): void {
  validateIdentityCreation(node);
  const id = nonEmpty(node.id, "node id");
  const name = nonEmpty(node.name, `node ${id} name`);
  if (graph.nodes.some((candidate) => candidate.id === id)) invalid(`duplicate node id ${id}`);

  if (node.kind === "page" || node.kind === "component") {
    const artifactId = nonEmpty(node.artifactId, `${node.kind} node ${id} artifactId`);
    if (graph.nodes.some((candidate) => isArtifactNode(candidate) && candidate.artifactId === artifactId)) {
      invalid(`duplicate artifact identity ${artifactId}`);
    }
    graph.nodes.push({ id, workspaceId: graph.workspaceId, kind: node.kind, name, artifactId });
    return;
  }
  if (node.kind !== "resource") invalid(`unsupported node kind ${String((node as { kind?: unknown }).kind)}`);
  const resourceId = nonEmpty(node.resourceId, `resource node ${id} resourceId`);
  if (graph.nodes.some((candidate) => candidate.kind === "resource" && candidate.resourceId === resourceId)) {
    invalid(`duplicate resource identity ${resourceId}`);
  }
  graph.nodes.push({ id, workspaceId: graph.workspaceId, kind: "resource", name, resourceId });
}

function addEdge(graph: WorkspaceGraph, edge: NewWorkspaceEdge): void {
  if (edge.kind === "uses") invalid("uses edges are derived and cannot be inserted manually");
  const id = nonEmpty(edge.id, "edge id");
  if (graph.edges.some((candidate) => candidate.id === id)) invalid(`duplicate edge id ${id}`);
  if (edge.workspaceId !== graph.workspaceId) {
    invalid(`edge ${id} belongs to workspace ${edge.workspaceId}, not ${graph.workspaceId}`);
  }
  const normalized: WorkspaceEdge = {
    id,
    workspaceId: graph.workspaceId,
    kind: edge.kind,
    sourceNodeId: nonEmpty(edge.sourceNodeId, `edge ${id} source node id`),
    targetNodeId: nonEmpty(edge.targetNodeId, `edge ${id} target node id`),
  };
  if (edge.kind === "prototype") normalized.prototype = { status: "planned" };
  graph.edges.push(normalized);
}

function bindPrototype(graph: WorkspaceGraph, edgeId: string, binding: PrototypeBinding): void {
  const edge = requireEdge(graph, edgeId);
  if (edge.kind !== "prototype") invalid(`edge ${edgeId} is not a prototype edge`);
  const source = requireNode(graph, edge.sourceNodeId);
  const target = requireNode(graph, edge.targetNodeId);
  validateBinding(binding, source, target);
  edge.prototype = { status: "interactive", binding: structuredClone(binding) };
}

function applyOne(graph: WorkspaceGraph, command: WorkspaceGraphCommand): void {
  switch (command.type) {
    case "add-node":
      addNode(graph, command.node);
      return;
    case "rename-node":
      requireNode(graph, command.nodeId).name = nonEmpty(command.name, `node ${command.nodeId} name`);
      return;
    case "archive-node": {
      const nodeIndex = graph.nodes.findIndex((node) => node.id === command.nodeId);
      if (nodeIndex < 0) invalid(`node ${command.nodeId} does not exist`);
      graph.nodes.splice(nodeIndex, 1);
      graph.edges = graph.edges.filter(
        (edge) => edge.sourceNodeId !== command.nodeId && edge.targetNodeId !== command.nodeId,
      );
      return;
    }
    case "add-edge":
      addEdge(graph, command.edge);
      return;
    case "remove-edge": {
      const edgeIndex = graph.edges.findIndex((edge) => edge.id === command.edgeId);
      if (edgeIndex < 0) invalid(`edge ${command.edgeId} does not exist`);
      if (graph.edges[edgeIndex]?.kind === "uses") invalid("uses edges are derived and cannot be removed manually");
      graph.edges.splice(edgeIndex, 1);
      return;
    }
    case "bind-prototype":
      bindPrototype(graph, command.edgeId, command.binding);
      return;
  }
}

export function applyWorkspaceGraphCommands(
  graph: WorkspaceGraph,
  commands: readonly WorkspaceGraphCommand[],
): WorkspaceGraph {
  const next = structuredClone(graph);
  const commandIds = new Set<string>();
  for (const command of commands) {
    const commandId = nonEmpty(command.id, "command id");
    if (commandIds.has(commandId)) invalid(`duplicate command id ${commandId}`);
    commandIds.add(commandId);
    applyOne(next, command);
  }
  validateWorkspaceGraph(next);
  return { ...next, revision: graph.revision + 1 };
}
