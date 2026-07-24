import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { workspaceEdgeLaneExpansion } from "./edge-lane-geometry.ts";

interface PrototypeEdgeGeometryInput {
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Parameters<typeof getBezierPath>[0]["sourcePosition"];
  targetPosition?: Parameters<typeof getBezierPath>[0]["targetPosition"];
  lane?: number;
}

export function prototypeEdgeGeometry(input: PrototypeEdgeGeometryInput): { path: string; labelX: number; labelY: number } {
  const laneExpansion = workspaceEdgeLaneExpansion(input.lane);
  if (input.source === input.target) {
    const horizontalReach = Math.max(72, Math.abs(input.sourceX - input.targetX) * 0.28) + laneExpansion * 18;
    const lift = Math.max(104, Math.abs(input.sourceX - input.targetX) * 0.42) + laneExpansion * 24;
    const apexY = Math.min(input.sourceY, input.targetY) - lift;
    return {
      path: `M ${input.sourceX} ${input.sourceY} C ${input.sourceX + horizontalReach} ${apexY} ${input.targetX - horizontalReach} ${apexY} ${input.targetX} ${input.targetY}`,
      labelX: (input.sourceX + input.targetX) / 2,
      labelY: apexY,
    };
  }
  if (
    laneExpansion > 0
    && input.sourcePosition !== undefined
    && input.sourcePosition === input.targetPosition
  ) {
    const reach = 30 + laneExpansion * 18;
    const horizontalSide = input.sourcePosition === Position.Top || input.sourcePosition === Position.Bottom;
    const direction = input.sourcePosition === Position.Top || input.sourcePosition === Position.Left ? -1 : 1;
    const offsetX = horizontalSide ? 0 : direction * reach;
    const offsetY = horizontalSide ? direction * reach : 0;
    return {
      path: `M ${input.sourceX} ${input.sourceY} C ${input.sourceX + offsetX} ${input.sourceY + offsetY} ${input.targetX + offsetX} ${input.targetY + offsetY} ${input.targetX} ${input.targetY}`,
      labelX: (input.sourceX + input.targetX) / 2 + offsetX * 0.75,
      labelY: (input.sourceY + input.targetY) / 2 + offsetY * 0.75,
    };
  }
  const { lane: _lane, ...pathInput } = input;
  const [path, labelX, labelY] = getBezierPath({
    ...pathInput,
    curvature: 0.24 + laneExpansion * 0.08,
  });
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
    lane: data?.lane,
  });
  const broken = data?.status === "broken";
  const foreground = broken
    ? "var(--destructive)"
    : selected || hovered
      ? "var(--foreground)"
      : "var(--foreground-2)";
  const showLabel = data?.zoomLevel === "full" || selected || broken || hovered;
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
            strokeWidth: selected || hovered ? 3.8 : 3.2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            opacity: 0.78,
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
            strokeWidth: selected || hovered ? 1.8 : 1.25,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            opacity: selected || hovered || broken ? 0.96 : 0.68,
            vectorEffect: "non-scaling-stroke",
          }}
        />
      </g>
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className="dezin-flow-edge-label nodrag nopan"
            data-broken={broken || undefined}
            data-edge-kind="prototype"
            data-status={data?.status ?? undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <CornerDownRight size={10} strokeWidth={1.7} aria-hidden />
            {data?.label ?? "prototype"}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
