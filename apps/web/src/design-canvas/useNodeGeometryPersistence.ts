import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { DesignFlowNode } from "./DesignCanvasNode.tsx";
import { flowNodeGeometry, sameGeometry } from "./design-canvas-screen-helpers.ts";
import type { DesignCanvas, DesignCanvasIntent, DesignNode } from "./types.ts";

type Geometry = DesignNode["geometry"];

/**
 * Drag/resize bookkeeping between React Flow's optimistic node positions and
 * the daemon's canvas authority: which nodes are mid-gesture, which geometry
 * writes are still in flight, and how transient resize frames are batched.
 */
export function useNodeGeometryPersistence({
  applyIntents,
  refresh,
  canvasNodes,
  flowNodesRef,
  replaceFlowNodes,
  bumpLayout,
}: {
  applyIntents: (intents: DesignCanvasIntent[]) => Promise<DesignCanvas>;
  refresh: () => Promise<unknown>;
  canvasNodes: readonly DesignNode[] | undefined;
  flowNodesRef: RefObject<DesignFlowNode[]>;
  replaceFlowNodes: (update: (current: DesignFlowNode[]) => DesignFlowNode[]) => DesignFlowNode[];
  bumpLayout: () => void;
}) {
  const draggingNodeIdsRef = useRef(new Set<string>());
  const resizingNodeIdsRef = useRef(new Set<string>());
  const pendingNodeGeometriesRef = useRef(new Map<string, Geometry>());
  const transientNodeChangesFrameRef = useRef<number | null>(null);
  const pendingTransientNodeChangesRef = useRef<NodeChange<DesignFlowNode>[]>([]);

  const persistNodeGeometries = useCallback((updates: ReadonlyArray<{ nodeId: string; geometry: Geometry }>) => {
    if (updates.length === 0) return;
    for (const update of updates) {
      pendingNodeGeometriesRef.current.set(update.nodeId, { ...update.geometry });
    }
    void applyIntents(updates.map((update) => ({
      type: "update-node" as const,
      nodeId: update.nodeId,
      patch: { geometry: update.geometry },
    }))).then((next) => {
      for (const update of updates) {
        const pending = pendingNodeGeometriesRef.current.get(update.nodeId);
        const canonical = next.nodes.find((node) => node.id === update.nodeId)?.geometry;
        if (pending && canonical && sameGeometry(pending, update.geometry) && sameGeometry(canonical, update.geometry)) {
          pendingNodeGeometriesRef.current.delete(update.nodeId);
        }
      }
    }).catch(() => {
      for (const update of updates) {
        const pending = pendingNodeGeometriesRef.current.get(update.nodeId);
        if (pending && sameGeometry(pending, update.geometry)) {
          pendingNodeGeometriesRef.current.delete(update.nodeId);
        }
      }
      void refresh();
    });
  }, [applyIntents, refresh]);

  const persistNodeResize = useCallback((nodeId: string, geometry: Geometry) => {
    persistNodeGeometries([{ nodeId, geometry }]);
  }, [persistNodeGeometries]);

  const persistNodePositions = useCallback((nodeIds: readonly string[], nextFlowNodes: readonly DesignFlowNode[]) => {
    const authoritativeById = new Map((canvasNodes ?? []).map((node) => [node.id, node]));
    const flowById = new Map(nextFlowNodes.map((node) => [node.id, node]));
    const updates = [...new Set(nodeIds)].flatMap((nodeId) => {
      const authoritative = authoritativeById.get(nodeId);
      const flowNode = flowById.get(nodeId);
      if (!authoritative || !flowNode) return [];
      const geometry = flowNodeGeometry(flowNode, authoritative.geometry);
      if (sameGeometry(geometry, authoritative.geometry)) return [];
      return [{ nodeId, geometry }];
    });
    persistNodeGeometries(updates);
  }, [canvasNodes, persistNodeGeometries]);

  const takePendingTransientNodeChanges = useCallback(() => {
    if (transientNodeChangesFrameRef.current !== null) {
      window.cancelAnimationFrame(transientNodeChangesFrameRef.current);
      transientNodeChangesFrameRef.current = null;
    }
    const pending = pendingTransientNodeChangesRef.current;
    pendingTransientNodeChangesRef.current = [];
    return pending;
  }, []);

  const scheduleTransientNodeChanges = useCallback((changes: NodeChange<DesignFlowNode>[]) => {
    pendingTransientNodeChangesRef.current.push(...changes);
    if (transientNodeChangesFrameRef.current !== null) return;
    transientNodeChangesFrameRef.current = window.requestAnimationFrame(() => {
      transientNodeChangesFrameRef.current = null;
      const pending = takePendingTransientNodeChanges();
      if (pending.length > 0) {
        replaceFlowNodes((current) => applyNodeChanges(pending, current));
      }
    });
  }, [replaceFlowNodes, takePendingTransientNodeChanges]);

  const onNodesChange = useCallback((changes: NodeChange<DesignFlowNode>[]) => {
    const resizeEnded = changes.some((change) => change.type === "dimensions" && change.resizing === false);
    const transientResize = !resizeEnded && changes.some((change) => (
      change.type === "dimensions"
        && (change.resizing === true || resizingNodeIdsRef.current.has(change.id))
    ));
    let next = flowNodesRef.current;
    if (transientResize) {
      scheduleTransientNodeChanges(changes);
    } else {
      const pending = takePendingTransientNodeChanges();
      const orderedChanges = pending.length > 0 ? [...pending, ...changes] : changes;
      next = replaceFlowNodes((current) => applyNodeChanges(orderedChanges, current));
    }
    let completedPositionChange = false;
    for (const change of changes) {
      if (change.type === "position") {
        if (change.dragging === true) draggingNodeIdsRef.current.add(change.id);
        if (change.dragging === false) {
          draggingNodeIdsRef.current.add(change.id);
          completedPositionChange = true;
        }
      }
      if (change.type === "dimensions") {
        if (change.resizing === true) resizingNodeIdsRef.current.add(change.id);
        if (change.resizing === false) resizingNodeIdsRef.current.delete(change.id);
      }
    }
    if (completedPositionChange) {
      const completedNodeIds = [...draggingNodeIdsRef.current];
      draggingNodeIdsRef.current.clear();
      persistNodePositions(completedNodeIds, next);
    }
    if (changes.some((change) => change.type === "position" || change.type === "dimensions")) bumpLayout();
  }, [bumpLayout, flowNodesRef, persistNodePositions, replaceFlowNodes, scheduleTransientNodeChanges, takePendingTransientNodeChanges]);

  useEffect(() => () => {
    if (transientNodeChangesFrameRef.current !== null) {
      window.cancelAnimationFrame(transientNodeChangesFrameRef.current);
    }
    draggingNodeIdsRef.current.clear();
    resizingNodeIdsRef.current.clear();
    pendingNodeGeometriesRef.current.clear();
    pendingTransientNodeChangesRef.current = [];
    transientNodeChangesFrameRef.current = null;
  }, []);

  return { draggingNodeIdsRef, resizingNodeIdsRef, pendingNodeGeometriesRef, persistNodeResize, onNodesChange };
}
