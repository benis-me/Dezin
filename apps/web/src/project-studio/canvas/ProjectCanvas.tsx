import "@xyflow/react/dist/style.css";
import "./project-canvas.css";

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type AriaLabelConfig,
  type NodeChange,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../../lib/api.ts";
import type { ProposalDiff } from "../proposal/proposal-diff.ts";
import {
  EMPTY_PROPOSAL_OVERLAY_MODEL,
  ProposalOverlay,
  ProposalOverlayEdge,
  createProposalOverlayModel,
  mergeProposalOverlay,
  proposalOverlayIdForChange,
  type ProposalFocusRequest,
} from "../proposal/ProposalOverlay.tsx";
import { WorkspaceCanvasToolbar, type CanvasTool } from "./WorkspaceCanvasToolbar.tsx";
import { WorkspaceOutline } from "./WorkspaceOutline.tsx";
import { workspaceEdgeTypes } from "./edge-types.tsx";
import { workspaceNodeTypes } from "./node-types.tsx";
import {
  createPlannedPrototypeCommand,
  isValidWorkspaceConnection,
  semanticZoomLevel,
  workspaceGraphToFlow,
  type WorkspaceEdgeFilter,
  type WorkspaceFlowEdge,
  type WorkspaceFlowNode,
} from "./workspace-graph-adapter.ts";
import {
  buildDeleteGroupCommands,
  buildGroupCommands,
  buildMoveCommands,
  buildUngroupCommands,
  layoutObjectMap,
  materializeWorkspaceLayout,
} from "./workspace-layout.ts";

const VIEWPORT_SAVE_DELAY_MS = 260;
const MOVE_DEDUPE_WINDOW_MS = 80;
const PROPOSAL_FOCUS_MOUNT_RETRIES = 4;
const NOOP_VIEWPORT_CHANGE = () => {};
const proposalNodeTypes = { ...workspaceNodeTypes, proposal: ProposalOverlay } satisfies NodeTypes;
const proposalEdgeTypes = { ...workspaceEdgeTypes, proposal: ProposalOverlayEdge } satisfies EdgeTypes;
const CANVAS_ARIA_LABEL_CONFIG = {
  "node.a11yDescription.default": "For Page and Component nodes, Enter opens the editor. Press Space to select; arrow keys move selected objects; Escape clears selection. Objects are not deleted with the keyboard.",
  "node.a11yDescription.keyboardDisabled": "For Page and Component nodes, Enter opens the editor. Press Space to select; arrow keys move selected objects; Escape clears selection. Objects are not deleted with the keyboard.",
  "edge.a11yDescription.default": "Press Enter or Space to select a relation; Escape clears selection. Relations are not deleted with the keyboard.",
} satisfies Partial<AriaLabelConfig>;

function restoreDeleteButtonFocus(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Delete group"]')?.focus();
  });
}

export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "input,textarea,select,button,a,[role='button'],[contenteditable]:not([contenteditable='false'])",
  ));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameViewport(left: Viewport, right: WorkspaceViewport): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function freshGroupId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `group-${suffix}`;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function isLayoutDescendant(layout: WorkspaceLayout, objectId: string, ancestorId: string): boolean {
  const byId = layoutObjectMap(layout);
  let parentId = byId.get(objectId)?.parentGroupId ?? null;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentGroupId ?? null;
  }
  return false;
}

export interface ProjectCanvasProps {
  projectId: string;
  projectName: string;
  graph: WorkspaceGraph;
  layout: WorkspaceLayout;
  viewport?: WorkspaceViewport;
  artifactRevisionIds: Readonly<Record<string, string | null>>;
  selectedNodeIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onViewportChange?: (viewport: WorkspaceViewport) => void;
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onApplyGraphCommands: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
  proposal?: { id: string } | null;
  proposalDiff?: ProposalDiff | null;
  proposalFocus?: ProposalFocusRequest | null;
}

