import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowRight, FileImage, PanelTop } from "lucide-react";
import { useState } from "react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function PageNode({ data, selected, isConnectable }: NodeProps<WorkspaceFlowNode>) {
  const [loadedThumbnailUrl, setLoadedThumbnailUrl] = useState<string | null>(null);
  const thumbnailReady = Boolean(data.thumbnailUrl && loadedThumbnailUrl === data.thumbnailUrl);
  const overview = data.zoomLevel === "overview";
  const full = data.zoomLevel === "full";
  const overviewStatus = data.generationState !== "idle"
    ? data.generationState
    : data.qualityState !== "unassessed"
      ? data.qualityState.replace("-", " ")
      : data.revisionId ? "published" : "draft";
  const handlesActive = full && isConnectable;
  const activateHandle = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.click();
  };
  return (
    <div
      className="dezin-flow-card dezin-flow-page"
      data-selected={selected || undefined}
      data-zoom={data.zoomLevel}
    >
      <Handle
        id="page-target"
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        className="dezin-flow-handle"
        role="button"
        tabIndex={handlesActive ? 0 : -1}
        aria-hidden={!handlesActive}
        aria-label={`Connect into ${data.name}`}
        style={{ visibility: handlesActive ? "visible" : "hidden" }}
        onKeyDown={activateHandle}
      />
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
        <span className="dezin-flow-card__kind"><PanelTop size={11} /> Page</span>
      </div>
      <div className="dezin-flow-card__body">
        <div className="dezin-flow-card__title-row">
          <h3 title={data.name}>{data.name}</h3>
          {full && <ArrowRight className="dezin-flow-card__open-mark" size={13} aria-hidden />}
        </div>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.revisionId ? `rev ${data.revisionId.slice(0, 7)}` : "draft shell"}</span>
            {full && (
              <span data-quality={data.qualityState}>
                {data.qualityScore === null ? data.qualityState.replace("-", " ") : `${data.qualityScore} quality`}
              </span>
            )}
          </div>
        )}
        {overview && <span className="dezin-flow-card__overview-status">{overviewStatus}</span>}
      </div>
      <Handle
        id="page-source"
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className="dezin-flow-handle"
        role="button"
        tabIndex={handlesActive ? 0 : -1}
        aria-hidden={!handlesActive}
        aria-label={`Connect from ${data.name}`}
        style={{ visibility: handlesActive ? "visible" : "hidden" }}
        onKeyDown={activateHandle}
      />
    </div>
  );
}
