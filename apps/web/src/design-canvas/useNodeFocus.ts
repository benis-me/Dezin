import type { ReactFlowInstance, Viewport } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignFlowNode } from "./DesignCanvasNode.tsx";
import {
  cancelSpatialFocusAnimations,
  downloadFileStem,
  focusedLayoutOptions,
  sameViewport,
  synchronizeFocusTransitionDuration,
  type NodeFocusTransition,
} from "./design-canvas-screen-helpers.ts";
import { readExactVersionMetadata, useExactVersionMetadata } from "./exact-version-metadata.ts";
import type { FocusedPreviewDevice } from "./FocusedNodeChrome.tsx";
import {
  focusedNodeTransform,
  NODE_FOCUS_DETAIL_DELAY_MS,
  NODE_FOCUS_FLIGHT_DURATION_MS,
  type NodeFocusPhase,
} from "./node-focus-motion.ts";
import type { DesignCanvas } from "./types.ts";
import { previewVersionIdForNode } from "./useExactVersionPreview.ts";

/**
 * Refs that arbitrate between React Flow's asynchronous selection events and
 * the clicks/menus that caused them. They live in the screen because every
 * pointer handler reads them; the focus hook arms and clears them.
 */
export interface SelectionGuardRefs {
  selectionGuardRef: RefObject<string | null>;
  selectionGuardFrameRef: RefObject<number | null>;
  contextSelectionGuardRef: RefObject<string | null>;
  contextSelectionGuardFrameRef: RefObject<number | null>;
  selectionClearGuardRef: RefObject<boolean>;
}

/**
 * The spatial-focus state machine: which Node is focused, whether its Agent
 * panel is shown, the open/close flight, device presets, portable-HTML export,
 * and the selection bookkeeping that accompanies entering and leaving focus.
 */
