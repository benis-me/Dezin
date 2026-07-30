import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Images,
  LoaderCircle,
  Orbit,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ResourceNodeRevisionPreview,
  ResourceNodeRevisionPreviewStatus,
} from "../resource-node-preview.ts";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

function MoodboardCover({
  cover,
}: {
  cover: NonNullable<Extract<ResourceNodeRevisionPreview, { kind: "moodboard" }>["cover"]>;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const nextObjectUrl = URL.createObjectURL(cover.blob);
    setObjectUrl(nextObjectUrl);
    return () => {
      URL.revokeObjectURL(nextObjectUrl);
    };
  }, [cover.blob]);

  if (objectUrl !== null) {
    return (
      <img
        src={objectUrl}
        alt={cover.alt}
        width={cover.width ?? undefined}
        height={cover.height ?? undefined}
        decoding="async"
        draggable={false}
      />
    );
  }
  return <LoaderCircle className="animate-spin" size={16} aria-label="Loading Moodboard cover" />;
}

function ResourceVisualPreview({
  preview,
  status,
  name,
  onRetry,
}: {
  preview: ResourceNodeRevisionPreview | null | undefined;
  status: ResourceNodeRevisionPreviewStatus | null | undefined;
  name: string;
  onRetry?: () => void;
}) {
  if (status === "error") {
    return (
      <button
        type="button"
        className="nodrag nopan dezin-flow-resource__preview dezin-flow-resource__preview-empty dezin-flow-resource__preview-retry"
        aria-label={`Retry ${name} preview`}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRetry?.();
        }}
      >
        Preview unavailable
      </button>
    );
  }
  if (status === "loading" || status === "refreshing") {
    return (
      <div className="dezin-flow-resource__preview dezin-flow-resource__preview-empty" role="status">
        <LoaderCircle className="animate-spin" size={16} aria-hidden />
        {status === "refreshing" ? "Refreshing preview" : "Loading preview"}
      </div>
    );
  }
  if (preview?.kind === "moodboard") {
    return (
      <div
        className="dezin-flow-resource__preview dezin-flow-resource__preview--moodboard"
        role="group"
        aria-label={`${preview.boardName} Moodboard preview`}
      >
        {preview.cover ? (
          <MoodboardCover cover={preview.cover} />
        ) : (
          <span className="dezin-flow-resource__preview-empty">
            <Images size={16} aria-hidden />
            {preview.assetCount} assets
          </span>
        )}
      </div>
    );
  }
  if (preview?.kind === "research") {
    const directionCount = preview.evidenceDirectionCount + preview.hypothesisDirectionCount;
    return (
      <div
        className="dezin-flow-resource__preview dezin-flow-resource__preview--research"
        role="group"
        aria-label="Research decision brief preview"
      >
        <span>Decision brief</span>
        <p>{preview.executiveSummary}</p>
        <small>
          {preview.findingCount} {preview.findingCount === 1 ? "finding" : "findings"}
          {" · "}
          {directionCount} {directionCount === 1 ? "direction" : "directions"}
        </small>
      </div>
    );
  }
  return (
    <div className="dezin-flow-resource__glyph" aria-hidden>
      <Orbit size={17} strokeWidth={1.45} />
    </div>
  );
}

export function ResourceNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const overview = data.zoomLevel === "overview";
  const awaitingSelection = data.generationState === "awaiting-selection";
  const generationLabel = data.revisionId || data.generationState === "idle" || data.generationState === "awaiting-selection"
    ? null
    : data.generationState === "complete"
      ? "Finalizing revision"
      : data.generationState === "failed"
        ? "Generation failed"
        : data.generationState === "blocked"
          ? "Blocked by dependency"
          : data.generationState === "cancelled"
            ? "Generation cancelled"
            : data.generationState === "queued"
              ? "Queued for generation"
              : "Generating";
  const qualityLabel = data.resourceQualityState === "grounded"
    ? "Grounded"
    : data.resourceQualityState === "needs-review"
      ? "Needs review"
      : data.revisionId
        ? "Revision ready"
        : "Awaiting revision";
  const previewLabel = data.resourcePreviewStatus === "error"
    ? data.resourcePreview ? "Preview refresh failed" : "Preview unavailable"
    : data.resourcePreviewStatus === "refreshing"
      ? "Refreshing preview"
      : data.resourcePreviewStatus === "loading"
        ? "Loading preview"
        : null;
  const statusLabel = generationLabel
    ?? (awaitingSelection ? `${qualityLabel} · choose direction` : qualityLabel);
  const visibleStatusLabel = previewLabel ?? statusLabel;
  const resourceKind = data.resourcePreview?.kind ?? data.resourceKind;
  const resourceKindLabel = resourceKind === "research"
    ? "Research"
    : resourceKind === "moodboard"
      ? "Moodboard"
      : "Context resource";
  const ResourceKindIcon = resourceKind === "research"
    ? Orbit
    : resourceKind === "moodboard"
      ? Images
      : Orbit;
  return (
    <div
      className="dezin-flow-card dezin-flow-resource"
      data-selected={selected || undefined}
      data-zoom={data.zoomLevel}
      data-selection-emphasis={overview && selected ? "overview" : undefined}
      data-resource-quality={data.resourceQualityState ?? undefined}
      data-awaiting-selection={awaitingSelection || undefined}
      data-generation-state={data.generationState}
      data-resource-preview={data.resourcePreview?.kind ?? (data.resourcePreviewStatus ? "pending" : undefined)}
      title={data.generationMessage ?? (data.resourcePreviewStatus === "error" ? "Preview unavailable. Retry the exact Revision." : undefined)}
    >
      <Handle id="resource-target-left" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="resource-target-right" type="target" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <ResourceVisualPreview
        preview={data.resourcePreview}
        status={data.resourcePreviewStatus}
        name={data.name}
        onRetry={data.resourceId && data.onRetryResourcePreview
          ? () => data.onRetryResourcePreview?.(data.resourceId!)
          : undefined}
      />
      <div className="dezin-flow-resource__copy">
        <span className="dezin-flow-card__kind">
          <ResourceKindIcon size={10} />
          {resourceKindLabel}
        </span>
        <h3 title={data.name}>{data.name}</h3>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.incomingCount + data.outgoingCount} relations</span>
            <span data-state={data.resourceQualityState ?? data.generationState}>
              <span>{statusLabel}</span>
              {previewLabel ? <small data-state={data.resourcePreviewStatus}>{previewLabel}</small> : null}
            </span>
          </div>
        )}
        {overview && <span className="dezin-flow-card__overview-meta">{visibleStatusLabel}</span>}
      </div>
      <Handle id="resource-source-left" type="source" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="resource-source-right" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
