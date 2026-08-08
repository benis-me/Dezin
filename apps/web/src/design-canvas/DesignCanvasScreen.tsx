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
  type NodeMouseHandler,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  Bot,
  Code2,
  FileUp,
  Hand,
  LayoutGrid,
  LoaderCircle,
  LocateFixed,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/index.ts";
import { StudioToolbarHeader } from "../components/ui/StudioHeader.tsx";
import type { AgentInfo } from "../lib/api.ts";
import type { DesignExportRevealResult } from "../lib/design-export.ts";
import { arrangeDesignNodes } from "./auto-layout.ts";
import { isDesignAgentCommand, type DesignCanvasApi } from "./api.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import { DesignCanvasNode, type DesignFlowNode } from "./DesignCanvasNode.tsx";
import {
  CanvasAgentPanel,
  useFloatingNodePanel,
  type CanvasAgentSelection,
} from "./FloatingNodeAgent.tsx";
import { NodeCatalogMenu } from "./NodeCatalogMenu.tsx";
import { QuickStart } from "./QuickStart.tsx";
import type { DesignExportResult, DesignJobStatus, DesignNode, DesignNodeKind, DesignNodeVersion } from "./types.ts";
import { useDesignCanvasController } from "./useDesignCanvasController.ts";

const NODE_TYPES = { design: DesignCanvasNode } as const;
const EMPTY_EDGES: Edge[] = [];
const SELECT_PAN_BUTTONS = [1];
const MULTI_SELECTION_KEYS = ["Meta", "Control", "Shift"];
const PRO_OPTIONS = { hideAttribution: true } as const;
const CANVAS_MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function isLiveJobStatus(status: DesignJobStatus): boolean {
  return status === "queued" || status === "running" || status === "validating";
}

interface ContextMenuState {
  canvasX: number;
  canvasY: number;
  targetNode: DesignNode | null;
}