export function useNodeFocus({
  api,
  projectId,
  canvas,
  contentAspectRatios,
  contentNaturalSizes,
  nodeAgentWidth,
  reduceMotion,
  selectedNodeIds,
  surfaceRef,
  flowRef,
  flowNodesRef,
  nodePanelRef,
  replaceFlowNodes,
  setSelectedNodeIds,
  setMainAgentOpen,
  focusViewportLockRef,
  cancelPendingViewportSave,
  setZoom,
  guards,
}: {
  api: DesignCanvasApi;
  projectId: string;
  canvas: DesignCanvas | null;
  contentAspectRatios: ReadonlyMap<string, number>;
  contentNaturalSizes: ReadonlyMap<string, { width: number; height: number }>;
  nodeAgentWidth: number;
  reduceMotion: boolean;
  selectedNodeIds: readonly string[];
  surfaceRef: RefObject<HTMLElement | null>;
  flowRef: RefObject<ReactFlowInstance<DesignFlowNode> | null>;
  flowNodesRef: RefObject<DesignFlowNode[]>;
  nodePanelRef: RefObject<HTMLElement | null>;
  replaceFlowNodes: (update: (current: DesignFlowNode[]) => DesignFlowNode[]) => DesignFlowNode[];
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setMainAgentOpen: Dispatch<SetStateAction<boolean>>;
  focusViewportLockRef: RefObject<Viewport | null>;
  cancelPendingViewportSave: () => void;
  setZoom: Dispatch<SetStateAction<number>>;
  guards: SelectionGuardRefs;
}) {
  const focusClosingRef = useRef(false);
  const focusTransitionSequenceRef = useRef(0);
  const focusPanelTimerRef = useRef<number | null>(null);
  const focusFinishTimerRef = useRef<number | null>(null);
  const focusReleaseTimerRef = useRef<number | null>(null);
  const focusCloseCompletionRef = useRef<{ nodeId: string; finish: () => void } | null>(null);
  const previewDeviceByNodeRef = useRef(new Map<string, FocusedPreviewDevice>());
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusedPanelNodeId, setFocusedPanelNodeId] = useState<string | null>(null);
  const [focusTransition, setFocusTransition] = useState<NodeFocusTransition | null>(null);
  const [focusMotionEnabled, setFocusMotionEnabled] = useState(true);
  const [focusedPreviewDevice, setFocusedPreviewDevice] = useState<FocusedPreviewDevice>("desktop");
  // Whether the focused layout keeps room for the Node Agent on the right. It
  // reflects the user's intent, not the panel's delayed mount, so the flight
  // targets the final position from its first frame.
  const [focusAgentReserved, setFocusAgentReserved] = useState(true);
  const [focusPreviewExporting, setFocusPreviewExporting] = useState(false);
  const [focusPreviewExportError, setFocusPreviewExportError] = useState<string | null>(null);
  const focusMotionAllowed = focusMotionEnabled && !reduceMotion;

  const focusedCanvasNode = useMemo(() => (
    focusTransition
      ? canvas?.nodes.find((node) => node.id === focusTransition.nodeId) ?? null
      : null
  ), [canvas?.nodes, focusTransition]);
  const focusedVersionId = focusedCanvasNode ? previewVersionIdForNode(focusedCanvasNode) : null;
  const focusedVersionMetadata = useExactVersionMetadata({
    api,
    projectId,
    nodeId: focusedCanvasNode?.id ?? null,
    versionId: focusedVersionId,
    enabled: focusedCanvasNode !== null,
  }).metadata;
  const focusActive = focusTransition !== null;

  const chooseFocusedPreviewDevice = useCallback((device: FocusedPreviewDevice) => {
    if (focusTransition) previewDeviceByNodeRef.current.set(focusTransition.nodeId, device);
    setFocusedPreviewDevice(device);
  }, [focusTransition]);

  const clearFocusTimers = useCallback(() => {
    if (focusPanelTimerRef.current !== null) {
      window.clearTimeout(focusPanelTimerRef.current);
      focusPanelTimerRef.current = null;
    }
    if (focusFinishTimerRef.current !== null) {
      window.clearTimeout(focusFinishTimerRef.current);
      focusFinishTimerRef.current = null;
    }
    if (focusReleaseTimerRef.current !== null) {
      window.clearTimeout(focusReleaseTimerRef.current);
      focusReleaseTimerRef.current = null;
    }
  }, []);

  /**
   * Hold the selection on `nodeId` for two frames so a delayed empty selection
   * from the preceding pane click cannot undo the click that selected it.
   */
  const armSelectionGuard = useCallback((nodeId: string) => {
    if (guards.selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(guards.selectionGuardFrameRef.current);
    guards.contextSelectionGuardRef.current = null;
    if (guards.contextSelectionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(guards.contextSelectionGuardFrameRef.current);
      guards.contextSelectionGuardFrameRef.current = null;
    }
    guards.selectionClearGuardRef.current = false;
    guards.selectionGuardRef.current = nodeId;
    guards.selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      guards.selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        guards.selectionGuardFrameRef.current = null;
        guards.selectionGuardRef.current = null;
      });
    });
  }, [guards]);

  const clearSelection = useCallback(() => {
    guards.selectionGuardRef.current = null;
    guards.selectionClearGuardRef.current = true;
    if (guards.selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(guards.selectionGuardFrameRef.current);
    guards.selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      guards.selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        guards.selectionGuardFrameRef.current = null;
        guards.selectionClearGuardRef.current = false;
      });
    });
    setSelectedNodeIds([]);
    setFocusedPanelNodeId(null);
    replaceFlowNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }, [guards, replaceFlowNodes, setSelectedNodeIds]);

  const openNodeAgent = useCallback((nodeId: string, focusComposer = false, animate = true) => {
    armSelectionGuard(nodeId);
    clearFocusTimers();
    cancelPendingViewportSave();
    const motionEnabled = animate && !reduceMotion;
    const panelAlreadyVisible = focusedPanelNodeId === nodeId;
    focusClosingRef.current = false;
    focusCloseCompletionRef.current = null;
    const sequence = focusTransitionSequenceRef.current + 1;
    focusTransitionSequenceRef.current = sequence;
    setFocusMotionEnabled(motionEnabled);
    const previewDevice = previewDeviceByNodeRef.current.get(nodeId) ?? "desktop";
    previewDeviceByNodeRef.current.set(nodeId, previewDevice);
    setFocusedPreviewDevice(previewDevice);
    setFocusPreviewExporting(false);
    setFocusPreviewExportError(null);
    setMainAgentOpen(false);
    setFocusedNodeId(nodeId);
    setFocusAgentReserved(true);
    if (!panelAlreadyVisible) setFocusedPanelNodeId(null);
    const sourceNode = canvas?.nodes.find((candidate) => candidate.id === nodeId) ?? null;
    const sourceVersionMetadata = sourceNode
      ? readExactVersionMetadata({
          api,
          projectId,
          nodeId: sourceNode.id,
          versionId: previewVersionIdForNode(sourceNode),
        })
      : null;
    const surfaceBounds = surfaceRef.current?.getBoundingClientRect();
    const activeViewport = flowRef.current?.getViewport() ?? canvas?.viewport ?? null;
    focusViewportLockRef.current = activeViewport ? { ...activeViewport } : null;
    const durationMs = sourceNode && surfaceBounds && activeViewport
      ? focusedNodeTransform(
          sourceNode.geometry,
          { width: surfaceBounds.width, height: surfaceBounds.height },
          activeViewport,
          focusedLayoutOptions(
            surfaceBounds,
            sourceNode,
            undefined,
            contentAspectRatios.get(sourceNode.id),
            sourceVersionMetadata,
            { agentPanelWidth: nodeAgentWidth, naturalSize: contentNaturalSizes.get(sourceNode.id) ?? null },
          ),
        ).durationMs
      : NODE_FOCUS_FLIGHT_DURATION_MS;
    setFocusTransition({ nodeId, phase: "opening", durationMs });
    setSelectedNodeIds([nodeId]);
    replaceFlowNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));

    const revealPanel = () => {
      if (focusTransitionSequenceRef.current !== sequence) return;
      focusPanelTimerRef.current = null;
      setFocusedPanelNodeId(nodeId);
      if (focusComposer) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const selector = `[data-agent-scope="node:${nodeId}"] textarea`;
            surfaceRef.current?.querySelector<HTMLTextAreaElement>(selector)?.focus();
          });
        });
      }
    };
    const panelSurfaceBounds = surfaceRef.current?.getBoundingClientRect();
    if (panelAlreadyVisible) {
      revealPanel();
    } else if (motionEnabled && panelSurfaceBounds && panelSurfaceBounds.width > 0) {
      focusPanelTimerRef.current = window.setTimeout(revealPanel, NODE_FOCUS_DETAIL_DELAY_MS);
    } else {
      revealPanel();
    }
  }, [api, armSelectionGuard, cancelPendingViewportSave, canvas, clearFocusTimers, contentAspectRatios, contentNaturalSizes, flowRef, focusViewportLockRef, focusedPanelNodeId, nodeAgentWidth, projectId, reduceMotion, replaceFlowNodes, setMainAgentOpen, setSelectedNodeIds, surfaceRef]);

  const setFocusedNodeAgentVisible = useCallback((visible: boolean) => {
    const nodeId = focusedNodeId ?? focusedPanelNodeId ?? selectedNodeIds[0] ?? null;
    if (!nodeId) return;
    setFocusAgentReserved(visible);
    if (!focusedNodeId) {
      setFocusedPanelNodeId(visible ? nodeId : null);
      return;
    }
    if (focusPanelTimerRef.current !== null) {
      window.clearTimeout(focusPanelTimerRef.current);
      focusPanelTimerRef.current = null;
    }
    const sequence = focusTransitionSequenceRef.current + 1;
    focusTransitionSequenceRef.current = sequence;
    const reveal = () => {
      if (focusTransitionSequenceRef.current !== sequence) return;
      focusPanelTimerRef.current = null;
      setFocusedPanelNodeId(nodeId);
    };
    if (visible) {
      if (reduceMotion) reveal();
      else focusPanelTimerRef.current = window.setTimeout(reveal, 80);
    } else {
      setFocusedPanelNodeId(null);
    }
    setFocusTransition((current) => current ? { ...current } : current);
  }, [focusedNodeId, focusedPanelNodeId, reduceMotion, selectedNodeIds]);

  const onFocusAnimationStart = useCallback((nodeId: string, phase: NodeFocusPhase, durationMs: number) => {
    const sharedDurationMs = Math.max(0, Math.round(durationMs));
    setFocusTransition((current) => synchronizeFocusTransitionDuration(current, nodeId, phase, sharedDurationMs));
    if (phase !== "closing") return;
    const completion = focusCloseCompletionRef.current;
    if (!completion || completion.nodeId !== nodeId) return;
    if (focusFinishTimerRef.current !== null) window.clearTimeout(focusFinishTimerRef.current);
    focusFinishTimerRef.current = window.setTimeout(
      completion.finish,
      Math.max(120, sharedDurationMs) + 120,
    );
  }, []);

  const onFocusAnimationComplete = useCallback((nodeId: string, phase: NodeFocusPhase) => {
    if (phase !== "closing") return;
    const completion = focusCloseCompletionRef.current;
    if (completion?.nodeId === nodeId) completion.finish();
  }, []);

  const closeNodeFocus = useCallback((animate = true) => {
    if (focusClosingRef.current) return;
    const anchorNodeId = focusedNodeId ?? focusTransition?.nodeId ?? null;
    if (!anchorNodeId) {
      clearSelection();
      return;
    }
    focusClosingRef.current = true;
    const motionEnabled = animate && !reduceMotion;
    const flightDuration = focusTransition?.durationMs
      ?? flowNodesRef.current.find((node) => node.id === anchorNodeId)?.data.focusMotion?.durationMs
      ?? NODE_FOCUS_FLIGHT_DURATION_MS;
    const sequence = focusTransitionSequenceRef.current + 1;
    focusTransitionSequenceRef.current = sequence;
    clearFocusTimers();
    cancelPendingViewportSave();
    setFocusMotionEnabled(motionEnabled);
    setFocusedNodeId(null);
    setFocusedPanelNodeId(null);
    setFocusTransition({ nodeId: anchorNodeId, phase: "closing", durationMs: flightDuration });

    const releaseFocus = () => {
      if (focusTransitionSequenceRef.current !== sequence) return;
      focusReleaseTimerRef.current = null;
      focusClosingRef.current = false;
    };
    const finish = () => {
      if (focusTransitionSequenceRef.current !== sequence) return;
      if (focusFinishTimerRef.current !== null) window.clearTimeout(focusFinishTimerRef.current);
      focusFinishTimerRef.current = null;
      focusCloseCompletionRef.current = null;
      const lockedViewport = focusViewportLockRef.current;
      const currentViewport = flowRef.current?.getViewport();
      if (lockedViewport && currentViewport && !sameViewport(currentViewport, lockedViewport)) {
        void flowRef.current?.setViewport({ ...lockedViewport }, { duration: 0 }).catch(() => undefined);
      }
      if (lockedViewport) setZoom(lockedViewport.zoom);
      focusViewportLockRef.current = null;
      setFocusTransition(null);
      clearSelection();
      focusReleaseTimerRef.current = window.setTimeout(releaseFocus, motionEnabled ? 120 : 80);
    };
    focusCloseCompletionRef.current = { nodeId: anchorNodeId, finish };
    if (motionEnabled) focusFinishTimerRef.current = window.setTimeout(finish, flightDuration + 160);
    else finish();
  }, [cancelPendingViewportSave, clearFocusTimers, clearSelection, flowNodesRef, flowRef, focusTransition?.durationMs, focusTransition?.nodeId, focusViewportLockRef, focusedNodeId, reduceMotion, setZoom]);

  /** A context menu over a Node hides its Agent panel until the menu closes. */
  const hideNodeAgentForContextMenu = useCallback(() => {
    if (focusPanelTimerRef.current !== null) {
      window.clearTimeout(focusPanelTimerRef.current);
      focusPanelTimerRef.current = null;
    }
    const panel = nodePanelRef.current;
    if (panel) {
      panel.setAttribute("aria-hidden", "true");
      panel.setAttribute("inert", "");
      panel.style.pointerEvents = "none";
    }
    setFocusedPanelNodeId(null);
  }, [nodePanelRef]);

  /** Nodes removed from the canvas (by another client or undo) leave focus/selection cleanly. */
  const dropFocusForMissingNodes = useCallback((canvasNodeIds: ReadonlySet<string>) => {
    if (focusedNodeId && !canvasNodeIds.has(focusedNodeId)) setFocusedNodeId(null);
    if (focusedPanelNodeId && !canvasNodeIds.has(focusedPanelNodeId)) setFocusedPanelNodeId(null);
    if (focusTransition && !canvasNodeIds.has(focusTransition.nodeId)) {
      focusTransitionSequenceRef.current += 1;
      focusClosingRef.current = false;
      focusCloseCompletionRef.current = null;
      setFocusedPanelNodeId(null);
      setFocusTransition(null);
      focusViewportLockRef.current = null;
    }
  }, [focusTransition, focusViewportLockRef, focusedNodeId, focusedPanelNodeId]);

  const exportFocusedPreview = useCallback(async () => {
    const versionId = focusedCanvasNode ? previewVersionIdForNode(focusedCanvasNode) : null;
    if (!focusedCanvasNode || !versionId || focusPreviewExporting) return;
    setFocusPreviewExporting(true);
    setFocusPreviewExportError(null);
    let objectUrl: string | null = null;
    try {
      const bundle = api.downloadExactVersionExport
        ? await api.downloadExactVersionExport(projectId, focusedCanvasNode.id, versionId)
        : await api.downloadExactVersionHtml(projectId, focusedCanvasNode.id, versionId);
      objectUrl = URL.createObjectURL(bundle);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${downloadFileStem(focusedCanvasNode.name)}-${versionId}.${api.downloadExactVersionExport ? "zip" : "html"}`;
      link.rel = "noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "Unknown export error";
      setFocusPreviewExportError(`Couldn't export this preview. ${detail}`);
    } finally {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      setFocusPreviewExporting(false);
    }
  }, [api, focusPreviewExporting, focusedCanvasNode, projectId]);

  useLayoutEffect(() => {
    if (!reduceMotion || !focusTransition || !focusMotionEnabled) return;
    // Keep this focus session instant even if the preference is switched back
    // before it closes; otherwise the remaining flight would restart.
    setFocusMotionEnabled(false);
    const root = surfaceRef.current?.closest(".design-canvas-root");
    if (!root) return;
    const settle = () => cancelSpatialFocusAnimations(root);
    settle();
    queueMicrotask(settle);
    window.requestAnimationFrame(settle);
  }, [focusMotionEnabled, focusTransition, reduceMotion, surfaceRef]);

  useEffect(() => () => {
    if (focusPanelTimerRef.current !== null) window.clearTimeout(focusPanelTimerRef.current);
    if (focusFinishTimerRef.current !== null) window.clearTimeout(focusFinishTimerRef.current);
    if (focusReleaseTimerRef.current !== null) window.clearTimeout(focusReleaseTimerRef.current);
    focusTransitionSequenceRef.current += 1;
    focusCloseCompletionRef.current = null;
    focusClosingRef.current = false;
  }, []);

  return {
    focusedNodeId,
    setFocusedNodeId,
    focusedPanelNodeId,
    setFocusedPanelNodeId,
    focusTransition,
    focusMotionAllowed,
    focusedPreviewDevice,
    focusPreviewExporting,
    focusPreviewExportError,
    setFocusPreviewExportError,
    focusedCanvasNode,
    focusedVersionId,
    focusedVersionMetadata,
    focusActive,
    focusAgentReserved,
    previewDeviceByNodeRef,
    armSelectionGuard,
    clearSelection,
    chooseFocusedPreviewDevice,
    openNodeAgent,
    setFocusedNodeAgentVisible,
    closeNodeFocus,
    onFocusAnimationStart,
    onFocusAnimationComplete,
    hideNodeAgentForContextMenu,
    dropFocusForMissingNodes,
    exportFocusedPreview,
  };
}
