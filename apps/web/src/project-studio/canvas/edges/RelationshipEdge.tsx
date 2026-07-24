import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import { useState } from "react";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { workspaceEdgeLaneExpansion } from "./edge-lane-geometry.ts";

interface RelationshipEdgeGeometryInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Parameters<typeof getSmoothStepPath>[0]["sourcePosition"];
  targetPosition?: Parameters<typeof getSmoothStepPath>[0]["targetPosition"];
  lane?: number;
}

export function relationshipEdgeGeometry(
  input: RelationshipEdgeGeometryInput,
): { path: string; labelX: number; labelY: number } {
  const { lane, ...pathInput } = input;
  const [path, labelX, labelY] = getSmoothStepPath({
    ...pathInput,
    borderRadius: 18,
    offset: 30 + workspaceEdgeLaneExpansion(lane) * 18,
  });
  return { path, labelX, labelY };
}

export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<WorkspaceFlowEdge>) {
  const [hovered, setHovered] = useState(false);
  const { path, labelX, labelY } = relationshipEdgeGeometry({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    lane: data?.lane,
  });
  const supportingRelation = data?.kind === "informs" || data?.kind === "derives-from";
  const foreground = selected || hovered ? "var(--foreground)" : "var(--foreground-2)";
  const showLabel = data?.zoomLevel === "full" || selected || hovered;
  return (
    <>
      <g
        className="dezin-flow-edge__interaction-layer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <BaseEdge
          id={`${id}-halo`}
          path={path}
          interactionWidth={0}
          className="dezin-flow-edge__halo"
          style={{
            stroke: "var(--background)",
            strokeWidth: selected || hovered ? 3.6 : 3,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            opacity: 0.72,
            pointerEvents: "none",
          }}
        />
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          interactionWidth={24}
          className="dezin-flow-edge__path"
          style={{
            stroke: foreground,
            strokeWidth: selected || hovered ? 1.7 : 1.2,
            strokeDasharray: supportingRelation ? "3 6" : undefined,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            opacity: selected || hovered ? 0.88 : 0.48,
            vectorEffect: "non-scaling-stroke",
          }}
        />
      </g>
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className="dezin-flow-edge-label nodrag nopan"
            data-edge-kind={data?.kind ?? "relation"}
            data-kind={data?.kind}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <Link2 size={10} strokeWidth={1.7} aria-hidden />
            {data?.label ?? "relation"}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
