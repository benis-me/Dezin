import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  BookOpenText,
  CircleCheck,
  ImageOff,
  Images,
  Link2,
  LoaderCircle,
  Orbit,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useApi } from "../../../lib/api-context.tsx";
import type { ResourceNodeRevisionPreview } from "../resource-node-preview.ts";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

type CoverLoadState =
  | { status: "loading" }
  | { status: "ready"; objectUrl: string }
  | { status: "error" };

function MoodboardCover({
  cover,
}: {
  cover: NonNullable<Extract<ResourceNodeRevisionPreview, { kind: "moodboard" }>["cover"]>;
}) {
  const api = useApi();
  const [state, setState] = useState<CoverLoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void api.getResourceRevisionBlob(cover.path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        return;
      }
      setState({ status: "ready", objectUrl });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, cover.path]);

  if (state.status === "ready") {
    return (
      <img
        src={state.objectUrl}
        alt={cover.alt}
        width={cover.width ?? undefined}
        height={cover.height ?? undefined}
        decoding="async"
        draggable={false}
      />
    );
  }
  return state.status === "loading"
    ? <LoaderCircle className="animate-spin" size={16} aria-label="Loading Moodboard cover" />
    : <ImageOff size={16} aria-label="Moodboard cover unavailable" />;
}

function ResourceVisualPreview({
  preview,
}: {
  preview: ResourceNodeRevisionPreview | null | undefined;
}) {
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
      <BookOpenText size={17} strokeWidth={1.45} />
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
  const statusLabel = generationLabel ?? (awaitingSelection ? `${qualityLabel} · choose direction` : qualityLabel);
  const resourceKindLabel = data.resourcePreview?.kind === "research"
    ? "Research"
    : data.resourcePreview?.kind === "moodboard"
      ? "Moodboard"
      : "Context resource";
  const ResourceKindIcon = data.resourcePreview?.kind === "research"
    ? BookOpenText
    : data.resourcePreview?.kind === "moodboard"
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
      data-resource-preview={data.resourcePreview?.kind}
      title={data.generationMessage ?? undefined}
    >
      <Handle id="resource-target-left" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="resource-target-right" type="target" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <ResourceVisualPreview preview={data.resourcePreview} />
      <div className="dezin-flow-resource__copy">
        <span className="dezin-flow-card__kind">
          <ResourceKindIcon size={10} />
          {resourceKindLabel}
        </span>
        <h3 title={data.name}>{data.name}</h3>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.incomingCount + data.outgoingCount} relations</span>
            <span>
              {data.resourceQualityState === "grounded"
                ? <CircleCheck size={10} aria-hidden />
                : data.resourceQualityState === "needs-review"
                  ? <TriangleAlert size={10} aria-hidden />
                  : null}
              {statusLabel}
            </span>
            <span className="dezin-flow-resource__id"><Link2 size={10} /> {data.resourceId}</span>
          </div>
        )}
        {overview && <span className="dezin-flow-card__overview-meta">{statusLabel}</span>}
      </div>
      <Handle id="resource-source-left" type="source" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="resource-source-right" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
