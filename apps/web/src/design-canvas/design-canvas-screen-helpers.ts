/**
 * Pure helpers for the Design Canvas screen: node/flow conversions, equality
 * checks that keep React state referentially stable, focus-layout math, and
 * hover-label scaling. Nothing here touches component state.
 */
import type { Viewport } from "@xyflow/react";

import type { DesignCanvasApi } from "./api.ts";
import {
  designNodeAriaLabel,
  type DesignFlowNode,
  type DesignNodeContentLayout,
  type DesignPreviewAnnotationTarget,
} from "./DesignCanvasNode.tsx";
import type { FocusedPreviewDevice } from "./FocusedNodeChrome.tsx";
import {
  focusedNodeLayoutMode,
  focusedNodeTransform,
  type NodeFocusMotion,
  type NodeFocusPhase,
} from "./node-focus-motion.ts";
import type {
  DesignCanvas,
  DesignJobStatus,
  DesignNode,
  DesignNodeKind,
  DesignNodeVersion,
  FigmaCanvasImportResponse,
} from "./types.ts";

export const DESIGN_CANVAS_MIN_ZOOM = 0.05;
const HOVER_LABEL_SCREEN_INSET_PX = 12;

export function syncHoverLabelViewportScale(surface: HTMLElement | null, zoom: number): void {
  if (!surface) return;
  const safeZoom = Math.max(Number.isFinite(zoom) ? zoom : 1, DESIGN_CANVAS_MIN_ZOOM);
  const inverseScale = String(1 / safeZoom);
  const screenInset = `${HOVER_LABEL_SCREEN_INSET_PX / safeZoom}px`;
  if (surface.style.getPropertyValue("--design-canvas-viewport-inverse-scale") !== inverseScale) {
    surface.style.setProperty("--design-canvas-viewport-inverse-scale", inverseScale);
  }
  if (surface.style.getPropertyValue("--design-canvas-hover-label-inset") !== screenInset) {
    surface.style.setProperty("--design-canvas-hover-label-inset", screenInset);
  }
}

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

export function isLiveJobStatus(status: DesignJobStatus): boolean {
  return status === "queued" || status === "running" || status === "validating";
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


export const FOCUSED_PREVIEW_WIDTHS: Record<FocusedPreviewDevice, number | undefined> = {
  desktop: undefined,
  tablet: 768,
  mobile: 390,
};

export interface FocusedLayoutContext {
  /** Width of the Node Agent panel docked on the right, or null when it is hidden. */
  agentPanelWidth?: number | null;
  naturalSize?: { width: number; height: number } | null;
}

export function focusedLayoutOptions(
  surface: { width: number; height: number },
  node: DesignNode,
  targetWidth?: number,
  contentAspectRatio?: number,
  metadata?: DesignNodeVersion | null,
  context: FocusedLayoutContext = {},
): Parameters<typeof focusedNodeTransform>[3] {
  const layoutMode = focusedNodeLayoutMode({
    kind: node.kind,
    fileName: metadata?.fileName ?? node.name,
    mimeType: metadata?.mimeType,
  });
  const responsiveTargetWidth = layoutMode === "web" ? targetWidth : undefined;
  const naturalSize = context.naturalSize ?? null;
  if (surface.width <= 720) {
    return {
      reservedRight: 0,
      horizontalInset: 16,
      bottomInset: Math.min(520, surface.height * 0.56) + 90,
      layoutMode,
      targetWidth: responsiveTargetWidth,
      contentAspectRatio,
      naturalSize,
    };
  }
  return {
    reservedRight: context.agentPanelWidth ? context.agentPanelWidth + 24 : 0,
    layoutMode,
    targetWidth: responsiveTargetWidth,
    contentAspectRatio,
    naturalSize,
  };
}


export function figmaImportedNodeIds(
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

export function canvasToFlowNodes(
  nodes: readonly DesignNode[],
  projectId: string,
  api: DesignCanvasApi,
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void,
  onAppendMaterialVersion: (nodeId: string, file: File) => Promise<void>,
  onContentAspectRatio: (nodeId: string, aspectRatio: number, naturalSize?: { width: number; height: number }) => void,
  onPreviewContextMenu: (nodeId: string, target: DesignPreviewAnnotationTarget) => void,
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

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']") || target.closest("iframe") !== null;
}

export function createDesignNodeId(kind: DesignNodeKind): string {
  return `${kind}-${globalThis.crypto.randomUUID()}`;
}

export function downloadFileStem(name: string): string {
  const normalized = name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "dezin-preview";
}

export function flowNodeGeometry(
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

export function sameDesignNode(left: DesignNode, right: DesignNode): boolean {
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

export function sameNodeFocusMotion(left: NodeFocusMotion | null | undefined, right: NodeFocusMotion | null | undefined): boolean {
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

export function sameContentLayout(
  left: DesignNodeContentLayout | null | undefined,
  right: DesignNodeContentLayout | null | undefined,
): boolean {
  if (!left || !right) return left === right || (left == null && right == null);
  return left.width === right.width
    && left.height === right.height
    && left.canvasScale === right.canvasScale;
}

export function sameViewport(left: Viewport | null, right: Viewport | null): boolean {
  return left !== null && right !== null && left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

export function sameGeometry(left: DesignNode["geometry"], right: DesignNode["geometry"]): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
