import "./proposal-overlay.css";

import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { Minus, PencilLine, Plus } from "lucide-react";
import type {
  WorkspaceEdgeData,
  WorkspaceFlowEdge,
  WorkspaceFlowModel,
  WorkspaceFlowNode,
} from "../canvas/workspace-graph-adapter.ts";
import type {
  ProposalChange,
  ProposalChangeKind,
  ProposalDiff,
} from "./proposal-diff.ts";

export interface ProposalOverlayModel extends WorkspaceFlowModel {
  affectedCanonicalNodeIds: ReadonlySet<string>;
  affectedCanonicalEdgeIds: ReadonlySet<string>;
}

export interface ProposalFocusRequest {
  key: string;
  nonce: number;
}

export const EMPTY_PROPOSAL_OVERLAY_MODEL: ProposalOverlayModel = {
  nodes: [],
  edges: [],
  affectedCanonicalNodeIds: new Set(),
  affectedCanonicalEdgeIds: new Set(),
};

const STATUS = {
  addition: { label: "Added", Icon: Plus },
  modification: { label: "Changed", Icon: PencilLine },
  removal: { label: "Removed", Icon: Minus },
} as const;

const RELATION_LABEL = {
  prototype: "Prototype",
  uses: "Uses component",
  informs: "Informs",
  "derives-from": "Derived from",
} as const;

export function proposalOverlayId(
  proposalId: string,
  objectKind: "node" | "edge",
  domainId: string,
): string {
  return `proposal:${proposalId}:${objectKind}:${domainId}`;
}

export function proposalOverlayIdForChange(proposalId: string, changeKey: string): string {
  const separator = changeKey.indexOf(":");
  const kind = separator >= 0 ? changeKey.slice(0, separator) : "node";
  const domainId = separator >= 0 ? changeKey.slice(separator + 1) : changeKey;
  return proposalOverlayId(proposalId, kind === "edge" ? "edge" : "node", domainId);
}

function changeData(change: ProposalChange<unknown>): Record<string, unknown> {
  return {
    proposalChangeKind: change.changeKind,
    proposalAccessibleLabel: change.accessibleLabel,
    proposalDomainId: change.objectId,
    proposalObjectKind: change.objectKind,
  };
}

function joinClassName(current: string | undefined, next: string): string {
  return current ? `${current} ${next}` : next;
}

function isDescendantOf(
  node: WorkspaceFlowNode,
  ancestorId: string,
  nodes: ReadonlyMap<string, WorkspaceFlowNode>,
): boolean {
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = nodes.get(parentId)?.parentId;
  }
  return false;
}

