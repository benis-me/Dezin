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
import {
  ArrowLeft,
  Bot,
  Code2,
  Hand,
  LayoutGrid,
  LoaderCircle,
  LocateFixed,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Button } from "../components/ui/Button.tsx";
import { StudioToolbarHeader } from "../components/ui/StudioHeader.tsx";
import type { AgentInfo } from "../lib/api.ts";
import type { DesignExportRevealResult } from "../lib/design-export.ts";
import { arrangeDesignNodes } from "./auto-layout.ts";
import type { DesignCanvasApi } from "./api.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import { DesignCanvasNode, type DesignFlowNode } from "./DesignCanvasNode.tsx";
import { CanvasAgentPanel, useFloatingNodePanel } from "./FloatingNodeAgent.tsx";
import { NodeCatalogMenu } from "./NodeCatalogMenu.tsx";
import { QuickStart } from "./QuickStart.tsx";
import type { DesignExportResult, DesignJobStatus, DesignNode, DesignNodeKind, DesignNodeVersion } from "./types.ts";
import { useDesignCanvasController } from "./useDesignCanvasController.ts";

const NODE_TYPES = { design: DesignCanvasNode } as const;
const EMPTY_EDGES: Edge[] = [];
const SELECT_PAN_BUTTONS = [1, 2];
const MULTI_SELECTION_KEYS = ["Meta", "Control", "Shift"];
const PRO_OPTIONS = { hideAttribution: true } as const;

function isLiveJobStatus(status: DesignJobStatus): boolean {
  return status === "queued" || status === "running" || status === "validating";
}

