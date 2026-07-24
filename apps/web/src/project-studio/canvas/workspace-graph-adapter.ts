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
  isComponentLibraryGroupId,
  layoutObjectMap,
  materializeWorkspaceLayout,
  resolveWorkspaceEdgeRoute,
  workspaceEdgeLaneMap,
} from "./workspace-layout.ts";

export type SemanticZoomLevel = "overview" | "compact" | "full";
export type WorkspaceEdgeFilter = "flow" | "relations" | "all";
export type WorkspaceFlowNodeType = WorkspaceNode["kind"] | "group" | "proposal";

export interface WorkspaceFlowNodeData extends Record<string, unknown> {
  objectId: string;
  kind: WorkspaceFlowNodeType;
  name: string;
  projectId: string | null;
  artifactId: string | null;
  resourceId: string | null;
  resourceKind?: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference" | null;
  resourceQualityState?: "grounded" | "needs-review" | null;
  revisionId: string | null;
  zoomLevel: SemanticZoomLevel;
  incomingCount: number;
  outgoingCount: number;
  qualityState: "passed" | "needs-attention" | "failed" | "unassessed" | "not-applicable";
  qualityScore: number | null;
  generationState: "idle" | "awaiting-selection" | "queued" | "running" | "complete" | "failed";
  collapsed: boolean;
  parentGroupId: string | null;
  groupRole: "component-library" | "freeform" | null;
  memberCount: number;
  minimumGroupWidth: number;
  minimumGroupHeight: number;
  expandedGroupWidth?: number;
  expandedGroupHeight?: number;
  onToggleCollapsed?: (groupId: string, collapsed: boolean) => void;
  onRenameGroup?: (groupId: string, label: string) => void;
  onResizeGroup?: (groupId: string, bounds: { x: number; y: number; width: number; height: number }) => void;
}

export interface WorkspaceEdgeData extends Record<string, unknown> {
  kind: WorkspaceEdge["kind"];
  status: "planned" | "interactive" | "broken" | null;
  label: string;
  zoomLevel: SemanticZoomLevel;
  lane: number;
}

export type WorkspaceFlowNode = Node<WorkspaceFlowNodeData, WorkspaceFlowNodeType>;
export type WorkspaceFlowEdge = Edge<WorkspaceEdgeData>;

const COLLAPSED_FREEFORM_GROUP_WIDTH = 264;
const COLLAPSED_COMPONENT_LIBRARY_WIDTH = 312;
const COLLAPSED_GROUP_HEIGHT = 48;

