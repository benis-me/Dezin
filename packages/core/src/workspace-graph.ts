import type {
  DesignNodeLocator,
  NewWorkspaceEdge,
  NewWorkspaceNode,
  PrototypeBinding,
  PrototypeEdge,
  PrototypeTransition,
  ResourceKind,
  ResourcePinPolicy,
  WorkspaceEdge,
  WorkspaceEdgeKind,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceNode,
} from "./workspace-types.ts";

type UnknownRecord = Record<string, unknown>;

const COMMAND_TYPES = [
  "add-node",
  "rename-node",
  "archive-node",
  "add-edge",
  "remove-edge",
  "bind-prototype",
] as const;
const NODE_KINDS = ["page", "component", "resource"] as const;
const EDGE_KINDS = ["prototype", "uses", "informs", "derives-from"] as const;
const RESOURCE_KINDS: readonly ResourceKind[] = [
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
];
const RESOURCE_PIN_POLICIES: readonly ResourcePinPolicy[] = ["follow-head", "pin-current", "manual"];
const PROTOTYPE_TRIGGERS = ["click", "submit"] as const;
const PROTOTYPE_TRANSITIONS = ["none", "fade", "slide"] as const;
const PROTOTYPE_STATUSES = ["planned", "interactive", "broken"] as const;

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

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as UnknownRecord;
}