interface ContextMenuState {
  clientX: number;
  clientY: number;
  canvasX: number;
  canvasY: number;
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
  projectPath,
  onRevealExport,
  onExportReady,
}: DesignCanvasScreenProps) {
  const controller = useDesignCanvasController({ projectId, api, onExportReady });
  const { canvas } = controller;
  const surfaceRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nodePanelRef = useRef<HTMLElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<DesignFlowNode> | null>(null);
  const flowNodesRef = useRef<DesignFlowNode[]>([]);
  const draggingNodeIdsRef = useRef(new Set<string>());
  const viewportSaveTimerRef = useRef<number | null>(null);
  const localViewportTargetRef = useRef<Viewport | null>(null);
  const viewportSyncTargetRef = useRef<Viewport | null>(null);
  const authoritativeViewportRef = useRef<Viewport | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const pendingImportPositionRef = useRef({ x: 120, y: 120 });
  const selectionGuardRef = useRef<string | null>(null);
  const selectionGuardFrameRef = useRef<number | null>(null);
  const [flowNodes, setFlowNodes] = useState<DesignFlowNode[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [mainAgentOpen, setMainAgentOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [versions, setVersions] = useState<DesignNodeVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

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

  const openNodeAgent = useCallback((nodeId: string) => {
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
  }, [replaceFlowNodes]);

  const persistNodeResize = useCallback((nodeId: string, geometry: DesignNode["geometry"]) => {
    void controller.applyIntents([{
      type: "update-node",
      nodeId,
      patch: { geometry },
    }]).catch(() => undefined);
  }, [controller.applyIntents]);

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

  const syncMountedViewport = useCallback((instance: ReactFlowInstance<DesignFlowNode>, target: Viewport) => {
    const mounted = instance.getViewport();
    if (sameViewport(mounted, target)) {
      if (sameViewport(viewportSyncTargetRef.current, target)) viewportSyncTargetRef.current = null;
      setZoom(mounted.zoom);
      return;
    }
    if (sameViewport(viewportSyncTargetRef.current, target)) return;
    const syncTarget = { ...target };
    viewportSyncTargetRef.current = syncTarget;
    void instance.setViewport(syncTarget, { duration: 0 }).then(() => {
      if (flowRef.current !== instance) return;
      const actual = instance.getViewport();
      setZoom(actual.zoom);
      if (sameViewport(viewportSyncTargetRef.current, syncTarget)) viewportSyncTargetRef.current = null;
      bumpLayout();
    }).catch(() => {
      if (flowRef.current !== instance) return;
      setZoom(instance.getZoom());
      if (sameViewport(viewportSyncTargetRef.current, syncTarget)) viewportSyncTargetRef.current = null;
    });
  }, [bumpLayout]);

  useEffect(() => {
    if (!canvas) return;
    authoritativeViewportRef.current = canvas.viewport;
    const selected = new Set(selectedNodeIds.filter((id) => canvas.nodes.some((node) => node.id === id)));
    if (selected.size !== selectedNodeIds.length) setSelectedNodeIds([...selected]);
    const nextFlowNodes = canvasToFlowNodes(canvas.nodes, projectId, api, openNodeAgent, removeNode, persistNodeResize, selected);
    flowNodesRef.current = nextFlowNodes;
    setFlowNodes(nextFlowNodes);
    for (const nodeId of draggingNodeIdsRef.current) {
      if (!canvas.nodes.some((node) => node.id === nodeId)) draggingNodeIdsRef.current.delete(nodeId);
    }

    const instance = flowRef.current;
    if (instance) syncMountedViewport(instance, canvas.viewport);
    else setZoom(canvas.viewport.zoom);
  }, [api, canvas, openNodeAgent, persistNodeResize, projectId, removeNode, selectedNodeIds.length, syncMountedViewport]);

  const onFlowInit = useCallback((instance: ReactFlowInstance<DesignFlowNode>) => {
    flowRef.current = instance;
    const target = authoritativeViewportRef.current;
    if (target) syncMountedViewport(instance, target);
    else setZoom(instance.getZoom());
    bumpLayout();
  }, [bumpLayout, syncMountedViewport]);

  useEffect(() => () => {
    if (layoutFrameRef.current !== null) window.cancelAnimationFrame(layoutFrameRef.current);
    if (selectionGuardFrameRef.current !== null) window.cancelAnimationFrame(selectionGuardFrameRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
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
    setContextMenu(null);
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
    const intents = [...new Set(nodeIds)].flatMap((nodeId) => {
      const authoritative = authoritativeById.get(nodeId);
      const flowNode = flowById.get(nodeId);
      if (!authoritative || !flowNode) return [];
      const geometry = {
        x: flowNode.position.x,
        y: flowNode.position.y,
        width: flowNode.measured?.width ?? authoritative.geometry.width,
        height: flowNode.measured?.height ?? authoritative.geometry.height,
      };
      if (sameGeometry(geometry, authoritative.geometry)) return [];
      return [{ type: "update-node" as const, nodeId, patch: { geometry } }];
    });
    if (intents.length > 0) void controller.applyIntents(intents).catch(() => undefined);
  }, [canvas?.nodes, controller.applyIntents]);

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
    }, 180);
  }, [controller.applyIntents, controller.refresh]);

  const onMove = useCallback<OnMove>((_event, viewport) => {
    setZoom(viewport.zoom);
    bumpLayout();
  }, [bumpLayout]);

  const onMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => {
    setZoom(viewport.zoom);
    if (sameViewport(viewportSyncTargetRef.current, viewport)) return;
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
    setContextMenu(null);
    clearSelection();
  }, [clearSelection]);

  const onPaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? canvasCenter();
    setContextMenu({ clientX: event.clientX, clientY: event.clientY, canvasX: position.x, canvasY: position.y });
  }, [canvasCenter]);

  const onSurfaceContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const viewport = canvas?.viewport ?? { x: 0, y: 0, zoom: 1 };
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const position = {
      x: (event.clientX - (bounds?.left ?? 0) - viewport.x) / viewport.zoom,
      y: (event.clientY - (bounds?.top ?? 0) - viewport.y) / viewport.zoom,
    };
    setContextMenu({ clientX: event.clientX, clientY: event.clientY, canvasX: position.x, canvasY: position.y });
  }, [canvas?.viewport]);

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
        setContextMenu(null);
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
      panOnDrag={tool === "hand" ? true : SELECT_PAN_BUTTONS}
      panOnScroll
      zoomOnScroll
      zoomOnPinch
      deleteKeyCode={null}
      multiSelectionKeyCode={MULTI_SELECTION_KEYS}
      onInit={onFlowInit}
      onNodesChange={onNodesChange}
      onNodeDrag={bumpLayout}
      onNodeClick={onNodeClick}
      onSelectionChange={onSelectionChange}
      onMove={onMove}
      onMoveEnd={onMoveEnd}
      onPaneClick={onPaneClick}
      onPaneContextMenu={onPaneContextMenu}
      proOptions={PRO_OPTIONS}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="color-mix(in srgb, var(--foreground) 15%, transparent)" />
    </ReactFlow>
  ) : null, [
    bumpLayout,
    canvas?.viewport,
    flowNodes,
    onFlowInit,
    onMove,
    onMoveEnd,
    onNodeClick,
    onNodesChange,
    onPaneClick,
    onPaneContextMenu,
    onSelectionChange,
    tool,
  ]);

  const contextPosition = contextMenu ? clampContextMenu(contextMenu, surfaceRef.current) : null;
  const exporting = controller.jobs.some((job) => job.kind === "implementation-export" && isLiveJobStatus(job.status));
  const generativeNodes = canvas?.nodes.filter((node) => !isMaterialNodeKind(node.kind)) ?? [];
  const liveNodeJobIds = new Set(controller.jobs
    .filter((job) => job.nodeId !== null && isLiveJobStatus(job.status))
    .map((job) => job.nodeId));
  const generatingNodes = generativeNodes.filter((node) => node.activeJobId !== null || liveNodeJobIds.has(node.id));
  const ungeneratedNodes = generativeNodes.filter((node) => (node.selectedVersionId ?? node.currentVersionId) === null);
  const canExport = generativeNodes.length > 0 && ungeneratedNodes.length === 0 && generatingNodes.length === 0;
  const exportTitle = generativeNodes.length === 0
    ? "Add and generate at least one design Node before exporting"
    : generatingNodes.length > 0
      ? `Wait for Node generation to finish before exporting: ${generatingNodes.map((node) => node.name).join(", ")}`
      : ungeneratedNodes.length > 0
      ? `Generate every design Node before exporting: ${ungeneratedNodes.map((node) => node.name).join(", ")}`
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

      <StudioToolbarHeader className="design-canvas-topbar app-drag px-2.5">
        <div className="app-no-drag flex min-w-0 items-center gap-1.5">
          {onBackHome ? <Button variant="ghost" size="icon-xs" aria-label="Back to projects" onClick={onBackHome}><ArrowLeft aria-hidden /></Button> : null}
          <div className="design-canvas-topbar__identity">
            <span>Design</span><span aria-hidden>/</span><strong>{projectName}</strong>
          </div>
        </div>
        <div className="app-no-drag design-canvas-topbar__center">
          <div className="design-canvas-add-control">
            <Button
              id="design-canvas-add"
              variant="outline"
              size="xs"
              aria-label="Add Design node"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((current) => !current)}
            >
              <Plus aria-hidden />Add
            </Button>
            {addMenuOpen ? <NodeCatalogMenu className="design-node-catalog--toolbar" labelledBy="design-canvas-add" onChoose={(kind) => void addNode(kind)} /> : null}
          </div>
          <div className="design-canvas-topbar__separator" />
          <Button variant="ghost" size="icon-xs" aria-label="Undo" title={historyLocked ? "Cancel active Node generation before using history" : "Undo (⌘Z)"} disabled={!canvas?.undoDepth || controller.mutating || historyLocked} onClick={() => void controller.undo().catch(() => undefined)}><Undo2 aria-hidden /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Redo" title={historyLocked ? "Cancel active Node generation before using history" : "Redo (⇧⌘Z)"} disabled={!canvas?.redoDepth || controller.mutating || historyLocked} onClick={() => void controller.redo().catch(() => undefined)}><Redo2 aria-hidden /></Button>
          <Button variant="ghost" size="xs" aria-label="Auto arrange nodes" disabled={(canvas?.nodes.length ?? 0) < 2 || controller.mutating} onClick={arrange}><LayoutGrid aria-hidden />Arrange</Button>
        </div>
        <div className="app-no-drag ml-auto flex min-w-0 items-center gap-1.5">
          <div className="design-canvas-topbar__zoom">
            <Button variant="ghost" size="icon-xs" aria-label="Zoom out" onClick={() => void flowRef.current?.zoomOut({ duration: 120 })}><Minus aria-hidden /></Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Button variant="ghost" size="icon-xs" aria-label="Zoom in" onClick={() => void flowRef.current?.zoomIn({ duration: 120 })}><Plus aria-hidden /></Button>
          </div>
          <Button variant={mainAgentOpen ? "secondary" : "outline"} size="xs" aria-label="Main Agent" aria-pressed={mainAgentOpen} onClick={() => setMainAgentOpen((current) => !current)}><Bot aria-hidden />Main Agent</Button>
          <Button
            size="xs"
            aria-label="Export code"
            title={exportTitle}
            disabled={exporting || controller.mutating || !canExport}
            onClick={() => {
              setMainAgentOpen(true);
              void controller.startExport().catch(() => undefined);
            }}
          >
            {exporting ? <LoaderCircle aria-hidden className="animate-spin" /> : <Code2 aria-hidden />}Export code
          </Button>
        </div>
      </StudioToolbarHeader>

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
          if (!event.dataTransfer.files.length) return;
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

        <div className="design-canvas-tools" role="toolbar" aria-label="Canvas tools">
          <Button variant={tool === "select" ? "secondary" : "ghost"} size="icon-xs" aria-label="Select tool" aria-pressed={tool === "select"} onClick={() => setTool("select")}><MousePointer2 aria-hidden /></Button>
          <Button variant={tool === "hand" ? "secondary" : "ghost"} size="icon-xs" aria-label="Hand tool" aria-pressed={tool === "hand"} onClick={() => setTool("hand")}><Hand aria-hidden /></Button>
          <span />
          <Button variant="ghost" size="icon-xs" aria-label="Fit canvas" onClick={() => void flowRef.current?.fitView({ padding: 0.16, duration: 240 })}><LocateFixed aria-hidden /></Button>
        </div>

        {contextMenu && contextPosition ? (
          <NodeCatalogMenu
            className="design-node-catalog--context"
            style={{ left: contextPosition.left, top: contextPosition.top }}
            onChoose={(kind) => void addNode(kind, { x: contextMenu.canvasX, y: contextMenu.canvasY })}
          />
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
            subtitle={`${catalogItem(selectedNode.kind).label} · reads the complete canvas`}
            nodes={canvas?.nodes ?? []}
            jobs={controller.jobs}
            versions={versions}
            selectedVersionId={selectedNode.selectedVersionId ?? selectedNode.currentVersionId}
            assetRevision={isMaterialNodeKind(selectedNode.kind) ? shortAssetRevision(selectedNode.assetId) : null}
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
              opacity: floatingPosition.visible ? 1 : 0,
              pointerEvents: floatingPosition.visible ? "auto" : "none",
            }}
          />
        ) : null}

        {mainAgentOpen ? (
          <div className="design-canvas-main-agent">
            <CanvasAgentPanel
              projectId={projectId}
              api={api}
              scope={{ type: "main" }}
              title="Main Agent"
              subtitle="Coordinates the canvas and node Agents"
              nodes={canvas?.nodes ?? []}
              jobs={controller.jobs}
              agents={agents}
              initialAgentCommand={initialAgentCommand}
              initialModel={initialModel}
              onRescanAgents={onRescanAgents}
              onCancelJob={controller.cancelJob}
              onSubmit={(prompt, nodeIds, selection) => controller.submitAgentTurn({ type: "main" }, prompt, nodeIds, selection)}
              onAttachFiles={(files) => importFiles(files, canvasCenter())}
              projectPath={projectPath}
              onRevealExport={onRevealExport}
              onClose={() => setMainAgentOpen(false)}
            />
          </div>
        ) : null}

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
        {controller.mutating ? <div className="design-canvas-saving" role="status"><Sparkles aria-hidden />Updating canvas</div> : null}
        {versionsLoading && selectedNode ? <span className="sr-only" role="status">Loading {selectedNode.name} versions</span> : null}
      </section>
    </main>
  );
}

