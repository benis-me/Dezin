import { NodeResizeControl, useViewport, type ControlPosition, type Node, type NodeProps } from "@xyflow/react";
import {
  CircleAlert,
  FileText,
  LoaderCircle,
  Maximize2,
  Play,
  Sparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { Button } from "../components/ui/Button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip.tsx";
import {
  embeddedPreviewDocumentSrc,
  previewDocumentSrc,
  useEmbeddedPreviewContextMenuChannel,
} from "../lib/preview-channel.ts";
import { cn } from "../lib/utils.ts";
import type { DesignCanvasApi } from "./api.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import { nodeFocusEase, type NodeFocusMotion } from "./node-focus-motion.ts";
import type { DesignNode, DesignNodeKind } from "./types.ts";
import { useExactVersionPreview } from "./useExactVersionPreview.ts";

export interface DesignFlowNodeData extends Record<string, unknown> {
  node: DesignNode;
  projectId: string;
  api: DesignCanvasApi;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
  onPreviewContextMenu?: (nodeId: string, clientX: number, clientY: number) => void;
  onFocusAnimationStart?: (nodeId: string, phase: NodeFocusMotion["phase"], durationMs: number) => void;
  onFocusAnimationComplete?: (nodeId: string, phase: NodeFocusMotion["phase"]) => void;
  focusMotion?: NodeFocusMotion | null;
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

function readFocusVisualState(element: HTMLElement): FocusVisualState {
  const computed = getComputedStyle(element);
  const opacity = Number.parseFloat(computed.opacity);
  return focusVisualStateFromTransform(computed.transform, Number.isFinite(opacity) ? opacity : 1);
}

function focusVisualFrames(
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

function previewFrameAddress(url: string, embedded: boolean): { src: string; instrumented: boolean } {
  if (!embedded) return { src: previewDocumentSrc(url), instrumented: false };
  try {
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

const RESIZE_CORNERS: readonly ControlPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

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

function NodeCornerResizeControls({
  node,
  interactive,
  lockAspectRatio,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  node: DesignNode;
  interactive: boolean;
  lockAspectRatio: boolean;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  return RESIZE_CORNERS.map((position) => (
    <NodeResizeControl
      key={position}
      position={position}
      minWidth={280}
      minHeight={200}
      keepAspectRatio={lockAspectRatio}
      shouldResize={() => interactive}
      className={cn(
        "design-canvas-node__resize-control",
        interactive
          ? "design-canvas-node__resize-control--interactive"
          : "design-canvas-node__resize-control--affordance",
      )}
      style={{ pointerEvents: interactive ? "auto" : "none" }}
      onResizeStart={onResizeStart}
      onResizeEnd={(_event, params) => {
        onResizeEnd();
        onResize(node.id, {
          x: params.x,
          y: params.y,
          width: params.width,
          height: params.height,
        });
      }}
    >
      <span aria-hidden className="design-canvas-node__resize-corner" />
    </NodeResizeControl>
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
    onPreviewContextMenu,
    onFocusAnimationStart,
    onFocusAnimationComplete,
    focusMotion = null,
  } = data;
  const [resizing, setResizing] = useState(false);
  const { zoom } = useViewport();
  const chromeScale = 1 / Math.max(0.12, zoom);
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
  const catalog = catalogItem(node.kind);
  const hasRichContent = versionId !== null;
  const live = LIVE_STATES.has(node.state);
  const previewFrameAddressValue = preview && !material
    ? previewFrameAddress(preview.url, focusSource)
    : null;
  useEmbeddedPreviewContextMenuChannel({
    iframeRef,
    previewSrc: focusSource ? previewFrameAddressValue?.src ?? null : null,
    enabled: focusSource && previewFrameAddressValue?.instrumented === true && onPreviewContextMenu !== undefined,
    onContextMenu: (message) => {
      const iframe = iframeRef.current;
      if (!focusSource || !onPreviewContextMenu || !iframe) return;
      const bounds = iframe.getBoundingClientRect();
      const scaleX = bounds.width / Math.max(1, iframe.clientWidth);
      const scaleY = bounds.height / Math.max(1, iframe.clientHeight);
      onPreviewContextMenu(
        node.id,
        bounds.left + Math.max(0, Math.min(bounds.width, message.clientX * scaleX)),
        bounds.top + Math.max(0, Math.min(bounds.height, message.clientY * scaleY)),
      );
    },
  });
  const previousVersionIdRef = useRef(versionId);
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
      focusMotion.layoutWidth,
      focusMotion.layoutHeight,
      focusMotion.role,
    ].join(":");
    if (running?.target === focusMotion.phase && running.pathKey === pathKey) return;

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
    const start = running
      ? readFocusVisualState(element)
      : focusMotion.phase === "opening"
        ? canvasTarget
        : focusedTarget;
    const end = focusMotion.phase === "opening" ? focusedTarget : canvasTarget;
    running?.animation.cancel();
    if (focusMotion.durationMs <= 0 || typeof element.animate !== "function") {
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
    focusAnimationRef.current = { animation, target: focusMotion.phase, pathKey };
    if (focusMotion.role === "source") {
      onFocusAnimationStart?.(node.id, focusMotion.phase, durationMs);
      void animation.finished.then(() => {
        if (focusAnimationRef.current?.animation !== animation) return;
        onFocusAnimationComplete?.(node.id, focusMotion.phase);
      }).catch(() => undefined);
    }
  }, [focusMotion, node.id, onFocusAnimationComplete, onFocusAnimationStart, ref]);

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
        width: focusSource && focusMotion.layoutWidth ? focusMotion.layoutWidth : "100%",
        height: focusSource && focusMotion.layoutHeight ? focusMotion.layoutHeight : "100%",
        ...focusStyle,
      }}
    >
      <NodeCornerResizeControls
        node={node}
        interactive={selected && focusMotion === null}
        lockAspectRatio={catalog.lockAspectRatio === true}
        onResize={onResize}
        onResizeStart={() => setResizing(true)}
        onResizeEnd={() => setResizing(false)}
      />

      {selected && hasRichContent && !material && !focusInteractive ? (
        <TooltipProvider delayDuration={180}>
          <div
            className="nodrag nopan design-canvas-node__toolbar"
            role="toolbar"
            aria-label={`${node.name} preview controls`}
            style={{
              top: `calc(100% + ${7 * chromeScale}px)`,
              transform: `translateX(-50%) scale(${chromeScale})`,
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Fit Node preview"
                  onClick={() => onResize(node.id, preferredGeneratedNodeGeometry(node))}
                >
                  <Maximize2 aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={5}>Fit Node preview</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ) : null}

      <div className="design-canvas-node__frame">
        <div className="design-canvas-node__body">
          {versionId ? (
            shouldMountRichPreview ? (
              preview ? (
                material ? (
                  <MaterialPreview key={preview.url} node={node} url={preview.url} interactive={focusInteractive} />
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
            <NodeWorkingPlaceholder state={node.state} label={catalog.label} />
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

          {hasRichContent && !focusInteractive ? (
            <button
              type="button"
              className="design-canvas-node__gesture-shield nopan"
              aria-label={`Select ${node.name}; double click to focus and interact`}
            />
          ) : null}

          {live && hasRichContent ? (
            <div className="design-canvas-node__working-badge" role="status">
              <LoaderCircle aria-hidden />
              <span>{node.state === "validating" ? "Preparing the next preview" : "Creating the next version"}</span>
            </div>
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

function NodeWorkingPlaceholder({ state, label }: { state: DesignNode["state"]; label: string }) {
  const title = state === "queued"
    ? "Waiting to begin"
    : state === "validating"
      ? "Preparing the preview"
      : `Creating ${articleFor(label)} ${label.toLocaleLowerCase()}`;
  const detail = state === "queued"
    ? "This Node is next in the Agent queue."
    : state === "validating"
      ? "Checking the single-file result before it becomes a version."
      : "The Agent is composing a new single-file design from the canvas context.";
  return <NodePlaceholder icon="loading" title={title} detail={detail} />;
}

function articleFor(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

function MaterialPreview({ node, url, interactive }: { node: DesignNode; url: string; interactive: boolean }) {
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
        onError={() => setFailed(true)}
      />
    );
  }
  if (node.kind === "video") {
    return (
      <video
        src={url}
        width={Math.round(node.geometry.width)}
        height={Math.round(node.geometry.height)}
        controls={interactive}
        muted
        preload="metadata"
        className="design-canvas-node__asset design-canvas-node__asset--video nodrag nopan"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="design-canvas-node__file-preview">
      <span className="design-canvas-node__file-icon"><FileText aria-hidden /></span>
      <div>
        <p>{node.name}</p>
        <span>Available as exact context to every Agent on this canvas.</span>
      </div>
      <a className="nodrag nopan" href={url} target="_blank" rel="noreferrer">Open file</a>
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
