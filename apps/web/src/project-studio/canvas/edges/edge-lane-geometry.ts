const BASE_SIBLING_LANE_MAGNITUDE = 0.5;

export function workspaceEdgeLaneExpansion(lane: number | undefined): number {
  if (lane === undefined || !Number.isFinite(lane)) return 0;
  return Math.max(0, Math.abs(lane) - BASE_SIBLING_LANE_MAGNITUDE);
}