export interface WorkspaceGraphView {
  zoom: number;
  edgeFilter: WorkspaceEdgeFilter;
  projectId?: string;
  artifactRevisionIds?: Readonly<Record<string, string | null>>;
  resourceRevisionStates?: Readonly<Record<string, {
    revisionId: string;
    resourceKind: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference";
    qualityState: "grounded" | "needs-review" | null;
  }>>;
  awaitingSelectionResourceIds?: ReadonlySet<string>;
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
  graphNodes: ReadonlyMap<string, WorkspaceNode>,
  view: WorkspaceGraphView,
): WorkspaceFlowNode {
  const componentLibrary = isComponentLibraryGroupId(group.id);
  const directChildren = [...byId.values()].filter((object) => object.parentGroupId === group.id);
  const rightPadding = componentLibrary ? 40 : 24;
  const bottomPadding = componentLibrary ? 48 : 24;
  const collapsedWidth = componentLibrary
    ? COLLAPSED_COMPONENT_LIBRARY_WIDTH
    : COLLAPSED_FREEFORM_GROUP_WIDTH;
  const minimumGroupWidth = Math.max(
    componentLibrary ? 360 : 240,
    ...directChildren.map((child) => {
      const size = child.kind === "group"
        ? { width: child.width, height: child.height }
        : WORKSPACE_NODE_SIZES[graphNodes.get(child.id)?.kind ?? "page"];
      return child.x + size.width + rightPadding;
    }),
  );
  const minimumGroupHeight = Math.max(
    componentLibrary ? 300 : 144,
    ...directChildren.map((child) => {
      const size = child.kind === "group"
        ? { width: child.width, height: child.height }
        : WORKSPACE_NODE_SIZES[graphNodes.get(child.id)?.kind ?? "page"];
      return child.y + size.height + bottomPadding;
    }),
  );
  return {
    id: group.id,
    type: "group",
    ariaLabel: `Group ${group.label}, ${group.collapsed ? "collapsed" : "expanded"}`,
    position: { x: group.x, y: group.y },
    parentId: group.parentGroupId ?? undefined,
    extent: group.parentGroupId ? "parent" : undefined,
    hidden: hasCollapsedAncestor(group, byId),
    selected: view.selectedNodeIds?.has(group.id) ?? false,
    style: group.collapsed
      ? { width: Math.min(group.width, collapsedWidth), height: COLLAPSED_GROUP_HEIGHT }
      : { width: group.width, height: group.height },
    data: {
      objectId: group.id,
      kind: "group",
      name: group.label,
      projectId: view.projectId ?? null,
      artifactId: null,
      resourceId: null,
      resourceKind: null,
      resourceQualityState: null,
      revisionId: null,
      zoomLevel: semanticZoomLevel(view.zoom),
      incomingCount: 0,
      outgoingCount: 0,
      qualityState: "not-applicable",
      qualityScore: null,
      generationState: "idle",
      collapsed: group.collapsed,
      parentGroupId: group.parentGroupId,
      groupRole: componentLibrary ? "component-library" : "freeform",
      memberCount: directChildren.filter((child) => graphNodes.get(child.id)?.kind === "component").length,
      minimumGroupWidth,
      minimumGroupHeight,
      expandedGroupWidth: group.width,
      expandedGroupHeight: group.height,
      onToggleCollapsed: view.onToggleCollapsed,
      onRenameGroup: componentLibrary ? undefined : view.onRenameGroup,
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
  const resourceState = node.kind === "resource" ? view.resourceRevisionStates?.[node.resourceId] : undefined;
  const revisionId = node.kind === "resource"
    ? resourceState?.revisionId ?? null
    : view.artifactRevisionIds?.[node.artifactId] ?? null;
  const quality = node.kind === "resource" ? null : node.quality ?? null;
  const size = WORKSPACE_NODE_SIZES[node.kind];
  return {
    id: node.id,
    type: node.kind,
    ariaLabel: `${node.kind} ${node.name}, incoming ${counts.get(node.id)?.incoming ?? 0}, outgoing ${counts.get(node.id)?.outgoing ?? 0}, quality ${node.kind === "resource" ? resourceState?.qualityState ?? "unassessed" : quality?.state ?? "unassessed"}`,
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
      projectId: view.projectId ?? null,
      artifactId: node.kind === "resource" ? null : node.artifactId,
      resourceId: node.kind === "resource" ? node.resourceId : null,
      resourceKind: node.kind === "resource" ? resourceState?.resourceKind ?? null : null,
      resourceQualityState: node.kind === "resource" ? resourceState?.qualityState ?? null : null,
      revisionId,
      zoomLevel: semanticZoomLevel(view.zoom),
      incomingCount: counts.get(node.id)?.incoming ?? 0,
      outgoingCount: counts.get(node.id)?.outgoing ?? 0,
      qualityState: node.kind === "resource" ? "not-applicable" : quality?.state ?? "unassessed",
      qualityScore: node.kind === "resource" ? null : quality?.score ?? null,
      generationState: node.kind === "resource" && view.awaitingSelectionResourceIds?.has(node.resourceId)
        ? "awaiting-selection"
        : "idle",
      collapsed: false,
      parentGroupId: layoutObject.parentGroupId,
      groupRole: null,
      memberCount: 0,
      minimumGroupWidth: 0,
      minimumGroupHeight: 0,
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

function directionalEdgeHandles(
  edge: WorkspaceEdge,
  layout: WorkspaceLayout,
  graphNodes: ReadonlyMap<string, WorkspaceNode>,
  lane = 0,
): Pick<WorkspaceFlowEdge, "sourceHandle" | "targetHandle"> {
  const sourceNode = graphNodes.get(edge.sourceNodeId);
  const targetNode = graphNodes.get(edge.targetNodeId);
  const route = resolveWorkspaceEdgeRoute(edge, layout, graphNodes, lane);
  if (!sourceNode || !targetNode || !route) return {};
  return {
    sourceHandle: `${sourceNode.kind}-source-${route.sourceSide}`,
    targetHandle: `${targetNode.kind}-target-${route.targetSide}`,
  };
}

function adaptEdge(
  edge: WorkspaceEdge,
  hiddenNodeIds: ReadonlySet<string>,
  nodeNames: ReadonlyMap<string, string>,
  layout: WorkspaceLayout,
  graphNodes: ReadonlyMap<string, WorkspaceNode>,
  view: WorkspaceGraphView,
  lane: number,
): WorkspaceFlowEdge {
  const status = edge.kind === "prototype" ? edge.prototype.status : null;
  const semanticLabel = edge.kind === "prototype" ? edge.prototype.status : edge.kind.replace("-", " ");
  const sourceName = nodeNames.get(edge.sourceNodeId) ?? edge.sourceNodeId;
  const targetName = nodeNames.get(edge.targetNodeId) ?? edge.targetNodeId;
  const displayLabel = edge.kind === "prototype" ? `to ${targetName}` : semanticLabel;
  const handles = directionalEdgeHandles(edge, layout, graphNodes, lane);
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    ...handles,
    type: edge.kind === "prototype" ? "prototype" : "relation",
    ariaLabel: `${semanticLabel} ${edge.kind === "prototype" ? "prototype" : "relation"} from ${sourceName} to ${targetName}`,
    hidden: hiddenNodeIds.has(edge.sourceNodeId) || hiddenNodeIds.has(edge.targetNodeId),
    selected: view.selectedEdgeIds?.has(edge.id) ?? false,
    zIndex: 0,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 12,
      height: 12,
      color: view.selectedEdgeIds?.has(edge.id)
        ? "var(--foreground)"
        : status === "broken"
          ? "var(--destructive)"
          : "var(--foreground-2)",
    },
    data: {
      kind: edge.kind,
      status,
      label: displayLabel,
      zoomLevel: semanticZoomLevel(view.zoom),
      lane,
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
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeNames = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const groups = sortedGroups(layout).map((group) => adaptGroup(group, byId, graphNodes, view));
  const nodes = graph.nodes.flatMap((node) => {
    const object = byId.get(node.id);
    return object ? [adaptGraphNode(node, object, byId, counts, view)] : [];
  });
  const hiddenNodeIds = new Set([...groups, ...nodes].filter((node) => node.hidden).map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) => edgePassesFilter(edge, view));
  const edgeLanes = workspaceEdgeLaneMap(visibleEdges);
  return {
    nodes: [...groups, ...nodes],
    edges: visibleEdges.map((edge) => adaptEdge(
      edge,
      hiddenNodeIds,
      nodeNames,
      layout,
      graphNodes,
      view,
      edgeLanes.get(edge.id) ?? 0,
    )),
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
