import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight } from "lucide-react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";
import { ArtifactNodePreview } from "./ArtifactNodePreview.tsx";

type ArtifactNodeKind = "page" | "component";

function displayState(data: WorkspaceFlowNode["data"]): string {
  if (data.revisionId && (data.generationState === "idle" || data.generationState === "complete")) {
    return "Published";
  }
  if (data.generationState !== "idle") {
    if (data.generationState === "awaiting-selection") return "Choose direction";
    if (data.generationState === "complete") return "Finalizing";
    return data.generationState.replace("-", " ");
  }
  return "Not generated";
}

function overviewState(data: WorkspaceFlowNode["data"]): string {
  if (data.generationState !== "idle") return displayState(data);
  if (data.qualityState !== "unassessed") return data.qualityState.replace("-", " ");
  return data.revisionId ? "Published" : "Draft";
}

export function ArtifactFlowNode({
  data,
  selected,
  isConnectable,
}: NodeProps<WorkspaceFlowNode>) {
  const kind: ArtifactNodeKind = data.kind === "component" ? "component" : "page";
  const page = kind === "page";
  const overview = data.zoomLevel === "overview";
  const full = data.zoomLevel === "full";
  const state = displayState(data);
  const handlesActive = page && full && isConnectable;
  const activateHandle = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.click();
  };
  const routingHandle = (type: "source" | "target", side: "left" | "right") => (
    <Handle
      id={`${kind}-${type}-${side}`}
      type={type}
      position={side === "left" ? Position.Left : Position.Right}
      isConnectable={false}
      className="dezin-flow-handle dezin-flow-handle--routing"
      aria-hidden
      tabIndex={-1}
      style={{ visibility: "hidden" }}
    />
  );

  return (
    <div
      className={`dezin-flow-card dezin-flow-artifact dezin-flow-${kind}`}
      data-kind={kind}
      data-selected={selected || undefined}
      data-zoom={data.zoomLevel}
      data-generation-state={data.generationState}
      data-quality-state={data.qualityState}
      data-selection-emphasis={overview && selected ? "overview" : undefined}
    >
      {page ? (
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
      ) : null}
      {routingHandle("target", "left")}
      {routingHandle("target", "right")}
      <ArtifactNodePreview
        artifactKind={kind}
        projectId={data.projectId}
        artifactId={data.artifactId}
        name={data.name}
        revisionId={data.revisionId}
        zoomLevel={data.zoomLevel}
        generationState={data.generationState}
        generationMessage={data.generationMessage}
      />
      <div className="dezin-flow-card__body">
        <div className="dezin-flow-card__title-row">
          <span className="dezin-flow-card__type" data-kind={kind}>
            {page ? "Page" : "Component"}
          </span>
          <h3 title={data.name} aria-label={data.name}>
            {overview && page && data.overviewDirection ? (
              <>
                <span className="dezin-flow-card__overview-direction">{data.overviewDirection}</span>
                <span className="dezin-flow-card__overview-role">{data.overviewPageRole ?? data.name}</span>
              </>
            ) : data.name}
          </h3>
          {full ? <ArrowUpRight className="dezin-flow-card__open-mark" size={13} aria-hidden /> : null}
        </div>
        {!overview ? (
          <div className="dezin-flow-card__meta">
            <span>
              {page
                ? state
                : `Used in ${data.incomingCount} ${data.incomingCount === 1 ? "page" : "pages"}`}
            </span>
            <span
              data-state={page ? data.qualityState : data.generationState}
              title={data.generationMessage ?? undefined}
            >
              {page
                ? data.qualityScore === null
                  ? data.qualityState.replace("-", " ")
                  : `${data.qualityScore} quality`
                : state}
            </span>
          </div>
        ) : (
          <span
            className="dezin-flow-card__overview-meta"
            aria-label={`${data.name} status: ${overviewState(data)}`}
          >
            {overviewState(data)}
          </span>
        )}
      </div>
      {page ? (
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
      ) : null}
      {routingHandle("source", "right")}
      {routingHandle("source", "left")}
    </div>
  );
}
