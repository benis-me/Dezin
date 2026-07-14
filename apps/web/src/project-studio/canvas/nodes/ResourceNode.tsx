import { Handle, Position, type NodeProps } from "@xyflow/react";
import { BookOpenText, Link2, Orbit } from "lucide-react";
import type { WorkspaceFlowNode } from "../workspace-graph-adapter.ts";

export function ResourceNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const overview = data.zoomLevel === "overview";
  return (
    <div className="dezin-flow-card dezin-flow-resource" data-selected={selected || undefined} data-zoom={data.zoomLevel}>
      <Handle id="resource-target" type="target" position={Position.Left} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
      <div className="dezin-flow-resource__glyph" aria-hidden><BookOpenText size={17} strokeWidth={1.45} /></div>
      <div className="dezin-flow-resource__copy">
        <span className="dezin-flow-card__kind"><Orbit size={10} /> Context resource</span>
        <h3 title={data.name}>{data.name}</h3>
        {!overview && (
          <div className="dezin-flow-card__meta">
            <span>{data.incomingCount + data.outgoingCount} relations</span>
            <span className="dezin-flow-resource__id"><Link2 size={10} /> {data.resourceId}</span>
          </div>
        )}
        {overview && <span className="dezin-flow-card__overview-status">context ready</span>}
      </div>
      <Handle id="resource-source" type="source" position={Position.Right} isConnectable={false} className="dezin-flow-handle dezin-flow-handle--relation" aria-hidden tabIndex={-1} style={{ visibility: "hidden" }} />
    </div>
  );
}