function rejectUnexpectedFields(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) invalid(`unexpected field ${field} in ${label}`);
  }
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${label} must be a non-empty string`);
  return value.trim();
}

function exactString(value: unknown, label: string): string {
  const canonical = canonicalString(value, label);
  if (canonical !== value) invalid(`${label} must not have surrounding whitespace`);
  return canonical;
}

function optionalCanonicalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : canonicalString(value, label);
}

function canonicalEnum<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: Values,
): Values[number] {
  const canonical = canonicalString(value, label);
  if (!(allowed as readonly string[]).includes(canonical)) invalid(`unsupported ${label} ${canonical}`);
  return canonical as Values[number];
}

function exactEnum<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: Values,
): Values[number] {
  const exact = exactString(value, label);
  if (!(allowed as readonly string[]).includes(exact)) invalid(`unsupported ${label} ${exact}`);
  return exact as Values[number];
}

function normalizeDesignNodeLocator(value: unknown): DesignNodeLocator {
  const locator = requireRecord(value, "prototype source locator");
  rejectUnexpectedFields(locator, ["designNodeId", "sourcePath", "selector"], "prototype source locator");
  const sourcePath = optionalCanonicalString(locator.sourcePath, "prototype source path");
  const selector = optionalCanonicalString(locator.selector, "prototype selector");
  return {
    designNodeId: canonicalString(locator.designNodeId, "prototype source locator design node id"),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(selector === undefined ? {} : { selector }),
  };
}

function normalizePrototypeTransition(value: unknown): PrototypeTransition {
  const transition = requireRecord(value, "prototype transition");
  rejectUnexpectedFields(transition, ["type", "durationMs", "easing"], "prototype transition");
  const type = canonicalEnum(transition.type, "prototype transition", PROTOTYPE_TRANSITIONS);
  const durationMs = transition.durationMs;
  if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) {
    invalid("prototype transition duration must be a non-negative number");
  }
  const easing = optionalCanonicalString(transition.easing, "prototype transition easing");
  return {
    type,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(easing === undefined ? {} : { easing }),
  };
}

function normalizePrototypeBinding(value: unknown): PrototypeBinding {
  const binding = requireRecord(value, "prototype binding");
  rejectUnexpectedFields(
    binding,
    [
      "sourceArtifactId",
      "sourceRevisionId",
      "sourceLocator",
      "trigger",
      "targetArtifactId",
      "targetState",
      "transition",
    ],
    "prototype binding",
  );
  const targetState = optionalCanonicalString(binding.targetState, "prototype target state");
  const transition = binding.transition === undefined ? undefined : normalizePrototypeTransition(binding.transition);
  return {
    sourceArtifactId: canonicalString(binding.sourceArtifactId, "prototype source artifact id"),
    sourceRevisionId: canonicalString(binding.sourceRevisionId, "prototype source revision id"),
    sourceLocator: normalizeDesignNodeLocator(binding.sourceLocator),
    trigger: canonicalEnum(binding.trigger, "prototype trigger", PROTOTYPE_TRIGGERS),
    targetArtifactId: canonicalString(binding.targetArtifactId, "prototype target artifact id"),
    ...(targetState === undefined ? {} : { targetState }),
    ...(transition === undefined ? {} : { transition }),
  };
}

function normalizeWorkspaceNode(value: unknown): NewWorkspaceNode {
  const node = requireRecord(value, "add-node node");
  const kind = canonicalEnum(node.kind, "workspace node kind", NODE_KINDS);
  const id = canonicalString(node.id, "node id");
  const name = canonicalString(node.name, `node ${id} name`);

  if (kind === "page" || kind === "component") {
    rejectUnexpectedFields(node, ["id", "kind", "name", "artifactId", "createIdentity"], "add-node node");
    const createIdentityValue = node.createIdentity;
    let createIdentity: { initialTrackId: string } | undefined;
    if (createIdentityValue !== undefined) {
      const identity = requireRecord(createIdentityValue, "artifact createIdentity");
      rejectUnexpectedFields(identity, ["initialTrackId"], "artifact createIdentity");
      createIdentity = { initialTrackId: canonicalString(identity.initialTrackId, "initial track id") };
    }
    return {
      id,
      kind,
      name,
      artifactId: canonicalString(node.artifactId, `${kind} node ${id} artifactId`),
      ...(createIdentity === undefined ? {} : { createIdentity }),
    };
  }

  rejectUnexpectedFields(node, ["id", "kind", "name", "resourceId", "createIdentity"], "add-node node");
  const createIdentityValue = node.createIdentity;
  let createIdentity: { resourceKind: ResourceKind; defaultPinPolicy: ResourcePinPolicy } | undefined;
  if (createIdentityValue !== undefined) {
    const identity = requireRecord(createIdentityValue, "resource createIdentity");
    rejectUnexpectedFields(identity, ["resourceKind", "defaultPinPolicy"], "resource createIdentity");
    const resourceKind = canonicalString(identity.resourceKind, "resource identity kind");
    const defaultPinPolicy = canonicalString(identity.defaultPinPolicy, "resource pin policy");
    if (!RESOURCE_KINDS.includes(resourceKind as ResourceKind)) invalid(`unsupported resource identity kind ${resourceKind}`);
    if (!RESOURCE_PIN_POLICIES.includes(defaultPinPolicy as ResourcePinPolicy)) {
      invalid(`unsupported resource pin policy ${defaultPinPolicy}`);
    }
    createIdentity = {
      resourceKind: resourceKind as ResourceKind,
      defaultPinPolicy: defaultPinPolicy as ResourcePinPolicy,
    };
  }
  return {
    id,
    kind: "resource",
    name,
    resourceId: canonicalString(node.resourceId, `resource node ${id} resourceId`),
    ...(createIdentity === undefined ? {} : { createIdentity }),
  };
}

function normalizeWorkspaceEdge(value: unknown): NewWorkspaceEdge {
  const edge = requireRecord(value, "add-edge edge");
  rejectUnexpectedFields(
    edge,
    ["id", "workspaceId", "kind", "sourceNodeId", "targetNodeId"],
    "add-edge edge",
  );
  const kind = canonicalEnum(edge.kind, "workspace edge kind", EDGE_KINDS);
  return {
    id: canonicalString(edge.id, "edge id"),
    workspaceId: canonicalString(edge.workspaceId, "edge workspace id"),
    kind,
    sourceNodeId: canonicalString(edge.sourceNodeId, "edge source node id"),
    targetNodeId: canonicalString(edge.targetNodeId, "edge target node id"),
  };
}

function normalizeWorkspaceGraphCommand(value: unknown, index: number): WorkspaceGraphCommand {
  const command = requireRecord(value, `command at index ${index}`);
  const type = canonicalEnum(command.type, "workspace graph command type", COMMAND_TYPES);
  const id = canonicalString(command.id, "command id");
  switch (type) {
    case "add-node":
      rejectUnexpectedFields(command, ["id", "type", "node"], "add-node command");
      return { id, type, node: normalizeWorkspaceNode(command.node) };
    case "rename-node":
      rejectUnexpectedFields(command, ["id", "type", "nodeId", "name"], "rename-node command");
      return {
        id,
        type,
        nodeId: canonicalString(command.nodeId, "rename node id"),
        name: canonicalString(command.name, "renamed node name"),
      };
    case "archive-node":
      rejectUnexpectedFields(command, ["id", "type", "nodeId"], "archive-node command");
      return { id, type, nodeId: canonicalString(command.nodeId, "archive node id") };
    case "add-edge":
      rejectUnexpectedFields(command, ["id", "type", "edge"], "add-edge command");
      return { id, type, edge: normalizeWorkspaceEdge(command.edge) };
    case "remove-edge":
      rejectUnexpectedFields(command, ["id", "type", "edgeId"], "remove-edge command");
      return { id, type, edgeId: canonicalString(command.edgeId, "remove edge id") };
    case "bind-prototype":
      rejectUnexpectedFields(command, ["id", "type", "edgeId", "binding"], "bind-prototype command");
      return {
        id,
        type,
        edgeId: canonicalString(command.edgeId, "prototype edge id"),
        binding: normalizePrototypeBinding(command.binding),
      };
  }
}

export function normalizeWorkspaceGraphCommands(commands: unknown): WorkspaceGraphCommand[] {
  if (!Array.isArray(commands)) invalid("workspace graph commands must be an array");
  if (commands.length === 0) invalid("workspace graph command batch must contain at least one command");
  return Array.from(commands, (command, index) => normalizeWorkspaceGraphCommand(command, index));
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

function validateNode(value: unknown, workspaceId: string): WorkspaceNode {
  const node = requireRecord(value, "workspace node");
  const id = exactString(node.id, "node id");
  const nodeWorkspaceId = exactString(node.workspaceId, `node ${id} workspace id`);
  if (nodeWorkspaceId !== workspaceId) {
    invalid(`node ${id} belongs to workspace ${nodeWorkspaceId}, not ${workspaceId}`);
  }
  exactString(node.name, `node ${id} name`);
  const kind = exactEnum(node.kind, "workspace node kind", NODE_KINDS);

  if (kind === "page" || kind === "component") {
    exactString(node.artifactId, `${kind} node ${id} artifactId`);
    if (node.resourceId !== undefined) invalid(`${kind} node ${id} cannot reference resourceId`);
  } else {
    exactString(node.resourceId, `resource node ${id} resourceId`);
    if (node.artifactId !== undefined) invalid(`resource node ${id} must reference resourceId only`);
  }
  return value as WorkspaceNode;
}

function validateBinding(value: unknown, source: WorkspaceNode, target: WorkspaceNode): void {
  const binding = normalizePrototypeBinding(value);
  if (source.kind !== "page" || target.kind !== "page") invalid("prototype bindings require page to page nodes");
  if (binding.sourceArtifactId !== source.artifactId) {
    invalid("prototype binding source artifact does not match edge source");
  }
  if (binding.targetArtifactId !== target.artifactId) {
    invalid("prototype binding target artifact does not match edge target");
  }
}

function validatePrototypePayload(
  value: unknown,
  edgeId: string,
  source: WorkspaceNode,
  target: WorkspaceNode,
): PrototypeEdge {
  const prototype = requireRecord(value, `prototype edge ${edgeId} payload`);
  rejectUnexpectedFields(prototype, ["status", "binding", "brokenReason"], `prototype edge ${edgeId} payload`);
  const status = exactEnum(prototype.status, "prototype edge status", PROTOTYPE_STATUSES);
  const hasBinding = Object.hasOwn(prototype, "binding");
  const hasBrokenReason = Object.hasOwn(prototype, "brokenReason");

  if (status === "planned") {
    if (hasBinding || hasBrokenReason) invalid(`planned prototype edge ${edgeId} cannot carry binding or brokenReason`);
    return value as PrototypeEdge;
  }
  if (status === "interactive") {
    if (!hasBinding || prototype.binding === undefined) invalid(`interactive prototype edge ${edgeId} requires a binding`);
    if (hasBrokenReason) invalid(`interactive prototype edge ${edgeId} cannot carry brokenReason`);
    validateBinding(prototype.binding, source, target);
    return value as PrototypeEdge;
  }

  canonicalString(prototype.brokenReason, `broken prototype edge ${edgeId} reason`);
  if (prototype.binding !== undefined) validateBinding(prototype.binding, source, target);
  return value as PrototypeEdge;
}

function validateEdge(
  value: unknown,
  workspaceId: string,
  nodesById: ReadonlyMap<string, WorkspaceNode>,
): WorkspaceEdge {
  const edge = requireRecord(value, "workspace edge");
  const id = exactString(edge.id, "edge id");
  const edgeWorkspaceId = exactString(edge.workspaceId, `edge ${id} workspace id`);
  if (edgeWorkspaceId !== workspaceId) {
    invalid(`edge ${id} belongs to workspace ${edgeWorkspaceId}, not ${workspaceId}`);
  }
  const kind = exactEnum(edge.kind, "workspace edge kind", EDGE_KINDS);
  const sourceNodeId = exactString(edge.sourceNodeId, `edge ${id} source node id`);
  const targetNodeId = exactString(edge.targetNodeId, `edge ${id} target node id`);
  const source = nodesById.get(sourceNodeId);
  if (!source) invalid(`edge ${id} source node ${sourceNodeId} does not exist`);
  const target = nodesById.get(targetNodeId);
  if (!target) invalid(`edge ${id} target node ${targetNodeId} does not exist`);

  switch (kind) {
    case "prototype":
      if (source.kind !== "page" || target.kind !== "page") invalid(`prototype edge ${id} must connect page to page`);
      validatePrototypePayload(edge.prototype, id, source, target);
      break;
    case "uses":
      if (Object.hasOwn(edge, "prototype")) invalid(`non-prototype edge ${id} cannot carry prototype payload`);
      if (!isArtifactNode(source) || target.kind !== "component") {
        invalid(`uses edge ${id} must connect page or component to component`);
      }
      break;
    case "informs":
      if (Object.hasOwn(edge, "prototype")) invalid(`non-prototype edge ${id} cannot carry prototype payload`);
      if (source.kind !== "resource" || !isArtifactNode(target)) {
        invalid(`informs edge ${id} must connect resource to page or component`);
      }
      break;
    case "derives-from":
      if (Object.hasOwn(edge, "prototype")) invalid(`non-prototype edge ${id} cannot carry prototype payload`);
      if (!isArtifactNode(source) || target.kind !== "resource") {
        invalid(`derives-from edge ${id} must connect page or component to resource`);
      }
      break;
  }
  return value as WorkspaceEdge;
}

function validateComponentDependencies(
  nodes: readonly WorkspaceNode[],
  edges: readonly WorkspaceEdge[],
  nodesById: ReadonlyMap<string, WorkspaceNode>,
): void {
  const dependencies = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.kind === "component") dependencies.set(node.id, []);
  }
  for (const edge of edges) {
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

export function validateWorkspaceGraph(value: unknown): asserts value is WorkspaceGraph {
  const graph = requireRecord(value, "workspace graph");
  const workspaceId = exactString(graph.workspaceId, "workspace id");
  if (!Number.isInteger(graph.revision) || (graph.revision as number) < 0) {
    invalid("workspace graph revision must be a non-negative integer");
  }
  if (!Array.isArray(graph.nodes)) invalid("workspace graph nodes must be an array");
  if (!Array.isArray(graph.edges)) invalid("workspace graph edges must be an array");

  const nodesById = new Map<string, WorkspaceNode>();
  const artifactIds = new Set<string>();
  const resourceIds = new Set<string>();
  const nodes = Array.from(graph.nodes, (node) => validateNode(node, workspaceId));
  for (const node of nodes) {
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
  const edges = Array.from(graph.edges, (edge) => validateEdge(edge, workspaceId, nodesById));
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) invalid(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
  }
  validateComponentDependencies(nodes, edges, nodesById);
}

function addNode(graph: WorkspaceGraph, node: NewWorkspaceNode): void {
  if (graph.nodes.some((candidate) => candidate.id === node.id)) invalid(`duplicate node id ${node.id}`);
  if (node.kind === "page" || node.kind === "component") {
    if (graph.nodes.some((candidate) => isArtifactNode(candidate) && candidate.artifactId === node.artifactId)) {
      invalid(`duplicate artifact identity ${node.artifactId}`);
    }
    graph.nodes.push({
      id: node.id,
      workspaceId: graph.workspaceId,
      kind: node.kind,
      name: node.name,
      artifactId: node.artifactId,
    });
    return;
  }
  const resourceNode = node as Extract<NewWorkspaceNode, { kind: "resource" }>;
  if (graph.nodes.some((candidate) => candidate.kind === "resource" && candidate.resourceId === resourceNode.resourceId)) {
    invalid(`duplicate resource identity ${resourceNode.resourceId}`);
  }
  graph.nodes.push({
    id: resourceNode.id,
    workspaceId: graph.workspaceId,
    kind: "resource",
    name: resourceNode.name,
    resourceId: resourceNode.resourceId,
  });
}

function addEdge(graph: WorkspaceGraph, edge: NewWorkspaceEdge): void {
  if (edge.kind === "uses") invalid("uses edges are derived and cannot be inserted manually");
  if (graph.edges.some((candidate) => candidate.id === edge.id)) invalid(`duplicate edge id ${edge.id}`);
  if (edge.workspaceId !== graph.workspaceId) {
    invalid(`edge ${edge.id} belongs to workspace ${edge.workspaceId}, not ${graph.workspaceId}`);
  }
  if (edge.kind === "prototype") {
    graph.edges.push({ ...edge, prototype: { status: "planned" } });
    return;
  }
  graph.edges.push(edge);
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
      requireNode(graph, command.nodeId).name = command.name;
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

export function applyWorkspaceGraphCommands(graph: WorkspaceGraph, commands: unknown): WorkspaceGraph {
  const normalizedCommands = normalizeWorkspaceGraphCommands(commands);
  validateWorkspaceGraph(graph);
  const next = structuredClone(graph);
  const commandIds = new Set<string>();
  for (const command of normalizedCommands) {
    if (commandIds.has(command.id)) invalid(`duplicate command id ${command.id}`);
    commandIds.add(command.id);
    applyOne(next, command);
  }
  validateWorkspaceGraph(next);
  return { ...next, revision: graph.revision + 1 };
}
