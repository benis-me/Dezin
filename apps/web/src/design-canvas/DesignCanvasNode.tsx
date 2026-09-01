import {
  Handle,
  NodeResizeControl,
  Position,
  type ControlPosition,
  type Node,
  type NodeProps,
  type OnResizeEnd,
  type ShouldResize,
} from "@xyflow/react";
import {
  CircleAlert,
  LoaderCircle,
  Pause,
  Play,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { Button, IconSwap } from "../components/ui/index.ts";
import {
  embeddedPreviewDocumentSrc,
  previewDocumentSrc,
  useEmbeddedPreviewContextMenuChannel,
} from "../lib/preview-channel.ts";
import { cn } from "../lib/utils.ts";
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion.ts";
import type { DesignCanvasApi } from "./api.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import { useExactVersionMetadata } from "./exact-version-metadata.ts";
import { nodeFocusEase, type NodeFocusMotion } from "./node-focus-motion.ts";
import { designNodeGenerationCopy, designNodePresentation } from "./node-presentation.ts";
import { TypedMaterialSurface } from "./TypedMaterialSurface.tsx";
import type { DesignNode, DesignNodeKind } from "./types.ts";
import { useExactVersionPreview } from "./useExactVersionPreview.ts";
import "./generation-particles.css";

export interface DesignFlowNodeData extends Record<string, unknown> {
  node: DesignNode;
  projectId: string;
  api: DesignCanvasApi;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
  onAppendMaterialVersion?: (nodeId: string, file: File) => Promise<void>;
  onContentAspectRatio?: (nodeId: string, aspectRatio: number) => void;
  onPreviewContextMenu?: (nodeId: string, target: DesignPreviewAnnotationTarget) => void;
  onFocusAnimationStart?: (nodeId: string, phase: NodeFocusMotion["phase"], durationMs: number) => void;
  onFocusAnimationComplete?: (nodeId: string, phase: NodeFocusMotion["phase"]) => void;
  contentLayout?: DesignNodeContentLayout | null;
  focusMotion?: NodeFocusMotion | null;
}

export interface DesignPreviewAnnotationTarget {
  clientX: number;
  clientY: number;
  tagName: string;
  selector: string;
  targetPath: string;
  nearbyText: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DesignNodeContentLayout {
  width: number;
  height: number;
  canvasScale: number;
}

export type DesignFlowNode = Node<DesignFlowNodeData, "design">;

export interface FocusVisualState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

interface FocusAnimationState {
  animation: Animation;
  target: NodeFocusMotion["phase"];
  pathKey: string;
  layoutWidth: number | null;
  layoutHeight: number | null;
}

export function focusVisualStateFromTransform(transform: string, opacity: number): FocusVisualState {
  if (transform === "none" || transform.trim() === "") {
    return { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity };
  }
  const serialized = transform.match(/^matrix(3d)?\(([^)]+)\)$/);
  const values = serialized?.[2]?.split(",").map((value) => Number(value.trim())) ?? [];
  const matrix3d = serialized?.[1] === "3d" && values.length === 16;
  const matrix2d = serialized?.[1] === undefined && values.length === 6;
  if (matrix3d || matrix2d) {
    return {
      x: matrix3d ? values[12]! : values[4]!,
      y: matrix3d ? values[13]! : values[5]!,
      scaleX: values[0]!,
      scaleY: matrix3d ? values[5]! : values[3]!,
      opacity,
    };
  }
  if (typeof DOMMatrixReadOnly !== "undefined") {
    try {
      const matrix = new DOMMatrixReadOnly(transform);
      return {
        x: Number.isFinite(matrix.m41) ? matrix.m41 : 0,
        y: Number.isFinite(matrix.m42) ? matrix.m42 : 0,
        scaleX: Number.isFinite(matrix.m11) ? matrix.m11 : 1,
        scaleY: Number.isFinite(matrix.m22) ? matrix.m22 : 1,
        opacity,
      };
    } catch {
      // Fall through to the serialization parser used by DOM-light test hosts.
    }
  }
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    opacity,
  };
}

export function rebaseFocusVisualState(
  state: FocusVisualState,
  previousLayout: { width: number; height: number },
  nextLayout: { width: number; height: number },
): FocusVisualState {
  if (previousLayout.width <= 0 || previousLayout.height <= 0 || nextLayout.width <= 0 || nextLayout.height <= 0) {
    return state;
  }
  return {
    ...state,
    x: state.x + (previousLayout.width - nextLayout.width) / 2,
    y: state.y + (previousLayout.height - nextLayout.height) / 2,
    scaleX: state.scaleX * previousLayout.width / nextLayout.width,
    scaleY: state.scaleY * previousLayout.height / nextLayout.height,
  };
}

