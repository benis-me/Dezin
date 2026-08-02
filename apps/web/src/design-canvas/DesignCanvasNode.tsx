import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  Braces,
  Component,
  File,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  Library,
  MessageSquareText,
  MousePointer2,
  Palette,
  Play,
  Search,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { Button } from "../components/ui/Button.tsx";
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
  onGenerate: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
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
  empty: "Awaiting generation",
  queued: "Queued",
  generating: "Generating",
  validating: "Validating",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

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
  return (
    <span className="design-canvas-node__state" data-state={state}>
      <span aria-hidden className="design-canvas-node__state-dot" />
      {STATE_LABELS[state]}
    </span>
  );
}

export function DesignCanvasNode({ data, selected }: NodeProps<DesignFlowNode>) {
  const { node, projectId, api, onGenerate, onDelete, onResize } = data;
  const [interacting, setInteracting] = useState(false);
  const { ref, nearViewport } = useNearViewport(selected);
  const material = isMaterialNodeKind(node.kind);
  const shouldMountRichPreview = nearViewport || selected || interacting;
  const { preview, versionId, loading, error: previewError } = useExactVersionPreview({
    api,
    projectId,
    node,
    enabled: !material && shouldMountRichPreview,
  });
  const Icon = KIND_ICONS[node.kind];
  const catalog = catalogItem(node.kind);
  const assetUrl = material && node.assetId ? api.getAssetPreviewUrl(projectId, node.assetId) : null;
  const hasRichContent = (!material && versionId !== null) || (material && assetUrl !== null);

  useEffect(() => {
    if (!selected) setInteracting(false);
  }, [selected]);
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
        interacting && "design-canvas-node--interacting nodrag nopan",
      )}
      style={{ width: "100%", height: "100%" }}
    >
      <NodeResizer
        isVisible={selected && !interacting}
        minWidth={260}
        minHeight={180}
        color="var(--ring)"
        onResizeEnd={(_event, params) => onResize(node.id, {
          x: params.x,
          y: params.y,
          width: params.width,
          height: params.height,
        })}
      />
      <header className="design-canvas-node__header">
        <div className="design-canvas-node__identity">
          <Icon aria-hidden className="size-3.5" />
          <span className="design-canvas-node__kind">{catalog.label}</span>
          <span className="design-canvas-node__name">{node.name}</span>
        </div>
        <div className="nodrag nopan flex shrink-0 items-center gap-1.5">
          {node.versionCount > 0 ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">v{node.versionCount}</span>
          ) : null}
          <NodeState state={node.state} />
          {hasRichContent && selected ? (
            <Button
              type="button"
              variant={interacting ? "secondary" : "ghost"}
              size="icon-xs"
              aria-label={interacting ? "Exit preview interaction" : "Interact with preview"}
              title={interacting ? "Exit preview interaction (Esc)" : "Interact with preview"}
              onClick={() => setInteracting((current) => !current)}
            >
              {interacting ? <X aria-hidden /> : <MousePointer2 aria-hidden />}
            </Button>
          ) : null}
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${node.name}`}
              onClick={() => onDelete(node.id)}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      <div className="design-canvas-node__body">
        {material ? (
          <MaterialPreview node={node} url={assetUrl} interactive={interacting} />
        ) : versionId ? (
          shouldMountRichPreview ? (
            preview ? (
              <iframe
                className="design-canvas-node__iframe nodrag nopan"
                title={`${node.name} · version ${versionId}`}
                src={previewDocumentSrc(preview.url)}
                sandbox="allow-scripts"
                tabIndex={interacting ? 0 : -1}
              />
            ) : (
              <NodePlaceholder
                icon={loading ? "loading" : "error"}
                title={loading ? "Loading exact revision" : "Preview unavailable"}
                detail={previewError ?? `Version ${versionId}`}
              />
            )
          ) : (
            <NodePlaceholder icon="paused" title="Preview paused off-screen" detail={`Version ${node.versionCount}`} />
          )
        ) : (
          <NodePlaceholder
            icon="sparkles"
            title="Ready for generation"
            detail={`This ${catalog.label.toLowerCase()} is empty. Its Agent can read the whole canvas.`}
            action={<Button size="sm" variant="outline" onClick={() => onGenerate(node.id)}><Sparkles aria-hidden />Generate with Agent</Button>}
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

        {(node.state === "failed" || node.state === "cancelled" || node.state === "superseded") && hasRichContent ? (
          <div className="design-canvas-node__failure" role="status">
            <span>{node.error ?? `${STATE_LABELS[node.state]} — showing the last ready version.`}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MaterialPreview({ node, url, interactive }: { node: DesignNode; url: string | null; interactive: boolean }) {
  if (!url) return <NodePlaceholder icon="error" title="Asset unavailable" detail="The material identity has no preview URL." />;
  if (node.kind === "image") {
    return <img src={url} alt={node.name} draggable={false} loading="lazy" decoding="async" className="design-canvas-node__asset" />;
  }
  if (node.kind === "video") {
    return <video src={url} controls={interactive} muted preload="metadata" className="design-canvas-node__asset nodrag nopan" />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <FileText aria-hidden className="size-8 text-muted-foreground/60" />
      <div>
        <p className="text-xs font-medium text-foreground">{node.name}</p>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Available to every Agent as project context.</p>
      </div>
      <a className="nodrag nopan text-[11px] font-medium text-foreground underline underline-offset-4" href={url} target="_blank" rel="noreferrer">Open file</a>
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
    <div className="design-canvas-node__placeholder">
      <span className="design-canvas-node__placeholder-icon" data-icon={icon}>
        {icon === "sparkles" ? <Sparkles aria-hidden /> : icon === "paused" ? <Play aria-hidden /> : icon === "error" ? <MessageSquareText aria-hidden /> : <span aria-hidden className="design-canvas-node__loader" />}
      </span>
      <div className="max-w-[260px] text-center">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </div>
      {action ? <div className="nodrag nopan mt-1">{action}</div> : null}
    </div>
  );
}
