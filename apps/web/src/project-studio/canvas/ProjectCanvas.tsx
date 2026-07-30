import "@xyflow/react/dist/style.css";
import "./project-canvas.css";

import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
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
import { Play } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { useToast } from "../../components/Toast.tsx";
import {
  ProjectActionsMenu,
  ProjectExportMenu,
  ProjectPanelToggleButton,
  ProjectSettingsButton,
} from "../../components/ProjectHeaderActions.tsx";
import {
  Button,
  StudioHeaderActions,
  StudioHeaderCopy,
  StudioHeaderIdentity,
  StudioToolbarHeader,
  TooltipProvider,
} from "../../components/ui/index.ts";
import type {
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceViewport,
} from "../../lib/api.ts";
import type { GenerationTargetState } from "../generation/generation-target-state.ts";
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
  useResourceNodeRevisionPreviewController,
  type ResourceNodeRevisionBinding,
} from "./resource-node-preview.ts";
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
  isComponentLibraryGroupId,
  layoutObjectMap,
  materializeWorkspaceLayout,
} from "./workspace-layout.ts";

const VIEWPORT_SAVE_DELAY_MS = 260;
const RESIZE_VIEWPORT_SAVE_DELAY_MS = 320;
const PROPOSAL_FOCUS_MOUNT_RETRIES = 4;
const OUTLINE_SAFE_SURFACE_WIDTH = 900;
const CANVAS_MIN_ZOOM = 0.15;
const CANVAS_MAX_ZOOM = 2.25;
const CANVAS_PROBLEM_TOAST_DEDUPE_MS = 4_000;
const CANVAS_CONNECTION_LINE_STYLE = {
  stroke: "var(--foreground-2)",
  strokeWidth: 1.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  opacity: 0.72,
  vectorEffect: "non-scaling-stroke",
} satisfies CSSProperties;
const NOOP_VIEWPORT_CHANGE = () => {};
const EMPTY_RESOURCE_REVISION_STATES = {} as const;
const EMPTY_ARTIFACT_REVISION_QUALITY_STATES = {} as const;
const EMPTY_GENERATION_TARGET_STATES = {} as const;
const proposalNodeTypes = { ...workspaceNodeTypes, proposal: ProposalOverlay } satisfies NodeTypes;
const proposalEdgeTypes = { ...workspaceEdgeTypes, proposal: ProposalOverlayEdge } satisfies EdgeTypes;
const CANVAS_NODE_KEYBOARD_DESCRIPTION = "For Page and Component nodes, Enter opens the editor. For Resource nodes, Enter opens the exact revision viewer. Press Space to select; arrow keys move selected objects; Escape clears selection. Nodes are not deleted with the keyboard.";
const CANVAS_ARIA_LABEL_CONFIG = {
  "node.a11yDescription.default": CANVAS_NODE_KEYBOARD_DESCRIPTION,
  "node.a11yDescription.keyboardDisabled": CANVAS_NODE_KEYBOARD_DESCRIPTION,
  "edge.a11yDescription.default": "Press Enter or Space to select a relationship. Delete or Backspace removes selected editable relationships; Escape clears selection. Uses relationships are derived and read-only.",
} satisfies Partial<AriaLabelConfig>;
const NODE_DEFINITION_FIELDS = [
  "type", "ariaLabel", "parentId", "extent", "hidden", "selected", "className",
  "focusable", "draggable", "connectable", "selectable", "deletable", "zIndex",
] as const;
const NODE_GEOMETRY_FIELDS = [
  "type", "parentId", "extent", "hidden", "initialWidth", "initialHeight", "expandParent",
] as const;
const EDGE_DEFINITION_FIELDS = [
  "source", "target", "sourceHandle", "targetHandle", "type", "ariaLabel", "hidden",
  "selected", "className", "focusable", "selectable", "deletable", "animated", "zIndex",
  "interactionWidth",
] as const;

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
  const epsilon = 0.001;
  return Math.abs(left.x - right.x) < epsilon
    && Math.abs(left.y - right.y) < epsilon
    && Math.abs(left.zoom - right.zoom) < epsilon;
}

function freshId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

const freshGroupId = () => freshId("group");
const freshRemoveEdgeCommandId = (edgeId: string) => freshId(`remove-edge-${edgeId}`);

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
  artifactRevisionQualityStates?: Readonly<Record<string, {
    revisionId: string;
    qualityState: "passed" | "needs-attention" | "failed" | "unassessed";
    qualityScore: number | null;
  }>>;
  resourceRevisionStates?: Readonly<Record<string, {
    revisionId: string;
    resourceKind: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference";
    qualityState: "grounded" | "needs-review" | null;
  }>>;
  artifactGenerationStates?: Readonly<Record<string, GenerationTargetState>>;
  resourceGenerationStates?: Readonly<Record<string, GenerationTargetState>>;
  selectedNodeIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onViewportChange?: (viewport: WorkspaceViewport) => void;
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onApplyGraphCommands: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
  onOpenResource?: (resourceId: string, revisionId: string | null) => void;
  onPresentFlow?: () => void;
  presentFlowButtonRef?: Ref<HTMLButtonElement>;
  planPanelAvailable?: boolean;
  planPanelOpen?: boolean;
  onTogglePlanPanel?: () => void;
  planPanelButtonRef?: Ref<HTMLButtonElement>;
  exportSourceUrl?: string;
  exportFullUrl?: string;
  onRenameProject?: () => void;
  onOpenProjectInFinder?: () => void;
  canOpenProjectInFinder?: boolean;
  onDeleteProject?: () => void;
  onCopyAnalysisPrompt?: () => void;
  onOpenSettings?: () => void;
  proposal?: { id: string } | null;
  proposalDiff?: ProposalDiff | null;
  proposalFocus?: ProposalFocusRequest | null;
}

type LayoutCommandSource = readonly WorkspaceLayoutCommand[]
  | ((layout: WorkspaceLayout) => readonly WorkspaceLayoutCommand[]);

export interface PendingMovePosition {
  generation: number;
  position: { x: number; y: number };
}

export interface PendingResizeBounds {
  generation: number;
  position: { x: number; y: number };
  width: number;
  height: number;
}

interface ViewportIntent {
  viewport: WorkspaceViewport;
  version: number;
}

interface SurfaceResizeDelta {
  x: number;
  y: number;
}

function hasSurfaceResizeDelta(delta: SurfaceResizeDelta): boolean {
  return Math.abs(delta.x) >= 0.5 || Math.abs(delta.y) >= 0.5;
}

function compensateViewportForSurfaceResize(
  viewport: WorkspaceViewport,
  delta: SurfaceResizeDelta,
): WorkspaceViewport {
  return {
    ...viewport,
    x: viewport.x + delta.x,
    y: viewport.y + delta.y,
  };
}

function samePosition(
  left: WorkspaceFlowNode["position"],
  right: WorkspaceFlowNode["position"],
): boolean {
  return left.x === right.x && left.y === right.y;
}