function readFocusVisualState(element: HTMLElement): FocusVisualState {
  const computed = getComputedStyle(element);
  const opacity = Number.parseFloat(computed.opacity);
  return {
    ...focusVisualStateFromTransform(computed.transform, Number.isFinite(opacity) ? opacity : 1),
  };
}

export function focusVisualFrames(
  start: FocusVisualState,
  end: FocusVisualState,
  arcX: number,
  arcY: number,
): Keyframe[] {
  const controlX = (start.x + end.x) / 2 + arcX * 2;
  const controlY = (start.y + end.y) / 2 + arcY * 2;
  return Array.from({ length: 17 }, (_, index): Keyframe => {
    const offset = index / 16;
    const progress = nodeFocusEase(offset);
    const inverse = 1 - progress;
    const x = inverse * inverse * start.x + 2 * inverse * progress * controlX + progress * progress * end.x;
    const y = inverse * inverse * start.y + 2 * inverse * progress * controlY + progress * progress * end.y;
    const scaleX = start.scaleX + (end.scaleX - start.scaleX) * progress;
    const scaleY = start.scaleY + (end.scaleY - start.scaleY) * progress;
    const opacity = start.opacity + (end.opacity - start.opacity) * progress;
    return {
      offset,
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`,
      opacity,
    };
  });
}

function previewFrameAddress(url: string): { src: string; instrumented: boolean } {
  try {
    // Keep one immutable document identity from canvas preview through focus and
    // back. Swapping exact preview <-> embed here reloads the iframe, erasing its
    // scroll position and runtime state even when React preserves the element.
    return { src: embeddedPreviewDocumentSrc(url), instrumented: true };
  } catch {
    // Non-production adapters and old fixtures can still render exact previews;
    // only the dedicated immutable endpoint gains the context-menu bridge.
    return { src: previewDocumentSrc(url), instrumented: false };
  }
}

const STATE_LABELS: Record<DesignNode["state"], string> = {
  empty: "Not generated",
  queued: "Queued",
  generating: "Generating",
  validating: "Preparing preview",
  ready: "Ready",
  failed: "Needs attention",
  cancelled: "Cancelled",
  superseded: "Newer version ready",
};

const LIVE_STATES = new Set<DesignNode["state"]>(["queued", "generating", "validating"]);
const NODE_ENTERING_DURATION_MS = 1_500;

export function designNodeAriaLabel(
  node: Pick<DesignNode, "kind" | "name" | "state">,
): string {
  return `${node.name}, ${catalogItem(node.kind).label}, ${STATE_LABELS[node.state]}`;
}

const GENERATED_PREVIEW_SIZES: Partial<Record<DesignNodeKind, { width: number; height: number }>> = {
  page: { width: 800, height: 600 },
  component: { width: 560, height: 400 },
  "design-system": { width: 720, height: 520 },
  research: { width: 680, height: 500 },
  "design-tokens": { width: 640, height: 460 },
  "design-document": { width: 680, height: 520 },
  layout: { width: 720, height: 500 },
  knowledge: { width: 680, height: 500 },
};

const RESIZE_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const satisfies readonly ControlPosition[];
type ResizeCornerPosition = typeof RESIZE_CORNERS[number];
const RESIZE_CORNER_LABELS: Record<ResizeCornerPosition, string> = {
  "top-left": "top left",
  "top-right": "top right",
  "bottom-left": "bottom left",
  "bottom-right": "bottom right",
};

export function preferredGeneratedNodeGeometry(node: Pick<DesignNode, "kind" | "geometry">): DesignNode["geometry"] {
  const preferred = GENERATED_PREVIEW_SIZES[node.kind];
  return preferred ? { ...node.geometry, ...preferred } : { ...node.geometry };
}

function useNearViewport(selected: boolean): { ref: React.RefObject<HTMLDivElement | null>; nearViewport: boolean } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(selected || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (selected) setNearViewport(true);
  }, [selected]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setNearViewport(entry?.isIntersecting === true);
    }, { rootMargin: "360px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, nearViewport };
}

function keyboardResizeGeometry(
  geometry: DesignNode["geometry"],
  position: ResizeCornerPosition,
  key: string,
  step: number,
  lockAspectRatio: boolean,
): DesignNode["geometry"] | null {
  const horizontalDelta = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const verticalDelta = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  if (horizontalDelta === 0 && verticalDelta === 0) return null;

  const left = position.endsWith("left");
  const top = position.startsWith("top");
  const minimumWidth = lockAspectRatio ? 120 : 280;
  const minimumHeight = lockAspectRatio ? 80 : 200;

  if (!lockAspectRatio) {
    const width = horizontalDelta === 0
      ? geometry.width
      : Math.max(minimumWidth, geometry.width + (left ? -horizontalDelta : horizontalDelta));
    const height = verticalDelta === 0
      ? geometry.height
      : Math.max(minimumHeight, geometry.height + (top ? -verticalDelta : verticalDelta));
    return {
      x: left ? geometry.x + geometry.width - width : geometry.x,
      y: top ? geometry.y + geometry.height - height : geometry.y,
      width,
      height,
    };
  }

  const aspectRatio = geometry.width / geometry.height;
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return null;
  let width: number;
  let height: number;
  if (horizontalDelta !== 0) {
    width = Math.max(
      minimumWidth,
      minimumHeight * aspectRatio,
      geometry.width + (left ? -horizontalDelta : horizontalDelta),
    );
    height = width / aspectRatio;
  } else {
    height = Math.max(
      minimumHeight,
      minimumWidth / aspectRatio,
      geometry.height + (top ? -verticalDelta : verticalDelta),
    );
    width = height * aspectRatio;
  }
  return {
    x: left ? geometry.x + geometry.width - width : geometry.x,
    y: top ? geometry.y + geometry.height - height : geometry.y,
    width,
    height,
  };
}

function NodeCornerResizeControl({
  nodeId,
  nodeName,
  geometryRef,
  position,
  enabled,
  emphasized,
  lockAspectRatio,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  nodeId: string;
  nodeName: string;
  geometryRef: RefObject<DesignNode["geometry"]>;
  position: ResizeCornerPosition;
  enabled: boolean;
  emphasized: boolean;
  lockAspectRatio: boolean;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const shouldResize = useCallback<ShouldResize>(() => enabled, [enabled]);
  const handleResizeEnd = useCallback<OnResizeEnd>((_event, params) => {
    const geometry = {
      x: params.x,
      y: params.y,
      width: params.width,
      height: params.height,
    };
    geometryRef.current = geometry;
    onResizeEnd();
    onResize(nodeId, geometry);
  }, [geometryRef, nodeId, onResize, onResizeEnd]);
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    const geometry = keyboardResizeGeometry(
      geometryRef.current,
      position,
      event.key,
      event.shiftKey ? 24 : 8,
      lockAspectRatio,
    );
    if (!geometry) return;
    event.preventDefault();
    event.stopPropagation();
    const current = geometryRef.current;
    if (geometry.x === current.x
      && geometry.y === current.y
      && geometry.width === current.width
      && geometry.height === current.height) return;
    geometryRef.current = geometry;
    onResize(nodeId, geometry);
  }, [enabled, geometryRef, lockAspectRatio, nodeId, onResize, position]);

  return (
    <NodeResizeControl
      position={position}
      minWidth={lockAspectRatio ? 120 : 280}
      minHeight={lockAspectRatio ? 80 : 200}
      keepAspectRatio={lockAspectRatio}
      shouldResize={shouldResize}
      className={cn(
        "design-canvas-node__resize-control",
        enabled && "design-canvas-node__resize-control--enabled",
        emphasized
          ? "design-canvas-node__resize-control--interactive"
          : "design-canvas-node__resize-control--affordance",
      )}
      onResizeStart={onResizeStart}
      onResizeEnd={handleResizeEnd}
    >
      {emphasized && enabled ? (
        <button
          type="button"
          className="design-canvas-node__resize-hit-target"
          data-resize-corner={position}
          tabIndex={0}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
          aria-label={`Resize ${nodeName} from ${RESIZE_CORNER_LABELS[position]}`}
          aria-description="Use arrow keys to resize. Hold Shift for larger steps."
          onKeyDown={handleKeyDown}
        >
          <span aria-hidden className="design-canvas-node__resize-corner" />
        </button>
      ) : (
        <span aria-hidden className="design-canvas-node__resize-corner" />
      )}
    </NodeResizeControl>
  );
}

function NodeCornerResizeControls({
  node,
  enabled,
  emphasized,
  lockAspectRatio,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  node: DesignNode;
  enabled: boolean;
  emphasized: boolean;
  lockAspectRatio: boolean;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const geometryRef = useRef(node.geometry);
  useEffect(() => {
    geometryRef.current = node.geometry;
  }, [node.geometry]);

  return RESIZE_CORNERS.map((position) => (
    <NodeCornerResizeControl
      key={position}
      nodeId={node.id}
      nodeName={node.name}
      geometryRef={geometryRef}
      position={position}
      enabled={enabled}
      emphasized={emphasized}
      lockAspectRatio={lockAspectRatio}
      onResize={onResize}
      onResizeStart={onResizeStart}
      onResizeEnd={onResizeEnd}
    />
  ));
}

function useNodeEntering(createdAt: number): boolean {
  const [entering, setEntering] = useState(() => {
    const age = Date.now() - createdAt;
    return age >= 0 && age < NODE_ENTERING_DURATION_MS;
  });

  useEffect(() => {
    const age = Date.now() - createdAt;
    const remaining = NODE_ENTERING_DURATION_MS - age;
    if (age < 0 || remaining <= 0) {
      setEntering(false);
      return;
    }

    setEntering(true);
    const timeout = window.setTimeout(() => setEntering(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [createdAt]);

  return entering;
}

export function DesignCanvasNode({ data, selected }: NodeProps<DesignFlowNode>) {
  const {
    node,
    projectId,
    api,
    onResize,
    onAppendMaterialVersion,
    onContentAspectRatio,
    onPreviewContextMenu,
    onFocusAnimationStart,
    onFocusAnimationComplete,
    contentLayout = null,
    focusMotion = null,
  } = data;
  const [resizing, setResizing] = useState(false);
  const reduceMotion = usePrefersReducedMotion();
  const { ref, nearViewport } = useNearViewport(selected);
  const focusAnimationRef = useRef<FocusAnimationState | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const entering = useNodeEntering(node.createdAt);
  const material = isMaterialNodeKind(node.kind);
  const focusInteractive = focusMotion?.phase === "opening" && focusMotion.role === "source";
  const focusSource = focusMotion?.role === "source";
  const shouldMountRichPreview = nearViewport || selected || focusSource;
  const { preview, versionId, loading, error: previewError } = useExactVersionPreview({
    api,
    projectId,
    node,
    enabled: shouldMountRichPreview,
  });
  useExactVersionMetadata({
    api,
    projectId,
    nodeId: node.id,
    versionId,
    enabled: shouldMountRichPreview,
  });
  const catalog = catalogItem(node.kind);
  const presentation = designNodePresentation(node.kind);
  const hasRichContent = versionId !== null;
  const contentPlaneActive = preview !== null && contentLayout !== null;
  const live = LIVE_STATES.has(node.state);
  const generationSeed = `${node.id}:${node.activeJobId ?? "pending"}`;
  const generationMotionActive = nearViewport || selected || focusSource;
  const previewFrameAddressValue = preview && !material
    ? previewFrameAddress(preview.url)
    : null;
  useEmbeddedPreviewContextMenuChannel({
    iframeRef,
    previewSrc: previewFrameAddressValue?.src ?? null,
    enabled: previewFrameAddressValue?.instrumented === true && onPreviewContextMenu !== undefined,
    onContextMenu: (message) => {
      const iframe = iframeRef.current;
      if (!focusSource || !onPreviewContextMenu || !iframe) return;
      const bounds = iframe.getBoundingClientRect();
      const scaleX = bounds.width / Math.max(1, iframe.clientWidth);
      const scaleY = bounds.height / Math.max(1, iframe.clientHeight);
      onPreviewContextMenu(node.id, {
        clientX: bounds.left + Math.max(0, Math.min(bounds.width, message.clientX * scaleX)),
        clientY: bounds.top + Math.max(0, Math.min(bounds.height, message.clientY * scaleY)),
        tagName: message.tagName,
        selector: message.selector,
        targetPath: message.targetPath,
        nearbyText: message.nearbyText,
        rect: {
          x: bounds.left + message.rect.x * scaleX,
          y: bounds.top + message.rect.y * scaleY,
          width: message.rect.width * scaleX,
          height: message.rect.height * scaleY,
        },
      });
    },
  });
  const previousVersionIdRef = useRef(versionId);
  const handleResizeStart = useCallback(() => setResizing(true), []);
  const handleResizeEnd = useCallback(() => setResizing(false), []);
  const focusStyle = focusMotion ? {
    "--design-node-focus-start-x": `${focusMotion.startX}px`,
    "--design-node-focus-start-y": `${focusMotion.startY}px`,
    "--design-node-focus-x": `${focusMotion.shiftX}px`,
    "--design-node-focus-y": `${focusMotion.shiftY}px`,
    "--design-node-focus-arc-x": `${focusMotion.arcX}px`,
    "--design-node-focus-arc-y": `${focusMotion.arcY}px`,
    "--design-node-focus-start-scale-x": focusMotion.startScaleX,
    "--design-node-focus-start-scale-y": focusMotion.startScaleY,
    "--design-node-focus-scale-x": focusMotion.scaleX,
    "--design-node-focus-scale-y": focusMotion.scaleY,
    "--design-node-focus-duration": `${focusMotion.durationMs}ms`,
    "--design-node-focus-delay": `${focusMotion.delayMs}ms`,
    "--design-node-focus-fade-duration": `${focusMotion.fadeDurationMs}ms`,
  } as CSSProperties : undefined;

  useLayoutEffect(() => {
    const element = ref.current;
    const running = focusAnimationRef.current;
    if (!element || !focusMotion) {
      running?.animation.cancel();
      focusAnimationRef.current = null;
      return;
    }
    const pathKey = [
      focusMotion.shiftX,
      focusMotion.shiftY,
      focusMotion.arcX,
      focusMotion.arcY,
      focusMotion.startX,
      focusMotion.startY,
      focusMotion.startScaleX,
      focusMotion.startScaleY,
      focusMotion.scaleX,
      focusMotion.scaleY,
      focusMotion.startWidth,
      focusMotion.startHeight,
      focusMotion.layoutWidth,
      focusMotion.layoutHeight,
      focusMotion.durationMs,
      focusMotion.delayMs,
      focusMotion.fadeDurationMs,
      focusMotion.role,
    ].join(":");
    if (!reduceMotion && running?.target === focusMotion.phase && running.pathKey === pathKey) return;

    const focusedTarget: FocusVisualState = {
      x: focusMotion.shiftX,
      y: focusMotion.shiftY,
      scaleX: focusMotion.scaleX,
      scaleY: focusMotion.scaleY,
      opacity: focusMotion.role === "source" ? 1 : 0,
    };
    const canvasTarget: FocusVisualState = {
      x: focusMotion.startX,
      y: focusMotion.startY,
      scaleX: focusMotion.startScaleX,
      scaleY: focusMotion.startScaleY,
      opacity: 1,
    };
    const liveStart = running ? readFocusVisualState(element) : null;
    const start = liveStart
      ? focusMotion.role === "source"
        && running !== null
        && running.layoutWidth !== null
        && running.layoutHeight !== null
        && focusMotion.layoutWidth !== null
        && focusMotion.layoutHeight !== null
        ? rebaseFocusVisualState(
            liveStart,
            { width: running.layoutWidth, height: running.layoutHeight },
            { width: focusMotion.layoutWidth, height: focusMotion.layoutHeight },
          )
        : liveStart
      : focusMotion.phase === "opening"
        ? canvasTarget
        : focusedTarget;
    const end = focusMotion.phase === "opening" ? focusedTarget : canvasTarget;
    running?.animation.cancel();
    if (reduceMotion || focusMotion.durationMs <= 0 || typeof element.animate !== "function") {
      focusAnimationRef.current = null;
      if (focusMotion.role !== "source") return;
      onFocusAnimationStart?.(node.id, focusMotion.phase, 0);
      const settleTimer = window.setTimeout(() => {
        onFocusAnimationComplete?.(node.id, focusMotion.phase);
      }, 0);
      return () => window.clearTimeout(settleTimer);
    }
    const fullTravel = Math.hypot(focusMotion.shiftX - focusMotion.startX, focusMotion.shiftY - focusMotion.startY)
      + Math.abs(focusMotion.scaleX - focusMotion.startScaleX) * 180
      + Math.abs(focusMotion.scaleY - focusMotion.startScaleY) * 180
      + (focusMotion.role === "source" ? 0 : 80);
    const remainingTravel = Math.hypot(end.x - start.x, end.y - start.y)
      + Math.abs(end.scaleX - start.scaleX) * 180
      + Math.abs(end.scaleY - start.scaleY) * 180
      + Math.abs(end.opacity - start.opacity) * 80;
    const travelRatio = Math.min(1, remainingTravel / Math.max(1, fullTravel));
    const durationRatio = Math.sqrt(travelRatio);
    const durationMs = Math.max(120, Math.round(focusMotion.durationMs * durationRatio));
    const animation = element.animate(
      focusVisualFrames(
        start,
        end,
        focusMotion.arcX * travelRatio,
        focusMotion.arcY * travelRatio,
      ),
      {
        duration: durationMs,
        delay: running ? 0 : focusMotion.delayMs,
        easing: "linear",
        fill: "both",
      },
    );
    focusAnimationRef.current = {
      animation,
      target: focusMotion.phase,
      pathKey,
      layoutWidth: focusMotion.layoutWidth,
      layoutHeight: focusMotion.layoutHeight,
    };
    if (focusMotion.role === "source") {
      onFocusAnimationStart?.(node.id, focusMotion.phase, durationMs);
      void animation.finished.then(() => {
        if (focusAnimationRef.current?.animation !== animation) return;
        onFocusAnimationComplete?.(node.id, focusMotion.phase);
      }).catch(() => undefined);
    }
  }, [focusMotion, node.id, onFocusAnimationComplete, onFocusAnimationStart, reduceMotion, ref]);

  useEffect(() => () => {
    focusAnimationRef.current?.animation.cancel();
    focusAnimationRef.current = null;
  }, []);

  useEffect(() => {
    if (!selected) setResizing(false);
  }, [selected]);
  useEffect(() => {
    const previousVersionId = previousVersionIdRef.current;
    previousVersionIdRef.current = versionId;
    if (previousVersionId !== null || versionId === null || material) return;
    const defaults = catalogItem(node.kind).defaultGeometry;
    if (node.geometry.width !== defaults.width || node.geometry.height !== defaults.height) return;
    const preferred = preferredGeneratedNodeGeometry(node);
    if (preferred.width !== node.geometry.width || preferred.height !== node.geometry.height) {
      onResize(node.id, preferred);
    }
  }, [material, node, onResize, versionId]);
  return (
    <div
      ref={ref}
      data-design-node-id={node.id}
      data-node-kind={node.kind}
      data-node-presentation={presentation.mode}
      data-node-state={node.state}
      data-node-focus-role={focusMotion?.role}
      data-node-focus-phase={focusMotion?.phase}
      className={cn(
        "design-canvas-node",
        selected && "design-canvas-node--selected",
        resizing && "design-canvas-node--resizing",
        entering && "design-canvas-node--entering",
        focusInteractive && "design-canvas-node--focus-interactive nodrag nopan",
      )}
      style={{
        width: focusSource
          ? focusMotion.layoutWidth ?? "100%"
          : "100%",
        height: focusSource
          ? focusMotion.layoutHeight ?? "100%"
          : "100%",
        ...focusStyle,
      }}
    >
      <Handle type="target" position={Position.Left} className="design-canvas-node__flow-handle" />
      <Handle type="source" position={Position.Right} className="design-canvas-node__flow-handle" />
      <div className="design-canvas-node__hover-label" aria-hidden="true">
        <span>{node.name}</span>
      </div>

      <NodeCornerResizeControls
        node={node}
        enabled={focusMotion === null}
        emphasized={selected}
        lockAspectRatio={catalog.lockAspectRatio === true}
        onResize={onResize}
        onResizeStart={handleResizeStart}
        onResizeEnd={handleResizeEnd}
      />

      <div className="design-canvas-node__frame">
        <div className="design-canvas-node__body">
          <div
            className={cn(
              "design-canvas-node__content",
              contentPlaneActive && "design-canvas-node__content-plane",
            )}
            data-content-plane-state={contentPlaneActive ? focusSource ? "focus" : "canvas" : undefined}
            style={contentPlaneActive ? {
              width: `calc(${contentLayout.width}px - 2px)`,
              height: `calc(${contentLayout.height}px - 2px)`,
              transform: focusSource
                ? "translate3d(0, 0, 0) scale(1)"
                : `translate3d(0, 0, 0) scale(${contentLayout.canvasScale})`,
            } : undefined}
          >
            {versionId ? (
              shouldMountRichPreview ? (
                preview ? (
                  material ? (
                    <MaterialPreview
                      key={preview.url}
                      node={node}
                      projectId={projectId}
                      api={api}
                      versionId={versionId}
                      url={preview.url}
                      focusMotion={focusMotion}
                      onAppendMaterialVersion={onAppendMaterialVersion}
                      onContentAspectRatio={onContentAspectRatio}
                    />
                  ) : (
                    <iframe
                      ref={iframeRef}
                      className="design-canvas-node__iframe nodrag nopan"
                      title={`${node.name}, version ${versionId}`}
                      src={previewFrameAddressValue?.src ?? previewDocumentSrc(preview.url)}
                      sandbox="allow-scripts"
                      tabIndex={focusInteractive ? 0 : -1}
                    />
                  )
                ) : (
                  <NodePlaceholder
                    icon={loading ? "loading" : "error"}
                    title={loading ? "Opening this version" : "Preview unavailable"}
                    detail={previewError ?? `Version ${versionId}`}
                  />
                )
              ) : (
                <NodePlaceholder icon="paused" title="Preview paused" detail="It will resume when this Node returns to view." />
              )
            ) : live ? (
              <NodeWorkingPlaceholder
                state={node.state}
                kind={node.kind}
                label={catalog.label}
                generationSeed={generationSeed}
                motionActive={generationMotionActive}
              />
            ) : node.state === "failed" ? (
              <NodePlaceholder icon="error" title="Generation needs attention" detail={node.error ?? "Open the Agent to review the failed run."} />
            ) : node.state === "cancelled" || node.state === "superseded" ? (
              <NodePlaceholder icon="paused" title={STATE_LABELS[node.state]} detail="Open the Agent when you are ready to continue." />
            ) : material ? (
              <NodePlaceholder
                icon="sparkles"
                title="Add the first revision"
                detail="Select this Node, then add a local revision from its Agent."
              />
            ) : (
              <NodePlaceholder
                tone="empty"
                title={`Create this ${catalog.label.toLocaleLowerCase()}`}
                detail="Select this Node and describe the result in its Agent."
              />
            )}
          </div>

          {hasRichContent && !focusInteractive && node.kind !== "video" ? (
            <button
              type="button"
              className="design-canvas-node__gesture-shield nopan"
              aria-label={`Select ${node.name}; double click to focus and interact`}
            />
          ) : null}

          {live && hasRichContent ? (
            <NodeGenerationStatus
              state={node.state}
              kind={node.kind}
              generationSeed={generationSeed}
              motionActive={generationMotionActive}
            />
          ) : null}

          {(node.state === "failed" || node.state === "cancelled" || node.state === "superseded") && hasRichContent ? (
            <div className="design-canvas-node__failure" role="status">
              <CircleAlert aria-hidden />
              <span>{node.error ?? `${STATE_LABELS[node.state]}. Showing the last ready version.`}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function NodeWorkingPlaceholder({
  state,
  kind = "page",
  generationSeed = "generation-preview",
  motionActive = true,
}: {
  state: DesignNode["state"];
  kind?: DesignNodeKind;
  label?: string;
  generationSeed?: string;
  motionActive?: boolean;
}) {
  const copy = designNodeGenerationCopy(kind, state, false);
  return (
    <div
      className="design-canvas-node__generation"
      data-generation-state={state}
      data-generation-kind={kind}
      data-generation-motion={motionActive ? "active" : "paused"}
      role="status"
    >
      <GenerationDotField key={generationSeed} generationSeed={generationSeed} motionActive={motionActive} />
      <div className="design-canvas-node__generation-copy">
        <p>{copy.title}</p>
        <span>{copy.detail}</span>
      </div>
    </div>
  );
}

export function NodeGenerationStatus({
  state,
  kind = "page",
  generationSeed = "generation-preview",
  motionActive = true,
}: {
  state: DesignNode["state"];
  kind?: DesignNodeKind;
  generationSeed?: string;
  motionActive?: boolean;
}) {
  const copy = designNodeGenerationCopy(kind, state, true);
  return (
    <div
      className="design-canvas-node__working-badge"
      data-generation-state={state}
      data-generation-kind={kind}
      data-generation-motion={motionActive ? "active" : "paused"}
      role="status"
    >
      <GenerationDotField key={generationSeed} compact generationSeed={generationSeed} motionActive={motionActive} />
      <span>{copy.title}</span>
    </div>
  );
}

interface GenerationParticleStyle extends CSSProperties {
  [property: `--generation-particle-${string}`]: string | number | undefined;
}

function stableGenerationUnit(seed: string, particleIndex: number, channel: string): number {
  const input = `${seed}\u001f${particleIndex}\u001f${channel}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4_294_967_296;
}

function stableGenerationRange(
  seed: string,
  particleIndex: number,
  channel: string,
  minimum: number,
  maximum: number,
): number {
  return minimum + stableGenerationUnit(seed, particleIndex, channel) * (maximum - minimum);
}

function rounded(value: number, precision = 2): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function generationParticleStyle(
  generationSeed: string,
  particleIndex: number,
  compact: boolean,
): GenerationParticleStyle {
  const seed = generationSeed || "generation-preview";
  const drift = compact ? 6 : 20;
  const duration = Math.round(stableGenerationRange(
    seed,
    particleIndex,
    "duration",
    compact ? 2_900 : 3_800,
    compact ? 5_100 : 7_200,
  ));
  const opacity = rounded(stableGenerationRange(
    seed,
    particleIndex,
    "opacity",
    compact ? 0.24 : 0.18,
    compact ? 0.62 : 0.58,
  ));
  const style: GenerationParticleStyle = {
    "--generation-particle-delay": `${-Math.round(duration * stableGenerationUnit(seed, particleIndex, "delay"))}ms`,
    "--generation-particle-duration": `${duration}ms`,
    "--generation-particle-origin-x": `${rounded(stableGenerationRange(seed, particleIndex, "origin-x", 6, 94), 1)}%`,
    "--generation-particle-origin-y": `${rounded(stableGenerationRange(seed, particleIndex, "origin-y", 7, 91), 1)}%`,
    "--generation-particle-size": `${rounded(
      stableGenerationRange(seed, particleIndex, "size", compact ? 1.4 : 1.8, compact ? 2.8 : 4.6),
      1,
    )}px`,
    "--generation-particle-opacity": opacity,
    "--generation-particle-opacity-low": rounded(opacity * 0.46),
    "--generation-particle-static-opacity": rounded(opacity * 0.55),
    "--generation-particle-scale": rounded(stableGenerationRange(seed, particleIndex, "scale", 0.88, 1.16)),
  };
  for (let waypoint = 1; waypoint <= 3; waypoint += 1) {
    style[`--generation-particle-x-${waypoint}`] = `${rounded(
      stableGenerationRange(seed, particleIndex, `x-${waypoint}`, -drift, drift),
      1,
    )}px`;
    style[`--generation-particle-y-${waypoint}`] = `${rounded(
      stableGenerationRange(seed, particleIndex, `y-${waypoint}`, -drift, drift),
      1,
    )}px`;
  }
  return style;
}

function GenerationDotField({
  compact = false,
  generationSeed,
  motionActive,
}: {
  compact?: boolean;
  generationSeed: string;
  motionActive: boolean;
}) {
  const particleCount = motionActive ? compact ? 7 : 14 : compact ? 3 : 4;
  return (
    <span
      className={compact ? "design-canvas-node__working-dots" : "design-canvas-node__generation-dots"}
      aria-hidden
    >
      <span className="design-canvas-node__generation-field" />
      <span className="design-canvas-node__generation-glow" />
      <span className="design-canvas-node__generation-particles">
        {Array.from({ length: particleCount }, (_, particleIndex) => (
          <span
            key={particleIndex}
            className="design-canvas-node__generation-particle"
            style={generationParticleStyle(generationSeed, particleIndex, compact)}
          />
        ))}
      </span>
    </span>
  );
}

function MaterialPreview({
  node,
  projectId,
  api,
  versionId,
  url,
  focusMotion,
  onAppendMaterialVersion,
  onContentAspectRatio,
}: {
  node: DesignNode;
  projectId: string;
  api: DesignCanvasApi;
  versionId: string;
  url: string;
  focusMotion: NodeFocusMotion | null;
  onAppendMaterialVersion?: (nodeId: string, file: File) => Promise<void>;
  onContentAspectRatio?: (nodeId: string, aspectRatio: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <NodePlaceholder
        icon="error"
        title="Preview unavailable"
        detail="The original file is preserved. Retry the preview or replace this revision from its Agent."
        action={<Button type="button" size="xs" variant="outline" onClick={() => setFailed(false)}>Retry preview</Button>}
      />
    );
  }
  if (node.kind === "image") {
    return (
      <img
        src={url}
        alt={node.name}
        width={Math.round(node.geometry.width)}
        height={Math.round(node.geometry.height)}
        draggable={false}
        loading="lazy"
        decoding="async"
        className="design-canvas-node__asset design-canvas-node__asset--image"
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            onContentAspectRatio?.(node.id, image.naturalWidth / image.naturalHeight);
          }
        }}
        onError={() => setFailed(true)}
      />
    );
  }
  if (node.kind === "video") {
    return (
      <DesignVideoPlayer
        node={node}
        url={url}
        focused={focusMotion?.role === "source"}
        onContentAspectRatio={onContentAspectRatio}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <TypedMaterialSurface
      node={node}
      projectId={projectId}
      api={api}
      versionId={versionId}
      url={url}
      focusMotion={focusMotion}
      onAppendMaterialVersion={onAppendMaterialVersion}
    />
  );
}

function formatVideoTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function DesignVideoPlayer({
  node,
  url,
  focused,
  onContentAspectRatio,
  onError,
}: {
  node: DesignNode;
  url: string;
  focused: boolean;
  onContentAspectRatio?: (nodeId: string, aspectRatio: number) => void;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0;

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, []);

  return (
    <div
      className="design-canvas-video-player nodrag nopan"
      data-playing={playing || undefined}
      data-focused={focused || undefined}
    >
      <video
        ref={videoRef}
        src={url}
        width={Math.round(node.geometry.width)}
        height={Math.round(node.geometry.height)}
        muted={muted}
        playsInline
        preload="metadata"
        className="design-canvas-node__asset design-canvas-node__asset--video"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onContentAspectRatio?.(node.id, video.videoWidth / video.videoHeight);
          }
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={onError}
      />
      <button
        type="button"
        className="design-canvas-video-player__center"
        aria-label={`Play ${node.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          togglePlayback();
        }}
      >
        <Play aria-hidden fill="currentColor" />
      </button>
      <div
        className="design-canvas-video-player__controls"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label={playing ? `Pause ${node.name}` : `Play ${node.name}`} onClick={togglePlayback}>
          <IconSwap active={playing} first={<Play />} second={<Pause />} />
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="any"
          value={Math.min(currentTime, duration || 0)}
          aria-label={`Seek ${node.name}`}
          style={{ "--design-video-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (!videoRef.current || !Number.isFinite(next)) return;
            videoRef.current.currentTime = next;
            setCurrentTime(next);
          }}
        />
        <span>{formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
        <button
          type="button"
          aria-label={muted ? `Unmute ${node.name}` : `Mute ${node.name}`}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            if (videoRef.current) videoRef.current.muted = next;
          }}
        >
          <IconSwap active={muted} first={<Volume2 />} second={<VolumeX />} />
        </button>
      </div>
    </div>
  );
}

function NodePlaceholder({
  icon,
  tone,
  title,
  detail,
  action,
}: {
  icon?: "sparkles" | "loading" | "paused" | "error";
  tone?: "empty";
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="design-canvas-node__placeholder" data-placeholder={icon ?? tone} data-tone={tone}>
      <div className="design-canvas-node__placeholder-atmosphere" aria-hidden />
      {icon ? (
        <span className="design-canvas-node__placeholder-icon" data-icon={icon}>
          {icon === "sparkles"
            ? <Sparkles aria-hidden />
            : icon === "paused"
              ? <Play aria-hidden />
              : icon === "error"
                ? <CircleAlert aria-hidden />
                : <LoaderCircle aria-hidden />}
        </span>
      ) : null}
      <div className="design-canvas-node__placeholder-copy">
        <p>{title}</p>
        <span>{detail}</span>
      </div>
      {action ? <div className="nodrag nopan design-canvas-node__placeholder-action">{action}</div> : null}
    </div>
  );
}
