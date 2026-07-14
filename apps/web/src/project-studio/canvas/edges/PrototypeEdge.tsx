import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useState } from "react";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";

interface PrototypeEdgeGeometryInput {
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Parameters<typeof getBezierPath>[0]["sourcePosition"];
  targetPosition?: Parameters<typeof getBezierPath>[0]["targetPosition"];
}

export function prototypeEdgeGeometry(input: PrototypeEdgeGeometryInput): { path: string; labelX: number; labelY: number } {
  if (input.source === input.target) {
    const horizontalReach = Math.max(72, Math.abs(input.sourceX - input.targetX) * 0.28);
    const lift = Math.max(104, Math.abs(input.sourceX - input.targetX) * 0.42);
    const apexY = Math.min(input.sourceY, input.targetY) - lift;
    return {
      path: `M ${input.sourceX} ${input.sourceY} C ${input.sourceX + horizontalReach} ${apexY} ${input.targetX - horizontalReach} ${apexY} ${input.targetX} ${input.targetY}`,
      labelX: (input.sourceX + input.targetX) / 2,
      labelY: apexY,
    };
  }
  const [path, labelX, labelY] = getBezierPath(input);
  return { path, labelX, labelY };
}

export function PrototypeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  target,
  markerEnd,
  data,
  selected,
}: EdgeProps<WorkspaceFlowEdge>) {
  const [hovered, setHovered] = useState(false);
  const { path, labelX, labelY } = prototypeEdgeGeometry({
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const broken = data?.status === "broken";
  const planned = data?.status === "planned";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={22}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          stroke: broken ? "var(--destructive)" : selected ? "var(--foreground)" : "var(--foreground-2)",
          strokeWidth: selected ? 1.8 : 1.35,
          strokeDasharray: planned ? "5 5" : undefined,
          opacity: selected || broken ? 0.95 : 0.58,
        }}
      />
      {(selected || broken || hovered) && (
        <EdgeLabelRenderer>
          <span
            className="dezin-flow-edge-label nodrag nopan"
            data-broken={broken || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data?.label ?? "prototype"}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
