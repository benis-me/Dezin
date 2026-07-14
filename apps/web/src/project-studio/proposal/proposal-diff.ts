import type {
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutObject,
  WorkspaceNode,
  WorkspaceViewport,
} from "../../lib/api.ts";
import {
  applyWorkspaceLayoutCommands,
  materializeWorkspaceLayout,
} from "../canvas/workspace-layout.ts";

export type ProposalOperationRef =
  | { kind: "graph"; commandId: string }
  | { kind: "layout"; index: number };

export type ProposalChangeKind = "addition" | "modification" | "removal";
export type ProposalObjectKind = "node" | "edge" | "group" | "viewport";

export interface ProposalChange<T> {
  key: string;
  objectId: string;
  objectKind: ProposalObjectKind;
  changeKind: ProposalChangeKind;
  before: T | null;
  after: T | null;
  operationRefs: ProposalOperationRef[];
  canvasObjectIds: string[];
  accessibleLabel: string;
}

export interface ProposalDiff {
  auditedGraph: WorkspaceGraph;
  auditedLayout: WorkspaceLayout | null;
  proposedGraph: WorkspaceGraph;
  proposedLayout: WorkspaceLayout | null;
  nodeChanges: ProposalChange<WorkspaceNode>[];
  edgeChanges: ProposalChange<WorkspaceEdge>[];
  groupChanges: ProposalChange<WorkspaceLayoutObject>[];
  viewportChanges: ProposalChange<WorkspaceViewport>[];
  reviewItems: ProposalChange<unknown>[];
  staleAgainstCurrent: boolean;
}

export interface ProposalDiffProposal {
  id: string;
  baseGraphRevision: number;
  baseSnapshotId: string;
  baseGraph: WorkspaceGraph;
  baseLayoutChecksum: string;
  baseLayout: WorkspaceLayout | null;
  operations: readonly WorkspaceGraphCommand[];
  layoutOperations: readonly WorkspaceLayoutCommand[];
}

export interface ProposalDiffCurrent {
  graph: WorkspaceGraph;
  activeSnapshotId: string;
  layoutChecksum?: string;
}

function nodeKindLabel(node: WorkspaceNode): string {
  if (node.kind === "resource") return "Resource";
  return node.kind === "page" ? "Page" : "Component";
}