type LayoutCommandSource = readonly WorkspaceLayoutCommand[]
  | ((layout: WorkspaceLayout) => readonly WorkspaceLayoutCommand[]);

export function ProjectCanvas({
  projectId,
  projectName,
  graph,
  layout,
  viewport = layout.viewport,
  artifactRevisionIds,
  selectedNodeIds,
  onSelectionChange,
  onViewportChange = NOOP_VIEWPORT_CHANGE,
  onSaveLayout,
  onApplyGraphCommands,
  onOpenArtifact,
  proposal = null,
  proposalDiff = null,
  proposalFocus = null,
}: ProjectCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkspaceFlowNode, WorkspaceFlowEdge> | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<WorkspaceViewport | null>(null);
  const lastMoveBatchRef = useRef<{ key: string; at: number } | null>(null);
  const handledProposalFocusRef = useRef<{ proposalId: string; nonce: number } | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [edgeFilter, setEdgeFilter] = useState<WorkspaceEdgeFilter>("flow");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(viewport.zoom);
  const [adapterZoom, setAdapterZoom] = useState(viewport.zoom);
  const [status, setStatus] = useState("Canvas ready");
  const [pendingDeleteGroupId, setPendingDeleteGroupId] = useState<string | null>(null);
  const [reconcileVersion, setReconcileVersion] = useState(0);

  const canvasLayout = useMemo(() => materializeWorkspaceLayout(graph, layout), [graph, layout]);
  const authoritativeLayoutRef = useRef(canvasLayout);
  const workingLayoutRef = useRef(canvasLayout);
  const layoutMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedLayoutJobsRef = useRef(0);
  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const selectedEdgeSet = useMemo(() => new Set(selectedEdgeIds), [selectedEdgeIds]);

  useEffect(() => {
    authoritativeLayoutRef.current = canvasLayout;
    if (queuedLayoutJobsRef.current === 0) workingLayoutRef.current = canvasLayout;
  }, [canvasLayout]);

  const synchronizeAuthoritativeViewport = useCallback((
    instance: ReactFlowInstance<WorkspaceFlowNode, WorkspaceFlowEdge>,
  ) => {
    if (sameViewport(instance.getViewport(), viewport)) return;
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    setZoom(viewport.zoom);
    setAdapterZoom(viewport.zoom);
    void instance.setViewport(viewport);
  }, [viewport.x, viewport.y, viewport.zoom]);

  useEffect(() => {
    const instance = flowRef.current;
    if (instance) synchronizeAuthoritativeViewport(instance);
  }, [synchronizeAuthoritativeViewport]);

  const persistLayout = useCallback(async (
    source: LayoutCommandSource,
    successMessage: string,
  ): Promise<boolean> => {
    queuedLayoutJobsRef.current += 1;
    const run = async (): Promise<boolean> => {
      try {
        const commands = typeof source === "function" ? source(workingLayoutRef.current) : source;
        if (commands.length === 0) return false;
        setStatus("Saving canvas…");
        const saved = await onSaveLayout(commands);
        authoritativeLayoutRef.current = saved;
        workingLayoutRef.current = saved;
        setStatus(successMessage);
        return true;
      } catch (error) {
        workingLayoutRef.current = authoritativeLayoutRef.current;
        setStatus(error instanceof Error && error.message ? error.message : "Couldn't save the canvas. Try again.");
        setReconcileVersion((version) => version + 1);
        return false;
      } finally {
        queuedLayoutJobsRef.current -= 1;
        if (queuedLayoutJobsRef.current === 0) {
          workingLayoutRef.current = authoritativeLayoutRef.current;
        }
      }
    };
    const result = layoutMutationQueueRef.current.then(run);
    layoutMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [onSaveLayout]);

  const toggleCollapsed = useCallback((groupId: string, collapsed: boolean) => {
    const previousSelection = [...selectedNodeIds];
    if (collapsed) {
      const next = selectedNodeIds.filter((id) => !isLayoutDescendant(canvasLayout, id, groupId));
      if (!next.includes(groupId)) next.push(groupId);
      if (!sameIds(next, selectedNodeIds)) onSelectionChange(next);
    }
    void persistLayout([{ type: "set-collapsed", groupId, collapsed }], collapsed ? "Group collapsed" : "Group expanded")
      .then((saved) => { if (!saved) onSelectionChange(previousSelection); });
  }, [canvasLayout, onSelectionChange, persistLayout, selectedNodeIds]);

  const renameGroup = useCallback((groupId: string, label: string) => {
    void persistLayout([{ type: "rename-group", groupId, label }], "Group renamed");
  }, [persistLayout]);

  const resizeGroup = useCallback((groupId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    void persistLayout([
      { type: "move", objectId: groupId, x: bounds.x, y: bounds.y },
      { type: "resize-group", groupId, width: bounds.width, height: bounds.height },
    ], "Group resized");
  }, [persistLayout]);

  const { canonicalModel, model, overlayModel } = useMemo(() => {
    const view = {
      zoom: adapterZoom,
      edgeFilter,
      projectId,
      artifactRevisionIds,
      selectedNodeIds: selectedSet,
      selectedEdgeIds: selectedEdgeSet,
      onToggleCollapsed: toggleCollapsed,
      onRenameGroup: renameGroup,
      onResizeGroup: resizeGroup,
    };
    const canonical = workspaceGraphToFlow(graph, canvasLayout, view);
    if (!proposal || !proposalDiff) {
      return {
        canonicalModel: canonical,
        model: canonical,
        overlayModel: EMPTY_PROPOSAL_OVERLAY_MODEL,
      };
    }
    const allRelationsView = { ...view, edgeFilter: "all" as const };
    const canonicalAll = edgeFilter === "all"
      ? canonical
      : workspaceGraphToFlow(graph, canvasLayout, allRelationsView);
    const proposedAll = workspaceGraphToFlow(
      proposalDiff.proposedGraph,
      proposalDiff.proposedLayout ?? canvasLayout,
      { ...allRelationsView, selectedNodeIds: new Set<string>(), selectedEdgeIds: new Set<string>() },
    );
    const auditedAll = proposalDiff.auditedLayout
      ? workspaceGraphToFlow(
          proposalDiff.auditedGraph,
          proposalDiff.auditedLayout,
          { ...allRelationsView, selectedNodeIds: new Set<string>(), selectedEdgeIds: new Set<string>() },
        )
      : canonicalAll;
    const overlay = createProposalOverlayModel(proposalDiff, canonicalAll, proposal.id, proposedAll, auditedAll);
    return {
      canonicalModel: canonical,
      model: mergeProposalOverlay(canonical, overlay),
      overlayModel: overlay,
    };
  }, [
    adapterZoom,
    artifactRevisionIds,
    canvasLayout,
    edgeFilter,
    graph,
    projectId,
    proposal,
    proposalDiff,
    renameGroup,
    resizeGroup,
    selectedEdgeSet,
    selectedSet,
    toggleCollapsed,
    reconcileVersion,
  ]);

  const [nodes, setNodes] = useState<WorkspaceFlowNode[]>(model.nodes);
  const [edges, setEdges] = useState<WorkspaceFlowEdge[]>(model.edges);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const canonicalNodeIds = useMemo(() => new Set(canonicalModel.nodes.map((node) => node.id)), [canonicalModel]);
  const canonicalEdgeIds = useMemo(() => new Set(canonicalModel.edges.map((edge) => edge.id)), [canonicalModel]);

  useEffect(() => {
    setNodes((current) => {
      const live = new Map(current.map((node) => [node.id, node]));
      const next = model.nodes.map((node) => {
        const existing = live.get(node.id);
        return existing?.dragging ? { ...node, position: existing.position, dragging: true } : node;
      });
      nodesRef.current = next;
      return next;
    });
    edgesRef.current = model.edges;
    setEdges(model.edges);
  }, [model]);

  useEffect(() => {
    if (!proposal || !proposalFocus || (overlayModel.nodes.length === 0 && overlayModel.edges.length === 0)) return;
    const handled = handledProposalFocusRef.current;
    if (handled?.proposalId === proposal.id && handled.nonce === proposalFocus.nonce) return;
    const viewId = proposalOverlayIdForChange(proposal.id, proposalFocus.key);
    let active = true;
    let focusFrame: number | null = null;
    const locateElement = () => [...(canvasRef.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id], .react-flow__edge[data-id]") ?? [])]
      .find((candidate) => candidate.dataset.id === viewId);
    const node = nodesRef.current.find((candidate) => candidate.id === viewId);
    const edge = edgesRef.current.find((candidate) => candidate.id === viewId);
    const fitNodes = node
      ? [node]
      : edge
        ? nodesRef.current.filter((candidate) => candidate.id === edge.source || candidate.id === edge.target)
        : [];
    const focusAfterViewSettles = async () => {
      try {
        if (fitNodes.length > 0 && flowRef.current) {
          await flowRef.current.fitView({
            nodes: fitNodes,
            padding: 0.42,
            duration: reducedMotion() ? 0 : 180,
          });
        }
      } catch {
        // Focus recovery remains useful if the viewport transition is interrupted.
      }
      if (!active) return;
      const focusMountedTarget = (retriesRemaining: number) => {
        focusFrame = window.requestAnimationFrame(() => {
          if (!active) return;
          const target = locateElement();
          if (!target && retriesRemaining > 0) {
            focusMountedTarget(retriesRemaining - 1);
            return;
          }
          if (!target) return;
          target.focus();
          handledProposalFocusRef.current = {
            proposalId: proposal.id,
            nonce: proposalFocus.nonce,
          };
        });
      };
      focusMountedTarget(PROPOSAL_FOCUS_MOUNT_RETRIES);
    };
    void focusAfterViewSettles();
    return () => {
      active = false;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [overlayModel, proposal, proposalFocus]);

  useEffect(() => () => {
    if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (pending) {
      void layoutMutationQueueRef.current.then(() => onSaveLayout([{ type: "set-viewport", viewport: pending }])).catch(() => {});
    }
  }, [onSaveLayout]);

  const onNodesChange = useCallback((changes: NodeChange<WorkspaceFlowNode>[]) => {
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (changes.some((change) => change.type === "select")) {
      const nextIds = next
        .filter((node) => node.selected && canonicalNodeIds.has(node.id))
        .map((node) => node.id);
      if (!sameIds(nextIds, selectedNodeIds)) onSelectionChange(nextIds);
    }
  }, [canonicalNodeIds, onSelectionChange, selectedNodeIds]);

  const onEdgesChange = useCallback((changes: EdgeChange<WorkspaceFlowEdge>[]) => {
    const next = applyEdgeChanges(changes, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
    if (changes.some((change) => change.type === "select")) {
      const nextIds = next
        .filter((edge) => edge.selected && canonicalEdgeIds.has(edge.id))
        .map((edge) => edge.id);
      if (!sameIds(nextIds, selectedEdgeIds)) setSelectedEdgeIds(nextIds);
    }
  }, [canonicalEdgeIds, selectedEdgeIds]);

  const saveMovedNodes = useCallback((movedNodes: readonly WorkspaceFlowNode[]) => {
    const canonicalNodes = movedNodes.filter((node) => canonicalNodeIds.has(node.id));
    const ids = canonicalNodes.map((node) => node.id);
    const positions = new Map(canonicalNodes.map((node) => [node.id, node.position]));
    const commands = buildMoveCommands(workingLayoutRef.current, ids, positions);
    if (commands.length === 0) return;
    const key = commands.map((command) => `${command.objectId}:${command.x}:${command.y}`).join("|");
    const now = Date.now();
    if (lastMoveBatchRef.current?.key === key && now - lastMoveBatchRef.current.at < MOVE_DEDUPE_WINDOW_MS) return;
    lastMoveBatchRef.current = { key, at: now };
    void persistLayout(
      (currentLayout) => buildMoveCommands(currentLayout, ids, positions),
      commands.length === 1 ? "Object moved" : `${commands.length} objects moved`,
    );
  }, [canonicalNodeIds, persistLayout]);

  const fitWorkspace = useCallback(() => {
    setStatus("Fit workspace");
    const instance = flowRef.current;
    if (!instance) return;
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    void instance.fitView({ padding: 0.18, duration: reducedMotion() ? 0 : 220 }).then(() => {
      const next = instance.getViewport();
      setZoom(next.zoom);
      setAdapterZoom(next.zoom);
      onViewportChange(next);
      return persistLayout([{ type: "set-viewport", viewport: next }], "Fit workspace");
    });
  }, [onViewportChange, persistLayout]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!isValidWorkspaceConnection(connection, graph)) {
      setStatus("Prototype links connect Page nodes.");
      return;
    }
    const command = createPlannedPrototypeCommand(graph, connection);
    setStatus("Adding planned prototype link…");
    void onApplyGraphCommands([command])
      .then(() => setStatus("Planned prototype link added"))
      .catch((error: unknown) => setStatus(error instanceof Error && error.message ? error.message : "Couldn't add the prototype link."));
  }, [graph, onApplyGraphCommands]);

  const handleGroup = useCallback(() => {
    const livePositions = new Map((flowRef.current?.getNodes() ?? nodes).map((node) => [node.id, node.position]));
    const groupId = freshGroupId();
    void persistLayout((currentLayout) => buildGroupCommands(currentLayout, selectedNodeIds, {
      groupId,
      label: "New group",
      graph,
      livePositions,
    }), "Selection grouped").then((saved) => {
      if (saved) onSelectionChange([groupId]);
    });
  }, [graph, nodes, onSelectionChange, persistLayout, selectedNodeIds]);

  const handleUngroup = useCallback(() => {
    void persistLayout(
      (currentLayout) => buildUngroupCommands(currentLayout, selectedNodeIds),
      "Selection moved out of its group",
    );
  }, [persistLayout, selectedNodeIds]);

  const confirmDeleteGroup = useCallback(() => {
    if (!pendingDeleteGroupId) return;
    const groupId = pendingDeleteGroupId;
    setPendingDeleteGroupId(null);
    restoreDeleteButtonFocus();
    void persistLayout(
      (currentLayout) => buildDeleteGroupCommands(currentLayout, groupId),
      "Group removed; contents kept",
    ).then((saved) => {
      if (saved) onSelectionChange(selectedNodeIds.filter((id) => id !== groupId));
    });
  }, [onSelectionChange, pendingDeleteGroupId, persistLayout, selectedNodeIds]);

  const requestDeleteGroup = useCallback(() => {
    const groupId = selectedNodeIds.find((id) => layoutObjectMap(canvasLayout).get(id)?.kind === "group") ?? null;
    setPendingDeleteGroupId(groupId);
  }, [canvasLayout, selectedNodeIds]);

  const handleViewportMove = useCallback((event: MouseEvent | TouchEvent | null, next: Viewport) => {
    setZoom(next.zoom);
    setAdapterZoom((current) => semanticZoomLevel(current) === semanticZoomLevel(next.zoom) ? current : next.zoom);
    if (event !== null) pendingViewportRef.current = next;
  }, []);

  const handleViewportEnd = useCallback((event: MouseEvent | TouchEvent | null, next: Viewport) => {
    if (event === null) return;
    onViewportChange(next);
    pendingViewportRef.current = next;
    if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = window.setTimeout(() => {
      viewportTimerRef.current = null;
      pendingViewportRef.current = null;
      void persistLayout([{ type: "set-viewport", viewport: next }], "Viewport saved");
    }, VIEWPORT_SAVE_DELAY_MS);
  }, [onViewportChange, persistLayout]);

  const openNode = useCallback((node: WorkspaceFlowNode | undefined) => {
    if (node && canonicalNodeIds.has(node.id) && node.data.artifactId) onOpenArtifact(node.data.artifactId);
  }, [canonicalNodeIds, onOpenArtifact]);

  const moveSelectionByKeyboard = useCallback((dx: number, dy: number) => {
    const byId = new Map(nodesRef.current.map((node) => [node.id, node]));
    const selected = selectedNodeIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
    const positions = new Map(selected.map((node) => [node.id, { x: node.position.x + dx, y: node.position.y + dy }]));
    const commands = buildMoveCommands(workingLayoutRef.current, selectedNodeIds, positions);
    if (commands.length === 0) return;
    const movedIds = new Set(commands.map((command) => command.objectId));
    const nextNodes = nodesRef.current.map((node) => {
      const position = positions.get(node.id);
      return movedIds.has(node.id) && position ? { ...node, position } : node;
    });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    void persistLayout(
      (currentLayout) => buildMoveCommands(currentLayout, selectedNodeIds, positions),
      commands.length === 1 ? "Object nudged" : `${commands.length} objects nudged`,
    );
  }, [persistLayout, selectedNodeIds]);

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (isCanvasShortcutTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "enter") {
      if (event.target instanceof Element && event.target.closest(".react-flow__edge")) return;
      const focusedId = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset.id
        : undefined;
      const focused = focusedId ? nodes.find((node) => node.id === focusedId) : undefined;
      const selected = focused ?? nodes.find((node) => selectedSet.has(node.id));
      if (selected?.data.artifactId) {
        event.preventDefault();
        event.stopPropagation();
        openNode(selected);
      }
      return;
    }
    if (key === "escape") {
      onSelectionChange([]);
      setSelectedEdgeIds([]);
      setPendingDeleteGroupId(null);
      return;
    }
    if (event.shiftKey && key === "1") {
      event.preventDefault();
      event.stopPropagation();
      fitWorkspace();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === "v" || key === "h")) {
      event.preventDefault();
      event.stopPropagation();
      setTool(key === "h" ? "hand" : "select");
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const delta = key === "arrowleft" ? [-step, 0]
      : key === "arrowright" ? [step, 0]
        : key === "arrowup" ? [0, -step]
          : key === "arrowdown" ? [0, step]
            : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    moveSelectionByKeyboard(delta[0], delta[1]);
  }, [fitWorkspace, moveSelectionByKeyboard, nodes, onSelectionChange, openNode, selectedSet]);

  const groupObjects = useMemo(() => layoutObjectMap(canvasLayout), [canvasLayout]);
  const canGroup = selectedNodeIds.some((id) => groupObjects.has(id));
  const canUngroup = selectedNodeIds.some((id) => Boolean(groupObjects.get(id)?.parentGroupId));
  const selectedGroups = selectedNodeIds.filter((id) => groupObjects.get(id)?.kind === "group");
  const canDeleteGroup = selectedGroups.length === 1;

  useEffect(() => {
    if (pendingDeleteGroupId) deleteCancelRef.current?.focus();
  }, [pendingDeleteGroupId]);

  useEffect(() => {
    if (pendingDeleteGroupId && !selectedNodeIds.includes(pendingDeleteGroupId)) {
      setPendingDeleteGroupId(null);
    }
  }, [pendingDeleteGroupId, selectedNodeIds]);

  const closeDeleteConfirmation = useCallback(() => {
    setPendingDeleteGroupId(null);
    restoreDeleteButtonFocus();
  }, []);

  return (
    <section
      ref={canvasRef}
      role="region"
      aria-label="Project canvas"
      className="dezin-project-canvas"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <header className="dezin-project-canvas__header app-drag">
        <div className="dezin-project-canvas__identity">
          <h1 title={projectName}>{projectName}</h1>
          <span>Canvas</span>
        </div>
        <div className="dezin-project-canvas__measure" aria-label={`${canonicalModel.nodes.length} objects at ${Math.round(zoom * 100)} percent zoom`}>
          <span>{canonicalModel.nodes.length} objects</span>
          <span>{Math.round(zoom * 100)}%</span>
        </div>
      </header>

      <div className="dezin-project-canvas__surface" data-tool={tool}>
        <ReactFlow<WorkspaceFlowNode, WorkspaceFlowEdge>
          aria-label="Project canvas"
          ariaLabelConfig={CANVAS_ARIA_LABEL_CONFIG}
          nodes={nodes}
          edges={edges}
          nodeTypes={proposalNodeTypes}
          edgeTypes={proposalEdgeTypes}
          defaultViewport={viewport}
          minZoom={0.15}
          maxZoom={2.25}
          selectionMode={SelectionMode.Partial}
          selectionOnDrag={tool === "select"}
          panOnDrag={tool === "hand" ? true : [1, 2]}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          nodesDraggable={tool === "select"}
          nodesConnectable={tool === "select"}
          connectOnClick
          deleteKeyCode={null}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          onlyRenderVisibleElements
          nodeDragThreshold={2}
          nodeClickDistance={3}
          paneClickDistance={3}
          proOptions={{ hideAttribution: true }}
          onInit={(instance) => {
            flowRef.current = instance;
            synchronizeAuthoritativeViewport(instance);
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onPaneClick={() => {
            onSelectionChange([]);
            setSelectedEdgeIds([]);
          }}
          onNodeDoubleClick={(event, node) => {
            if (canonicalNodeIds.has(node.id) && !isCanvasShortcutTarget(event.target)) openNode(node);
          }}
          onNodeDragStop={(_event, node, movedNodes) => saveMovedNodes(movedNodes.length ? movedNodes : [node])}
          onSelectionDragStop={(_event, movedNodes) => saveMovedNodes(movedNodes)}
          isValidConnection={(connection) => isValidWorkspaceConnection(connection, graph)}
          onConnect={handleConnect}
          onMove={handleViewportMove}
          onMoveEnd={handleViewportEnd}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={0.85} />
        </ReactFlow>

        <WorkspaceCanvasToolbar
          tool={tool}
          edgeFilter={edgeFilter}
          outlineOpen={outlineOpen}
          canGroup={canGroup}
          canUngroup={canUngroup}
          canDeleteGroup={canDeleteGroup}
          onToolChange={setTool}
          onEdgeFilterChange={setEdgeFilter}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onFitView={fitWorkspace}
          onGroup={handleGroup}
          onUngroup={handleUngroup}
          onDeleteGroup={requestDeleteGroup}
        />

        {outlineOpen && (
          <WorkspaceOutline
            projectId={projectId}
            nodes={canonicalModel.nodes}
            onSelect={(id, additive) => onSelectionChange(additive
              ? selectedNodeIds.includes(id) ? selectedNodeIds.filter((candidate) => candidate !== id) : [...selectedNodeIds, id]
              : [id])}
            onToggleCollapsed={toggleCollapsed}
            onClose={() => setOutlineOpen(false)}
          />
        )}

        {graph.nodes.length === 0 && (
          <div className="dezin-project-canvas__empty" role="status">
            <strong>No design artifacts yet</strong>
            <span>Ask the Workspace Agent to propose the first Page, Component, or research resource.</span>
          </div>
        )}

        {pendingDeleteGroupId && (
          <div
            className="dezin-canvas-confirm"
            role="region"
            aria-labelledby="remove-group-title"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                closeDeleteConfirmation();
              }
            }}
          >
            <div>
              <strong id="remove-group-title">Remove this group frame?</strong>
              <span>Its contents stay on the canvas.</span>
            </div>
            <button ref={deleteCancelRef} type="button" onClick={closeDeleteConfirmation}>Cancel</button>
            <button type="button" data-destructive onClick={confirmDeleteGroup}>Remove frame</button>
          </div>
        )}

        <p className="dezin-project-canvas__status" role="status" aria-label="Canvas status" aria-live="polite">
          {status}
        </p>
      </div>
    </section>
  );
}
