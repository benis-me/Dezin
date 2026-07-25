const BASE_SIBLING_LANE_MAGNITUDE = 0.5;
const WORKSPACE_EDGE_CORNER_RADIUS = 20;
const WORKSPACE_EDGE_TERMINAL_OFFSET = 28;
const WORKSPACE_EDGE_LANE_SPACING = 18;

export function workspaceEdgeLaneExpansion(lane: number | undefined): number {
  if (lane === undefined || !Number.isFinite(lane)) return 0;
  return Math.max(0, Math.abs(lane) - BASE_SIBLING_LANE_MAGNITUDE);
}

export function workspaceEdgeRouteGeometry(lane: number | undefined): {
  cornerRadius: number;
  terminalOffset: number;
  laneExpansion: number;
  laneOffset: number;
  routeOffset: number;
} {
  const laneExpansion = workspaceEdgeLaneExpansion(lane);
  const laneOffset = laneExpansion * WORKSPACE_EDGE_LANE_SPACING;
  return {
    cornerRadius: WORKSPACE_EDGE_CORNER_RADIUS,
    terminalOffset: WORKSPACE_EDGE_TERMINAL_OFFSET,
    laneExpansion,
    laneOffset,
    routeOffset: WORKSPACE_EDGE_TERMINAL_OFFSET + laneOffset,
  };
}
