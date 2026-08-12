import "@xyflow/react/dist/style.css";
import "./design-canvas.css";

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  type NodeChange,
  type Edge,
  type OnMove,
  type OnMoveEnd,
  type OnNodeDrag,
  type NodeMouseHandler,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { AnimatePresence, motion } from "motion/react";
import {
  FileUp,
  Figma,
  LoaderCircle,
  LocateFixed,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/index.ts";
import { FigmaImportDialog } from "../components/FigmaImportDialog.tsx";
import { useToast } from "../components/Toast.tsx";
import type { AgentInfo } from "../lib/api.ts";
import { fittedImageNodeSize } from "../lib/design-canvas-geometry.ts";
import type { DesignExportRevealResult } from "../lib/design-export.ts";
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion.ts";
import { arrangeDesignNodes } from "./auto-layout.ts";
import { isDesignAgentCommand, type DesignCanvasApi } from "./api.ts";
import { CanvasToolDocks } from "./CanvasToolDocks.tsx";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import { DesignCanvasHeader } from "./DesignCanvasHeader.tsx";
import { ImplementationExportConfirmation } from "./ImplementationExportConfirmation.tsx";
import {
  DesignCanvasNode,
  designNodeAriaLabel,
  type DesignFlowNode,
  type DesignNodeContentLayout,
} from "./DesignCanvasNode.tsx";
import { readExactVersionMetadata, useExactVersionMetadata } from "./exact-version-metadata.ts";
import { FocusedNodeChrome, type FocusedPreviewDevice } from "./FocusedNodeChrome.tsx";
import {
  focusedNodeLayoutMode,
  focusedNodeTransform,
  NODE_FOCUS_FLIGHT_DURATION_MS,
  NODE_FOCUS_DETAIL_DELAY_MS,
  nodeFocusEase,
  nodeFocusMotions,
  type NodeFocusPhase,
  type NodeFocusMotion,
} from "./node-focus-motion.ts";
import {
  CanvasAgentPanel,
  FLOATING_NODE_AGENT_WIDTH_PX,
  useFloatingNodePanel,
  type CanvasAgentSelection,
} from "./FloatingNodeAgent.tsx";
import { NodeCatalogMenu } from "./NodeCatalogMenu.tsx";
import { QuickStart } from "./QuickStart.tsx";
import type {
  DesignExportResult,
  DesignCanvas,
  DesignJobStatus,
  DesignNode,
  DesignNodeKind,
  DesignNodeVersion,
  FigmaCanvasImportResponse,
  FigmaImportAnchor,
} from "./types.ts";
import { useDesignCanvasController } from "./useDesignCanvasController.ts";
import { previewVersionIdForNode } from "./useExactVersionPreview.ts";

const NODE_TYPES = { design: DesignCanvasNode } as const;
const EMPTY_EDGES: Edge[] = [];
const SELECT_PAN_BUTTONS = [1];
const MULTI_SELECTION_KEYS = ["Meta", "Control", "Shift"];
const PRO_OPTIONS = { hideAttribution: true } as const;
const CANVAS_MOTION_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

const SPATIAL_FOCUS_MOTION_SELECTOR = [
  ".design-canvas-node[data-node-focus-role]",
  ".design-canvas-focus-dismiss",
  ".design-canvas-focus-back",
  ".design-canvas-focus-actions",
  ".design-canvas-topbar__leading",
  ".design-canvas-topbar__actions",
  ".design-canvas-tools",
  ".design-canvas-zoom",
  ".design-canvas-agent--floating",
].join(",");

export function cancelSpatialFocusAnimations(root: Element): number {
  if (typeof root.getAnimations !== "function") return 0;
  let cancelled = 0;
  for (const animation of root.getAnimations({ subtree: true })) {
    const target = animation.effect && "target" in animation.effect
      ? animation.effect.target
      : null;
    if (!(target instanceof Element)) continue;
    if (!target.matches(SPATIAL_FOCUS_MOTION_SELECTOR)
      && !target.closest(".design-canvas-node[data-node-focus-role]")) continue;
    try {
      animation.finish();
      animation.commitStyles();
    } catch {
      // A delayed animation can be non-finishable; cancelling still reveals
      // the static target state committed by React and focus CSS.
    }
    animation.cancel();
    cancelled += 1;
  }
  return cancelled;
}

function isLiveJobStatus(status: DesignJobStatus): boolean {
  return status === "queued" || status === "running" || status === "validating";
}

interface ContextMenuState {
  canvasX: number;
  canvasY: number;
  targetNode: DesignNode | null;
}

export interface NodeFocusTransition {
  nodeId: string;
  phase: NodeFocusPhase;
  durationMs: number;
}

export function synchronizeFocusTransitionDuration(
  current: NodeFocusTransition | null,
  nodeId: string,
  phase: NodeFocusPhase,
  durationMs: number,
): NodeFocusTransition | null {
  if (!current || current.nodeId !== nodeId || current.phase !== phase) return current;
  return { ...current, durationMs: Math.max(0, Math.round(durationMs)) };
}

interface SelectionGhost {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

const FOCUSED_PREVIEW_WIDTHS: Record<FocusedPreviewDevice, number | undefined> = {
  desktop: undefined,
  tablet: 768,
  mobile: 390,
};

function focusedLayoutOptions(
  surface: { width: number; height: number },
  node: DesignNode,
  targetWidth?: number,
  contentAspectRatio?: number,
  metadata?: DesignNodeVersion | null,
): Parameters<typeof focusedNodeTransform>[3] {
  const layoutMode = focusedNodeLayoutMode({
    kind: node.kind,
    fileName: metadata?.fileName ?? node.name,
    mimeType: metadata?.mimeType,
  });
  const responsiveTargetWidth = layoutMode === "web" ? targetWidth : undefined;
  if (surface.width <= 720) {
    return {
      reservedRight: 0,
      horizontalInset: 16,
      bottomInset: Math.min(520, surface.height * 0.56) + 90,
      layoutMode,
      targetWidth: responsiveTargetWidth,
      contentAspectRatio,
    };
  }
  return {
    reservedRight: FLOATING_NODE_AGENT_WIDTH_PX + 24,
    layoutMode,
    targetWidth: responsiveTargetWidth,
    contentAspectRatio,
  };
}

export interface DesignCanvasScreenProps {
  projectId: string;
  projectName: string;
  api: DesignCanvasApi;
  agents?: readonly AgentInfo[];
  initialAgentCommand?: string;
  initialModel?: string;
  onAgentDefaultsChange?: (selection: CanvasAgentSelection) => Promise<void>;
  onRescanAgents?: () => Promise<void>;
  onBackHome?: () => void;
  onRenameProject?: (name: string) => Promise<void>;
  onOpenSettings?: () => void;
  projectPath?: string | null;
  onRevealExport?: (exportId: string) => Promise<DesignExportRevealResult>;
  onExportReady?: (result: DesignExportResult) => void;
}

export function DesignCanvasScreen({
  projectId,
  projectName,
  api,
  agents = [],
  initialAgentCommand,
  initialModel,
  onAgentDefaultsChange,
  onRescanAgents,
  onBackHome,
  onRenameProject,
  onOpenSettings,
  projectPath,
  onRevealExport,
  onExportReady,
}: DesignCanvasScreenProps) {
  const { toast } = useToast();
  const reduceMotion = usePrefersReducedMotion();
  const controller = useDesignCanvasController({ projectId, api, onExportReady });
  const { canvas } = controller;
  const surfaceRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const revisionInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRevisionNodeIdRef = useRef<string | null>(null);
  const pendingContextTargetRef = useRef<string | null>(null);
  const contextMenuActiveRef = useRef(false);
  const pendingFigmaImportAnchorRef = useRef<FigmaImportAnchor | null>(null);
  const figmaImportOpenFrameRef = useRef<number | null>(null);
  const pendingFigmaImportedNodeIdsRef = useRef<string[] | null>(null);
  const figmaImportFitFrameRef = useRef<number | null>(null);
  const nodePanelRef = useRef<HTMLElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<DesignFlowNode> | null>(null);
  const flowNodesRef = useRef<DesignFlowNode[]>([]);
  const draggingNodeIdsRef = useRef(new Set<string>());
  const resizingNodeIdsRef = useRef(new Set<string>());
  const pendingNodeGeometriesRef = useRef(new Map<string, DesignNode["geometry"]>());
  const viewportSaveTimerRef = useRef<number | null>(null);
  const localViewportTargetRef = useRef<Viewport | null>(null);
  const authoritativeViewportRef = useRef<Viewport | null>(null);
  const focusViewportLockRef = useRef<Viewport | null>(null);
  const mountedViewportProjectRef = useRef<string | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const transientNodeChangesFrameRef = useRef<number | null>(null);
  const pendingTransientNodeChangesRef = useRef<NodeChange<DesignFlowNode>[]>([]);
  const pendingImportPositionRef = useRef({ x: 120, y: 120 });
  const selectionGuardRef = useRef<string | null>(null);
  const contextSelectionGuardRef = useRef<string | null>(null);
  const contextSelectionGuardFrameRef = useRef<number | null>(null);
  const selectionClearGuardRef = useRef(false);
  const selectionGuardFrameRef = useRef<number | null>(null);
  const focusClosingRef = useRef(false);
  const focusTransitionSequenceRef = useRef(0);
  const focusPanelTimerRef = useRef<number | null>(null);
  const focusFinishTimerRef = useRef<number | null>(null);
  const focusReleaseTimerRef = useRef<number | null>(null);
  const focusCloseCompletionRef = useRef<{ nodeId: string; finish: () => void } | null>(null);
  const previewDeviceByNodeRef = useRef(new Map<string, FocusedPreviewDevice>());
  const selectionGhostTimerRef = useRef<number | null>(null);
  const selectionRectRef = useRef<Omit<SelectionGhost, "id"> | null>(null);
  const selectionGhostSequenceRef = useRef(0);
  const [flowNodes, setFlowNodes] = useState<DesignFlowNode[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusedPanelNodeId, setFocusedPanelNodeId] = useState<string | null>(null);
  const [focusTransition, setFocusTransition] = useState<NodeFocusTransition | null>(null);
  const [focusMotionEnabled, setFocusMotionEnabled] = useState(true);
  const [focusedPreviewDevice, setFocusedPreviewDevice] = useState<FocusedPreviewDevice>("desktop");
  const [focusPreviewExporting, setFocusPreviewExporting] = useState(false);
  const [focusPreviewExportError, setFocusPreviewExportError] = useState<string | null>(null);
  const [selectionGhost, setSelectionGhost] = useState<SelectionGhost | null>(null);
  const [mainAgentOpen, setMainAgentOpen] = useState(false);
  const [exportConfirmationOpen, setExportConfirmationOpen] = useState(false);
  const [mainAgentSelection, setMainAgentSelection] = useState<CanvasAgentSelection>(() => ({
    agentCommand: isDesignAgentCommand(initialAgentCommand) ? initialAgentCommand : "",
    model: isDesignAgentCommand(initialAgentCommand) ? initialModel ?? "" : "",
  }));
  const mainAgentSelectionTouchedRef = useRef(false);
  const updateMainAgentSelection = useCallback((selection: CanvasAgentSelection) => {
    mainAgentSelectionTouchedRef.current = true;
    setMainAgentSelection(selection);
    void onAgentDefaultsChange?.(selection).catch(() => undefined);
  }, [onAgentDefaultsChange]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [figmaImportAnchor, setFigmaImportAnchor] = useState<FigmaImportAnchor | null>(null);
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [versions, setVersions] = useState<DesignNodeVersion[]>([]);
  const [versionsNodeId, setVersionsNodeId] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [contentAspectRatios, setContentAspectRatios] = useState<ReadonlyMap<string, number>>(() => new Map());
  const focusMotionAllowed = focusMotionEnabled && !reduceMotion;
  const availableDesignAgents = useMemo(
    () => agents.filter((agent) => isDesignAgentCommand(agent.command) && agent.available),
    [agents],
  );
  const canvasAvailable = controller.loadState === "ready" && canvas !== null;

  useEffect(() => {
    setMainAgentSelection((current) => {
      const settingsAgent = isDesignAgentCommand(initialAgentCommand)
        ? availableDesignAgents.find((agent) => agent.command === initialAgentCommand) ?? null
        : null;
      if (!mainAgentSelectionTouchedRef.current && settingsAgent) {
        const settingsModel = initialModel && settingsAgent.models.includes(initialModel) ? initialModel : "";
        if (current.agentCommand === settingsAgent.command && current.model === settingsModel) return current;
        return { agentCommand: settingsAgent.command, model: settingsModel };
      }
      const active = availableDesignAgents.find((agent) => agent.command === current.agentCommand) ?? null;
      if (active && (!current.model || active.models.includes(current.model))) return current;
      const preferred = settingsAgent ?? availableDesignAgents[0] ?? null;
      if (!preferred) return current.agentCommand || current.model ? { agentCommand: "", model: "" } : current;
      const preferredModel = preferred.command === initialAgentCommand
        && initialModel
        && preferred.models.includes(initialModel)
        ? initialModel
        : "";
      return { agentCommand: preferred.command, model: preferredModel };
    });
  }, [availableDesignAgents, initialAgentCommand, initialModel]);

  const selectedNode = useMemo(() => (
    canvas?.nodes.find((node) => node.id === focusedPanelNodeId) ?? null
  ), [canvas?.nodes, focusedPanelNodeId]);
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
  const historyLocked = useMemo(() => (
    (canvas?.nodes.some((node) => node.activeJobId !== null) ?? false)
      || controller.jobs.some((job) => job.nodeId !== null && isLiveJobStatus(job.status))
  ), [canvas?.nodes, controller.jobs]);

  const replaceFlowNodes = useCallback((update: (current: DesignFlowNode[]) => DesignFlowNode[]) => {
    const next = update(flowNodesRef.current);
    flowNodesRef.current = next;
    setFlowNodes(next);
    return next;
  }, []);

  const removeNode = useCallback((nodeId: string) => {
    void controller.applyIntents([{ type: "remove-node", nodeId }]).then(() => {
      setSelectedNodeIds((current) => current.filter((id) => id !== nodeId));
    }).catch(() => undefined);
  }, [controller.applyIntents]);

  const openNodeAgent = useCallback((nodeId: string, focusComposer = false, animate = true) => {
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    contextSelectionGuardRef.current = null;
    if (contextSelectionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(contextSelectionGuardFrameRef.current);
      contextSelectionGuardFrameRef.current = null;
    }
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
    if (viewportSaveTimerRef.current !== null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
      localViewportTargetRef.current = null;
    }
    selectionClearGuardRef.current = false;
    selectionGuardRef.current = nodeId;
    selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        selectionGuardFrameRef.current = null;
        selectionGuardRef.current = null;
      });
    });
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

  }, [api, canvas, contentAspectRatios, focusedPanelNodeId, projectId, reduceMotion, replaceFlowNodes]);

  const setFocusedNodeAgentVisible = useCallback((visible: boolean) => {
    const nodeId = focusedNodeId ?? focusedPanelNodeId ?? selectedNodeIds[0] ?? null;
    if (!nodeId) return;
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

  const persistNodeGeometries = useCallback((updates: ReadonlyArray<{
    nodeId: string;
    geometry: DesignNode["geometry"];
  }>) => {
    if (updates.length === 0) return;
    for (const update of updates) {
      pendingNodeGeometriesRef.current.set(update.nodeId, { ...update.geometry });
    }
    void controller.applyIntents(updates.map((update) => ({
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
      void controller.refresh();
    });
  }, [controller.applyIntents, controller.refresh]);

  const persistNodeResize = useCallback((nodeId: string, geometry: DesignNode["geometry"]) => {
    persistNodeGeometries([{ nodeId, geometry }]);
  }, [persistNodeGeometries]);

  const appendMaterialRevision = useCallback(async (nodeId: string, file: File): Promise<void> => {
    await controller.appendMaterialVersion(nodeId, file);
  }, [controller.appendMaterialVersion]);

  const reportContentAspectRatio = useCallback((nodeId: string, aspectRatio: number) => {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    setContentAspectRatios((current) => {
      const previous = current.get(nodeId);
      if (previous !== undefined && Math.abs(previous - aspectRatio) < 0.0001) return current;
      const next = new Map(current);
      next.set(nodeId, aspectRatio);
      return next;
    });
    const source = canvas?.nodes.find((node) => node.id === nodeId);
    if (!source
      || (source.kind !== "image" && source.kind !== "video")
      || resizingNodeIdsRef.current.has(nodeId)) return;
    const pending = pendingNodeGeometriesRef.current.get(nodeId);
    const currentGeometry = pending ?? source.geometry;
    if (Math.abs(currentGeometry.width / currentGeometry.height - aspectRatio) < 0.0001) return;
    const fitted = fittedImageNodeSize({ width: aspectRatio, height: 1 });
    persistNodeResize(nodeId, { ...currentGeometry, ...fitted });
  }, [canvas?.nodes, persistNodeResize]);

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

  useEffect(() => {
    if (!selectedNode) {
      setVersions([]);
      setVersionsNodeId(null);
      return;
    }
    const controller = new AbortController();
    setVersions([]);
    setVersionsNodeId(null);
    setVersionsLoading(true);
    void api.listNodeVersions(projectId, selectedNode.id, controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setVersions(next);
        setVersionsNodeId(selectedNode.id);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setVersions([]);
        setVersionsNodeId(selectedNode.id);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setVersionsLoading(false);
    });
    return () => controller.abort();
  }, [api, projectId, selectedNode?.id, selectedNode?.versionCount]);

  const bumpLayout = useCallback(() => {
    if (layoutFrameRef.current !== null) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      setLayoutNonce((current) => current + 1);
    });
  }, []);

  const onPreviewContextMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    pendingContextTargetRef.current = nodeId;
    surfaceRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX,
      clientY,
    }));
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(bumpLayout);
    observer.observe(surface);
    window.addEventListener("resize", bumpLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", bumpLayout);
    };
  }, [bumpLayout]);

  const applyInitialViewport = useCallback((instance: ReactFlowInstance<DesignFlowNode>, target: Viewport) => {
    mountedViewportProjectRef.current = projectId;
    const mounted = instance.getViewport();
    if (sameViewport(mounted, target)) {
      setZoom(mounted.zoom);
      return;
    }
    void instance.setViewport({ ...target }, { duration: 0 }).then(() => {
      if (flowRef.current !== instance) return;
      setZoom(instance.getZoom());
      bumpLayout();
    }).catch(() => {
      if (flowRef.current === instance) setZoom(instance.getZoom());
    });
  }, [bumpLayout, projectId]);

  useLayoutEffect(() => {
    if (!canvas) return;
    authoritativeViewportRef.current = canvas.viewport;
    const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id));
    const selected = new Set(selectedNodeIds.filter((id) => canvasNodeIds.has(id)));
    if (selected.size !== selectedNodeIds.length) setSelectedNodeIds([...selected]);
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
    const surfaceBounds = surfaceRef.current?.getBoundingClientRect();
    const activeViewport = focusViewportLockRef.current ?? flowRef.current?.getViewport() ?? canvas.viewport;
    const contentLayouts = new Map<string, DesignNodeContentLayout>();
    const measuredTransforms = new Map<string, ReturnType<typeof focusedNodeTransform>>();
    if (surfaceBounds) {
      for (const node of canvas.nodes) {
        const versionId = previewVersionIdForNode(node);
        const metadata = node.id === focusedCanvasNode?.id
          ? focusedVersionMetadata
          : readExactVersionMetadata({ api, projectId, nodeId: node.id, versionId });
        const device = previewDeviceByNodeRef.current.get(node.id) ?? "desktop";
        const transform = focusedNodeTransform(
          node.geometry,
          { width: surfaceBounds.width, height: surfaceBounds.height },
          activeViewport,
          focusedLayoutOptions(
            surfaceBounds,
            node,
            FOCUSED_PREVIEW_WIDTHS[device],
            contentAspectRatios.get(node.id),
            metadata,
          ),
        );
        measuredTransforms.set(node.id, transform);
        contentLayouts.set(node.id, {
          width: transform.layoutWidth,
          height: transform.layoutHeight,
          canvasScale: transform.startScaleX,
        });
      }
    }
    const measuredSourceTransform = focusedCanvasNode
      ? measuredTransforms.get(focusedCanvasNode.id)
      : undefined;
    const previousSourceMotion = focusTransition
      ? flowNodesRef.current.find((node) => node.id === focusTransition.nodeId)?.data.focusMotion ?? null
      : null;
    const sourceTransform = measuredSourceTransform && focusTransition?.phase === "closing" && previousSourceMotion?.role === "source"
      ? { ...measuredSourceTransform, durationMs: previousSourceMotion.durationMs }
      : measuredSourceTransform;
    const measuredFocusMotions = focusTransition
      ? nodeFocusMotions(canvas.nodes, focusTransition.nodeId, focusTransition.phase, sourceTransform)
      : new Map<string, NodeFocusMotion>();
    const focusMotions = focusMotionAllowed
      ? measuredFocusMotions
      : new Map([...measuredFocusMotions].map(([nodeId, motion]) => [nodeId, {
          ...motion,
          durationMs: 0,
          delayMs: 0,
          fadeDurationMs: 0,
        }]));
    for (const nodeId of draggingNodeIdsRef.current) {
      if (!canvasNodeIds.has(nodeId)) draggingNodeIdsRef.current.delete(nodeId);
    }
    for (const nodeId of resizingNodeIdsRef.current) {
      if (!canvasNodeIds.has(nodeId)) resizingNodeIdsRef.current.delete(nodeId);
    }
    for (const [nodeId, pending] of pendingNodeGeometriesRef.current) {
      const canonical = canvas.nodes.find((node) => node.id === nodeId)?.geometry;
      if (!canonical || sameGeometry(canonical, pending)) pendingNodeGeometriesRef.current.delete(nodeId);
    }

    const currentById = new Map(flowNodesRef.current.map((node) => [node.id, node]));
    const canonicalFlowNodes = canvasToFlowNodes(
      canvas.nodes,
      projectId,
      api,
      persistNodeResize,
      appendMaterialRevision,
      reportContentAspectRatio,
      onPreviewContextMenu,
      onFocusAnimationStart,
      onFocusAnimationComplete,
      selected,
      contentLayouts,
      focusMotions,
    );
    const nextFlowNodes = canonicalFlowNodes.map((canonicalNode) => {
      const existing = currentById.get(canonicalNode.id);
      const authoritativeNode = canonicalNode.data.node;
      const pending = pendingNodeGeometriesRef.current.get(canonicalNode.id);
      const locallyChanging = draggingNodeIdsRef.current.has(canonicalNode.id)
        || resizingNodeIdsRef.current.has(canonicalNode.id);
      const localGeometry = existing && locallyChanging
        ? flowNodeGeometry(existing, authoritativeNode.geometry)
        : pending ?? authoritativeNode.geometry;
      const displayedNode = sameGeometry(localGeometry, authoritativeNode.geometry)
        ? authoritativeNode
        : { ...authoritativeNode, geometry: { ...localGeometry } };
      if (existing
        && existing.selected === canonicalNode.selected
        && existing.position.x === localGeometry.x
        && existing.position.y === localGeometry.y
        && (existing.width ?? authoritativeNode.geometry.width) === localGeometry.width
        && (existing.height ?? authoritativeNode.geometry.height) === localGeometry.height
        && sameDesignNode(existing.data.node, displayedNode)
        && sameContentLayout(existing.data.contentLayout, canonicalNode.data.contentLayout)
        && sameNodeFocusMotion(existing.data.focusMotion, canonicalNode.data.focusMotion)
        && existing.data.api === api
        && existing.data.onResize === persistNodeResize
        && existing.data.onPreviewContextMenu === onPreviewContextMenu
        && existing.data.onFocusAnimationStart === onFocusAnimationStart
        && existing.data.onFocusAnimationComplete === onFocusAnimationComplete) {
        return existing;
      }
      return {
        ...existing,
        ...canonicalNode,
        position: { x: localGeometry.x, y: localGeometry.y },
        width: localGeometry.width,
        height: localGeometry.height,
        data: { ...canonicalNode.data, node: displayedNode },
      };
    });
    if (nextFlowNodes.length !== flowNodesRef.current.length
      || nextFlowNodes.some((node, index) => node !== flowNodesRef.current[index])) {
      flowNodesRef.current = nextFlowNodes;
      setFlowNodes(nextFlowNodes);
    }

    const instance = flowRef.current;
    if (instance && mountedViewportProjectRef.current !== projectId) {
      applyInitialViewport(instance, canvas.viewport);
    } else if (!instance && mountedViewportProjectRef.current !== projectId) {
      setZoom(canvas.viewport.zoom);
    }
  }, [api, appendMaterialRevision, applyInitialViewport, canvas, contentAspectRatios, focusedCanvasNode, focusedNodeId, focusedPanelNodeId, focusedPreviewDevice, focusedVersionMetadata, focusMotionAllowed, focusTransition, layoutNonce, onFocusAnimationComplete, onFocusAnimationStart, onPreviewContextMenu, persistNodeResize, projectId, reportContentAspectRatio, selectedNodeIds]);

  useLayoutEffect(() => {
    const pendingNodeIds = pendingFigmaImportedNodeIdsRef.current;
    if (!canvas || !pendingNodeIds?.length) return;
    const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id));
    const importedNodeIds = pendingNodeIds.filter((nodeId) => canvasNodeIds.has(nodeId));
    if (importedNodeIds.length === 0) return;
    const importedNodeIdSet = new Set(importedNodeIds);
    const importedFlowNodes = flowNodesRef.current.filter((node) => importedNodeIdSet.has(node.id));
    if (importedFlowNodes.length !== importedNodeIds.length) return;
    pendingFigmaImportedNodeIdsRef.current = null;
    setMainAgentOpen(false);
    setFocusedPanelNodeId(null);
    setSelectedNodeIds(importedNodeIds);
    replaceFlowNodes((current) => current.map((node) => ({
      ...node,
      selected: importedNodeIdSet.has(node.id),
    })));
    if (figmaImportFitFrameRef.current !== null) window.cancelAnimationFrame(figmaImportFitFrameRef.current);
    figmaImportFitFrameRef.current = window.requestAnimationFrame(() => {
      figmaImportFitFrameRef.current = null;
      void flowRef.current?.fitView({
        nodes: flowNodesRef.current.filter((node) => importedNodeIdSet.has(node.id)),
        padding: 0.18,
        duration: reduceMotion ? 0 : 260,
        ease: nodeFocusEase,
        interpolate: "smooth",
      });
    });
  }, [canvas, reduceMotion, replaceFlowNodes]);

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
  }, [focusMotionEnabled, focusTransition, reduceMotion]);

  const onFlowInit = useCallback((instance: ReactFlowInstance<DesignFlowNode>) => {
    flowRef.current = instance;
    const target = authoritativeViewportRef.current;
    if (target) applyInitialViewport(instance, target);
    else setZoom(instance.getZoom());
    bumpLayout();
  }, [applyInitialViewport, bumpLayout]);

  useEffect(() => () => {
    if (layoutFrameRef.current !== null) window.cancelAnimationFrame(layoutFrameRef.current);
    if (transientNodeChangesFrameRef.current !== null) {
      window.cancelAnimationFrame(transientNodeChangesFrameRef.current);
    }
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    if (contextSelectionGuardFrameRef.current !== null) window.cancelAnimationFrame(contextSelectionGuardFrameRef.current);
    if (focusPanelTimerRef.current !== null) window.clearTimeout(focusPanelTimerRef.current);
    if (focusFinishTimerRef.current !== null) window.clearTimeout(focusFinishTimerRef.current);
    if (focusReleaseTimerRef.current !== null) window.clearTimeout(focusReleaseTimerRef.current);
    if (selectionGhostTimerRef.current !== null) window.clearTimeout(selectionGhostTimerRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    if (figmaImportOpenFrameRef.current !== null) window.cancelAnimationFrame(figmaImportOpenFrameRef.current);
    if (figmaImportFitFrameRef.current !== null) window.cancelAnimationFrame(figmaImportFitFrameRef.current);
    draggingNodeIdsRef.current.clear();
    resizingNodeIdsRef.current.clear();
    pendingNodeGeometriesRef.current.clear();
    pendingTransientNodeChangesRef.current = [];
    transientNodeChangesFrameRef.current = null;
    focusTransitionSequenceRef.current += 1;
    focusCloseCompletionRef.current = null;
    selectionGuardRef.current = null;
    contextSelectionGuardRef.current = null;
    selectionClearGuardRef.current = false;
    focusClosingRef.current = false;
    focusViewportLockRef.current = null;
    mountedViewportProjectRef.current = null;
    flowRef.current = null;
  }, []);

  const floatingPosition = useFloatingNodePanel({
    hostRef: surfaceRef,
    panelRef: nodePanelRef,
    nodeId: selectedNode?.id ?? null,
    focused: focusActive,
    mainPanelOpen: mainAgentOpen,
    layoutNonce,
  });

  const canvasCenter = useCallback(() => {
    const surface = surfaceRef.current;
    const flow = flowRef.current;
    if (!surface || !flow) return { x: 120, y: 120 };
    const bounds = surface.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  }, []);

  const addNode = useCallback(async (kind: DesignNodeKind, position = canvasCenter()) => {
    setAddMenuOpen(false);
    if (isMaterialNodeKind(kind)) {
      pendingImportPositionRef.current = position;
      if (fileInputRef.current) {
        fileInputRef.current.accept = catalogItem(kind).accepts ?? "*/*";
        fileInputRef.current.click();
      }
      return;
    }
    const item = catalogItem(kind);
    const nodeId = createDesignNodeId(kind);
    try {
      const next = await controller.applyIntents([{
        type: "add-node",
        node: {
          id: nodeId,
          kind,
          name: item.label,
          geometry: { x: Math.round(position.x), y: Math.round(position.y), ...item.defaultGeometry },
        },
      }]);
      const created = next.nodes.find((node) => node.id === nodeId);
      if (created) {
        setMainAgentOpen(false);
        setSelectedNodeIds([created.id]);
        setFocusedPanelNodeId(created.id);
      }
    } catch {
      // Controller exposes a non-blocking error banner and canonical refresh.
    }
  }, [canvasCenter, controller.applyIntents]);

  const importFiles = useCallback(async (files: readonly File[], position = pendingImportPositionRef.current) => {
    if (!files.length) return;
    try {
      await controller.importLocalFiles(files, position);
    } catch {
      // Controller keeps the canvas usable and exposes retry context.
    }
  }, [controller.importLocalFiles]);

  const requestMaterialRevision = useCallback((node: DesignNode) => {
    pendingRevisionNodeIdRef.current = node.id;
    if (revisionInputRef.current) {
      revisionInputRef.current.accept = catalogItem(node.kind).accepts ?? "*/*";
      revisionInputRef.current.click();
    }
  }, []);

  const captureSelectionRect = useCallback(() => {
    const surface = surfaceRef.current;
    const selection = surface?.querySelector<HTMLElement>(".react-flow__selection");
    if (!surface || !selection) return;
    const surfaceBounds = surface.getBoundingClientRect();
    const selectionBounds = selection.getBoundingClientRect();
    if (selectionBounds.width < 1 || selectionBounds.height < 1) return;
    selectionRectRef.current = {
      left: selectionBounds.left - surfaceBounds.left,
      top: selectionBounds.top - surfaceBounds.top,
      width: selectionBounds.width,
      height: selectionBounds.height,
    };
  }, []);

  const onSelectionStart = useCallback(() => {
    if (selectionGhostTimerRef.current !== null) {
      window.clearTimeout(selectionGhostTimerRef.current);
      selectionGhostTimerRef.current = null;
    }
    selectionRectRef.current = null;
    setSelectionGhost(null);
  }, []);

  const onSelectionEnd = useCallback(() => {
    captureSelectionRect();
    const rect = selectionRectRef.current;
    if (!rect || reduceMotion) {
      selectionRectRef.current = null;
      return;
    }
    const ghost = { ...rect, id: selectionGhostSequenceRef.current + 1 };
    selectionGhostSequenceRef.current = ghost.id;
    setSelectionGhost(ghost);
    selectionGhostTimerRef.current = window.setTimeout(() => {
      selectionGhostTimerRef.current = null;
      setSelectionGhost((current) => current?.id === ghost.id ? null : current);
    }, 180);
    selectionRectRef.current = null;
  }, [captureSelectionRect, reduceMotion]);

  const onSelectionChange = useCallback(({ nodes }: { nodes: DesignFlowNode[] }) => {
    const next = nodes.map((node) => node.id);
    if (selectionClearGuardRef.current) {
      if (next.length > 0) return;
      selectionClearGuardRef.current = false;
      if (selectionGuardFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionGuardFrameRef.current);
        selectionGuardFrameRef.current = null;
      }
    }
    const contextGuardedNodeId = contextSelectionGuardRef.current;
    const guardSuppressesPanel = contextGuardedNodeId !== null && next.length === 1 && next[0] === contextGuardedNodeId;
    const suppressPanel = contextMenuActiveRef.current || guardSuppressesPanel;
    if (guardSuppressesPanel && !contextMenuActiveRef.current) {
      contextSelectionGuardRef.current = null;
      if (contextSelectionGuardFrameRef.current !== null) {
        window.cancelAnimationFrame(contextSelectionGuardFrameRef.current);
        contextSelectionGuardFrameRef.current = null;
      }
    }
    const guardedNodeId = selectionGuardRef.current;
    if (guardedNodeId && !next.includes(guardedNodeId)) return;
    // Keep the guard for its complete frame window. React Flow can acknowledge
    // this click before a delayed empty selection from the preceding pane click.
    setSelectedNodeIds((current) => (
      current.length === next.length && current.every((id, index) => id === next[index]) ? current : next
    ));
    if (!focusActive) setFocusedPanelNodeId(suppressPanel ? null : next.length === 1 ? next[0]! : null);
  }, [focusActive]);

  const selectNodeFromPointerInteraction = useCallback((nodeId: string, interactionNodeIds: readonly string[]) => {
    if (focusActive) return;
    const uniqueInteractionNodeIds = [...new Set(interactionNodeIds)];
    const nextNodeIds = uniqueInteractionNodeIds.includes(nodeId) ? uniqueInteractionNodeIds : [nodeId];
    selectionClearGuardRef.current = false;
    selectionGuardRef.current = nodeId;
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        selectionGuardFrameRef.current = null;
        selectionGuardRef.current = null;
      });
    });
    contextSelectionGuardRef.current = null;
    if (contextSelectionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(contextSelectionGuardFrameRef.current);
      contextSelectionGuardFrameRef.current = null;
    }
    setMainAgentOpen(false);
    setSelectedNodeIds(nextNodeIds);
    setFocusedPanelNodeId(nextNodeIds.length === 1 ? nodeId : null);
    const selectedNodeIdSet = new Set(nextNodeIds);
    replaceFlowNodes((current) => current.map((candidate) => ({
      ...candidate,
      selected: selectedNodeIdSet.has(candidate.id),
    })));
  }, [focusActive, replaceFlowNodes]);

  const onNodeClick = useCallback<NodeMouseHandler<DesignFlowNode>>((_event, node) => {
    selectNodeFromPointerInteraction(node.id, [node.id]);
  }, [selectNodeFromPointerInteraction]);

  const onNodeDragStart = useCallback<OnNodeDrag<DesignFlowNode>>((_event, node, nodes) => {
    selectNodeFromPointerInteraction(node.id, nodes.map((candidate) => candidate.id));
  }, [selectNodeFromPointerInteraction]);

  const onNodeDoubleClick = useCallback<NodeMouseHandler<DesignFlowNode>>((event, node) => {
    event.preventDefault();
    if (focusTransition?.phase === "closing") {
      if (focusTransition.nodeId === node.id) openNodeAgent(node.id);
      return;
    }
    if (focusActive) return;
    openNodeAgent(node.id);
  }, [focusActive, focusTransition, openNodeAgent]);

  const persistNodePositions = useCallback((nodeIds: readonly string[], nextFlowNodes: readonly DesignFlowNode[]) => {
    const authoritativeById = new Map((canvas?.nodes ?? []).map((node) => [node.id, node]));
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
  }, [canvas?.nodes, persistNodeGeometries]);

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
  }, [bumpLayout, persistNodePositions, replaceFlowNodes, scheduleTransientNodeChanges, takePendingTransientNodeChanges]);

  const persistViewport = useCallback((viewport: Viewport) => {
    const current = authoritativeViewportRef.current;
    if (sameViewport(current, viewport) || sameViewport(localViewportTargetRef.current, viewport)) return;
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    const intendedViewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    localViewportTargetRef.current = intendedViewport;
    viewportSaveTimerRef.current = window.setTimeout(() => {
      viewportSaveTimerRef.current = null;
      const latest = authoritativeViewportRef.current;
      if (sameViewport(latest, intendedViewport)) {
        if (sameViewport(localViewportTargetRef.current, intendedViewport)) localViewportTargetRef.current = null;
        return;
      }
      void controller.applyIntents([{
        type: "set-viewport",
        viewport: intendedViewport,
      }]).catch(() => {
        void controller.refresh();
      }).finally(() => {
        if (sameViewport(localViewportTargetRef.current, intendedViewport)) localViewportTargetRef.current = null;
      });
    }, 500);
  }, [controller.applyIntents, controller.refresh]);

  const restoreLockedFocusViewport = useCallback((viewport: Viewport): boolean => {
    const locked = focusViewportLockRef.current;
    if (!locked) return false;
    setZoom(locked.zoom);
    if (!sameViewport(viewport, locked)) {
      void flowRef.current?.setViewport({ ...locked }, { duration: 0 }).catch(() => undefined);
    }
    return true;
  }, []);

  const onMove = useCallback<OnMove>((_event, viewport) => {
    if (restoreLockedFocusViewport(viewport)) return;
    setZoom(viewport.zoom);
    bumpLayout();
  }, [bumpLayout, restoreLockedFocusViewport]);

  const onMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => {
    if (restoreLockedFocusViewport(viewport)) return;
    setZoom(viewport.zoom);
    persistViewport(viewport);
  }, [persistViewport, restoreLockedFocusViewport]);

  const arrange = useCallback(() => {
    if (!canvas || canvas.nodes.length < 2) return;
    const layout = arrangeDesignNodes(canvas.nodes, canvas.nodeOrder);
    void controller.applyIntents([{ type: "replace-layout", nodes: layout }]).then(() => {
      window.requestAnimationFrame(() => void flowRef.current?.fitView({
        padding: 0.16,
        duration: reduceMotion ? 0 : 260,
        ease: nodeFocusEase,
        interpolate: "smooth",
      }));
    }).catch(() => undefined);
  }, [canvas, controller.applyIntents, reduceMotion]);

  const clearSelection = useCallback(() => {
    selectionGuardRef.current = null;
    selectionClearGuardRef.current = true;
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        selectionGuardFrameRef.current = null;
        selectionClearGuardRef.current = false;
      });
    });
    setSelectedNodeIds([]);
    setFocusedPanelNodeId(null);
    replaceFlowNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }, [replaceFlowNodes]);

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
    if (viewportSaveTimerRef.current !== null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
      localViewportTargetRef.current = null;
    }
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
  }, [clearSelection, focusTransition?.durationMs, focusTransition?.nodeId, focusedNodeId, reduceMotion]);

  const onPaneClick = useCallback(() => {
    if (focusActive) closeNodeFocus();
    else clearSelection();
  }, [clearSelection, closeNodeFocus, focusActive]);

  const blockFocusedMiddleButton = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!focusActive || event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
  }, [focusActive]);

  const dispatchSurfaceContextMenu = useCallback((event: ReactMouseEvent | MouseEvent, targetNodeId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    pendingContextTargetRef.current = targetNodeId;
    surfaceRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: event.clientX,
      clientY: event.clientY,
    }));
  }, []);

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
  }, []);

  const onPaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    dispatchSurfaceContextMenu(event, focusTransition?.nodeId ?? null);
  }, [dispatchSurfaceContextMenu, focusTransition?.nodeId]);

  const onNodeContextMenu = useCallback<NodeMouseHandler<DesignFlowNode>>((event, node) => {
    if (!focusActive) {
      selectionClearGuardRef.current = false;
      contextSelectionGuardRef.current = node.id;
      if (contextSelectionGuardFrameRef.current !== null) window.cancelAnimationFrame(contextSelectionGuardFrameRef.current);
      contextSelectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        contextSelectionGuardFrameRef.current = window.requestAnimationFrame(() => {
          contextSelectionGuardFrameRef.current = null;
          contextSelectionGuardRef.current = null;
        });
      });
      setMainAgentOpen(false);
      setSelectedNodeIds([node.id]);
      setFocusedPanelNodeId(null);
      replaceFlowNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
    }
    dispatchSurfaceContextMenu(event, node.id);
  }, [dispatchSurfaceContextMenu, focusActive, replaceFlowNodes]);

  const onSurfaceContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!canvasAvailable) {
      event.preventDefault();
      return;
    }
    const domNodeId = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-design-node-id]")?.dataset.designNodeId ?? null
      : null;
    const targetNodeId = pendingContextTargetRef.current ?? domNodeId ?? focusTransition?.nodeId ?? null;
    pendingContextTargetRef.current = null;
    contextMenuActiveRef.current = true;
    setContextMenuOpen(true);
    hideNodeAgentForContextMenu();
    const position = flowRef.current?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    }) ?? canvasCenter();
    setContextMenu({
      canvasX: position.x,
      canvasY: position.y,
      targetNode: targetNodeId === null
        ? null
        : canvas?.nodes.find((node) => node.id === targetNodeId) ?? null,
    });
  }, [canvas?.nodes, canvasAvailable, canvasCenter, focusTransition?.nodeId, hideNodeAgentForContextMenu]);

  useEffect(() => {
    if (!focusActive) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const preventModifiedWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
    };
    surface.addEventListener("wheel", preventModifiedWheel, { capture: true, passive: false });
    return () => surface.removeEventListener("wheel", preventModifiedWheel, true);
  }, [focusActive]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (historyLocked) return;
        if (event.shiftKey) void controller.redo().catch(() => undefined);
        else void controller.undo().catch(() => undefined);
        return;
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (historyLocked) return;
        void controller.redo().catch(() => undefined);
        return;
      }
      if (event.key === "Enter" && !focusActive && selectedNodeIds.length === 1) {
        event.preventDefault();
        openNodeAgent(selectedNodeIds[0]!, false, false);
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedNodeIds.length > 0) {
        event.preventDefault();
        const ids = [...selectedNodeIds];
        if (focusActive) closeNodeFocus(false);
        void controller.applyIntents(ids.map((nodeId) => ({ type: "remove-node" as const, nodeId }))).then(() => clearSelection()).catch(() => undefined);
        return;
      }
      if (event.key === "Escape") {
        const transientSurfaceOpen = document.querySelector([
          '[data-slot="popover-content"][data-state="open"]',
          '[data-slot="dropdown-menu-content"][data-state="open"]',
          '[data-slot="context-menu-content"][data-state="open"]',
          '[data-slot="select-content"][data-state="open"]',
          '[role="listbox"][data-state="open"]',
          '[role="dialog"][data-state="open"]',
        ].join(",")) !== null;
        if (transientSurfaceOpen) return;
        setAddMenuOpen(false);
        if (focusActive) {
          event.preventDefault();
          closeNodeFocus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearSelection, closeNodeFocus, controller.applyIntents, controller.redo, controller.undo, focusActive, historyLocked, openNodeAgent, selectedNodeIds]);

  const exportFocusedPreview = useCallback(async () => {
    const versionId = focusedCanvasNode ? previewVersionIdForNode(focusedCanvasNode) : null;
    if (!focusedCanvasNode || !versionId || focusPreviewExporting) return;
    setFocusPreviewExporting(true);
    setFocusPreviewExportError(null);
    let objectUrl: string | null = null;
    try {
      const portable = await api.downloadExactVersionHtml(projectId, focusedCanvasNode.id, versionId);
      objectUrl = URL.createObjectURL(portable);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${downloadFileStem(focusedCanvasNode.name)}-${versionId}.html`;
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

  const flowCanvas = useMemo(() => canvas ? (
    <ReactFlow<DesignFlowNode>
      nodes={flowNodes}
      edges={EMPTY_EDGES}
      nodeTypes={NODE_TYPES}
      defaultViewport={canvas.viewport}
      minZoom={0.12}
      maxZoom={2.4}
      nodesConnectable={false}
      nodesDraggable={!focusActive}
      elementsSelectable={!focusActive}
      selectionMode={SelectionMode.Partial}
      selectionOnDrag={!focusActive && tool === "select"}
      panOnDrag={focusActive ? false : tool === "hand" ? [0, 1] : SELECT_PAN_BUTTONS}
      panOnScroll={!focusActive}
      zoomOnScroll={!focusActive}
      zoomOnPinch={!focusActive}
      zoomOnDoubleClick={!focusActive}
      deleteKeyCode={null}
      multiSelectionKeyCode={MULTI_SELECTION_KEYS}
      onInit={onFlowInit}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={bumpLayout}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onNodeContextMenu}
      onSelectionStart={onSelectionStart}
      onSelectionEnd={onSelectionEnd}
      onSelectionChange={onSelectionChange}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      onPaneClick={onPaneClick}
      onPaneContextMenu={onPaneContextMenu}
      proOptions={PRO_OPTIONS}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={0.8} color="color-mix(in srgb, #1f2933 11%, transparent)" />
    </ReactFlow>
  ) : null, [
    bumpLayout,
    canvas?.viewport,
    flowNodes,
    focusActive,
    onFlowInit,
    onMove,
    onMoveEnd,
    onNodeClick,
    onNodeDragStart,
    onNodeContextMenu,
    onNodeDoubleClick,
    onNodesChange,
    onPaneClick,
    onPaneContextMenu,
    onSelectionEnd,
    onSelectionChange,
    onSelectionStart,
    tool,
  ]);

  const exporting = controller.jobs.some((job) => job.kind === "implementation-export" && isLiveJobStatus(job.status));
  const focusedContentLayoutMode = focusedCanvasNode
    ? focusedNodeLayoutMode({
        kind: focusedCanvasNode.kind,
        fileName: focusedVersionMetadata?.fileName ?? focusedCanvasNode.name,
        mimeType: focusedVersionMetadata?.mimeType,
      })
    : null;
  const focusedPreviewToolsVisible = focusedCanvasNode !== null
    && focusedContentLayoutMode === "web"
    && focusedVersionId !== null;
  const activeFocusDurationMs = focusTransition?.durationMs ?? NODE_FOCUS_FLIGHT_DURATION_MS;
  const generativeNodes = canvas?.nodes.filter((node) => !isMaterialNodeKind(node.kind)) ?? [];
  const liveNodeJobIds = new Set(controller.jobs
    .filter((job) => job.nodeId !== null && isLiveJobStatus(job.status))
    .map((job) => job.nodeId));
  const generatingNodes = generativeNodes.filter((node) => node.activeJobId !== null || liveNodeJobIds.has(node.id));
  const ungeneratedNodes = generativeNodes.filter((node) => (node.selectedVersionId ?? node.currentVersionId) === null);
  const designReadyForExport = generativeNodes.length > 0 && ungeneratedNodes.length === 0 && generatingNodes.length === 0;
  const executionAgent = availableDesignAgents.find((agent) => agent.command === mainAgentSelection.agentCommand) ?? null;
  const contextMenuNode = contextMenu?.targetNode ?? null;
  const canExport = canvasAvailable && designReadyForExport && executionAgent !== null;
  const exportModel = executionAgent
    && (!mainAgentSelection.model || executionAgent.models.includes(mainAgentSelection.model))
    ? mainAgentSelection.model || null
    : null;
  const exportTitle = !canvasAvailable
    ? "Canvas unavailable"
    : generativeNodes.length === 0
    ? "Add and generate at least one design Node before exporting"
    : generatingNodes.length > 0
      ? `Wait for Node generation to finish before exporting: ${generatingNodes.map((node) => node.name).join(", ")}`
      : ungeneratedNodes.length > 0
      ? `Generate every design Node before exporting: ${ungeneratedNodes.map((node) => node.name).join(", ")}`
      : !executionAgent
        ? "No Design Agent is currently available for export"
        : "Reimplement selected Node versions as Vite + TypeScript";

  return (
    <main
      aria-label="Design canvas"
      className="design-canvas-root"
      data-node-focus={focusTransition?.phase}
      data-main-agent={mainAgentOpen || undefined}
      style={{ "--design-focus-duration": `${activeFocusDurationMs}ms` } as CSSProperties}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? [...event.target.files] : [];
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <input
        ref={revisionInputRef}
        type="file"
        className="hidden"
        aria-label="Add material Node revision"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const nodeId = pendingRevisionNodeIdRef.current;
          event.target.value = "";
          pendingRevisionNodeIdRef.current = null;
          if (file && nodeId) void controller.appendMaterialVersion(nodeId, file).catch(() => undefined);
        }}
      />

      <DesignCanvasHeader
        projectName={projectName}
        onRenameProject={onRenameProject}
        onBackHome={onBackHome}
        canvasAvailable={canvasAvailable}
        mainAgentOpen={mainAgentOpen}
        onToggleMainAgent={() => {
          const nextOpen = !mainAgentOpen;
          if (nextOpen && focusActive) closeNodeFocus(false);
          setMainAgentOpen(nextOpen);
          if (nextOpen) setFocusedPanelNodeId(null);
        }}
        exportTitle={exportTitle}
        exporting={exporting}
        exportDisabled={exporting || controller.mutating || !canExport}
        exportButtonRef={exportButtonRef}
        onExport={() => setExportConfirmationOpen(true)}
        onOpenSettings={onOpenSettings}
      />

      <ImplementationExportConfirmation
        open={exportConfirmationOpen}
        onOpenChange={setExportConfirmationOpen}
        returnFocusRef={exportButtonRef}
        onConfirm={async () => {
          if (!executionAgent || !isDesignAgentCommand(executionAgent.command)) return;
          if (focusActive) closeNodeFocus(false);
          setMainAgentOpen(true);
          await controller.startExport({ agentCommand: executionAgent.command, model: exportModel });
        }}
      />

      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          contextMenuActiveRef.current = open;
          setContextMenuOpen(open);
          if (open) {
            hideNodeAgentForContextMenu();
          } else if (pendingFigmaImportAnchorRef.current) {
            const anchor = pendingFigmaImportAnchorRef.current;
            pendingFigmaImportAnchorRef.current = null;
            if (figmaImportOpenFrameRef.current !== null) {
              window.cancelAnimationFrame(figmaImportOpenFrameRef.current);
            }
            figmaImportOpenFrameRef.current = window.requestAnimationFrame(() => {
              figmaImportOpenFrameRef.current = null;
              setFigmaImportAnchor(anchor);
            });
          }
        }}
      >
        <ContextMenuTrigger asChild disabled={!canvasAvailable}>
          <section
            ref={surfaceRef}
            className="design-canvas-surface"
            data-tool={tool}
            data-node-focus={focusTransition?.phase}
            data-node-agent={focusedPanelNodeId ? "open" : undefined}
            data-main-agent={mainAgentOpen || undefined}
            data-preview-device={focusTransition ? focusedPreviewDevice : undefined}
            data-focused-content={focusTransition ? focusedContentLayoutMode ?? undefined : undefined}
            data-context-menu-open={contextMenuOpen || undefined}
            data-focus-motion={focusMotionAllowed ? "animated" : "instant"}
            style={{
              "--design-focus-duration": `${activeFocusDurationMs}ms`,
              "--design-node-agent-width": `${FLOATING_NODE_AGENT_WIDTH_PX}px`,
              "--design-canvas-viewport-inverse-scale": 1 / Math.max(zoom, 0.12),
              "--design-canvas-hover-label-inset": `${12 / Math.max(zoom, 0.12)}px`,
            } as CSSProperties}
            aria-label="Infinite Design canvas"
            tabIndex={0}
            onPointerMoveCapture={focusActive ? undefined : captureSelectionRect}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onContextMenu={onSurfaceContextMenu}
            onPointerDownCapture={blockFocusedMiddleButton}
            onMouseDownCapture={blockFocusedMiddleButton}
            onAuxClickCapture={blockFocusedMiddleButton}
            onWheelCapture={(event) => {
              if (focusActive && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length || !canvasAvailable) return;
              event.preventDefault();
              const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? canvasCenter();
              void importFiles([...event.dataTransfer.files], position);
            }}
          >
        {flowCanvas}

        <FocusedNodeChrome
          transition={focusTransition}
          motionAllowed={focusMotionAllowed}
          durationMs={activeFocusDurationMs}
          previewToolsVisible={focusedPreviewToolsVisible}
          previewDevice={focusedPreviewDevice}
          previewExporting={focusPreviewExporting}
          agentVisible={focusedPanelNodeId === focusTransition?.nodeId}
          onClose={() => closeNodeFocus()}
          onChooseDevice={chooseFocusedPreviewDevice}
          onExport={() => void exportFocusedPreview().catch(() => undefined)}
          onSetAgentVisible={setFocusedNodeAgentVisible}
        />

        {selectionGhost ? (
          <span
            key={selectionGhost.id}
            className="design-canvas-selection-ghost"
            aria-hidden
            style={{
              left: selectionGhost.left,
              top: selectionGhost.top,
              width: selectionGhost.width,
              height: selectionGhost.height,
            }}
          />
        ) : null}

        {canvas && canvas.nodes.length === 0 && controller.loadState === "ready" ? (
          <QuickStart
            onAddPage={() => void addNode("page")}
            onAddResearch={() => void addNode("research")}
            onImport={() => void addNode("file")}
            onOpenMainAgent={() => setMainAgentOpen(true)}
          />
        ) : null}

        {canvasAvailable ? (
          <CanvasToolDocks
            tool={tool}
            addMenuOpen={addMenuOpen}
            onAddMenuOpenChange={setAddMenuOpen}
            onChooseNode={(kind) => void addNode(kind)}
            onToolChange={setTool}
            arrangeDisabled={(canvas?.nodes.length ?? 0) < 2 || controller.mutating}
            onArrange={arrange}
            onFit={() => void flowRef.current?.fitView({
              padding: 0.16,
              duration: reduceMotion ? 0 : 240,
              ease: nodeFocusEase,
              interpolate: "smooth",
            })}
            onZoomOut={() => void flowRef.current?.zoomOut({ duration: reduceMotion ? 0 : 140 })}
            onZoomIn={() => void flowRef.current?.zoomIn({ duration: reduceMotion ? 0 : 140 })}
            zoom={zoom}
          />
        ) : null}

        {contextMenuOpen ? null : (
          <AnimatePresence>
            {selectedNode && floatingPosition.visible && floatingPosition.nodeId === selectedNode.id ? (
            <CanvasAgentPanel
            key={selectedNode.id}
            rootRef={nodePanelRef}
            floating
            compact={!focusedNodeId}
            entryX={floatingPosition.entryX}
            entryY={floatingPosition.entryY}
            projectId={projectId}
            api={api}
            scope={{ type: "node", nodeId: selectedNode.id }}
            title={`${selectedNode.name} Agent`}
            subtitle=""
            nodes={canvas?.nodes ?? []}
            jobs={controller.jobs}
            versions={versionsNodeId === selectedNode.id ? versions : []}
            selectedVersionId={selectedNode.selectedVersionId ?? selectedNode.currentVersionId}
            onAppendMaterialVersion={isMaterialNodeKind(selectedNode.kind)
              ? async (file) => {
                  await controller.appendMaterialVersion(selectedNode.id, file);
                }
              : undefined}
            materialRevisionAccept={catalogItem(selectedNode.kind).accepts}
            agents={agents}
            initialAgentCommand={initialAgentCommand}
            initialModel={initialModel}
            agentSelection={mainAgentSelection}
            onAgentSelectionChange={updateMainAgentSelection}
            onRescanAgents={onRescanAgents}
            onCancelJob={controller.cancelJob}
            onRetryJob={controller.retryJob}
            onSubmit={(prompt, nodeIds, selection) => controller.submitAgentTurn({ type: "node", nodeId: selectedNode.id }, prompt, nodeIds, selection)}
            onAttachFiles={(files) => importFiles(files, { x: selectedNode.geometry.x + selectedNode.geometry.width + 48, y: selectedNode.geometry.y })}
            onSelectVersion={async (versionId) => {
              await controller.applyIntents([{ type: "update-node", nodeId: selectedNode.id, patch: { selectedVersionId: versionId } }]);
            }}
            onClose={() => setFocusedNodeAgentVisible(false)}
            style={{
              left: floatingPosition.left,
              top: floatingPosition.top,
              visibility: floatingPosition.visible ? "visible" : "hidden",
              pointerEvents: floatingPosition.visible ? "auto" : "none",
            }}
            />
            ) : null}
          </AnimatePresence>
        )}

        <AnimatePresence initial={false}>
          {mainAgentOpen ? (
            <motion.div
              key="main-agent"
              className="design-canvas-main-agent"
              initial={reduceMotion ? false : { opacity: 0, transform: "translate3d(18px, 0px, 0px) scale(0.985)" }}
              animate={{
                opacity: 1,
                transform: "translate3d(0px, 0px, 0px) scale(1)",
                transition: { duration: reduceMotion ? 0 : 0.24, ease: CANVAS_MOTION_EASE },
              }}
              exit={{
                opacity: 0,
                transform: reduceMotion ? "translate3d(0px, 0px, 0px) scale(1)" : "translate3d(14px, 0px, 0px) scale(0.99)",
                transition: { duration: reduceMotion ? 0 : 0.18, ease: CANVAS_MOTION_EASE },
              }}
            >
              <CanvasAgentPanel
                projectId={projectId}
                api={api}
                scope={{ type: "main" }}
                title="Main Agent"
                subtitle=""
                nodes={canvas?.nodes ?? []}
                jobs={controller.jobs}
                agents={agents}
                initialAgentCommand={initialAgentCommand}
                initialModel={initialModel}
                agentSelection={mainAgentSelection}
                onAgentSelectionChange={updateMainAgentSelection}
                onRescanAgents={onRescanAgents}
                onCancelJob={controller.cancelJob}
                onRetryJob={controller.retryJob}
                onSubmit={(prompt, nodeIds, selection) => controller.submitAgentTurn({ type: "main" }, prompt, nodeIds, selection)}
                onAttachFiles={(files) => importFiles(files, canvasCenter())}
                projectPath={projectPath}
                onRevealExport={onRevealExport}
                onClose={() => setMainAgentOpen(false)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {controller.loadState === "loading" ? (
          <div className="design-canvas-loading" role="status"><LoaderCircle aria-hidden className="animate-spin" />Loading Design canvas…</div>
        ) : null}
        {controller.loadState === "error" && !canvas ? (
          <div className="design-canvas-fatal" role="alert">
            <RotateCcw aria-hidden /><strong>Canvas unavailable</strong><p>{controller.error}</p><Button size="sm" variant="outline" onClick={() => void controller.refresh()}>Try again</Button>
          </div>
        ) : null}
        {controller.error && canvas ? (
          <div className="design-canvas-error" role="alert">
            <span>{controller.error}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Dismiss canvas error" onClick={controller.clearError}><X aria-hidden /></Button>
          </div>
        ) : null}
        {focusPreviewExportError && canvas && !controller.error ? (
          <div className="design-canvas-error" role="alert">
            <span>{focusPreviewExportError}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Dismiss preview export error" onClick={() => setFocusPreviewExportError(null)}><X aria-hidden /></Button>
          </div>
        ) : null}
        {versionsLoading && selectedNode ? <span className="sr-only" role="status">Loading {selectedNode.name} versions</span> : null}
          </section>
        </ContextMenuTrigger>
        {canvasAvailable ? contextMenuNode ? (
          <ContextMenuContent
            aria-label={`${catalogItem(contextMenuNode.kind).label} Node actions`}
            className="design-node-context-menu"
          >
            <DesignNodeContextMenu
              node={contextMenuNode}
              onOpenAgent={() => openNodeAgent(contextMenuNode.id, true)}
              onAddRevision={() => requestMaterialRevision(contextMenuNode)}
              fitDisabled={focusActive}
              onFit={() => void flowRef.current?.fitView({
                nodes: flowNodesRef.current.filter((node) => node.id === contextMenuNode.id),
                padding: 0.24,
                duration: reduceMotion ? 0 : 220,
                ease: nodeFocusEase,
                interpolate: "smooth",
                maxZoom: 1.35,
              })}
              onDelete={() => removeNode(contextMenuNode.id)}
            />
          </ContextMenuContent>
        ) : (
          <ContextMenuContent aria-label="Add Design node" className="design-node-catalog design-node-catalog--context">
            <NodeCatalogMenu
              menuType="context"
              onChoose={(kind) => void addNode(
                kind,
                contextMenu
                  ? { x: contextMenu.canvasX, y: contextMenu.canvasY }
                  : canvasCenter(),
              )}
            />
            <ContextMenuSeparator />
            <ContextMenuItem
              className="design-node-catalog__item"
              onSelect={() => {
                const position = contextMenu
                  ? { x: contextMenu.canvasX, y: contextMenu.canvasY }
                  : canvasCenter();
                pendingFigmaImportAnchorRef.current = {
                  x: Math.round(position.x),
                  y: Math.round(position.y),
                };
              }}
            >
              <span className="design-node-catalog__icon">
                <Figma aria-hidden className="size-3.5" />
              </span>
              Import from Figma
            </ContextMenuItem>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      <FigmaImportDialog
        open={figmaImportAnchor !== null}
        projectId={projectId}
        anchor={figmaImportAnchor ?? { x: 0, y: 0 }}
        returnFocusRef={surfaceRef}
        onClose={() => setFigmaImportAnchor(null)}
        onImported={(result) => {
          pendingFigmaImportedNodeIdsRef.current = figmaImportedNodeIds(result, canvas);
          controller.adoptCanvas(result.canvas);
          const limitations = [...new Set([
            ...result.import.manifest.incomplete,
            ...result.import.manifest.warnings,
          ])];
          if (limitations.length > 0) {
            const visible = limitations.slice(0, 2).join("; ");
            toast(`Figma imported with limited metadata: ${visible}${
              limitations.length > 2 ? `; +${limitations.length - 2} more` : ""
            }`);
          }
          setFigmaImportAnchor(null);
          void controller.refresh();
        }}
      />
    </main>
  );
}

function figmaImportedNodeIds(
  result: FigmaCanvasImportResponse,
  previousCanvas: DesignCanvas | null,
): string[] {
  const responseNodeIds = new Set(result.canvas.nodes.map((node) => node.id));
  const artifactNodeIds = [...new Set(result.import.manifest.artifacts.flatMap((artifact) => (
    artifact.nodeId && responseNodeIds.has(artifact.nodeId) ? [artifact.nodeId] : []
  )))];
  if (artifactNodeIds.length > 0) return artifactNodeIds;
  const previousNodeIds = new Set(previousCanvas?.nodes.map((node) => node.id) ?? []);
  return result.canvas.nodes
    .map((node) => node.id)
    .filter((nodeId) => !previousNodeIds.has(nodeId));
}

function DesignNodeContextMenu({
  node,
  onOpenAgent,
  onAddRevision,
  fitDisabled,
  onFit,
  onDelete,
}: {
  node: DesignNode;
  onOpenAgent: () => void;
  onAddRevision: () => void;
  fitDisabled: boolean;
  onFit: () => void;
  onDelete: () => void;
}) {
  const item = catalogItem(node.kind);
  const material = isMaterialNodeKind(node.kind);
  return (
    <>
      <ContextMenuItem onSelect={onOpenAgent}>
        <Sparkles aria-hidden />
        {material
          ? `Inspect ${item.label.toLocaleLowerCase()} with Agent`
          : node.versionCount > 0
            ? `Create new ${item.label.toLocaleLowerCase()} version`
            : `Create ${item.label.toLocaleLowerCase()} with Agent`}
      </ContextMenuItem>
      {material ? (
        <ContextMenuItem onSelect={onAddRevision}>
          <FileUp aria-hidden />
          Add {item.label.toLocaleLowerCase()} revision…
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem disabled={fitDisabled} onSelect={onFit}>
        <LocateFixed aria-hidden />
        Fit this Node
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="design-node-context-menu__danger" onSelect={onDelete}>
        <Trash2 aria-hidden />
        Delete {item.label.toLocaleLowerCase()}
      </ContextMenuItem>
    </>
  );
}

function canvasToFlowNodes(
  nodes: readonly DesignNode[],
  projectId: string,
  api: DesignCanvasApi,
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void,
  onAppendMaterialVersion: (nodeId: string, file: File) => Promise<void>,
  onContentAspectRatio: (nodeId: string, aspectRatio: number) => void,
  onPreviewContextMenu: (nodeId: string, clientX: number, clientY: number) => void,
  onFocusAnimationStart: (nodeId: string, phase: NodeFocusPhase, durationMs: number) => void,
  onFocusAnimationComplete: (nodeId: string, phase: NodeFocusPhase) => void,
  selectedIds: ReadonlySet<string>,
  contentLayouts: ReadonlyMap<string, DesignNodeContentLayout>,
  focusMotions: ReadonlyMap<string, NodeFocusMotion>,
): DesignFlowNode[] {
  return nodes.map((node) => {
    const focusMotion = focusMotions.get(node.id) ?? null;
    const contentLayout = contentLayouts.get(node.id) ?? null;
    return {
    id: node.id,
    type: "design",
    ariaLabel: designNodeAriaLabel(node),
    className: focusMotion?.role === "source"
      ? "design-canvas-flow-node--focused"
      : focusMotion
        ? "design-canvas-flow-node--inactive"
        : undefined,
    position: { x: node.geometry.x, y: node.geometry.y },
    width: node.geometry.width,
    height: node.geometry.height,
    selected: selectedIds.has(node.id),
    data: {
      node,
      projectId,
      api,
      onResize,
      onAppendMaterialVersion,
      onContentAspectRatio,
      onPreviewContextMenu,
      onFocusAnimationStart,
      onFocusAnimationComplete,
      contentLayout,
      focusMotion,
    },
  };
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']") || target.closest("iframe") !== null;
}

function createDesignNodeId(kind: DesignNodeKind): string {
  return `${kind}-${globalThis.crypto.randomUUID()}`;
}

function downloadFileStem(name: string): string {
  const normalized = name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "dezin-preview";
}

function flowNodeGeometry(
  node: DesignFlowNode,
  fallback: DesignNode["geometry"],
): DesignNode["geometry"] {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? fallback.width,
    height: node.measured?.height ?? node.height ?? fallback.height,
  };
}

function sameDesignNode(left: DesignNode, right: DesignNode): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.name === right.name
    && sameGeometry(left.geometry, right.geometry)
    && left.state === right.state
    && left.currentVersionId === right.currentVersionId
    && left.selectedVersionId === right.selectedVersionId
    && left.versionCount === right.versionCount
    && left.assetId === right.assetId
    && left.activeJobId === right.activeJobId
    && left.error === right.error
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameNodeFocusMotion(left: NodeFocusMotion | null | undefined, right: NodeFocusMotion | null | undefined): boolean {
  if (!left || !right) return left === right || (left == null && right == null);
  return left.phase === right.phase
    && left.role === right.role
    && left.startX === right.startX
    && left.startY === right.startY
    && left.shiftX === right.shiftX
    && left.shiftY === right.shiftY
    && left.arcX === right.arcX
    && left.arcY === right.arcY
    && left.startScaleX === right.startScaleX
    && left.startScaleY === right.startScaleY
    && left.scaleX === right.scaleX
    && left.scaleY === right.scaleY
    && left.scale === right.scale
    && left.startWidth === right.startWidth
    && left.startHeight === right.startHeight
    && left.layoutWidth === right.layoutWidth
    && left.layoutHeight === right.layoutHeight
    && left.durationMs === right.durationMs
    && left.delayMs === right.delayMs
    && left.fadeDurationMs === right.fadeDurationMs;
}

function sameContentLayout(
  left: DesignNodeContentLayout | null | undefined,
  right: DesignNodeContentLayout | null | undefined,
): boolean {
  if (!left || !right) return left === right || (left == null && right == null);
  return left.width === right.width
    && left.height === right.height
    && left.canvasScale === right.canvasScale;
}

function sameViewport(left: Viewport | null, right: Viewport | null): boolean {
  return left !== null && right !== null && left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function sameGeometry(left: DesignNode["geometry"], right: DesignNode["geometry"]): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