function appendOperationRef(
  refs: Map<string, ProposalOperationRef[]>,
  objectId: string,
  ref: ProposalOperationRef,
): void {
  const current = refs.get(objectId);
  if (current) current.push(ref);
  else refs.set(objectId, [ref]);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changeKind(before: unknown | null, after: unknown | null): ProposalChangeKind {
  if (before === null) return "addition";
  if (after === null) return "removal";
  return "modification";
}

function accessibleState(kind: ProposalChangeKind): string {
  if (kind === "addition") return "addition";
  if (kind === "removal") return "removal";
  return "change";
}

function relationshipLabel(kind: WorkspaceEdge["kind"]): string {
  return kind
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toWorkspaceNode(
  workspaceId: string,
  command: Extract<WorkspaceGraphCommand, { type: "add-node" }>,
): WorkspaceNode {
  const { createIdentity: _createIdentity, ...node } = command.node;
  return { ...node, workspaceId } as WorkspaceNode;
}

function toWorkspaceEdge(
  command: Extract<WorkspaceGraphCommand, { type: "add-edge" }>,
): WorkspaceEdge {
  if (command.edge.kind === "prototype") {
    return { ...command.edge, prototype: { status: "planned" } };
  }
  return { ...command.edge } as WorkspaceEdge;
}

function replayGraph(
  proposal: ProposalDiffProposal,
): {
  graph: WorkspaceGraph;
  nodeRefs: Map<string, ProposalOperationRef[]>;
  edgeRefs: Map<string, ProposalOperationRef[]>;
} {
  const nodes = new Map(proposal.baseGraph.nodes.map((node) => [node.id, structuredClone(node)]));
  const edges = new Map(proposal.baseGraph.edges.map((edge) => [edge.id, structuredClone(edge)]));
  const nodeRefs = new Map<string, ProposalOperationRef[]>();
  const edgeRefs = new Map<string, ProposalOperationRef[]>();

  for (const command of proposal.operations) {
    const ref: ProposalOperationRef = { kind: "graph", commandId: command.id };
    switch (command.type) {
      case "add-node":
        nodes.set(command.node.id, toWorkspaceNode(proposal.baseGraph.workspaceId, command));
        appendOperationRef(nodeRefs, command.node.id, ref);
        break;
      case "rename-node": {
        const node = nodes.get(command.nodeId);
        if (node) nodes.set(command.nodeId, { ...node, name: command.name });
        appendOperationRef(nodeRefs, command.nodeId, ref);
        break;
      }
      case "archive-node": {
        nodes.delete(command.nodeId);
        appendOperationRef(nodeRefs, command.nodeId, ref);
        for (const edge of [...edges.values()]) {
          if (edge.sourceNodeId !== command.nodeId && edge.targetNodeId !== command.nodeId) continue;
          edges.delete(edge.id);
          appendOperationRef(edgeRefs, edge.id, ref);
        }
        break;
      }
      case "add-edge":
        edges.set(command.edge.id, toWorkspaceEdge(command));
        appendOperationRef(edgeRefs, command.edge.id, ref);
        break;
      case "remove-edge":
        edges.delete(command.edgeId);
        appendOperationRef(edgeRefs, command.edgeId, ref);
        break;
      case "bind-prototype": {
        const edge = edges.get(command.edgeId);
        if (edge?.kind === "prototype") {
          edges.set(command.edgeId, {
            ...edge,
            prototype: { status: "interactive", binding: structuredClone(command.binding) },
          });
        }
        appendOperationRef(edgeRefs, command.edgeId, ref);
        break;
      }
    }
  }

  return {
    graph: {
      ...proposal.baseGraph,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    },
    nodeRefs,
    edgeRefs,
  };
}

function nodeChanges(
  baseGraph: WorkspaceGraph,
  proposedGraph: WorkspaceGraph,
  refs: Map<string, ProposalOperationRef[]>,
): ProposalChange<WorkspaceNode>[] {
  const beforeNodes = new Map(baseGraph.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(proposedGraph.nodes.map((node) => [node.id, node]));
  const changes: ProposalChange<WorkspaceNode>[] = [];
  for (const [objectId, operationRefs] of refs) {
    const before = beforeNodes.get(objectId) ?? null;
    const after = afterNodes.get(objectId) ?? null;
    if (sameValue(before, after)) continue;
    const kind = changeKind(before, after);
    const displayNode = after ?? before;
    if (!displayNode) continue;
    changes.push({
      key: `node:${objectId}`,
      objectId,
      objectKind: "node",
      changeKind: kind,
      before,
      after,
      operationRefs: [...operationRefs],
      canvasObjectIds: [objectId],
      accessibleLabel: `Proposed ${accessibleState(kind)}: ${nodeKindLabel(displayNode)} ${displayNode.name}`,
    });
  }
  return changes;
}

function edgeChanges(
  baseGraph: WorkspaceGraph,
  proposedGraph: WorkspaceGraph,
  refs: Map<string, ProposalOperationRef[]>,
): ProposalChange<WorkspaceEdge>[] {
  const beforeEdges = new Map(baseGraph.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(proposedGraph.edges.map((edge) => [edge.id, edge]));
  const baseNodes = new Map(baseGraph.nodes.map((node) => [node.id, node]));
  const proposedNodes = new Map(proposedGraph.nodes.map((node) => [node.id, node]));
  const changes: ProposalChange<WorkspaceEdge>[] = [];
  for (const [objectId, operationRefs] of refs) {
    const before = beforeEdges.get(objectId) ?? null;
    const after = afterEdges.get(objectId) ?? null;
    if (sameValue(before, after)) continue;
    const kind = changeKind(before, after);
    const displayEdge = after ?? before;
    if (!displayEdge) continue;
    const source = proposedNodes.get(displayEdge.sourceNodeId) ?? baseNodes.get(displayEdge.sourceNodeId);
    const target = proposedNodes.get(displayEdge.targetNodeId) ?? baseNodes.get(displayEdge.targetNodeId);
    changes.push({
      key: `edge:${objectId}`,
      objectId,
      objectKind: "edge",
      changeKind: kind,
      before,
      after,
      operationRefs: [...operationRefs],
      canvasObjectIds: [displayEdge.sourceNodeId, displayEdge.targetNodeId, objectId],
      accessibleLabel: `Proposed ${accessibleState(kind)}: ${relationshipLabel(displayEdge.kind)} from ${source?.name ?? displayEdge.sourceNodeId} to ${target?.name ?? displayEdge.targetNodeId}`,
    });
  }
  return changes;
}

function directLayoutObjectId(command: WorkspaceLayoutCommand): string | null {
  switch (command.type) {
    case "add-group":
      return command.groupId;
    case "rename-group":
    case "delete-group":
    case "resize-group":
    case "set-collapsed":
      return command.groupId;
    case "set-parent":
    case "move":
      return command.objectId;
    case "set-viewport":
      return null;
  }
}

function ensureCoreLayoutObject(
  layout: WorkspaceLayout,
  command: WorkspaceLayoutCommand,
  semanticNodeIds: ReadonlySet<string>,
): WorkspaceLayout {
  if (command.type !== "move" && command.type !== "set-parent") return layout;
  if (layout.objects.some((object) => object.id === command.objectId)) return layout;
  if (!semanticNodeIds.has(command.objectId)) return layout;
  return {
    ...layout,
    objects: [...layout.objects, {
      id: command.objectId,
      kind: "node",
      x: 0,
      y: 0,
      parentGroupId: null,
    }],
  };
}

function replayLayout(
  proposal: ProposalDiffProposal,
  proposedGraph: WorkspaceGraph,
): {
  layout: WorkspaceLayout | null;
  refs: Map<string, ProposalOperationRef[]>;
  viewportRefs: ProposalOperationRef[];
} {
  const refs = new Map<string, ProposalOperationRef[]>();
  const viewportRefs: ProposalOperationRef[] = [];
  if (!proposal.baseLayout) return { layout: null, refs, viewportRefs };
  const semanticNodeIds = new Set(proposedGraph.nodes.map((node) => node.id));
  let layout = structuredClone(proposal.baseLayout);
  for (const [index, command] of proposal.layoutOperations.entries()) {
    const before = new Map(layout.objects.map((object) => [object.id, object]));
    const prepared = ensureCoreLayoutObject(layout, command, semanticNodeIds);
    const next = applyWorkspaceLayoutCommands(prepared, [command]);
    const after = new Map(next.objects.map((object) => [object.id, object]));
    const changedObjectIds = new Set<string>();
    for (const objectId of new Set([...before.keys(), ...after.keys()])) {
      if (sameValue(before.get(objectId) ?? null, after.get(objectId) ?? null)) continue;
      changedObjectIds.add(objectId);
      appendOperationRef(refs, objectId, { kind: "layout", index });
    }
    const directObjectId = directLayoutObjectId(command);
    if (directObjectId && !changedObjectIds.has(directObjectId)) {
      appendOperationRef(refs, directObjectId, { kind: "layout", index });
    }
    if (command.type === "set-viewport") {
      viewportRefs.push({ kind: "layout", index });
    }
    layout = next;
  }
  return {
    layout: materializeWorkspaceLayout(proposedGraph, layout),
    refs,
    viewportRefs,
  };
}

function viewportChanges(
  baseLayout: WorkspaceLayout | null,
  proposedLayout: WorkspaceLayout | null,
  operationRefs: readonly ProposalOperationRef[],
): ProposalChange<WorkspaceViewport>[] {
  if (!baseLayout || !proposedLayout || operationRefs.length === 0) return [];
  if (sameValue(baseLayout.viewport, proposedLayout.viewport)) return [];
  return [{
    key: "layout:viewport",
    objectId: "viewport",
    objectKind: "viewport",
    changeKind: "modification",
    before: structuredClone(baseLayout.viewport),
    after: structuredClone(proposedLayout.viewport),
    operationRefs: [...operationRefs],
    canvasObjectIds: [],
    accessibleLabel: "Proposed change: Canvas viewport",
  }];
}

function layoutChanges(
  baseLayout: WorkspaceLayout | null,
  proposedLayout: WorkspaceLayout | null,
  graph: WorkspaceGraph,
  refs: Map<string, ProposalOperationRef[]>,
): ProposalChange<WorkspaceLayoutObject>[] {
  if (!baseLayout || !proposedLayout) return [];
  const beforeObjects = new Map(baseLayout.objects.map((object) => [object.id, object]));
  const afterObjects = new Map(proposedLayout.objects.map((object) => [object.id, object]));
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const changes: ProposalChange<WorkspaceLayoutObject>[] = [];
  for (const [objectId, operationRefs] of refs) {
    const before = beforeObjects.get(objectId) ?? null;
    const after = afterObjects.get(objectId) ?? null;
    if (sameValue(before, after)) continue;
    const kind = changeKind(before, after);
    const displayObject = after ?? before;
    if (!displayObject) continue;
    const node = graphNodes.get(objectId);
    const subject = displayObject.kind === "group"
      ? `Group ${displayObject.label}`
      : node
        ? `Layout for ${nodeKindLabel(node)} ${node.name}`
        : `Layout object ${objectId}`;
    changes.push({
      key: `layout:${objectId}`,
      objectId,
      objectKind: displayObject.kind,
      changeKind: kind,
      before,
      after,
      operationRefs: [...operationRefs],
      canvasObjectIds: [objectId],
      accessibleLabel: `Proposed ${accessibleState(kind)}: ${subject}`,
    });
  }
  return changes;
}

export function buildProposalDiff(
  proposal: ProposalDiffProposal,
  current: ProposalDiffCurrent,
): ProposalDiff {
  const auditedGraph = structuredClone(proposal.baseGraph);
  const auditedLayout = proposal.baseLayout
    ? materializeWorkspaceLayout(auditedGraph, structuredClone(proposal.baseLayout))
    : null;
  const graphReplay = replayGraph(proposal);
  const proposedGraph = graphReplay.graph;
  const proposalNodeChanges = nodeChanges(proposal.baseGraph, proposedGraph, graphReplay.nodeRefs);
  const proposalEdgeChanges = edgeChanges(proposal.baseGraph, proposedGraph, graphReplay.edgeRefs);
  const layoutReplay = replayLayout(proposal, proposedGraph);
  const proposedLayout = layoutReplay.layout;
  const groupChanges = layoutChanges(auditedLayout, proposedLayout, proposedGraph, layoutReplay.refs);
  const proposalViewportChanges = viewportChanges(
    auditedLayout,
    proposedLayout,
    layoutReplay.viewportRefs,
  );
  const reviewItems: ProposalChange<unknown>[] = [
    ...proposalNodeChanges,
    ...proposalEdgeChanges,
    ...groupChanges,
    ...proposalViewportChanges,
  ];

  return {
    auditedGraph,
    auditedLayout,
    proposedGraph,
    proposedLayout,
    nodeChanges: proposalNodeChanges,
    edgeChanges: proposalEdgeChanges,
    groupChanges,
    viewportChanges: proposalViewportChanges,
    reviewItems,
    staleAgainstCurrent:
      current.graph.revision !== proposal.baseGraphRevision
      || current.activeSnapshotId !== proposal.baseSnapshotId
      || (current.layoutChecksum !== undefined && current.layoutChecksum !== proposal.baseLayoutChecksum),
  };
}
