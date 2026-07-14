import {
  MarkerType,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import type {
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceLayout,
  WorkspaceLayoutObject,
  WorkspaceNode,
} from "../../lib/api.ts";
import {
  WORKSPACE_NODE_SIZES,
  layoutObjectMap,
  materializeWorkspaceLayout,
} from "./workspace-layout.ts";

export type SemanticZoomLevel = "overview" | "compact" | "full";
export type WorkspaceEdgeFilter = "flow" | "relations" | "all";
export type WorkspaceFlowNodeType = WorkspaceNode["kind"] | "group" | "proposal";

export interface WorkspaceFlowNodeData extends Record<string, unknown> {
  objectId: string;
  kind: WorkspaceFlowNodeType;
  name: string;
  artifactId: string | null;
  resourceId: string | null;
  revisionId: string | null;
  thumbnailUrl: string | null;
  zoomLevel: SemanticZoomLevel;
  incomingCount: number;
  outgoingCount: number;
  qualityState: "passed" | "needs-attention" | "failed" | "unassessed" | "not-applicable";
  qualityScore: number | null;
  generationState: "idle" | "queued" | "running" | "complete" | "failed";
  collapsed: boolean;
  parentGroupId: string | null;
  onToggleCollapsed?: (groupId: string, collapsed: boolean) => void;
  onRenameGroup?: (groupId: string, label: string) => void;
  onResizeGroup?: (groupId: string, bounds: { x: number; y: number; width: number; height: number }) => void;
}

export interface WorkspaceEdgeData extends Record<string, unknown> {
  kind: WorkspaceEdge["kind"];
  status: "planned" | "interactive" | "broken" | null;
  label: string;
}

export type WorkspaceFlowNode = Node<WorkspaceFlowNodeData, WorkspaceFlowNodeType>;
export type WorkspaceFlowEdge = Edge<WorkspaceEdgeData>;

export interface WorkspaceGraphView {
  zoom: number;
  edgeFilter: WorkspaceEdgeFilter;
  projectId?: string;
  artifactRevisionIds?: Readonly<Record<string, string | null>>;
  selectedNodeIds?: ReadonlySet<string>;
  selectedEdgeIds?: ReadonlySet<string>;
  onToggleCollapsed?: WorkspaceFlowNodeData["onToggleCollapsed"];
  onRenameGroup?: WorkspaceFlowNodeData["onRenameGroup"];
  onResizeGroup?: WorkspaceFlowNodeData["onResizeGroup"];
}

export interface WorkspaceFlowModel {
  nodes: WorkspaceFlowNode[];
  edges: WorkspaceFlowEdge[];
}

export function semanticZoomLevel(zoom: number): SemanticZoomLevel {
  if (zoom < 0.38) return "overview";
  if (zoom < 0.72) return "compact";
  return "full";
}

function groupDepth(group: Extract<WorkspaceLayoutObject, { kind: "group" }>, byId: Map<string, WorkspaceLayoutObject>): number {
  let depth = 0;
  let parentId = group.parentGroupId;
  const visited = new Set([group.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "group") break;
    depth += 1;
    parentId = parent.parentGroupId;
  }
  return depth;
}

function sortedGroups(layout: WorkspaceLayout): Extract<WorkspaceLayoutObject, { kind: "group" }>[] {
  const byId = layoutObjectMap(layout);
  return layout.objects
    .filter((object): object is Extract<WorkspaceLayoutObject, { kind: "group" }> => object.kind === "group")
    .map((group, index) => ({ group, index, depth: groupDepth(group, byId) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ group }) => group);
}

function hasCollapsedAncestor(object: WorkspaceLayoutObject, byId: Map<string, WorkspaceLayoutObject>): boolean {
  let parentId = object.parentGroupId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "group") return false;
    if (parent.collapsed) return true;
    parentId = parent.parentGroupId;
  }
  return false;
}