function absolutePosition(
  node: WorkspaceFlowNode,
  nodes: ReadonlyMap<string, WorkspaceFlowNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function contextNode(
  source: WorkspaceFlowNode,
  id: string,
  parentId: string | undefined,
  position: { x: number; y: number },
  hidden: boolean,
): WorkspaceFlowNode {
  return {
    ...source,
    id,
    parentId,
    position,
    hidden,
    extent: parentId ? "parent" : undefined,
    ariaLabel: `Proposal context: ${source.data.name}`,
    className: joinClassName(source.className, "dezin-proposal-derived-node"),
    data: {
      ...source.data,
      onToggleCollapsed: undefined,
      onRenameGroup: undefined,
      onResizeGroup: undefined,
      proposalContext: true,
    },
    draggable: false,
    connectable: false,
    selectable: false,
    deletable: false,
    focusable: false,
    selected: false,
    zIndex: 29,
  };
}

export function createProposalOverlayModel(
  diff: ProposalDiff,
  canonicalModel: WorkspaceFlowModel,
  proposalId: string,
  proposedModel: WorkspaceFlowModel = canonicalModel,
  auditedModel: WorkspaceFlowModel = canonicalModel,
): ProposalOverlayModel {
  const proposedNodes = new Map(proposedModel.nodes.map((node) => [node.id, node]));
  const proposedEdges = new Map(proposedModel.edges.map((edge) => [edge.id, edge]));
  const auditedNodes = new Map(auditedModel.nodes.map((node) => [node.id, node]));
  const auditedEdges = new Map(auditedModel.edges.map((edge) => [edge.id, edge]));
  const affectedCanonicalNodeIds = new Set<string>();
  const affectedCanonicalEdgeIds = new Set<string>();
  const nodeChangesById = new Map<string, ProposalChange<unknown>>();

  for (const change of [...diff.nodeChanges, ...diff.groupChanges]) {
    if (!nodeChangesById.has(change.objectId) || change.key.startsWith("node:")) {
      nodeChangesById.set(change.objectId, change as ProposalChange<unknown>);
    }
    if (change.before) affectedCanonicalNodeIds.add(change.objectId);
  }
  for (const change of diff.edgeChanges) {
    if (change.before) affectedCanonicalEdgeIds.add(change.objectId);
  }

  const groupDerivedNodes = new Map<string, WorkspaceFlowNode>();
  for (const change of diff.groupChanges) {
    if (change.objectKind !== "group") continue;
    const sourceNodes = change.after ? proposedNodes : auditedNodes;
    for (const candidate of sourceNodes.values()) {
      if (candidate.id === change.objectId || !isDescendantOf(candidate, change.objectId, sourceNodes)) continue;
      if (!nodeChangesById.has(candidate.id)) groupDerivedNodes.set(candidate.id, candidate);
      affectedCanonicalNodeIds.add(candidate.id);
    }
  }

  const overlayNodeIds = new Set(
    [...nodeChangesById.keys(), ...groupDerivedNodes.keys()]
      .map((id) => proposalOverlayId(proposalId, "node", id)),
  );
  const proposedOrder = new Map(proposedModel.nodes.map((node, index) => [node.id, index]));
  const auditedOrder = new Map(auditedModel.nodes.map((node, index) => [node.id, index]));
  const changedNodes = [...nodeChangesById.values()]
    .sort((left, right) => (proposedOrder.get(left.objectId) ?? Number.MAX_SAFE_INTEGER)
      - (proposedOrder.get(right.objectId) ?? Number.MAX_SAFE_INTEGER))
    .flatMap((change): WorkspaceFlowNode[] => {
      const source = change.after
        ? proposedNodes.get(change.objectId) ?? auditedNodes.get(change.objectId)
        : auditedNodes.get(change.objectId) ?? proposedNodes.get(change.objectId);
      if (!source) return [];
      const flattened = change.changeKind === "removal";
      const id = proposalOverlayId(proposalId, "node", change.objectId);
      const parentId = !flattened && source.parentId
        ? overlayNodeIds.has(proposalOverlayId(proposalId, "node", source.parentId))
          ? proposalOverlayId(proposalId, "node", source.parentId)
          : source.parentId
        : undefined;
      const expandedGroupSize = change.objectKind === "group"
        && typeof source.data.expandedGroupWidth === "number"
        && typeof source.data.expandedGroupHeight === "number"
        ? {
            width: source.data.expandedGroupWidth,
            height: source.data.expandedGroupHeight,
          }
        : null;
      return [{
        ...source,
        id,
        type: "proposal",
        position: flattened ? absolutePosition(source, auditedNodes) : source.position,
        parentId,
        extent: flattened ? undefined : parentId ? "parent" : source.extent,
        hidden: flattened ? false : source.hidden,
        ariaLabel: change.accessibleLabel,
        className: joinClassName(source.className, `dezin-proposal-flow-node dezin-proposal-flow-node--${change.changeKind}`),
        data: { ...source.data, ...changeData(change) },
        style: expandedGroupSize === null
          ? source.style
          : { ...source.style, ...expandedGroupSize },
        draggable: false,
        connectable: false,
        selectable: false,
        deletable: false,
        focusable: true,
        selected: false,
        zIndex: change.objectKind === "group" ? 26 : 30,
      } as WorkspaceFlowNode];
    });

  const derivedNodes = [...groupDerivedNodes.values()]
    .sort((left, right) => (proposedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (proposedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    .map((source) => {
      const parentId = source.parentId
        ? overlayNodeIds.has(proposalOverlayId(proposalId, "node", source.parentId))
          ? proposalOverlayId(proposalId, "node", source.parentId)
          : source.parentId
        : undefined;
      return contextNode(
        source,
        proposalOverlayId(proposalId, "node", source.id),
        parentId,
        source.position,
        source.hidden ?? false,
      );
    });

  const removedEdgeEndpointIds = new Map<string, string>();
  const edgeContextNodes: WorkspaceFlowNode[] = [];
  for (const change of diff.edgeChanges) {
    if (change.changeKind !== "removal") continue;
    const sourceEdge = auditedEdges.get(change.objectId);
    if (!sourceEdge) continue;
    for (const [role, domainId] of [["source", sourceEdge.source], ["target", sourceEdge.target]] as const) {
      const directChange = nodeChangesById.get(domainId);
      if (directChange?.changeKind === "removal") {
        removedEdgeEndpointIds.set(`${change.objectId}:${role}`, proposalOverlayId(proposalId, "node", domainId));
        continue;
      }
      const source = auditedNodes.get(domainId);
      if (!source) continue;
      const id = proposalOverlayId(proposalId, "node", `edge-context:${change.objectId}:${role}:${domainId}`);
      removedEdgeEndpointIds.set(`${change.objectId}:${role}`, id);
      edgeContextNodes.push(contextNode(source, id, undefined, absolutePosition(source, auditedNodes), false));
      affectedCanonicalNodeIds.add(domainId);
    }
  }

  edgeContextNodes.sort((left, right) => (auditedOrder.get(left.data.objectId) ?? Number.MAX_SAFE_INTEGER)
    - (auditedOrder.get(right.data.objectId) ?? Number.MAX_SAFE_INTEGER));
  const nodes = [...changedNodes, ...derivedNodes, ...edgeContextNodes];

  const directOverlayDomainNodeIds = new Set(nodeChangesById.keys());
  const overlayDomainNodeIds = new Set([
    ...directOverlayDomainNodeIds,
    ...groupDerivedNodes.keys(),
  ]);
  const edges = diff.edgeChanges.flatMap((change): WorkspaceFlowEdge[] => {
    const sourceEdge = change.changeKind === "removal"
      ? auditedEdges.get(change.objectId)
      : proposedEdges.get(change.objectId) ?? auditedEdges.get(change.objectId);
    if (!sourceEdge) return [];
    const removedSource = removedEdgeEndpointIds.get(`${change.objectId}:source`);
    const removedTarget = removedEdgeEndpointIds.get(`${change.objectId}:target`);
    const source = removedSource ?? (overlayDomainNodeIds.has(sourceEdge.source)
      ? proposalOverlayId(proposalId, "node", sourceEdge.source)
      : sourceEdge.source);
    const target = removedTarget ?? (overlayDomainNodeIds.has(sourceEdge.target)
      ? proposalOverlayId(proposalId, "node", sourceEdge.target)
      : sourceEdge.target);
    const sourceHandle = !removedSource && directOverlayDomainNodeIds.has(sourceEdge.source)
      ? "proposal-source"
      : sourceEdge.sourceHandle;
    const targetHandle = !removedTarget && directOverlayDomainNodeIds.has(sourceEdge.target)
      ? "proposal-target"
      : sourceEdge.targetHandle;
    return [{
      ...sourceEdge,
      id: proposalOverlayId(proposalId, "edge", change.objectId),
      type: "proposal",
      source,
      target,
      sourceHandle,
      targetHandle,
      ariaLabel: change.accessibleLabel,
      className: joinClassName(sourceEdge.className, `dezin-proposal-flow-edge dezin-proposal-flow-edge--${change.changeKind}`),
      data: { ...sourceEdge.data, ...changeData(change) } as WorkspaceEdgeData,
      selectable: false,
      deletable: false,
      focusable: true,
      selected: false,
      animated: false,
      zIndex: 28,
    }];
  });

  return { nodes, edges, affectedCanonicalNodeIds, affectedCanonicalEdgeIds };
}

export function mergeProposalOverlay(
  canonicalModel: WorkspaceFlowModel,
  overlay: ProposalOverlayModel,
): WorkspaceFlowModel {
  if (overlay.nodes.length === 0 && overlay.edges.length === 0) return canonicalModel;
  return {
    nodes: [
      ...canonicalModel.nodes.map((node) => overlay.affectedCanonicalNodeIds.has(node.id)
        ? {
            ...node,
            focusable: false,
            className: joinClassName(node.className, "proposal-canonical-affected"),
          }
        : node),
      ...overlay.nodes,
    ],
    edges: [
      ...canonicalModel.edges.map((edge) => overlay.affectedCanonicalEdgeIds.has(edge.id)
        ? {
            ...edge,
            focusable: false,
            className: joinClassName(edge.className, "proposal-canonical-affected"),
          }
        : edge),
      ...overlay.edges,
    ],
  };
}

export function ProposalOverlay({ data }: NodeProps<WorkspaceFlowNode>) {
  const changeKind = data.proposalChangeKind as ProposalChangeKind;
  const status = STATUS[changeKind] ?? STATUS.modification;
  const objectKind = typeof data.proposalObjectKind === "string" ? data.proposalObjectKind : data.kind;
  return (
    <div
      className="dezin-proposal-node"
      data-change={changeKind}
      data-object-kind={objectKind}
      style={objectKind === "group" ? { width: "100%", height: "100%" } : undefined}
    >
      {objectKind !== "group" ? (
        <>
          <Handle
            id="proposal-target"
            type="target"
            position={Position.Left}
            isConnectable={false}
            className="dezin-proposal-node__handle"
            aria-hidden
            tabIndex={-1}
          />
          <Handle
            id="proposal-source"
            type="source"
            position={Position.Right}
            isConnectable={false}
            className="dezin-proposal-node__handle"
            aria-hidden
            tabIndex={-1}
          />
        </>
      ) : null}
      <span className="dezin-proposal-node__marker" data-shape={changeKind} aria-hidden>
        <status.Icon size={12} strokeWidth={2} />
      </span>
      <span className="dezin-proposal-node__content">
        <span className="dezin-proposal-node__status">{status.label}</span>
        <strong title={data.name}>{data.name}</strong>
        <span>{String(objectKind)}</span>
      </span>
    </div>
  );
}

export function ProposalOverlayEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<WorkspaceFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const changeKind = data?.proposalChangeKind as ProposalChangeKind;
  const status = STATUS[changeKind] ?? STATUS.modification;
  const relation = data?.kind ? RELATION_LABEL[data.kind] : "Relation";
  const lifecycle = data?.status
    ? `${data.status.slice(0, 1).toUpperCase()}${data.status.slice(1)}`
    : null;
  return (
    <>
      {changeKind === "modification" ? (
        <BaseEdge
          id={`${id}:accepted-outline`}
          path={path}
          style={{ stroke: "var(--border)", strokeWidth: 5, opacity: 0.85 }}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={22}
        style={{
          stroke: "var(--foreground)",
          strokeWidth: 1.6,
          strokeDasharray: changeKind === "removal" ? "7 5" : undefined,
          opacity: 0.88,
        }}
      />
      <EdgeLabelRenderer>
        <span
          className="dezin-proposal-edge-label nodrag nopan"
          data-change={changeKind}
          style={{
            zIndex: 28,
            transform: `translate(-50%, calc(-100% - 8px)) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <status.Icon size={10} strokeWidth={2} aria-hidden />
          <span>{status.label}</span>
          <strong>{relation}</strong>
          {lifecycle ? <span className="dezin-proposal-edge-label__status">{lifecycle}</span> : null}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