export interface DesignCanvasScreenProps {
  projectId: string;
  projectName: string;
  api: DesignCanvasApi;
  agents?: readonly AgentInfo[];
  initialAgentCommand?: string;
  initialModel?: string;
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
  onRescanAgents,
  onBackHome,
  onRenameProject,
  onOpenSettings,
  projectPath,
  onRevealExport,
  onExportReady,
}: DesignCanvasScreenProps) {
  const reduceMotion = useReducedMotion();
  const controller = useDesignCanvasController({ projectId, api, onExportReady });
  const { canvas } = controller;
  const surfaceRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const revisionInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRevisionNodeIdRef = useRef<string | null>(null);
  const pendingContextTargetRef = useRef<string | null>(null);
  const nodePanelRef = useRef<HTMLElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<DesignFlowNode> | null>(null);
  const flowNodesRef = useRef<DesignFlowNode[]>([]);
  const draggingNodeIdsRef = useRef(new Set<string>());
  const pendingNodeGeometriesRef = useRef(new Map<string, DesignNode["geometry"]>());
  const viewportSaveTimerRef = useRef<number | null>(null);
  const localViewportTargetRef = useRef<Viewport | null>(null);
  const authoritativeViewportRef = useRef<Viewport | null>(null);
  const mountedViewportProjectRef = useRef<string | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const pendingImportPositionRef = useRef({ x: 120, y: 120 });
  const selectionGuardRef = useRef<string | null>(null);
  const selectionGuardFrameRef = useRef<number | null>(null);
  const [flowNodes, setFlowNodes] = useState<DesignFlowNode[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [mainAgentOpen, setMainAgentOpen] = useState(false);
  const [mainAgentSelection, setMainAgentSelection] = useState<CanvasAgentSelection>(() => ({
    agentCommand: isDesignAgentCommand(initialAgentCommand) ? initialAgentCommand : "",
    model: isDesignAgentCommand(initialAgentCommand) ? initialModel ?? "" : "",
  }));
  const mainAgentSelectionTouchedRef = useRef(false);
  const updateMainAgentSelection = useCallback((selection: CanvasAgentSelection) => {
    mainAgentSelectionTouchedRef.current = true;
    setMainAgentSelection(selection);
  }, []);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [versions, setVersions] = useState<DesignNodeVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
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
    canvas?.nodes.find((node) => node.id === selectedNodeIds[0]) ?? null
  ), [canvas?.nodes, selectedNodeIds]);
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

  const openNodeAgent = useCallback((nodeId: string, focusComposer = false) => {
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    selectionGuardRef.current = nodeId;
    selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
      selectionGuardFrameRef.current = window.requestAnimationFrame(() => {
        selectionGuardFrameRef.current = null;
        selectionGuardRef.current = null;
      });
    });
    setSelectedNodeIds([nodeId]);
    replaceFlowNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));
    if (focusComposer) {
      window.requestAnimationFrame(() => {
        const selector = `[data-agent-scope="node:${nodeId}"] textarea`;
        surfaceRef.current?.querySelector<HTMLTextAreaElement>(selector)?.focus();
      });
    }
  }, [replaceFlowNodes]);

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

  useEffect(() => {
    if (!selectedNode) {
      setVersions([]);
      return;
    }
    const controller = new AbortController();
    setVersionsLoading(true);
    void api.listNodeVersions(projectId, selectedNode.id, controller.signal).then((next) => {
      if (!controller.signal.aborted) setVersions(next);
    }).catch(() => {
      if (!controller.signal.aborted) setVersions([]);
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

  useEffect(() => {
    if (!canvas) return;
    authoritativeViewportRef.current = canvas.viewport;
    const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id));
    const selected = new Set(selectedNodeIds.filter((id) => canvasNodeIds.has(id)));
    if (selected.size !== selectedNodeIds.length) setSelectedNodeIds([...selected]);
    for (const nodeId of draggingNodeIdsRef.current) {
      if (!canvasNodeIds.has(nodeId)) draggingNodeIdsRef.current.delete(nodeId);
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
      selected,
    );
    const nextFlowNodes = canonicalFlowNodes.map((canonicalNode) => {
      const existing = currentById.get(canonicalNode.id);
      const authoritativeNode = canonicalNode.data.node;
      const pending = pendingNodeGeometriesRef.current.get(canonicalNode.id);
      const localGeometry = existing && draggingNodeIdsRef.current.has(canonicalNode.id)
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
        && existing.data.api === api
        && existing.data.onResize === persistNodeResize) {
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
  }, [api, applyInitialViewport, canvas, persistNodeResize, projectId, selectedNodeIds]);

  const onFlowInit = useCallback((instance: ReactFlowInstance<DesignFlowNode>) => {
    flowRef.current = instance;
    const target = authoritativeViewportRef.current;
    if (target) applyInitialViewport(instance, target);
    else setZoom(instance.getZoom());
    bumpLayout();
  }, [applyInitialViewport, bumpLayout]);

  useEffect(() => () => {
    if (layoutFrameRef.current !== null) window.cancelAnimationFrame(layoutFrameRef.current);
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    pendingNodeGeometriesRef.current.clear();
    mountedViewportProjectRef.current = null;
    flowRef.current = null;
  }, []);

  const floatingPosition = useFloatingNodePanel({
    hostRef: surfaceRef,
    panelRef: nodePanelRef,
    nodeId: selectedNode?.id ?? null,
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
      if (created) openNodeAgent(created.id);
    } catch {
      // Controller exposes a non-blocking error banner and canonical refresh.
    }
  }, [canvasCenter, controller.applyIntents, openNodeAgent]);

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

  const onSelectionChange = useCallback(({ nodes }: { nodes: DesignFlowNode[] }) => {
    const next = nodes.map((node) => node.id);
    const guardedNodeId = selectionGuardRef.current;
    if (guardedNodeId && !next.includes(guardedNodeId)) return;
    if (guardedNodeId) {
      selectionGuardRef.current = null;
      if (selectionGuardFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionGuardFrameRef.current);
        selectionGuardFrameRef.current = null;
      }
    }
    setSelectedNodeIds((current) => (
      current.length === next.length && current.every((id, index) => id === next[index]) ? current : next
    ));
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler<DesignFlowNode>>((_event, node) => {
    openNodeAgent(node.id);
  }, [openNodeAgent]);

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

  const onNodesChange = useCallback((changes: NodeChange<DesignFlowNode>[]) => {
    const next = replaceFlowNodes((current) => applyNodeChanges(changes, current));
    let completedPositionChange = false;
    for (const change of changes) {
      if (change.type !== "position") continue;
      if (change.dragging === true) draggingNodeIdsRef.current.add(change.id);
      if (change.dragging === false) {
        draggingNodeIdsRef.current.add(change.id);
        completedPositionChange = true;
      }
    }
    if (completedPositionChange) {
      const completedNodeIds = [...draggingNodeIdsRef.current];
      draggingNodeIdsRef.current.clear();
      persistNodePositions(completedNodeIds, next);
    }
    if (changes.some((change) => change.type === "position" || change.type === "dimensions")) bumpLayout();
  }, [bumpLayout, persistNodePositions, replaceFlowNodes]);

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

  const onMove = useCallback<OnMove>((_event, viewport) => {
    setZoom(viewport.zoom);
    bumpLayout();
  }, [bumpLayout]);

  const onMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => {
    setZoom(viewport.zoom);
    persistViewport(viewport);
  }, [persistViewport]);

  const arrange = useCallback(() => {
    if (!canvas || canvas.nodes.length < 2) return;
    const layout = arrangeDesignNodes(canvas.nodes, canvas.nodeOrder);
    void controller.applyIntents([{ type: "replace-layout", nodes: layout }]).then(() => {
      window.requestAnimationFrame(() => void flowRef.current?.fitView({ padding: 0.16, duration: 260 }));
    }).catch(() => undefined);
  }, [canvas, controller.applyIntents]);

  const clearSelection = useCallback(() => {
    selectionGuardRef.current = null;
    if (selectionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionGuardFrameRef.current);
      selectionGuardFrameRef.current = null;
    }
    setSelectedNodeIds([]);
    replaceFlowNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
  }, [replaceFlowNodes]);

  const onPaneClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

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

  const onPaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    dispatchSurfaceContextMenu(event, null);
  }, [dispatchSurfaceContextMenu]);

  const onNodeContextMenu = useCallback<NodeMouseHandler<DesignFlowNode>>((event, node) => {
    openNodeAgent(node.id);
    dispatchSurfaceContextMenu(event, node.id);
  }, [dispatchSurfaceContextMenu, openNodeAgent]);

  const onSurfaceContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!canvasAvailable) {
      event.preventDefault();
      return;
    }
    const domNodeId = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-design-node-id]")?.dataset.designNodeId ?? null
      : null;
    const targetNodeId = pendingContextTargetRef.current ?? domNodeId;
    pendingContextTargetRef.current = null;
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
  }, [canvas?.nodes, canvasAvailable, canvasCenter]);

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
      if ((event.key === "Backspace" || event.key === "Delete") && selectedNodeIds.length > 0) {
        event.preventDefault();
        const ids = [...selectedNodeIds];
        void controller.applyIntents(ids.map((nodeId) => ({ type: "remove-node" as const, nodeId }))).then(clearSelection).catch(() => undefined);
      }
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearSelection, controller.applyIntents, controller.redo, controller.undo, historyLocked, selectedNodeIds]);

  const flowCanvas = useMemo(() => canvas ? (
    <ReactFlow<DesignFlowNode>
      nodes={flowNodes}
      edges={EMPTY_EDGES}
      nodeTypes={NODE_TYPES}
      defaultViewport={canvas.viewport}
      minZoom={0.12}
      maxZoom={2.4}
      nodesConnectable={false}
      selectionMode={SelectionMode.Partial}
      selectionOnDrag={tool === "select"}
      panOnDrag={tool === "hand" ? [0, 1] : SELECT_PAN_BUTTONS}
      panOnScroll
      zoomOnScroll
      zoomOnPinch
      deleteKeyCode={null}
      multiSelectionKeyCode={MULTI_SELECTION_KEYS}
      onInit={onFlowInit}
      onNodesChange={onNodesChange}
      onNodeDrag={bumpLayout}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
      onSelectionChange={onSelectionChange}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      onPaneClick={onPaneClick}
      onPaneContextMenu={onPaneContextMenu}
      proOptions={PRO_OPTIONS}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={0.8} color="color-mix(in srgb, var(--foreground) 10%, transparent)" />
    </ReactFlow>
  ) : null, [
    bumpLayout,
    canvas?.viewport,
    flowNodes,
    onFlowInit,
    onMove,
    onMoveEnd,
    onNodeClick,
    onNodeContextMenu,
    onNodesChange,
    onPaneClick,
    onPaneContextMenu,
    onSelectionChange,
    tool,
  ]);

  const exporting = controller.jobs.some((job) => job.kind === "implementation-export" && isLiveJobStatus(job.status));
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
        ? "No compatible Design Agent is currently available for export"
        : "Reimplement selected Node versions as Vite + TypeScript";

  return (
    <main aria-label="Design canvas" className="design-canvas-root">
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

      <StudioToolbarHeader className="design-canvas-topbar app-drag">
        <TooltipProvider delayDuration={120}>
          <div className="app-no-drag design-canvas-topbar__leading">
            {onBackHome ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Back to projects" onClick={onBackHome}><ArrowLeft aria-hidden /></Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>Back to projects</TooltipContent>
                </Tooltip>
                <span className="design-canvas-topbar__divider" aria-hidden />
              </>
            ) : null}
            <div className="design-canvas-topbar__identity">
              <EditableProjectName name={projectName} onRename={onRenameProject} />
              <span className="design-canvas-topbar__view"><LayoutGrid aria-hidden />Canvas</span>
            </div>
          </div>
          <div className="app-no-drag design-canvas-topbar__actions" role="toolbar" aria-label="Project actions">
            <HeaderIconAction
              label="Main Agent"
              active={mainAgentOpen}
              disabled={!canvasAvailable}
              onClick={() => setMainAgentOpen((current) => !current)}
            >
              <Bot aria-hidden />
            </HeaderIconAction>
            <HeaderIconAction
              label="Export code"
              tooltip={exportTitle}
              disabled={exporting || controller.mutating || !canExport}
              onClick={() => {
                setMainAgentOpen(true);
                if (executionAgent && isDesignAgentCommand(executionAgent.command)) {
                  void controller.startExport({ agentCommand: executionAgent.command, model: exportModel }).catch(() => undefined);
                }
              }}
            >
              {exporting ? <LoaderCircle aria-hidden className="animate-spin" /> : <Code2 aria-hidden />}
            </HeaderIconAction>
            <HeaderIconAction label="Settings" disabled={!onOpenSettings} onClick={() => onOpenSettings?.()}>
              <Settings2 aria-hidden />
            </HeaderIconAction>
          </div>
        </TooltipProvider>
      </StudioToolbarHeader>

      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild disabled={!canvasAvailable}>
          <section
            ref={surfaceRef}
            className="design-canvas-surface"
            data-tool={tool}
            aria-label="Infinite Design canvas"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onContextMenu={onSurfaceContextMenu}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length || !canvasAvailable) return;
              event.preventDefault();
              const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? canvasCenter();
              void importFiles([...event.dataTransfer.files], position);
            }}
          >
        {flowCanvas}

        {canvas && canvas.nodes.length === 0 && controller.loadState === "ready" ? (
          <QuickStart
            onAddPage={() => void addNode("page")}
            onAddResearch={() => void addNode("research")}
            onImport={() => void addNode("file")}
            onOpenMainAgent={() => setMainAgentOpen(true)}
          />
        ) : null}

        {canvasAvailable ? (
          <TooltipProvider delayDuration={120}>
            <div className="design-canvas-tools" role="toolbar" aria-label="Canvas tools" onContextMenu={(event) => event.stopPropagation()}>
              <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen} modal={false}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        id="design-canvas-add"
                        variant="default"
                        size="sm"
                        aria-label="Add Design node"
                      >
                        <Plus aria-hidden />Add
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={5}>Add Node</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={9}
                  aria-label="Add Design node"
                  className="design-node-catalog"
                >
                  <NodeCatalogMenu menuType="dropdown" onChoose={(kind) => void addNode(kind)} />
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="design-canvas-tools__divider" aria-hidden />
              <CanvasToolButton label="Select tool" active={tool === "select"} onClick={() => setTool("select")}>
                <MousePointer2 aria-hidden />
              </CanvasToolButton>
              <CanvasToolButton label="Hand tool" active={tool === "hand"} onClick={() => setTool("hand")}>
                <Hand aria-hidden />
              </CanvasToolButton>
            </div>

            <div className="design-canvas-zoom" role="toolbar" aria-label="Canvas view controls" onContextMenu={(event) => event.stopPropagation()}>
              <CanvasToolButton compact label="Arrange nodes" disabled={(canvas?.nodes.length ?? 0) < 2 || controller.mutating} onClick={arrange}>
                <LayoutGrid aria-hidden />
              </CanvasToolButton>
              <CanvasToolButton compact label="Fit canvas" onClick={() => void flowRef.current?.fitView({ padding: 0.16, duration: 240 })}>
                <LocateFixed aria-hidden />
              </CanvasToolButton>
              <span className="design-canvas-tools__divider" aria-hidden />
              <CanvasToolButton compact label="Zoom out" onClick={() => void flowRef.current?.zoomOut({ duration: 140 })}>
                <Minus aria-hidden />
              </CanvasToolButton>
              <output aria-label="Canvas zoom">{Math.round(zoom * 100)}%</output>
              <CanvasToolButton compact label="Zoom in" onClick={() => void flowRef.current?.zoomIn({ duration: 140 })}>
                <Plus aria-hidden />
              </CanvasToolButton>
            </div>
          </TooltipProvider>
        ) : null}

        {selectedNode ? (
          <CanvasAgentPanel
            key={selectedNode.id}
            rootRef={nodePanelRef}
            floating
            projectId={projectId}
            api={api}
            scope={{ type: "node", nodeId: selectedNode.id }}
            title={`${selectedNode.name} Agent`}
            subtitle=""
            nodes={canvas?.nodes ?? []}
            jobs={controller.jobs}
            versions={versions}
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
            onRescanAgents={onRescanAgents}
            onCancelJob={controller.cancelJob}
            onSubmit={(prompt, nodeIds, selection) => controller.submitAgentTurn({ type: "node", nodeId: selectedNode.id }, prompt, nodeIds, selection)}
            onAttachFiles={(files) => importFiles(files, { x: selectedNode.geometry.x + selectedNode.geometry.width + 48, y: selectedNode.geometry.y })}
            onSelectVersion={async (versionId) => {
              await controller.applyIntents([{ type: "update-node", nodeId: selectedNode.id, patch: { selectedVersionId: versionId } }]);
            }}
            onClose={clearSelection}
            style={{
              left: floatingPosition.left,
              top: floatingPosition.top,
              visibility: floatingPosition.visible ? "visible" : "hidden",
              pointerEvents: floatingPosition.visible ? "auto" : "none",
            }}
          />
        ) : null}

        <AnimatePresence initial={false}>
          {mainAgentOpen ? (
            <motion.div
              key="main-agent"
              className="design-canvas-main-agent"
              initial={reduceMotion ? false : { opacity: 0, x: 12, y: 4, scale: 0.992, filter: "blur(2px)" }}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.995, filter: "blur(2px)" }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: CANVAS_MOTION_EASE }}
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
            {controller.pendingIntentRetryAvailable ? <Button size="xs" variant="outline" onClick={controller.retryPendingIntent}><RotateCcw aria-hidden />Retry handoff</Button> : null}
            <Button size="icon-xs" variant="ghost" aria-label="Dismiss canvas error" onClick={controller.clearError}><X aria-hidden /></Button>
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
              onFit={() => void flowRef.current?.fitView({
                nodes: flowNodesRef.current.filter((node) => node.id === contextMenuNode.id),
                padding: 0.24,
                duration: 220,
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
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
    </main>
  );
}

function DesignNodeContextMenu({
  node,
  onOpenAgent,
  onAddRevision,
  onFit,
  onDelete,
}: {
  node: DesignNode;
  onOpenAgent: () => void;
  onAddRevision: () => void;
  onFit: () => void;
  onDelete: () => void;
}) {
  const item = catalogItem(node.kind);
  const material = isMaterialNodeKind(node.kind);
  return (
    <>
      <ContextMenuLabel className="design-node-context-menu__label">
        <span>{node.name}</span>
        <small>{item.label}{node.versionCount > 0 ? ` · v${node.versionCount}` : ""}</small>
      </ContextMenuLabel>
      <ContextMenuSeparator />
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
      <ContextMenuItem onSelect={onFit}>
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

function EditableProjectName({
  name,
  onRename,
}: {
  name: string;
  onRename?: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [displayName, setDisplayName] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setDisplayName(name);
    setValue(name);
  }, [name]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const nextName = value.trim();
    if (!nextName || nextName === displayName || !onRename) {
      setValue(displayName);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(nextName);
      setDisplayName(nextName);
      setValue(nextName);
    } catch {
      setValue(displayName);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }, [displayName, onRename, value]);

  return (
    <h1 className="design-canvas-topbar__project-name" title={displayName} data-editing={editing || undefined}>
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Project name"
          value={value}
          maxLength={160}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelledRef.current = true;
              setValue(displayName);
              setEditing(false);
            }
          }}
        />
      ) : onRename ? (
        <button
          type="button"
          aria-label={`Rename project: ${displayName}`}
          title="Rename project"
          onClick={() => {
            cancelledRef.current = false;
            setValue(displayName);
            setEditing(true);
          }}
        >
          {displayName}
        </button>
      ) : displayName}
    </h1>
  );
}

