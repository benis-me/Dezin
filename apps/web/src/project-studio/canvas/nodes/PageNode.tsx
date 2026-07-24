import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, PanelTop } from "lucide-react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";
import { ArtifactNodePreview } from "./ArtifactNodePreview.tsx";

export function PageNode({ data, selected, isConnectable }: NodeProps<WorkspaceFlowNode>) {
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
      <Handle id="page-target-left" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-target-right" type="target" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-target-top" type="target" position={Position.Top} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-target-bottom" type="target" position={Position.Bottom} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <ArtifactNodePreview
        artifactKind="page"
        projectId={data.projectId}
        artifactId={data.artifactId}
        name={data.name}
        revisionId={data.revisionId}
        zoomLevel={data.zoomLevel}
      />
      <div className="dezin-flow-card__body">
        <div className="dezin-flow-card__title-row">
          <span className="dezin-flow-card__title-mark" data-kind="page" aria-hidden>
            <PanelTop size={11} strokeWidth={1.6} />
          </span>
          <h3 title={data.name}>{data.name}</h3>
          {full && <ArrowUpRight className="dezin-flow-card__open-mark" size={13} aria-hidden />}
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
        {overview && (
          <span
            className="dezin-flow-card__overview-status"
            aria-label={`${data.name} status: ${overviewStatus}`}
          >
            {overviewStatus}
          </span>
        )}
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
      <Handle id="page-source-right" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-source-left" type="source" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-source-top" type="source" position={Position.Top} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="page-source-bottom" type="source" position={Position.Bottom} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