function immutableThumbnailUrl(projectId: string | undefined, node: WorkspaceNode, revisionId: string | null): string | null {
  if (!projectId || node.kind === "resource" || !revisionId) return null;
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(node.artifactId)}/revisions/${encodeURIComponent(revisionId)}/thumbnail`;
}

interface NodeRelationCount {
  incoming: number;
  outgoing: number;
}

function edgeCounts(graph: WorkspaceGraph): Map<string, NodeRelationCount> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const counts = new Map(graph.nodes.map((node) => [node.id, { incoming: 0, outgoing: 0 }]));
  const relevant = (node: WorkspaceNode | undefined, edge: WorkspaceEdge): boolean => {
    if (node?.kind === "page") return edge.kind === "prototype";
    if (node?.kind === "component") return edge.kind === "uses";
    return node?.kind === "resource" && (edge.kind === "informs" || edge.kind === "derives-from");
  };
  for (const edge of graph.edges) {
    if (relevant(nodes.get(edge.sourceNodeId), edge)) counts.get(edge.sourceNodeId)!.outgoing += 1;
    if (relevant(nodes.get(edge.targetNodeId), edge)) counts.get(edge.targetNodeId)!.incoming += 1;
  }
  return counts;
}

function adaptGroup(
  group: Extract<WorkspaceLayoutObject, { kind: "group" }>,
  byId: Map<string, WorkspaceLayoutObject>,
  view: WorkspaceGraphView,
): WorkspaceFlowNode {
  return {
    id: group.id,
    type: "group",
    ariaLabel: `Group ${group.label}, ${group.collapsed ? "collapsed" : "expanded"}`,
    position: { x: group.x, y: group.y },
    parentId: group.parentGroupId ?? undefined,
    extent: group.parentGroupId ? "parent" : undefined,
    hidden: hasCollapsedAncestor(group, byId),
    selected: view.selectedNodeIds?.has(group.id) ?? false,
    style: { width: group.width, height: group.height },
    data: {
      objectId: group.id,
      kind: "group",
      name: group.label,
      artifactId: null,
      resourceId: null,
      revisionId: null,
      thumbnailUrl: null,
      zoomLevel: semanticZoomLevel(view.zoom),
      incomingCount: 0,
      outgoingCount: 0,
      qualityState: "not-applicable",
      qualityScore: null,
      generationState: "idle",
      collapsed: group.collapsed,
      parentGroupId: group.parentGroupId,
      onToggleCollapsed: view.onToggleCollapsed,
      onRenameGroup: view.onRenameGroup,
      onResizeGroup: view.onResizeGroup,
    },
  };
}

function adaptGraphNode(
  node: WorkspaceNode,
  layoutObject: WorkspaceLayoutObject,
  byId: Map<string, WorkspaceLayoutObject>,
  counts: ReadonlyMap<string, NodeRelationCount>,
  view: WorkspaceGraphView,
): WorkspaceFlowNode {
  const revisionId = node.kind === "resource" ? null : view.artifactRevisionIds?.[node.artifactId] ?? null;
  const quality = node.kind === "resource" ? null : node.quality ?? null;
  const size = WORKSPACE_NODE_SIZES[node.kind];
  return {
    id: node.id,
    type: node.kind,
    ariaLabel: `${node.kind} ${node.name}, incoming ${counts.get(node.id)?.incoming ?? 0}, outgoing ${counts.get(node.id)?.outgoing ?? 0}, quality ${node.kind === "resource" ? "not applicable" : quality?.state ?? "unassessed"}`,
    position: { x: layoutObject.x, y: layoutObject.y },
    parentId: layoutObject.parentGroupId ?? undefined,
    extent: layoutObject.parentGroupId ? "parent" : undefined,
    hidden: hasCollapsedAncestor(layoutObject, byId),
    selected: view.selectedNodeIds?.has(node.id) ?? false,
    style: { width: size.width, height: size.height },
    data: {
      objectId: node.id,
      kind: node.kind,
      name: node.name,
      artifactId: node.kind === "resource" ? null : node.artifactId,
      resourceId: node.kind === "resource" ? node.resourceId : null,
      revisionId,
      thumbnailUrl: immutableThumbnailUrl(view.projectId, node, revisionId),
      zoomLevel: semanticZoomLevel(view.zoom),
      incomingCount: counts.get(node.id)?.incoming ?? 0,
      outgoingCount: counts.get(node.id)?.outgoing ?? 0,
      qualityState: node.kind === "resource" ? "not-applicable" : quality?.state ?? "unassessed",
      qualityScore: node.kind === "resource" ? null : quality?.score ?? null,
      generationState: "idle",
      collapsed: false,
      parentGroupId: layoutObject.parentGroupId,
    },
  };
}

function edgePassesFilter(edge: WorkspaceEdge, view: WorkspaceGraphView): boolean {
  if (view.selectedEdgeIds?.has(edge.id)) return true;
  if (view.edgeFilter === "all") return true;
  if (view.edgeFilter === "relations") return edge.kind !== "prototype";
  if (edge.kind === "prototype") return true;
  const selection = view.selectedNodeIds;
  return Boolean(selection?.has(edge.sourceNodeId) || selection?.has(edge.targetNodeId));
}

function adaptEdge(
  edge: WorkspaceEdge,
  hiddenNodeIds: ReadonlySet<string>,
  nodeNames: ReadonlyMap<string, string>,
  view: WorkspaceGraphView,
): WorkspaceFlowEdge {
  const status = edge.kind === "prototype" ? edge.prototype.status : null;
  const label = edge.kind === "prototype" ? edge.prototype.status : edge.kind.replace("-", " ");
  const sourceName = nodeNames.get(edge.sourceNodeId) ?? edge.sourceNodeId;
  const targetName = nodeNames.get(edge.targetNodeId) ?? edge.targetNodeId;
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: edge.kind === "prototype" ? "prototype" : "relation",
    ariaLabel: `${label} ${edge.kind === "prototype" ? "prototype" : "relation"} from ${sourceName} to ${targetName}`,
    hidden: hiddenNodeIds.has(edge.sourceNodeId) || hiddenNodeIds.has(edge.targetNodeId),
    selected: view.selectedEdgeIds?.has(edge.id) ?? false,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    data: {
      kind: edge.kind,
      status,
      label,
    },
  };
}

export function workspaceGraphToFlow(
  graph: WorkspaceGraph,
  sourceLayout: WorkspaceLayout,
  view: WorkspaceGraphView,
): WorkspaceFlowModel {
  const layout = materializeWorkspaceLayout(graph, sourceLayout);
  const byId = layoutObjectMap(layout);
  const counts = edgeCounts(graph);
  const nodeNames = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const groups = sortedGroups(layout).map((group) => adaptGroup(group, byId, view));
  const nodes = graph.nodes.flatMap((node) => {
    const object = byId.get(node.id);
    return object ? [adaptGraphNode(node, object, byId, counts, view)] : [];
  });
  const hiddenNodeIds = new Set([...groups, ...nodes].filter((node) => node.hidden).map((node) => node.id));
  return {
    nodes: [...groups, ...nodes],
    edges: graph.edges
      .filter((edge) => edgePassesFilter(edge, view))
      .map((edge) => adaptEdge(edge, hiddenNodeIds, nodeNames, view)),
  };
}

export function isValidWorkspaceConnection(
  connection: Pick<Connection, "source" | "target">,
  graph: WorkspaceGraph,
): boolean {
  const { source, target } = connection;
  if (!source || !target) return false;
  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  if (sourceNode?.kind !== "page" || targetNode?.kind !== "page") return false;
  return true;
}

function freshId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createPlannedPrototypeCommand(
  graph: WorkspaceGraph,
  connection: Pick<Connection, "source" | "target">,
  ids: { commandId?: string; edgeId?: string } = {},
): Extract<WorkspaceGraphCommand, { type: "add-edge" }> {
  if (!isValidWorkspaceConnection(connection, graph)) throw new Error("Prototype connections require Page nodes");
  return {
    id: ids.commandId ?? freshId("command"),
    type: "add-edge",
    edge: {
      id: ids.edgeId ?? freshId("edge"),
      workspaceId: graph.workspaceId,
      kind: "prototype",
      sourceNodeId: connection.source!,
      targetNodeId: connection.target!,
    },
  };
}