function HeaderIconAction({
  label,
  tooltip = label,
  active,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="design-canvas-topbar__action-trigger" tabIndex={disabled ? 0 : undefined}>
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            className="design-canvas-topbar__icon-action"
            aria-label={label}
            aria-pressed={active === undefined ? undefined : active}
            title={tooltip}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function CanvasToolButton({
  label,
  active,
  compact = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size={compact ? "icon-xs" : "icon-sm"}
          aria-label={label}
          aria-pressed={active === undefined ? undefined : active}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={5}>{label}</TooltipContent>
    </Tooltip>
  );
}

function canvasToFlowNodes(
  nodes: readonly DesignNode[],
  projectId: string,
  api: DesignCanvasApi,
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void,
  selectedIds: ReadonlySet<string>,
): DesignFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "design",
    position: { x: node.geometry.x, y: node.geometry.y },
    width: node.geometry.width,
    height: node.geometry.height,
    selected: selectedIds.has(node.id),
    data: { node, projectId, api, onResize },
  }));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']") || target.closest("iframe") !== null;
}

function createDesignNodeId(kind: DesignNodeKind): string {
  return `${kind}-${globalThis.crypto.randomUUID()}`;
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
    && (left.lastReadyVersionId ?? null) === (right.lastReadyVersionId ?? null)
    && left.versionCount === right.versionCount
    && left.assetId === right.assetId
    && left.activeJobId === right.activeJobId
    && left.error === right.error
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameViewport(left: Viewport | null, right: Viewport | null): boolean {
  return left !== null && right !== null && left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function sameGeometry(left: DesignNode["geometry"], right: DesignNode["geometry"]): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