function sameShallowRecord(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function sameFields<T extends object, K extends keyof T>(
  left: T,
  right: T,
  fields: readonly K[],
): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function sameNodeDefinition(
  left: WorkspaceFlowNode,
  right: WorkspaceFlowNode,
): boolean {
  return sameFields(left, right, NODE_DEFINITION_FIELDS)
    && sameShallowRecord(
      left.style as Readonly<Record<string, unknown>> | undefined,
      right.style as Readonly<Record<string, unknown>> | undefined,
    )
    && sameShallowRecord(left.data, right.data);
}

function sameNodeGeometryDefinition(
  left: WorkspaceFlowNode,
  right: WorkspaceFlowNode,
): boolean {
  const leftStyle = left.style as Readonly<Record<string, unknown>> | undefined;
  const rightStyle = right.style as Readonly<Record<string, unknown>> | undefined;
  return sameFields(left, right, NODE_GEOMETRY_FIELDS)
    && leftStyle?.width === rightStyle?.width
    && leftStyle?.height === rightStyle?.height
    && left.data.zoomLevel === right.data.zoomLevel
    && left.data.collapsed === right.data.collapsed;
}

function runtimeNodeGeometryMatchesDefinition(
  current: WorkspaceFlowNode,
  incoming: WorkspaceFlowNode,
): boolean {
  const style = incoming.style as Readonly<Record<string, unknown>> | undefined;
  const declaredWidth = typeof style?.width === "number" ? style.width : incoming.width;
  const declaredHeight = typeof style?.height === "number" ? style.height : incoming.height;
  const currentWidth = current.width;
  const currentHeight = current.height;
  return (declaredWidth === undefined || currentWidth === undefined || Math.abs(currentWidth - declaredWidth) < 0.5)
    && (declaredHeight === undefined || currentHeight === undefined || Math.abs(currentHeight - declaredHeight) < 0.5);
}

function sameOptionalRecord(
  left: unknown,
  right: unknown,
): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  return sameShallowRecord(
    left as Readonly<Record<string, unknown>>,
    right as Readonly<Record<string, unknown>>,
  );
}

function sameEdgeDefinition(
  left: WorkspaceFlowEdge,
  right: WorkspaceFlowEdge,
): boolean {
  return sameFields(left, right, EDGE_DEFINITION_FIELDS)
    && sameOptionalRecord(left.markerStart, right.markerStart)
    && sameOptionalRecord(left.markerEnd, right.markerEnd)
    && sameShallowRecord(
      left.style as Readonly<Record<string, unknown>> | undefined,
      right.style as Readonly<Record<string, unknown>> | undefined,
    )
    && sameShallowRecord(
      left.data as Readonly<Record<string, unknown>> | undefined,
      right.data as Readonly<Record<string, unknown>> | undefined,
    );
}

export function reconcileCanvasNodes(
  current: readonly WorkspaceFlowNode[],
  incoming: readonly WorkspaceFlowNode[],
  pendingMoves: ReadonlyMap<string, PendingMovePosition>,
  pendingResizes: ReadonlyMap<string, PendingResizeBounds> = new Map(),
): WorkspaceFlowNode[] {
  const live = new Map(current.map((node) => [node.id, node]));
  let changed = current.length !== incoming.length;
  const next = incoming.map((node, index) => {
    const existing = live.get(node.id);
    const pendingMove = pendingMoves.get(node.id);
    const pendingResize = pendingResizes.get(node.id);
    const activeResize = existing?.resizing === true;
    const resolvedNode = pendingResize && !activeResize
      ? {
          ...node,
          position: pendingResize.position,
          style: {
            ...node.style,
            width: pendingResize.width,
            height: pendingResize.height,
          },
          width: pendingResize.width,
          height: pendingResize.height,
          measured: { width: pendingResize.width, height: pendingResize.height },
          resizing: false,
        }
      : node;
    const pendingPosition = pendingMove && pendingResize
      ? pendingMove.generation > pendingResize.generation
        ? pendingMove.position
        : pendingResize.position
      : pendingMove?.position ?? pendingResize?.position;
    const position = existing?.dragging || activeResize
      ? existing.position
      : pendingPosition ?? resolvedNode.position;
    const runtimeGeometryMatches = existing !== undefined
      && runtimeNodeGeometryMatchesDefinition(existing, resolvedNode);
    if (current[index]?.id !== node.id) changed = true;
    if (existing
      && runtimeGeometryMatches
      && samePosition(existing.position, position)
      && sameNodeDefinition(existing, resolvedNode)) {
      return existing;
    }
    changed = true;
    const preserveRuntimeGeometry = activeResize;
    const preserveMeasured = existing !== undefined
      && (preserveRuntimeGeometry
        || (runtimeGeometryMatches && sameNodeGeometryDefinition(existing, resolvedNode)));
    return {
      ...resolvedNode,
      position,
      ...(pendingResize && !activeResize
        ? {
            measured: { width: pendingResize.width, height: pendingResize.height },
            width: pendingResize.width,
            height: pendingResize.height,
          }
        : preserveMeasured && existing.measured ? { measured: existing.measured } : {}),
      ...((!pendingResize || activeResize) && preserveRuntimeGeometry && existing.width !== undefined ? { width: existing.width } : {}),
      ...((!pendingResize || activeResize) && preserveRuntimeGeometry && existing.height !== undefined ? { height: existing.height } : {}),
      ...(existing?.dragging ? { dragging: true } : {}),
      ...((!pendingResize || activeResize) && preserveRuntimeGeometry ? { resizing: true } : {}),
    };
  });
  return changed ? next : current as WorkspaceFlowNode[];
}

export function reconcileCanvasEdges(
  current: readonly WorkspaceFlowEdge[],
  incoming: readonly WorkspaceFlowEdge[],
): WorkspaceFlowEdge[] {
  const live = new Map(current.map((edge) => [edge.id, edge]));
  let changed = current.length !== incoming.length;
  const next = incoming.map((edge, index) => {
    const existing = live.get(edge.id);
    if (current[index]?.id !== edge.id) changed = true;
    if (existing && sameEdgeDefinition(existing, edge)) return existing;
    changed = true;
    return edge;
  });
  return changed ? next : current as WorkspaceFlowEdge[];
}

