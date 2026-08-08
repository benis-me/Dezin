import { NodeResizeControl, useViewport, type ControlPosition, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  Braces,
  CircleAlert,
  Component,
  File,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  Library,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Palette,
  Play,
  Search,
  Sparkles,
  Video,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { Button } from "../components/ui/Button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { previewDocumentSrc } from "../lib/preview-channel.ts";
import { cn } from "../lib/utils.ts";
import type { DesignCanvasApi } from "./api.ts";
import { catalogItem, isMaterialNodeKind } from "./catalog.ts";
import type { DesignNode, DesignNodeKind } from "./types.ts";
import { useExactVersionPreview } from "./useExactVersionPreview.ts";

export interface DesignFlowNodeData extends Record<string, unknown> {
  node: DesignNode;
  projectId: string;
  api: DesignCanvasApi;
  onResize: (nodeId: string, geometry: DesignNode["geometry"]) => void;
}

export type DesignFlowNode = Node<DesignFlowNodeData, "design">;

const KIND_ICONS: Record<DesignNodeKind, ComponentType<{ className?: string }>> = {
  component: Component,
  page: LayoutTemplate,
  "design-system": Palette,
  research: Search,
  "design-tokens": Braces,
  "design-document": FileText,
  layout: Box,
  knowledge: Library,
  image: ImageIcon,
  video: Video,
  document: FileText,
  file: File,
};

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

function NodeState({ state }: { state: DesignNode["state"] }) {
  const label = STATE_LABELS[state];
  return (
    <span className="design-canvas-node__state" data-state={state} aria-label={label} title={label}>
      <span aria-hidden className="design-canvas-node__state-mark" />
    </span>
  );
}

function NodeCornerResizeControls({
  node,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  node: DesignNode;
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
      className="design-canvas-node__resize-control"
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

export function DesignCanvasNode({ data, selected }: NodeProps<DesignFlowNode>) {
  const { node, projectId, api, onResize } = data;
  const [interacting, setInteracting] = useState(false);
  const [resizing, setResizing] = useState(false);
  const { zoom } = useViewport();
  const chromeScale = 1 / Math.max(0.12, zoom);
  const { ref, nearViewport } = useNearViewport(selected);
  const material = isMaterialNodeKind(node.kind);
  const shouldMountRichPreview = nearViewport || selected || interacting;
  const { preview, versionId, loading, error: previewError } = useExactVersionPreview({
    api,
    projectId,
    node,
    enabled: shouldMountRichPreview,
  });
  const Icon = KIND_ICONS[node.kind];
  const catalog = catalogItem(node.kind);
  const hasRichContent = versionId !== null;
  const live = LIVE_STATES.has(node.state);
  const previousVersionIdRef = useRef(versionId);

  useEffect(() => {
    if (!selected) {
      setInteracting(false);
      setResizing(false);
    }
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
  useEffect(() => {
    if (!interacting) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInteracting(false);
    };
    window.addEventListener("keydown", exit, true);
    return () => window.removeEventListener("keydown", exit, true);
  }, [interacting]);

  return (
    <div
      ref={ref}
      data-design-node-id={node.id}
      data-node-kind={node.kind}
      data-node-state={node.state}
      className={cn(
        "design-canvas-node",
        selected && "design-canvas-node--selected",
        resizing && "design-canvas-node--resizing",
        interacting && "design-canvas-node--interacting nodrag nopan",
      )}
      style={{ width: "100%", height: "100%" }}
    >
      {selected && !interacting ? (
        <NodeCornerResizeControls
          node={node}
          onResize={onResize}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      ) : null}

      <div
        className="design-canvas-node__chrome"
        style={{
          height: `${24 * chromeScale}px`,
          bottom: `calc(100% + ${3 * chromeScale}px)`,
        }}
      >
        <div
          className="design-canvas-node__identity"
          style={{ transform: `scale(${chromeScale})` }}
        >
          <span className="design-canvas-node__kind-icon"><Icon aria-hidden /></span>
          <strong className="design-canvas-node__name">{node.name}</strong>
        </div>
        <span
          className="design-canvas-node__state-anchor"
          style={{ transform: `scale(${chromeScale})` }}
        >
          <NodeState state={node.state} />
        </span>
      </div>

      {selected && hasRichContent && (!material || node.kind === "video") ? (
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
                  variant={interacting ? "secondary" : "ghost"}
                  size="icon-xs"
                  aria-label={interacting ? "Exit preview interaction" : "Interact with preview"}
                  aria-pressed={interacting}
                  onClick={() => setInteracting((current) => !current)}
                >
                  <MousePointer2 aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={5}>
                {interacting ? "Exit interaction (Esc)" : "Interact with preview"}
              </TooltipContent>
            </Tooltip>
            {!material ? (
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
            ) : null}
          </div>
        </TooltipProvider>
      ) : null}

      <div className="design-canvas-node__frame">
        <div className="design-canvas-node__body">
          {versionId ? (
            shouldMountRichPreview ? (
              preview ? (
                material ? (
                  <MaterialPreview key={preview.url} node={node} url={preview.url} interactive={interacting} />
                ) : (
                  <iframe
                    className="design-canvas-node__iframe nodrag nopan"
                    title={`${node.name}, version ${versionId}`}
                    src={previewDocumentSrc(preview.url)}
                    sandbox="allow-scripts"
                    tabIndex={interacting ? 0 : -1}
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
              icon="sparkles"
              title={`Create this ${catalog.label.toLocaleLowerCase()}`}
              detail="Select this Node and describe the result in its Agent."
            />
          )}

          {hasRichContent && !interacting ? (
            <button
              type="button"
              className="design-canvas-node__gesture-shield nodrag nopan"
              aria-label={`Select ${node.name}; double click to interact with preview`}
              onDoubleClick={() => setInteracting(true)}
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
  title,
  detail,
  action,
}: {
  icon: "sparkles" | "loading" | "paused" | "error";
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="design-canvas-node__placeholder" data-placeholder={icon}>
      <div className="design-canvas-node__placeholder-atmosphere" aria-hidden />
      <span className="design-canvas-node__placeholder-icon" data-icon={icon}>
        {icon === "sparkles"
          ? <Sparkles aria-hidden />
          : icon === "paused"
            ? <Play aria-hidden />
            : icon === "error"
              ? <CircleAlert aria-hidden />
              : <LoaderCircle aria-hidden />}
      </span>
      <div className="design-canvas-node__placeholder-copy">
        <p>{title}</p>
        <span>{detail}</span>
      </div>
      {action ? <div className="nodrag nopan design-canvas-node__placeholder-action">{action}</div> : null}
    </div>
  );
}
