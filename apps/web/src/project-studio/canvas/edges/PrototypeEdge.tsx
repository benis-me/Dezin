import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import { Link2 } from "lucide-react";
import { useState } from "react";
import type { WorkspaceFlowEdge } from "../workspace-graph-adapter.ts";
import { canvasEdgeTheme } from "./edge-theme.ts";
import { workspaceEdgeRouteGeometry } from "./edge-lane-geometry.ts";

interface PrototypeEdgeGeometryInput {
  source: string;
  target: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Parameters<typeof getSmoothStepPath>[0]["sourcePosition"];
  targetPosition?: Parameters<typeof getSmoothStepPath>[0]["targetPosition"];
  lane?: number;
}

interface EdgePoint {
  x: number;
  y: number;
}

function roundedOrthogonalPath(rawPoints: readonly EdgePoint[], radius: number): string {
  const points = rawPoints.filter((point, index) => (
    index === 0
    || point.x !== rawPoints[index - 1]!.x
    || point.y !== rawPoints[index - 1]!.y
  ));
  const first = points[0]!;
  const last = points.at(-1)!;
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const incomingLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoingLength = Math.hypot(next.x - current.x, next.y - current.y);
    const bend = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    if (bend === 0) continue;
    const entry = {
      x: current.x - ((current.x - previous.x) / incomingLength) * bend,
      y: current.y - ((current.y - previous.y) / incomingLength) * bend,
    };
    const exit = {
      x: current.x + ((next.x - current.x) / outgoingLength) * bend,
      y: current.y + ((next.y - current.y) / outgoingLength) * bend,
    };
    path += ` L ${entry.x} ${entry.y} Q ${current.x} ${current.y} ${exit.x} ${exit.y}`;
  }
  return `${path} L ${last.x} ${last.y}`;
}

export function prototypeEdgeGeometry(input: PrototypeEdgeGeometryInput): { path: string; labelX: number; labelY: number } {
  const routeGeometry = workspaceEdgeRouteGeometry(input.lane);
  if (input.source === input.target) {
    const loopDirection = (input.lane ?? 0) > 0 ? 1 : -1;
    const horizontalReach = Math.max(72, Math.abs(input.sourceX - input.targetX) * 0.28) + routeGeometry.laneOffset;
    const lift = Math.max(104, Math.abs(input.sourceX - input.targetX) * 0.42) + routeGeometry.laneOffset;
    const apexY = loopDirection > 0
      ? Math.max(input.sourceY, input.targetY) + lift
      : Math.min(input.sourceY, input.targetY) - lift;
    return {
      path: `M ${input.sourceX} ${input.sourceY} C ${input.sourceX + horizontalReach} ${apexY} ${input.targetX - horizontalReach} ${apexY} ${input.targetX} ${input.targetY}`,
      labelX: (input.sourceX + input.targetX) / 2,
      labelY: apexY,
    };
  }
  const lane = input.lane ?? 0;
  const sourcePosition = input.sourcePosition ?? Position.Bottom;
  const targetPosition = input.targetPosition ?? Position.Top;
  const horizontalHandles = (
    (sourcePosition === Position.Left || sourcePosition === Position.Right)
    && (targetPosition === Position.Left || targetPosition === Position.Right)
  );
  const verticalHandles = (
    (sourcePosition === Position.Top || sourcePosition === Position.Bottom)
    && (targetPosition === Position.Top || targetPosition === Position.Bottom)
  );
  if (lane !== 0 && sourcePosition !== targetPosition && (horizontalHandles || verticalHandles)) {
    const direction = lane > 0 ? 1 : -1;
    const laneDistance = routeGeometry.routeOffset;
    const sourceGap = routeGeometry.terminalOffset;
    if (horizontalHandles) {
      const sourceGapX = input.sourceX + (sourcePosition === Position.Right ? sourceGap : -sourceGap);
      const targetGapX = input.targetX + (targetPosition === Position.Right ? sourceGap : -sourceGap);
      const laneY = direction > 0
        ? Math.max(input.sourceY, input.targetY) + laneDistance
        : Math.min(input.sourceY, input.targetY) - laneDistance;
      return {
        path: roundedOrthogonalPath([
          { x: input.sourceX, y: input.sourceY },
          { x: sourceGapX, y: input.sourceY },
          { x: sourceGapX, y: laneY },
          { x: targetGapX, y: laneY },
          { x: targetGapX, y: input.targetY },
          { x: input.targetX, y: input.targetY },
        ], routeGeometry.cornerRadius),
        labelX: (sourceGapX + targetGapX) / 2,
        labelY: laneY,
      };
    }
    const sourceGapY = input.sourceY + (sourcePosition === Position.Bottom ? sourceGap : -sourceGap);
    const targetGapY = input.targetY + (targetPosition === Position.Bottom ? sourceGap : -sourceGap);
    const laneX = direction > 0
      ? Math.max(input.sourceX, input.targetX) + laneDistance
      : Math.min(input.sourceX, input.targetX) - laneDistance;
    return {
      path: roundedOrthogonalPath([
        { x: input.sourceX, y: input.sourceY },
        { x: input.sourceX, y: sourceGapY },
        { x: laneX, y: sourceGapY },
        { x: laneX, y: targetGapY },
        { x: input.targetX, y: targetGapY },
        { x: input.targetX, y: input.targetY },
      ], routeGeometry.cornerRadius),
      labelX: laneX,
      labelY: (sourceGapY + targetGapY) / 2,
    };
  }
  const { source: _source, target: _target, lane: _lane, ...pathInput } = input;
  const [path, labelX, labelY] = getSmoothStepPath({
    ...pathInput,
    borderRadius: routeGeometry.cornerRadius,
    offset: routeGeometry.routeOffset,
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
  const theme = canvasEdgeTheme({
    kind: "prototype",
    active: selected || hovered,
    broken,
  });
  const showLabel = broken || selected || hovered;
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
          style={theme.halo}
        />
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          interactionWidth={24}
          className="dezin-flow-edge__path"
          style={theme.path}
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
            <Link2 size={10} strokeWidth={1.7} aria-hidden />
            {data?.label ?? "prototype"}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