export function ProjectCanvas({
  projectId,
  projectName,
  graph,
  layout,
  viewport = layout.viewport,
  artifactRevisionIds,
  artifactRevisionQualityStates = EMPTY_ARTIFACT_REVISION_QUALITY_STATES,
  resourceRevisionStates = EMPTY_RESOURCE_REVISION_STATES,
  artifactGenerationStates = EMPTY_GENERATION_TARGET_STATES,
  resourceGenerationStates = EMPTY_GENERATION_TARGET_STATES,
  selectedNodeIds,
  onSelectionChange,
  onViewportChange = NOOP_VIEWPORT_CHANGE,
  onSaveLayout,
  onApplyGraphCommands,
  onOpenArtifact,
  onOpenResource,
  onPresentFlow,
  presentFlowButtonRef,
  planPanelAvailable = false,
  planPanelOpen = false,
  onTogglePlanPanel,
  planPanelButtonRef,
  exportSourceUrl,
  exportFullUrl,
  onRenameProject,
  onOpenProjectInFinder,
  canOpenProjectInFinder = false,
  onDeleteProject,
  onCopyAnalysisPrompt,
  onOpenSettings,
  proposal = null,
  proposalDiff = null,
  proposalFocus = null,
}: ProjectCanvasProps) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceSizeRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkspaceFlowNode, WorkspaceFlowEdge> | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
  const resizeViewportTimerRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<ViewportIntent | null>(null);
  const pendingResizeViewportRef = useRef<ViewportIntent | null>(null);
  const deferredSurfaceResizeRef = useRef<SurfaceResizeDelta>({ x: 0, y: 0 });
  const viewportIntentVersionRef = useRef(0);
  const canvasProjectRef = useRef(projectId);
  const canvasProjectEpochRef = useRef(0);
  const persistViewportRef = useRef<((
    viewport: WorkspaceViewport,
    intentVersion: number,
  ) => Promise<boolean>) | null>(null);
  const viewportSaveJobsRef = useRef(0);
  const persistedMoveInteractionsRef = useRef(new WeakMap<object, Set<string>>());
  const geometryGenerationRef = useRef(0);
  const pendingMovePositionsRef = useRef(new Map<string, PendingMovePosition>());
  const pendingResizeBoundsRef = useRef(new Map<string, PendingResizeBounds>());
  const relationshipMutationPendingRef = useRef(false);
  const selectedEdgeGraphRevisionRef = useRef(graph.revision);
  const handledProposalFocusRef = useRef<{ proposalId: string; nonce: number } | null>(null);
  const proposalViewportPreviewRef = useRef<{ proposalId: string; changeKey: string } | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const recentProblemToastsRef = useRef(new Map<string, number>());
  const nodeTypesRef = useRef(proposalNodeTypes);
  const edgeTypesRef = useRef(proposalEdgeTypes);
  if (canvasProjectRef.current !== projectId) {
    canvasProjectRef.current = projectId;
    canvasProjectEpochRef.current += 1;
  }
  const [tool, setTool] = useState<CanvasTool>("select");
  const [edgeFilter, setEdgeFilter] = useState<WorkspaceEdgeFilter>("flow");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(viewport.zoom);
  const [adapterZoom, setAdapterZoom] = useState(viewport.zoom);
  const [status, setStatus] = useState("Canvas ready");
  const [relationshipMutationPending, setRelationshipMutationPending] = useState(false);
  const [pendingDeleteGroupId, setPendingDeleteGroupId] = useState<string | null>(null);
  const [reconcileVersion, setReconcileVersion] = useState(0);
  const [surfaceMeasured, setSurfaceMeasured] = useState(false);
  const [flowReady, setFlowReady] = useState(false);
  const reportCanvasProblem = useCallback((message: string) => {
    setStatus(message);
    const now = Date.now();
    const lastReportedAt = recentProblemToastsRef.current.get(message);
    if (lastReportedAt !== undefined && now - lastReportedAt < CANVAS_PROBLEM_TOAST_DEDUPE_MS) return;
    recentProblemToastsRef.current.set(message, now);
    for (const [reportedMessage, reportedAt] of recentProblemToastsRef.current) {
      if (now - reportedAt >= CANVAS_PROBLEM_TOAST_DEDUPE_MS) {
        recentProblemToastsRef.current.delete(reportedMessage);
      }
    }
    toast(message, { variant: "error" });
  }, [toast]);
  const resourcePreviewBindings = useMemo(() => graph.nodes.flatMap((node): ResourceNodeRevisionBinding[] => {
    if (node.kind !== "resource") return [];
    const revision = resourceRevisionStates[node.resourceId];
    return revision === undefined ? [] : [{
      workspaceId: graph.workspaceId,
      resourceId: node.resourceId,
      revisionId: revision.revisionId,
      resourceKind: revision.resourceKind,
    }];
  }), [graph.nodes, resourceRevisionStates]);
  const {
    states: resourceRevisionPreviewStates,
    retry: retryResourceRevisionPreview,
  } = useResourceNodeRevisionPreviewController(projectId, resourcePreviewBindings);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const initialRect = surface.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
      surfaceSizeRef.current = {
        left: initialRect.left,
        top: initialRect.top,
        width: initialRect.width,
        height: initialRect.height,
      };
      setSurfaceMeasured(true);
    }
    let active = true;
    let measurementFrame: number | null = null;
    let pendingMeasurement: { left: number; top: number; width: number; height: number } | null = null;
    const observer = new ResizeObserver((entries) => {
      if (!active) return;
      const entry = entries.find((candidate) => candidate.target === surface);
      if (!entry) return;
      const rect = surface.getBoundingClientRect();
      pendingMeasurement = {
        left: rect.left,
        top: rect.top,
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      if (measurementFrame !== null) return;
      measurementFrame = window.requestAnimationFrame(() => {
        measurementFrame = null;
        const measurement = pendingMeasurement;
        pendingMeasurement = null;
        if (!active || !measurement) return;
        if (measurement.width <= 0 || measurement.height <= 0) return;
        const previous = surfaceSizeRef.current;
        surfaceSizeRef.current = measurement;
        setSurfaceMeasured(true);
        if (measurement.width < OUTLINE_SAFE_SURFACE_WIDTH) setOutlineOpen(false);
        const instance = flowRef.current;
        if (!instance || previous === null
          || (previous.left === measurement.left
            && previous.top === measurement.top
            && previous.width === measurement.width
            && previous.height === measurement.height)) return;
        const delta = {
          x: previous.left - measurement.left,
          y: previous.top - measurement.top,
        };
        if (!hasSurfaceResizeDelta(delta)) return;
        if (proposalViewportPreviewRef.current !== null || pendingViewportRef.current !== null) {
          deferredSurfaceResizeRef.current = {
            x: deferredSurfaceResizeRef.current.x + delta.x,
            y: deferredSurfaceResizeRef.current.y + delta.y,
          };
          return;
        }
        const effectiveDelta = {
          x: delta.x + deferredSurfaceResizeRef.current.x,
          y: delta.y + deferredSurfaceResizeRef.current.y,
        };
        deferredSurfaceResizeRef.current = { x: 0, y: 0 };
        const current = instance.getViewport();
        const intent: ViewportIntent = {
          viewport: compensateViewportForSurfaceResize(current, effectiveDelta),
          version: ++viewportIntentVersionRef.current,
        };
        pendingResizeViewportRef.current = intent;
        void instance.setViewport(intent.viewport).catch(() => {});
        if (resizeViewportTimerRef.current !== null) {
          window.clearTimeout(resizeViewportTimerRef.current);
        }
        resizeViewportTimerRef.current = window.setTimeout(() => {
          resizeViewportTimerRef.current = null;
          const pending = pendingResizeViewportRef.current;
          if (!pending || pending.version !== intent.version || proposalViewportPreviewRef.current !== null) return;
          pendingResizeViewportRef.current = null;
          void persistViewportRef.current?.(intent.viewport, intent.version);
        }, RESIZE_VIEWPORT_SAVE_DELAY_MS);
      });
    });
    observer.observe(surface);
    return () => {
      active = false;
      if (measurementFrame !== null) window.cancelAnimationFrame(measurementFrame);
      if (resizeViewportTimerRef.current !== null) {
        window.clearTimeout(resizeViewportTimerRef.current);
        resizeViewportTimerRef.current = null;
      }
      observer.disconnect();
      surfaceSizeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (selectedEdgeGraphRevisionRef.current === graph.revision) return;
    selectedEdgeGraphRevisionRef.current = graph.revision;
    setSelectedEdgeIds([]);
  }, [graph.revision]);

  useEffect(() => {
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    if (resizeViewportTimerRef.current !== null) {
      window.clearTimeout(resizeViewportTimerRef.current);
      resizeViewportTimerRef.current = null;
    }
    pendingMovePositionsRef.current.clear();
    pendingResizeBoundsRef.current.clear();
    persistedMoveInteractionsRef.current = new WeakMap();
    pendingViewportRef.current = null;
    pendingResizeViewportRef.current = null;
    deferredSurfaceResizeRef.current = { x: 0, y: 0 };
    viewportIntentVersionRef.current += 1;
    layoutMutationQueueRef.current = Promise.resolve();
    queuedLayoutJobsRef.current = 0;
    viewportSaveJobsRef.current = 0;
    handledProposalFocusRef.current = null;
    proposalViewportPreviewRef.current = null;
    relationshipMutationPendingRef.current = false;
    setRelationshipMutationPending(false);
    setSelectedEdgeIds([]);
    setPendingDeleteGroupId(null);
    recentProblemToastsRef.current.clear();
    setStatus("Canvas ready");
  }, [projectId]);

  const canvasLayout = useMemo(() => materializeWorkspaceLayout(graph, layout), [graph, layout]);
  const authoritativeLayoutRef = useRef(canvasLayout);
  const workingLayoutRef = useRef(canvasLayout);
  const layoutMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedLayoutJobsRef = useRef(0);
  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const awaitingSelectionResourceIds = useMemo(() => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.kind !== "informs") continue;
      const source = nodes.get(edge.sourceNodeId);
      const target = nodes.get(edge.targetNodeId);
      if (source?.kind !== "resource" || !target || target.kind === "resource"
        || resourceRevisionStates[source.resourceId]?.resourceKind !== "research"
        || !resourceRevisionStates[source.resourceId]?.revisionId
        || (artifactRevisionIds[target.artifactId] ?? null) !== null) continue;
      result.add(source.resourceId);
    }
    return result;
  }, [artifactRevisionIds, graph.edges, graph.nodes, resourceRevisionStates]);
  const selectedEdgeSet = useMemo(() => new Set(selectedEdgeIds), [selectedEdgeIds]);

  useEffect(() => {
    authoritativeLayoutRef.current = canvasLayout;
    if (queuedLayoutJobsRef.current === 0) workingLayoutRef.current = canvasLayout;
  }, [canvasLayout]);

  const synchronizeAuthoritativeViewport = useCallback((
    instance: ReactFlowInstance<WorkspaceFlowNode, WorkspaceFlowEdge>,
  ) => {
    if (pendingViewportRef.current !== null
      || pendingResizeViewportRef.current !== null
      || viewportSaveJobsRef.current > 0) return;
    proposalViewportPreviewRef.current = null;
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
    successMessage: string | null,
  ): Promise<boolean> => {
    const projectEpoch = canvasProjectEpochRef.current;
    queuedLayoutJobsRef.current += 1;
    const run = async (): Promise<boolean> => {
      if (projectEpoch !== canvasProjectEpochRef.current) return false;
      try {
        const commands = typeof source === "function" ? source(workingLayoutRef.current) : source;
        if (commands.length === 0) return false;
        if (successMessage !== null) setStatus("Saving canvas…");
        const saved = await onSaveLayout(commands);
        if (projectEpoch !== canvasProjectEpochRef.current) return false;
        authoritativeLayoutRef.current = saved;
        workingLayoutRef.current = saved;
        if (successMessage !== null) setStatus(successMessage);
        return true;
      } catch (error) {
        if (projectEpoch !== canvasProjectEpochRef.current) return false;
        workingLayoutRef.current = authoritativeLayoutRef.current;
        reportCanvasProblem(error instanceof Error && error.message ? error.message : "Couldn't save the canvas. Try again.");
        setReconcileVersion((version) => version + 1);
        return false;
      } finally {
        if (projectEpoch === canvasProjectEpochRef.current) {
          queuedLayoutJobsRef.current = Math.max(0, queuedLayoutJobsRef.current - 1);
          if (queuedLayoutJobsRef.current === 0) workingLayoutRef.current = authoritativeLayoutRef.current;
        }
      }
    };
    const result = layoutMutationQueueRef.current.then(run);
    layoutMutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [onSaveLayout, reportCanvasProblem]);

  const persistViewport = useCallback(async (
    next: WorkspaceViewport,
    intentVersion: number,
  ): Promise<boolean> => {
    const projectEpoch = canvasProjectEpochRef.current;
    viewportSaveJobsRef.current += 1;
    let saved: boolean;
    try {
      saved = await persistLayout([{ type: "set-viewport", viewport: next }], null);
    } finally {
      if (projectEpoch === canvasProjectEpochRef.current) {
        viewportSaveJobsRef.current = Math.max(0, viewportSaveJobsRef.current - 1);
      }
    }
    if (projectEpoch !== canvasProjectEpochRef.current) return false;
    const authoritative = authoritativeLayoutRef.current.viewport;
    const ownsLatestIntent = intentVersion === viewportIntentVersionRef.current;
    if (ownsLatestIntent) onViewportChange(authoritative);
    if (ownsLatestIntent
      && pendingViewportRef.current === null
      && pendingResizeViewportRef.current === null
      && viewportSaveJobsRef.current === 0) {
      setZoom(authoritative.zoom);
      setAdapterZoom(authoritative.zoom);
      const instance = flowRef.current;
      if (instance && !sameViewport(instance.getViewport(), authoritative)) {
        void instance.setViewport(authoritative).catch(() => {});
      }
    }
    return saved;
  }, [onViewportChange, persistLayout]);

  useEffect(() => {
    persistViewportRef.current = persistViewport;
    return () => {
      persistViewportRef.current = null;
    };
  }, [persistViewport]);

  const toggleCollapsed = useCallback((groupId: string, collapsed: boolean) => {
    const projectEpoch = canvasProjectEpochRef.current;
    const previousSelection = [...selectedNodeIds];
    if (collapsed) {
      const next = selectedNodeIds.filter((id) => !isLayoutDescendant(canvasLayout, id, groupId));
      if (!next.includes(groupId)) next.push(groupId);
      if (!sameIds(next, selectedNodeIds)) onSelectionChange(next);
    }
    void persistLayout([{ type: "set-collapsed", groupId, collapsed }], collapsed ? "Group collapsed" : "Group expanded")
      .then((saved) => {
        if (projectEpoch !== canvasProjectEpochRef.current) return;
        if (!saved) onSelectionChange(previousSelection);
      });
  }, [canvasLayout, onSelectionChange, persistLayout, selectedNodeIds]);

  const renameGroup = useCallback((groupId: string, label: string) => {
    if (isComponentLibraryGroupId(groupId)) return;
    void persistLayout([{ type: "rename-group", groupId, label }], "Group renamed");
  }, [persistLayout]);

  const resizeGroup = useCallback((groupId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const generation = geometryGenerationRef.current + 1;
    geometryGenerationRef.current = generation;
    pendingResizeBoundsRef.current.set(groupId, {
      generation,
      position: { x: bounds.x, y: bounds.y },
      width: bounds.width,
      height: bounds.height,
    });
    void persistLayout([
      { type: "move", objectId: groupId, x: bounds.x, y: bounds.y },
      { type: "resize-group", groupId, width: bounds.width, height: bounds.height },
    ], "Group resized").then(() => {
      if (pendingResizeBoundsRef.current.get(groupId)?.generation !== generation) return;
      pendingResizeBoundsRef.current.delete(groupId);
      setReconcileVersion((version) => version + 1);
    });
  }, [persistLayout]);

  const { canonicalModel, model, overlayModel } = useMemo(() => {
    const view = {
      zoom: adapterZoom,
      edgeFilter,
      projectId,
      artifactRevisionIds,
      artifactRevisionQualityStates,
      resourceRevisionStates,
      resourceRevisionPreviewStates,
      onRetryResourcePreview: retryResourceRevisionPreview,
      artifactGenerationStates,
      resourceGenerationStates,
      awaitingSelectionResourceIds,
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
    artifactGenerationStates,
    awaitingSelectionResourceIds,
    canvasLayout,
    edgeFilter,
    graph,
    projectId,
    proposal,
    proposalDiff,
    renameGroup,
    resizeGroup,
    artifactRevisionQualityStates,
    resourceRevisionStates,
    resourceRevisionPreviewStates,
    retryResourceRevisionPreview,
    resourceGenerationStates,
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
      const next = reconcileCanvasNodes(
        current,
        model.nodes,
        pendingMovePositionsRef.current,
        pendingResizeBoundsRef.current,
      );
      nodesRef.current = next;
      return next;
    });
    setEdges((current) => {
      const next = reconcileCanvasEdges(current, model.edges);
      edgesRef.current = next;
      return next;
    });
  }, [model]);

  useEffect(() => {
    if (!proposal || !proposalDiff || !proposalFocus) return;
    const handled = handledProposalFocusRef.current;
    if (handled?.proposalId === proposal.id && handled.nonce === proposalFocus.nonce) return;
    const viewportChange = proposalDiff.viewportChanges.find((change) => change.key === proposalFocus.key);
    const instance = flowRef.current;
    const nextViewport = proposalDiff.proposedLayout?.viewport;
    if (!viewportChange || !instance || !nextViewport) return;
    let active = true;
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    if (resizeViewportTimerRef.current !== null) {
      window.clearTimeout(resizeViewportTimerRef.current);
      resizeViewportTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    pendingResizeViewportRef.current = null;
    viewportIntentVersionRef.current += 1;
    proposalViewportPreviewRef.current = { proposalId: proposal.id, changeKey: viewportChange.key };
    handledProposalFocusRef.current = {
      proposalId: proposal.id,
      nonce: proposalFocus.nonce,
    };
    setZoom(nextViewport.zoom);
    setAdapterZoom(nextViewport.zoom);
    void instance.setViewport(nextViewport).then(() => {
      if (!active) return;
      canvasRef.current
        ?.querySelector<HTMLElement>('[role="application"][aria-label="Project canvas"]')
        ?.focus();
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [flowReady, proposal, proposalDiff, proposalFocus]);

  useEffect(() => {
    if (!flowReady || !proposal || !proposalFocus || (overlayModel.nodes.length === 0 && overlayModel.edges.length === 0)) return;
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
  }, [flowReady, overlayModel, proposal, proposalFocus]);

  useEffect(() => {
    const preview = proposalViewportPreviewRef.current;
    if (!preview) return;
    const previewStillExists = proposal?.id === preview.proposalId
      && proposalDiff?.viewportChanges.some((change) => change.key === preview.changeKey) === true;
    if (previewStillExists) return;
    const instance = flowRef.current;
    proposalViewportPreviewRef.current = null;
    if (!instance) return;
    const deferred = deferredSurfaceResizeRef.current;
    if (!hasSurfaceResizeDelta(deferred)) {
      synchronizeAuthoritativeViewport(instance);
      return;
    }
    deferredSurfaceResizeRef.current = { x: 0, y: 0 };
    const intent: ViewportIntent = {
      viewport: compensateViewportForSurfaceResize(authoritativeLayoutRef.current.viewport, deferred),
      version: ++viewportIntentVersionRef.current,
    };
    pendingResizeViewportRef.current = intent;
    setZoom(intent.viewport.zoom);
    setAdapterZoom(intent.viewport.zoom);
    void instance.setViewport(intent.viewport).catch(() => {});
    if (resizeViewportTimerRef.current !== null) window.clearTimeout(resizeViewportTimerRef.current);
    resizeViewportTimerRef.current = window.setTimeout(() => {
      resizeViewportTimerRef.current = null;
      if (pendingResizeViewportRef.current?.version !== intent.version) return;
      pendingResizeViewportRef.current = null;
      void persistViewportRef.current?.(intent.viewport, intent.version);
    }, RESIZE_VIEWPORT_SAVE_DELAY_MS);
  }, [proposal, proposalDiff, synchronizeAuthoritativeViewport]);

  useEffect(() => () => {
    if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
    if (resizeViewportTimerRef.current !== null) window.clearTimeout(resizeViewportTimerRef.current);
    const pendingPan = pendingViewportRef.current;
    const pendingResize = pendingResizeViewportRef.current;
    pendingViewportRef.current = null;
    pendingResizeViewportRef.current = null;
    const pending = pendingPan && (!pendingResize || pendingPan.version >= pendingResize.version)
      ? pendingPan
      : pendingResize;
    if (pending) {
      const viewport = pendingPan?.version === pending.version && hasSurfaceResizeDelta(deferredSurfaceResizeRef.current)
        ? compensateViewportForSurfaceResize(pending.viewport, deferredSurfaceResizeRef.current)
        : pending.viewport;
      deferredSurfaceResizeRef.current = { x: 0, y: 0 };
      void layoutMutationQueueRef.current
        .then(() => onSaveLayout([{ type: "set-viewport", viewport }]))
        .catch(() => {});
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

  const persistMovedPositions = useCallback((
    ids: readonly string[],
    positions: ReadonlyMap<string, { x: number; y: number }>,
    successMessage: string,
  ) => {
    const generation = geometryGenerationRef.current + 1;
    geometryGenerationRef.current = generation;
    for (const id of ids) {
      const position = positions.get(id);
      if (position) pendingMovePositionsRef.current.set(id, { generation, position });
    }
    void persistLayout(
      (currentLayout) => buildMoveCommands(currentLayout, ids, positions),
      successMessage,
    ).then(() => {
      let clearedLatestMove = false;
      for (const id of ids) {
        if (pendingMovePositionsRef.current.get(id)?.generation !== generation) continue;
        pendingMovePositionsRef.current.delete(id);
        clearedLatestMove = true;
      }
      if (clearedLatestMove) setReconcileVersion((version) => version + 1);
    });
  }, [persistLayout]);

  const saveMovedNodes = useCallback((
    interaction: object,
    movedNodes: readonly WorkspaceFlowNode[],
  ) => {
    const canonicalNodes = movedNodes.filter((node) => canonicalNodeIds.has(node.id));
    const ids = canonicalNodes.map((node) => node.id);
    const positions = new Map(canonicalNodes.map((node) => [node.id, node.position]));
    const commands = buildMoveCommands(workingLayoutRef.current, ids, positions);
    if (commands.length === 0) return;
    const key = commands
      .map((command) => `${command.objectId}:${command.x}:${command.y}`)
      .sort()
      .join("|");
    const persistedBatches = persistedMoveInteractionsRef.current.get(interaction);
    if (persistedBatches?.has(key)) return;
    if (persistedBatches) persistedBatches.add(key);
    else persistedMoveInteractionsRef.current.set(interaction, new Set([key]));
    persistMovedPositions(
      ids,
      positions,
      commands.length === 1 ? "Object moved" : `${commands.length} objects moved`,
    );
  }, [canonicalNodeIds, persistMovedPositions]);

  const fitWorkspace = useCallback(() => {
    setStatus("Fit workspace");
    const instance = flowRef.current;
    if (!instance) return;
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    if (resizeViewportTimerRef.current !== null) {
      window.clearTimeout(resizeViewportTimerRef.current);
      resizeViewportTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    pendingResizeViewportRef.current = null;
    deferredSurfaceResizeRef.current = { x: 0, y: 0 };
    const intentVersion = ++viewportIntentVersionRef.current;
    const surfaceWidth = surfaceRef.current?.clientWidth || 960;
    const keepOutlineOpen = outlineOpen && surfaceWidth >= OUTLINE_SAFE_SURFACE_WIDTH;
    if (outlineOpen && !keepOutlineOpen) setOutlineOpen(false);
    void instance.fitView({
      padding: {
        top: 0.18,
        right: 0.18,
        bottom: 0.32,
        left: 0.18,
      },
      duration: reducedMotion() ? 0 : 220,
    }).then(() => {
      if (viewportIntentVersionRef.current !== intentVersion) return false;
      const fitted = instance.getViewport();
      const outlineOffset = keepOutlineOpen ? Math.min(132, surfaceWidth * 0.14) : 0;
      const next = outlineOffset > 0 ? { ...fitted, x: fitted.x + outlineOffset } : fitted;
      const align = !sameViewport(next, instance.getViewport())
        ? instance.setViewport(next, { duration: reducedMotion() ? 0 : 120 })
        : Promise.resolve(true);
      return align.then(() => {
        if (viewportIntentVersionRef.current !== intentVersion) return false;
        setZoom(next.zoom);
        setAdapterZoom(next.zoom);
        return persistViewport(next, intentVersion);
      });
    });
  }, [outlineOpen, persistViewport]);

  const setWorkspaceZoom = useCallback((requestedZoom: number) => {
    const instance = flowRef.current;
    if (!instance) return;
    const nextZoom = Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, requestedZoom));
    if (viewportTimerRef.current !== null) {
      window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
    }
    if (resizeViewportTimerRef.current !== null) {
      window.clearTimeout(resizeViewportTimerRef.current);
      resizeViewportTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    pendingResizeViewportRef.current = null;
    deferredSurfaceResizeRef.current = { x: 0, y: 0 };
    const intentVersion = ++viewportIntentVersionRef.current;
    void instance.zoomTo(nextZoom, { duration: reducedMotion() ? 0 : 140 }).then(() => {
      if (viewportIntentVersionRef.current !== intentVersion) return false;
      const next = instance.getViewport();
      setZoom(next.zoom);
      setAdapterZoom(next.zoom);
      return persistViewport(next, intentVersion);
    });
  }, [persistViewport]);

  const zoomWorkspaceOut = useCallback(() => {
    setWorkspaceZoom((flowRef.current?.getZoom() ?? zoom) * 0.88);
  }, [setWorkspaceZoom, zoom]);

  const zoomWorkspaceIn = useCallback(() => {
    setWorkspaceZoom((flowRef.current?.getZoom() ?? zoom) * 1.14);
  }, [setWorkspaceZoom, zoom]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!isValidWorkspaceConnection(connection, graph)) {
      reportCanvasProblem("Prototype links connect Page nodes.");
      return;
    }
    const projectEpoch = canvasProjectEpochRef.current;
    const command = createPlannedPrototypeCommand(graph, connection);
    setStatus("Adding planned prototype link…");
    void onApplyGraphCommands([command])
      .then(() => {
        if (projectEpoch === canvasProjectEpochRef.current) setStatus("Planned prototype link added");
      })
      .catch((error: unknown) => {
        if (projectEpoch !== canvasProjectEpochRef.current) return;
        reportCanvasProblem(error instanceof Error && error.message ? error.message : "Couldn't add the prototype link.");
      });
  }, [graph, onApplyGraphCommands, reportCanvasProblem]);

  const handleGroup = useCallback(() => {
    const livePositions = new Map((flowRef.current?.getNodes() ?? nodes).map((node) => [node.id, node.position]));
    const byId = layoutObjectMap(canvasLayout);
    const groupableIds = selectedNodeIds.filter((id) => {
      const object = byId.get(id);
      return object
        && !isComponentLibraryGroupId(id)
        && !isComponentLibraryGroupId(object.parentGroupId ?? "");
    });
    if (groupableIds.length === 0) return;
    const groupId = freshGroupId();
    void persistLayout((currentLayout) => buildGroupCommands(currentLayout, groupableIds, {
      groupId,
      label: "New group",
      graph,
      livePositions,
    }), "Selection grouped").then((saved) => {
      if (saved) onSelectionChange([groupId]);
    });
  }, [canvasLayout, graph, nodes, onSelectionChange, persistLayout, selectedNodeIds]);

  const handleUngroup = useCallback(() => {
    void persistLayout(
      (currentLayout) => {
        const byId = layoutObjectMap(currentLayout);
        return buildUngroupCommands(
          currentLayout,
          selectedNodeIds.filter((id) => !isComponentLibraryGroupId(byId.get(id)?.parentGroupId ?? "")),
        );
      },
      "Selection moved out of its group",
    );
  }, [persistLayout, selectedNodeIds]);

  const confirmDeleteGroup = useCallback(() => {
    if (!pendingDeleteGroupId || isComponentLibraryGroupId(pendingDeleteGroupId)) return;
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
    const groupId = selectedNodeIds.find((id) => (
      !isComponentLibraryGroupId(id) && layoutObjectMap(canvasLayout).get(id)?.kind === "group"
    )) ?? null;
    setPendingDeleteGroupId(groupId);
  }, [canvasLayout, selectedNodeIds]);

  const handleViewportMove = useCallback((event: MouseEvent | TouchEvent | null, next: Viewport) => {
    setZoom(next.zoom);
    setAdapterZoom((current) => semanticZoomLevel(current) === semanticZoomLevel(next.zoom) ? current : next.zoom);
    if (event !== null) {
      if (resizeViewportTimerRef.current !== null) {
        window.clearTimeout(resizeViewportTimerRef.current);
        resizeViewportTimerRef.current = null;
      }
      pendingResizeViewportRef.current = null;
      proposalViewportPreviewRef.current = null;
      pendingViewportRef.current = {
        viewport: next,
        version: ++viewportIntentVersionRef.current,
      };
    }
  }, []);

  const handleEdgeFilterChange = useCallback((nextFilter: WorkspaceEdgeFilter) => {
    setSelectedEdgeIds([]);
    setEdgeFilter(nextFilter);
  }, []);

  const handleViewportEnd = useCallback((event: MouseEvent | TouchEvent | null, next: Viewport) => {
    if (event === null) return;
    if (resizeViewportTimerRef.current !== null) {
      window.clearTimeout(resizeViewportTimerRef.current);
      resizeViewportTimerRef.current = null;
    }
    pendingResizeViewportRef.current = null;
    const deferred = deferredSurfaceResizeRef.current;
    deferredSurfaceResizeRef.current = { x: 0, y: 0 };
    const adjusted = hasSurfaceResizeDelta(deferred)
      ? compensateViewportForSurfaceResize(next, deferred)
      : next;
    const intent: ViewportIntent = {
      viewport: adjusted,
      version: ++viewportIntentVersionRef.current,
    };
    pendingViewportRef.current = intent;
    if (!sameViewport(adjusted, next)) {
      void flowRef.current?.setViewport(adjusted).catch(() => {});
    }
    if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = window.setTimeout(() => {
      viewportTimerRef.current = null;
      const pending = pendingViewportRef.current;
      if (pending?.version !== intent.version) return;
      const latestDeferred = deferredSurfaceResizeRef.current;
      deferredSurfaceResizeRef.current = { x: 0, y: 0 };
      const latestViewport = hasSurfaceResizeDelta(latestDeferred)
        ? compensateViewportForSurfaceResize(pending.viewport, latestDeferred)
        : pending.viewport;
      pendingViewportRef.current = null;
      if (!sameViewport(latestViewport, flowRef.current?.getViewport() ?? latestViewport)) {
        void flowRef.current?.setViewport(latestViewport).catch(() => {});
      }
      void persistViewport(latestViewport, pending.version);
    }, VIEWPORT_SAVE_DELAY_MS);
  }, [persistViewport]);

  const openNode = useCallback((node: WorkspaceFlowNode | undefined) => {
    if (!node || !canonicalNodeIds.has(node.id)) return;
    if (node.data.artifactId) onOpenArtifact(node.data.artifactId);
    else if (node.data.resourceId) onOpenResource?.(node.data.resourceId, node.data.revisionId);
  }, [canonicalNodeIds, onOpenArtifact, onOpenResource]);

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
    persistMovedPositions(
      selectedNodeIds,
      positions,
      commands.length === 1 ? "Object nudged" : `${commands.length} objects nudged`,
    );
  }, [persistMovedPositions, selectedNodeIds]);

  const selectedRelationships = useMemo(() => {
    const selectedIds = new Set(selectedEdgeIds);
    return graph.edges.filter((edge) => selectedIds.has(edge.id));
  }, [graph.edges, selectedEdgeIds]);
  const selectedRelationshipHasDerivedUse = selectedRelationships.some((edge) => edge.kind === "uses");
  const canDeleteRelationship = selectedRelationships.length > 0
    && !selectedRelationshipHasDerivedUse
    && !relationshipMutationPending;
  const relationshipDeleteLabel = selectedRelationshipHasDerivedUse
    ? "Uses relationships are derived and read-only"
    : "Delete selected relationship";
  const relationshipDeleteDisabledReason = selectedRelationshipHasDerivedUse
    ? relationshipDeleteLabel
    : relationshipMutationPending
      ? "Relationship removal is in progress"
      : "Select a relationship to delete";

  const deleteSelectedRelationships = useCallback(async (): Promise<void> => {
    if (relationshipMutationPendingRef.current) return;
    const projectEpoch = canvasProjectEpochRef.current;
    const selectedIds = new Set(selectedEdgeIds);
    const selected = graph.edges.filter((edge) => selectedIds.has(edge.id));
    if (selected.length === 0) return;
    if (selected.some((edge) => edge.kind === "uses")) {
      reportCanvasProblem("Uses relationships are derived and read-only");
      return;
    }
    const removedIds = new Set(selected.map((edge) => edge.id));
    const commands = selected.map((edge): WorkspaceGraphCommand => ({
      id: freshRemoveEdgeCommandId(edge.id),
      type: "remove-edge",
      edgeId: edge.id,
    }));
    relationshipMutationPendingRef.current = true;
    setRelationshipMutationPending(true);
    setStatus(commands.length === 1 ? "Removing relationship…" : `Removing ${commands.length} relationships…`);
    try {
      await onApplyGraphCommands(commands);
      if (projectEpoch !== canvasProjectEpochRef.current) return;
      setSelectedEdgeIds((current) => current.filter((id) => !removedIds.has(id)));
      setStatus(commands.length === 1 ? "Relationship removed" : `${commands.length} relationships removed`);
    } catch (error) {
      if (projectEpoch !== canvasProjectEpochRef.current) return;
      reportCanvasProblem(error instanceof Error && error.message ? error.message : "Couldn't remove the relationship.");
    } finally {
      if (projectEpoch === canvasProjectEpochRef.current) {
        relationshipMutationPendingRef.current = false;
        setRelationshipMutationPending(false);
      }
    }
  }, [graph.edges, onApplyGraphCommands, reportCanvasProblem, selectedEdgeIds]);

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    const edgeTarget = event.target instanceof Element && Boolean(event.target.closest(".react-flow__edge"));
    if ((key === "delete" || key === "backspace")
      && selectedEdgeIds.length > 0
      && (edgeTarget || !isCanvasShortcutTarget(event.target))) {
      event.preventDefault();
      event.stopPropagation();
      void deleteSelectedRelationships();
      return;
    }
    if (isCanvasShortcutTarget(event.target)) return;
    if (key === "enter") {
      if (event.target instanceof Element && event.target.closest(".react-flow__edge")) return;
      const focusedId = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset.id
        : undefined;
      const focused = focusedId ? nodes.find((node) => node.id === focusedId) : undefined;
      const selected = focused ?? nodes.find((node) => selectedSet.has(node.id));
      if (selected?.data.artifactId || selected?.data.resourceId) {
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
  }, [deleteSelectedRelationships, fitWorkspace, moveSelectionByKeyboard, nodes, onSelectionChange, openNode, selectedEdgeIds.length, selectedSet]);

  const groupObjects = useMemo(() => layoutObjectMap(canvasLayout), [canvasLayout]);
  const canGroup = selectedNodeIds.some((id) => {
    const object = groupObjects.get(id);
    return object
      && !isComponentLibraryGroupId(id)
      && !isComponentLibraryGroupId(object.parentGroupId ?? "");
  });
  const canUngroup = selectedNodeIds.some((id) => {
    const parentGroupId = groupObjects.get(id)?.parentGroupId;
    return Boolean(parentGroupId && !isComponentLibraryGroupId(parentGroupId));
  });
  const selectedGroups = selectedNodeIds.filter((id) => groupObjects.get(id)?.kind === "group");
  const canDeleteGroup = selectedGroups.length === 1 && !isComponentLibraryGroupId(selectedGroups[0]!);

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
      <TooltipProvider delayDuration={120}>
        <StudioToolbarHeader draggable className="dezin-project-canvas__header">
          <StudioHeaderIdentity className="dezin-project-canvas__identity">
            <StudioHeaderCopy title={<span title={projectName}>{projectName}</span>} subtitle="Canvas" />
          </StudioHeaderIdentity>
          <StudioHeaderActions className="dezin-project-canvas__header-actions">
            {onPresentFlow ? (
              <Button
                ref={presentFlowButtonRef}
                type="button"
                variant="outline"
                size="sm"
                className="dezin-project-canvas__present"
                aria-label="Present prototype flow"
                onClick={onPresentFlow}
              >
                <Play aria-hidden size={11} fill="currentColor" />
                Present
              </Button>
            ) : null}
            <div className="dezin-project-canvas__measure" aria-label={`${canonicalModel.nodes.length} objects at ${Math.round(zoom * 100)} percent zoom`}>
              <span>{canonicalModel.nodes.length} objects</span>
              <span>{Math.round(zoom * 100)}%</span>
            </div>
            {planPanelAvailable && onTogglePlanPanel ? (
              <ProjectPanelToggleButton
                open={planPanelOpen}
                onToggle={onTogglePlanPanel}
                controls="workspace-plan-inspector"
                buttonRef={planPanelButtonRef}
              />
            ) : null}
            {onRenameProject
              && onOpenProjectInFinder
              && onDeleteProject
              && onCopyAnalysisPrompt ? (
                <ProjectActionsMenu
                  canOpenInFinder={canOpenProjectInFinder}
                  onRename={onRenameProject}
                  onOpenInFinder={onOpenProjectInFinder}
                  onDelete={onDeleteProject}
                  onCopyAnalysisPrompt={onCopyAnalysisPrompt}
                />
              ) : null}
            {exportSourceUrl && exportFullUrl ? (
              <ProjectExportMenu sourceUrl={exportSourceUrl} fullUrl={exportFullUrl} />
            ) : null}
            {onOpenSettings ? <ProjectSettingsButton onOpen={onOpenSettings} /> : null}
          </StudioHeaderActions>
        </StudioToolbarHeader>
      </TooltipProvider>

      <div ref={surfaceRef} className="dezin-project-canvas__surface" data-tool={tool}>
        {surfaceMeasured ? (
          <ReactFlow<WorkspaceFlowNode, WorkspaceFlowEdge>
          aria-label="Project canvas"
          tabIndex={0}
          ariaLabelConfig={CANVAS_ARIA_LABEL_CONFIG}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypesRef.current}
          edgeTypes={edgeTypesRef.current}
          defaultViewport={viewport}
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
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
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={CANVAS_CONNECTION_LINE_STYLE}
          elevateEdgesOnSelect
          deleteKeyCode={null}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          nodeDragThreshold={2}
          nodeClickDistance={3}
          paneClickDistance={3}
          proOptions={{ hideAttribution: true }}
          onInit={(instance) => {
            flowRef.current = instance;
            synchronizeAuthoritativeViewport(instance);
            setFlowReady(true);
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
          onNodeDragStop={(event, node, movedNodes) => saveMovedNodes(event, movedNodes.length ? movedNodes : [node])}
          onSelectionDragStop={(event, movedNodes) => saveMovedNodes(event, movedNodes)}
          isValidConnection={(connection) => isValidWorkspaceConnection(connection, graph)}
          onConnect={handleConnect}
          onMove={handleViewportMove}
          onMoveEnd={handleViewportEnd}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={0.85} />
          </ReactFlow>
        ) : null}

        <WorkspaceCanvasToolbar
          tool={tool}
          edgeFilter={edgeFilter}
          outlineOpen={outlineOpen}
          canGroup={canGroup}
          canUngroup={canUngroup}
          canDeleteGroup={canDeleteGroup}
          canDeleteRelationship={canDeleteRelationship}
          hasRelationshipSelection={selectedRelationships.length > 0}
          relationshipDeleteLabel={relationshipDeleteLabel}
          relationshipDeleteDisabledReason={relationshipDeleteDisabledReason}
          onToolChange={setTool}
          onEdgeFilterChange={handleEdgeFilterChange}
          onToggleOutline={() => setOutlineOpen((open) => !open)}
          onFitView={fitWorkspace}
          zoom={zoom}
          onZoomOut={zoomWorkspaceOut}
          onZoomIn={zoomWorkspaceIn}
          onSetZoom={setWorkspaceZoom}
          onGroup={handleGroup}
          onUngroup={handleUngroup}
          onDeleteGroup={requestDeleteGroup}
          onDeleteRelationship={() => void deleteSelectedRelationships()}
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
            <Button ref={deleteCancelRef} type="button" size="sm" variant="outline" onClick={closeDeleteConfirmation}>
              Cancel
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={confirmDeleteGroup}>
              Remove frame
            </Button>
          </div>
        )}

        <p
          className="sr-only"
          role="status"
          aria-label="Canvas status"
          aria-live="polite"
        >
          {status}
        </p>
      </div>
    </section>
  );
}
