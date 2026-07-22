import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BookOpenText, CircleCheck, Link2, Orbit, TriangleAlert } from "lucide-react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function ResourceNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const overview = data.zoomLevel === "overview";
  const awaitingSelection = data.generationState === "awaiting-selection";
  const qualityLabel = data.resourceQualityState === "grounded"
    ? "Grounded"
    : data.resourceQualityState === "needs-review"
      ? "Needs review"
      : data.revisionId
        ? "Revision ready"
        : "Awaiting revision";
  const statusLabel = awaitingSelection ? `${qualityLabel} · choose direction` : qualityLabel;
  return (
    <div
      className="dezin-flow-card dezin-flow-resource"
      data-selected={selected || undefined}
      data-zoom={data.zoomLevel}
      data-resource-quality={data.resourceQualityState ?? undefined}
      data-awaiting-selection={awaitingSelection || undefined}
    >
      <Handle id="resource-target" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <div className="dezin-flow-resource__glyph" aria-hidden><BookOpenText size={17} strokeWidth={1.45} /></div>
      <div className="dezin-flow-resource__copy">
        <span className="dezin-flow-card__kind"><Orbit size={10} /> Context resource</span>
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
        {overview && <span className="dezin-flow-card__overview-status">{statusLabel}</span>}
      </div>
      <Handle id="resource-source" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