function canvasToFlowNodes(
  nodes: readonly DesignNode[],
  projectId: string,
  api: DesignCanvasApi,
  onGenerate: (nodeId: string) => void,
  onDelete: (nodeId: string) => void,
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
    data: { node, projectId, api, onGenerate, onDelete, onResize },
  }));
}

function clampContextMenu(menu: ContextMenuState, host: HTMLElement | null): { left: number; top: number } | null {
  if (!host) return null;
  const rect = host.getBoundingClientRect();
  const width = Math.min(420, Math.max(280, rect.width - 16));
  const height = Math.min(480, Math.max(260, rect.height - 16));
  return {
    left: Math.max(8, Math.min(menu.clientX - rect.left, rect.width - width - 8)),
    top: Math.max(8, Math.min(menu.clientY - rect.top, rect.height - height - 8)),
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']") || target.closest("iframe") !== null;
}

function shortAssetRevision(assetId: string | null): string {
  if (!assetId) return "unavailable";
  return assetId.length > 18 ? `${assetId.slice(0, 18)}…` : assetId;
}

function createDesignNodeId(kind: DesignNodeKind): string {
  return `${kind}-${globalThis.crypto.randomUUID()}`;
}

function sameViewport(left: Viewport | null, right: Viewport | null): boolean {
  return left !== null && right !== null && left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function sameGeometry(left: DesignNode["geometry"], right: DesignNode["geometry"]): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
