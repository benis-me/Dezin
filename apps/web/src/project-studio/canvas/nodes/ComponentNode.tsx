import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Component, FileImage, Pin } from "lucide-react";
import { useState } from "react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function ComponentNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const [loadedThumbnailUrl, setLoadedThumbnailUrl] = useState<string | null>(null);
  const thumbnailReady = Boolean(data.thumbnailUrl && loadedThumbnailUrl === data.thumbnailUrl);
  const overview = data.zoomLevel === "overview";
  const full = data.zoomLevel === "full";
  const overviewStatus = data.generationState !== "idle"
    ? data.generationState
    : data.qualityState !== "unassessed"
      ? data.qualityState.replace("-", " ")
      : data.revisionId ? "published" : "draft";
  return (
    <div className="dezin-flow-card dezin-flow-component" data-selected={selected || undefined} data-zoom={data.zoomLevel}>
      <Handle id="component-target" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <div className="dezin-flow-card__preview" aria-hidden>
        {data.thumbnailUrl && (
          <img
            src={data.thumbnailUrl}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            width={280}
            height={128}
            data-ready={thumbnailReady || undefined}
            onLoad={() => setLoadedThumbnailUrl(data.thumbnailUrl)}
            onError={() => setLoadedThumbnailUrl(null)}
          />
        )}
        {!thumbnailReady && (
          <div className="dezin-flow-card__placeholder">
            <FileImage size={18} strokeWidth={1.4} />
            {!overview && <span>{data.revisionId ? "Preview pending" : "No published revision"}</span>}
          </div>
        )}
        <span className="dezin-flow-card__kind"><Component size={11} /> Component</span>
      </div>
      <div className="dezin-flow-card__body">
        <div className="dezin-flow-card__title-row">
          <h3 title={data.name}>{data.name}</h3>
          {full && <Pin className="dezin-flow-card__open-mark" size={12} aria-hidden />}
        </div>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.incomingCount} {data.incomingCount === 1 ? "consumer" : "consumers"}</span>
            {full && <span>{data.revisionId ? `rev ${data.revisionId.slice(0, 7)}` : "unpublished"}</span>}
          </div>
        )}
        {overview && <span className="dezin-flow-card__overview-status">{overviewStatus}</span>}
      </div>
      <Handle id="component-source" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
