import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, Component } from "lucide-react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";
import { ArtifactNodePreview } from "./ArtifactNodePreview.tsx";

export function ComponentNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const overview = data.zoomLevel === "overview";
  const full = data.zoomLevel === "full";
  const overviewStatus = data.generationState !== "idle"
    ? data.generationState
    : data.qualityState !== "unassessed"
      ? data.qualityState.replace("-", " ")
      : data.revisionId ? "published" : "draft";
  return (
    <div className="dezin-flow-card dezin-flow-component" data-selected={selected || undefined} data-zoom={data.zoomLevel}>
      <Handle id="component-target-left" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-target-right" type="target" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-target-top" type="target" position={Position.Top} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-target-bottom" type="target" position={Position.Bottom} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <ArtifactNodePreview
        artifactKind="component"
        projectId={data.projectId}
        artifactId={data.artifactId}
        name={data.name}
        revisionId={data.revisionId}
        zoomLevel={data.zoomLevel}
      />
      <div className="dezin-flow-card__body">
        <div className="dezin-flow-card__title-row">
          <span className="dezin-flow-card__title-mark" data-kind="component" aria-hidden>
            <Component size={11} strokeWidth={1.6} />
          </span>
          <h3 title={data.name}>{data.name}</h3>
          {full && <ArrowUpRight className="dezin-flow-card__open-mark" size={13} aria-hidden />}
        </div>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.incomingCount} {data.incomingCount === 1 ? "consumer" : "consumers"}</span>
            {full && <span>{data.revisionId ? `rev ${data.revisionId.slice(0, 7)}` : "unpublished"}</span>}
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
      <Handle id="component-source-left" type="source" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-source-right" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-source-top" type="source" position={Position.Top} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <Handle id="component-source-bottom" type="source" position={Position.Bottom} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--routing" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
