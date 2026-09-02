import type { ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { DesignFlowNode } from "./DesignCanvasNode.tsx";
import { figmaImportedNodeIds } from "./design-canvas-screen-helpers.ts";
import { nodeFocusEase } from "./node-focus-motion.ts";
import type { DesignCanvas, FigmaCanvasImportResponse, FigmaImportAnchor } from "./types.ts";

/**
 * The blank-canvas "Import from Figma" flow: the context menu stages an anchor,
 * the dialog opens once the menu has fully closed, and the imported Nodes are
 * selected and framed as soon as React Flow has mounted them.
 */
export function useFigmaImportFlow({
  canvas,
  flowRef,
  flowNodesRef,
  reduceMotion,
  adoptCanvas,
  refresh,
  toast,
  onImportedNodesReady,
}: {
  canvas: DesignCanvas | null;
  flowRef: RefObject<ReactFlowInstance<DesignFlowNode> | null>;
  flowNodesRef: RefObject<DesignFlowNode[]>;
  reduceMotion: boolean;
  adoptCanvas: (canvas: DesignCanvas) => void;
  refresh: () => Promise<unknown>;
  toast: (message: string) => void;
  onImportedNodesReady: (importedNodeIds: string[]) => void;
}) {
  const pendingAnchorRef = useRef<FigmaImportAnchor | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const pendingImportedNodeIdsRef = useRef<string[] | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const [figmaImportAnchor, setFigmaImportAnchor] = useState<FigmaImportAnchor | null>(null);

  /** Remember where the context menu was opened; the dialog opens after the menu closes. */
  const stageFigmaImportAnchor = useCallback((position: { x: number; y: number }) => {
    pendingAnchorRef.current = { x: Math.round(position.x), y: Math.round(position.y) };
  }, []);

  /** Called when the context menu has closed: open the dialog for a staged anchor, if any. */
  const openPendingFigmaImport = useCallback(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    if (openFrameRef.current !== null) window.cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = window.requestAnimationFrame(() => {
      openFrameRef.current = null;
      setFigmaImportAnchor(anchor);
    });
  }, []);

  const closeFigmaImport = useCallback(() => setFigmaImportAnchor(null), []);

  const onFigmaImported = useCallback((result: FigmaCanvasImportResponse) => {
    pendingImportedNodeIdsRef.current = figmaImportedNodeIds(result, canvas);
    adoptCanvas(result.canvas);
    const limitations = [...new Set([
      ...result.import.manifest.incomplete,
      ...result.import.manifest.warnings,
    ])];
    if (limitations.length > 0) {
      const visible = limitations.slice(0, 2).join("; ");
      toast(`Figma imported with limitations: ${visible}${
        limitations.length > 2 ? `; +${limitations.length - 2} more` : ""
      }`);
    }
    setFigmaImportAnchor(null);
    void refresh();
  }, [adoptCanvas, canvas, refresh, toast]);

  useLayoutEffect(() => {
    const pendingNodeIds = pendingImportedNodeIdsRef.current;
    if (!canvas || !pendingNodeIds?.length) return;
    const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id));
    const importedNodeIds = pendingNodeIds.filter((nodeId) => canvasNodeIds.has(nodeId));
    if (importedNodeIds.length === 0) return;
    const importedNodeIdSet = new Set(importedNodeIds);
    const importedFlowNodes = flowNodesRef.current.filter((node) => importedNodeIdSet.has(node.id));
    if (importedFlowNodes.length !== importedNodeIds.length) return;
    pendingImportedNodeIdsRef.current = null;
    onImportedNodesReady(importedNodeIds);
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      void flowRef.current?.fitView({
        nodes: flowNodesRef.current.filter((node) => importedNodeIdSet.has(node.id)),
        padding: 0.18,
        duration: reduceMotion ? 0 : 260,
        ease: nodeFocusEase,
        interpolate: "smooth",
      });
    });
  }, [canvas, flowNodesRef, flowRef, onImportedNodesReady, reduceMotion]);

  useEffect(() => () => {
    if (openFrameRef.current !== null) window.cancelAnimationFrame(openFrameRef.current);
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
  }, []);

  return { figmaImportAnchor, stageFigmaImportAnchor, openPendingFigmaImport, closeFigmaImport, onFigmaImported };
}
