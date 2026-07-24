import type {
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutObject,
  WorkspaceNode,
} from "../../lib/api.ts";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export const WORKSPACE_NODE_SIZES = {
  page: { width: 280, height: 222 },
  component: { width: 280, height: 188 },
  resource: { width: 240, height: 112 },
} as const satisfies Record<WorkspaceNode["kind"], CanvasSize>;

export const COMPONENT_LIBRARY_GROUP_ID = "dezin-component-library";
export const COMPONENT_LIBRARY_GROUP_LABEL = "Components";

const FALLBACK_ORIGIN = { x: 80, y: 80 };
const FALLBACK_COLUMNS = 3;
const FALLBACK_COLUMN_STEP = 360;
const FALLBACK_ROW_STEP = 260;
const GROUP_PADDING = 48;
const EDGE_CORRIDOR_PADDING = 32;
const COMPONENT_LIBRARY_COLUMNS = 3;
const COMPONENT_LIBRARY_GAP = 28;
const COMPONENT_LIBRARY_PADDING_X = 40;
const COMPONENT_LIBRARY_PADDING_TOP = 64;
const COMPONENT_LIBRARY_PADDING_BOTTOM = 48;
const COMPONENT_LIBRARY_ROOT_GAP = 96;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function decodeWorkspaceLayout(raw: unknown): WorkspaceLayout {
  const record = isRecord(raw) ? raw : {};
  const viewportRecord = isRecord(record.viewport) ? record.viewport : {};
  const objects = Array.isArray(record.objects) ? record.objects.flatMap((candidate): WorkspaceLayoutObject[] => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) return [];
    const kind = candidate.kind ?? candidate.objectKind;
    const base = {
      id: candidate.id,
      x: finiteNumber(candidate.x),
      y: finiteNumber(candidate.y),
      parentGroupId: nullableString(candidate.parentGroupId),
    };
    if (kind === "node") return [{ ...base, kind: "node" }];
    if (kind !== "group") return [];
    return [{
      ...base,
      kind: "group",
      width: Math.max(1, finiteNumber(candidate.width, 320)),
      height: Math.max(1, finiteNumber(candidate.height, 220)),
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label : "Group",
      collapsed: candidate.collapsed === true,
    }];
  }) : [];
  return {
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : "",
    layoutId: typeof record.layoutId === "string" && record.layoutId ? record.layoutId : "default",
    objects,
    viewport: {
      x: finiteNumber(viewportRecord.x),
      y: finiteNumber(viewportRecord.y),
      zoom: Math.max(0.05, finiteNumber(viewportRecord.zoom, 1)),
    },
    checksum: typeof record.checksum === "string" ? record.checksum : "",
  };
}

export function fallbackPosition(index: number, origin: CanvasPoint = FALLBACK_ORIGIN): CanvasPoint {
  return {
    x: origin.x + (index % FALLBACK_COLUMNS) * FALLBACK_COLUMN_STEP,
    y: origin.y + Math.floor(index / FALLBACK_COLUMNS) * FALLBACK_ROW_STEP,
  };
}

function prototypePagePositions(
  graph: WorkspaceGraph,
  origin: CanvasPoint,
): Map<string, CanvasPoint> {
  const pageIds = graph.nodes.filter((node) => node.kind === "page").map((node) => node.id);
  if (pageIds.length === 0) return new Map();
  const pageOrder = new Map(pageIds.map((id, index) => [id, index]));
  const adjacency = new Map(pageIds.map((id) => [id, new Set<string>()]));
  const undirectedAdjacency = new Map(pageIds.map((id) => [id, new Set<string>()]));
  let prototypeRelationCount = 0;
  for (const edge of graph.edges) {
    if (
      edge.kind !== "prototype"
      || !adjacency.has(edge.sourceNodeId)
      || !adjacency.has(edge.targetNodeId)
      || edge.sourceNodeId === edge.targetNodeId
    ) continue;
    adjacency.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    undirectedAdjacency.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    undirectedAdjacency.get(edge.targetNodeId)!.add(edge.sourceNodeId);
    prototypeRelationCount += 1;
  }
  if (prototypeRelationCount === 0) {
    return new Map(pageIds.map((nodeId, index) => [nodeId, fallbackPosition(index, origin)]));
  }

  let visitIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const components: string[][] = [];
  const visit = (nodeId: string) => {
    indices.set(nodeId, visitIndex);
    lowLinks.set(nodeId, visitIndex);
    visitIndex += 1;
    stack.push(nodeId);
    inStack.add(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (!indices.has(targetId)) {
        visit(targetId);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(targetId)!));
      } else if (inStack.has(targetId)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indices.get(targetId)!));
      }
    }
    if (lowLinks.get(nodeId) !== indices.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const memberId = stack.pop()!;
      inStack.delete(memberId);
      component.push(memberId);
      if (memberId === nodeId) break;
    }
    component.sort((left, right) => pageOrder.get(left)! - pageOrder.get(right)!);
    components.push(component);
  };
  pageIds.forEach((nodeId) => {
    if (!indices.has(nodeId)) visit(nodeId);
  });

  const componentByNode = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    component.forEach((nodeId) => componentByNode.set(nodeId, componentIndex));
  });
  const componentAdjacency = new Map(components.map((_, index) => [index, new Set<number>()]));
  const indegrees = new Array(components.length).fill(0) as number[];
  for (const sourceId of pageIds) {
    const sourceComponent = componentByNode.get(sourceId)!;
    for (const targetId of adjacency.get(sourceId) ?? []) {
      const targetComponent = componentByNode.get(targetId)!;
      if (sourceComponent === targetComponent || componentAdjacency.get(sourceComponent)!.has(targetComponent)) continue;
      componentAdjacency.get(sourceComponent)!.add(targetComponent);
      indegrees[targetComponent] += 1;
    }
  }
  const componentOrder = (componentIndex: number) => Math.min(
    ...components[componentIndex]!.map((nodeId) => pageOrder.get(nodeId)!),
  );
  const queue = components
    .map((_, index) => index)
    .filter((index) => indegrees[index] === 0)
    .sort((left, right) => componentOrder(left) - componentOrder(right));
  const levels = new Array(components.length).fill(0) as number[];
  while (queue.length > 0) {
    const sourceComponent = queue.shift()!;
    for (const targetComponent of componentAdjacency.get(sourceComponent) ?? []) {
      levels[targetComponent] = Math.max(
        levels[targetComponent]!,
        levels[sourceComponent]! + Math.max(1, components[sourceComponent]!.length),
      );
      indegrees[targetComponent] -= 1;
      if (indegrees[targetComponent] === 0) {
        queue.push(targetComponent);
        queue.sort((left, right) => componentOrder(left) - componentOrder(right));
      }
    }
  }

  const weakComponents: string[][] = [];
  const assignedWeakNodes = new Set<string>();
  for (const nodeId of pageIds) {
    if (assignedWeakNodes.has(nodeId)) continue;
    const members: string[] = [];
    const pending = [nodeId];
    assignedWeakNodes.add(nodeId);
    while (pending.length > 0) {
      const memberId = pending.shift()!;
      members.push(memberId);
      for (const neighborId of undirectedAdjacency.get(memberId) ?? []) {
        if (assignedWeakNodes.has(neighborId)) continue;
        assignedWeakNodes.add(neighborId);
        pending.push(neighborId);
      }
    }
    members.sort((left, right) => pageOrder.get(left)! - pageOrder.get(right)!);
    weakComponents.push(members);
  }

  const PAGE_CLUSTER_GAP = 80;
  const PAGE_CLUSTER_PACK_WIDTH = FALLBACK_COLUMNS * FALLBACK_COLUMN_STEP;
  const positions = new Map<string, CanvasPoint>();
  let clusterX = 0;
  let clusterY = 0;
  let packedRowHeight = 0;
  for (const weakComponent of weakComponents) {
    const pagesByLevel = new Map<number, string[]>();
    for (const nodeId of weakComponent) {
      const componentIndex = componentByNode.get(nodeId)!;
      const level = levels[componentIndex]! + components[componentIndex]!.indexOf(nodeId);
      const members = pagesByLevel.get(level) ?? [];
      members.push(nodeId);
      members.sort((left, right) => pageOrder.get(left)! - pageOrder.get(right)!);
      pagesByLevel.set(level, members);
    }
    const widestLevel = Math.max(...[...pagesByLevel.values()].map((members) => members.length));
    const deepestLevel = Math.max(...pagesByLevel.keys());
    const clusterWidth = deepestLevel * FALLBACK_COLUMN_STEP + WORKSPACE_NODE_SIZES.page.width;
    const clusterHeight = (widestLevel - 1) * FALLBACK_ROW_STEP + WORKSPACE_NODE_SIZES.page.height;
    if (clusterX > 0 && clusterX + clusterWidth > PAGE_CLUSTER_PACK_WIDTH) {
      clusterX = 0;
      clusterY += packedRowHeight + PAGE_CLUSTER_GAP;
      packedRowHeight = 0;
    }
    for (const [level, members] of pagesByLevel) {
      const verticalOffset = (widestLevel - members.length) * FALLBACK_ROW_STEP / 2;
      members.forEach((nodeId, row) => {
        positions.set(nodeId, {
          x: origin.x + clusterX + level * FALLBACK_COLUMN_STEP,
          y: origin.y + clusterY + verticalOffset + row * FALLBACK_ROW_STEP,
        });
      });
    }
    clusterX += clusterWidth + PAGE_CLUSTER_GAP;
    packedRowHeight = Math.max(packedRowHeight, clusterHeight);
  }
  return positions;
}

export function layoutObjectMap(layout: WorkspaceLayout): Map<string, WorkspaceLayoutObject> {
  return new Map(layout.objects.map((object) => [object.id, object]));
}

export function isComponentLibraryGroupId(id: string): boolean {
  return id === COMPONENT_LIBRARY_GROUP_ID;
}

interface EdgeCorridor {
  start: CanvasPoint;
  end: CanvasPoint;
}

export type WorkspaceEdgeSide = "left" | "right" | "top" | "bottom";

export interface WorkspaceDirectionalEdgeRoute extends EdgeCorridor {
  sourceSide: WorkspaceEdgeSide;
  targetSide: WorkspaceEdgeSide;
}

function edgeAnchor(
  position: CanvasPoint,
  size: CanvasSize,
  side: WorkspaceEdgeSide,
): CanvasPoint {
  switch (side) {
    case "left":
      return { x: position.x, y: position.y + size.height / 2 };
    case "right":
      return { x: position.x + size.width, y: position.y + size.height / 2 };
    case "top":
      return { x: position.x + size.width / 2, y: position.y };
    case "bottom":
      return { x: position.x + size.width / 2, y: position.y + size.height };
  }
}

export function workspaceEdgeLaneMap(
  edges: readonly WorkspaceGraph["edges"][number][],
): Map<string, number> {
  const lanes = new Map<string, number>();
  const endpointGroups = new Map<string, WorkspaceGraph["edges"][number][]>();
  edges.forEach((edge) => {
    const endpoints = [edge.sourceNodeId, edge.targetNodeId].sort();
    const key = `${endpoints[0]}\u0000${endpoints[1]}`;
    const siblings = endpointGroups.get(key) ?? [];
    siblings.push(edge);
    endpointGroups.set(key, siblings);
  });
  endpointGroups.forEach((siblings) => {
    if (siblings.length < 2) return;
    siblings
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .forEach((edge, index) => lanes.set(edge.id, index - (siblings.length - 1) / 2));
  });
  return lanes;
}

export function resolveWorkspaceEdgeRoute(
  edge: WorkspaceGraph["edges"][number],
  layout: WorkspaceLayout,
  graphNodes: ReadonlyMap<string, WorkspaceNode>,
  lane = 0,
): WorkspaceDirectionalEdgeRoute | null {
  const sourceNode = graphNodes.get(edge.sourceNodeId);
  const targetNode = graphNodes.get(edge.targetNodeId);
  const source = rootPosition(layout, edge.sourceNodeId);
  const target = rootPosition(layout, edge.targetNodeId);
  if (!sourceNode || !targetNode || !source || !target) return null;
  const sourceSize = WORKSPACE_NODE_SIZES[sourceNode.kind];
  const targetSize = WORKSPACE_NODE_SIZES[targetNode.kind];
  const sourceCenter = {
    x: source.x + sourceSize.width / 2,
    y: source.y + sourceSize.height / 2,
  };
  const targetCenter = {
    x: target.x + targetSize.width / 2,
    y: target.y + targetSize.height / 2,
  };
  const route = (
    sourceSide: WorkspaceEdgeSide,
    targetSide: WorkspaceEdgeSide,
  ): WorkspaceDirectionalEdgeRoute => ({
    sourceSide,
    targetSide,
    start: edgeAnchor(source, sourceSize, sourceSide),
    end: edgeAnchor(target, targetSize, targetSide),
  });
  if (edge.sourceNodeId === edge.targetNodeId) return route("right", "left");

  const deltaX = targetCenter.x - sourceCenter.x;
  const deltaY = targetCenter.y - sourceCenter.y;
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  if (lane !== 0) {
    if (horizontal) return lane < 0 ? route("top", "top") : route("bottom", "bottom");
    return lane < 0 ? route("left", "left") : route("right", "right");
  }
  const directPathObstructed = [...graphNodes.entries()].some(([nodeId, node]) => {
    if (nodeId === edge.sourceNodeId || nodeId === edge.targetNodeId) return false;
    const position = rootPosition(layout, nodeId);
    if (!position) return false;
    const size = WORKSPACE_NODE_SIZES[node.kind];
    const bounds = {
      left: position.x - 24,
      right: position.x + size.width + 24,
      top: position.y - 24,
      bottom: position.y + size.height + 24,
    };
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;
    let start = 0;
    let end = 1;
    for (const [direction, distance] of [
      [-dx, sourceCenter.x - bounds.left],
      [dx, bounds.right - sourceCenter.x],
      [-dy, sourceCenter.y - bounds.top],
      [dy, bounds.bottom - sourceCenter.y],
    ] as const) {
      if (direction === 0) {
        if (distance < 0) return false;
        continue;
      }
      const ratio = distance / direction;
      if (direction < 0) {
        if (ratio > end) return false;
        start = Math.max(start, ratio);
      } else {
        if (ratio < start) return false;
        end = Math.min(end, ratio);
      }
    }
    return true;
  });
  if (directPathObstructed) {
    return horizontal ? route("top", "top") : route("right", "right");
  }
  if (horizontal) {
    return deltaX >= 0
      ? route("right", "left")
      : route("left", "right");
  }
  return deltaY >= 0
    ? route("bottom", "top")
    : route("top", "bottom");
}

function segmentIntersectsPaddedBounds(
  corridor: EdgeCorridor,
  bounds: CanvasPoint & CanvasSize,
): boolean {
  const minX = bounds.x - EDGE_CORRIDOR_PADDING;
  const maxX = bounds.x + bounds.width + EDGE_CORRIDOR_PADDING;
  const minY = bounds.y - EDGE_CORRIDOR_PADDING;
  const maxY = bounds.y + bounds.height + EDGE_CORRIDOR_PADDING;
  const dx = corridor.end.x - corridor.start.x;
  const dy = corridor.end.y - corridor.start.y;
  let start = 0;
  let end = 1;
  for (const [direction, distance] of [
    [-dx, corridor.start.x - minX],
    [dx, maxX - corridor.start.x],
    [-dy, corridor.start.y - minY],
    [dy, maxY - corridor.start.y],
  ] as const) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) {
      if (ratio > end) return false;
      start = Math.max(start, ratio);
    } else {
      if (ratio < start) return false;
      end = Math.min(end, ratio);
    }
  }
  return true;
}

function existingEdgeCorridors(
  graph: WorkspaceGraph,
  layout: WorkspaceLayout,
  graphNodes: ReadonlyMap<string, WorkspaceNode>,
): EdgeCorridor[] {
  const lanes = workspaceEdgeLaneMap(graph.edges);
  return graph.edges.flatMap((edge): EdgeCorridor[] => {
    const route = resolveWorkspaceEdgeRoute(edge, layout, graphNodes, lanes.get(edge.id) ?? 0);
    return route ? [{ start: route.start, end: route.end }] : [];
  });
}

export function materializeWorkspaceLayout(
  graph: WorkspaceGraph,
  layout: WorkspaceLayout,
  livePositions?: ReadonlyMap<string, CanvasPoint>,
  options: { ignoreComponentLibraryBounds?: boolean } = {},
): WorkspaceLayout {
  const existing = layoutObjectMap(layout);
  const additions: WorkspaceLayoutObject[] = [];
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeCorridors = existingEdgeCorridors(graph, layout, graphNodes);
  const occupied = layout.objects
    .filter((object) => (
      object.parentGroupId === null
      && (!options.ignoreComponentLibraryBounds || object.id !== COMPONENT_LIBRARY_GROUP_ID)
    ))
    .map((object) => {
      const size = object.kind === "group"
        ? { width: object.width, height: object.height }
        : WORKSPACE_NODE_SIZES[graphNodes.get(object.id)?.kind ?? "page"];
      return { x: object.x, y: object.y, ...size };
    });
  const positionedRootObjects = layout.objects.filter(
    (object) => object.parentGroupId === null && object.id !== COMPONENT_LIBRARY_GROUP_ID,
  );
  const fallbackOrigin = positionedRootObjects.length === 0
    ? FALLBACK_ORIGIN
    : {
        x: Math.min(...positionedRootObjects.map((object) => object.x)),
        y: Math.min(...positionedRootObjects.map((object) => object.y)),
      };
  const pagePositions = prototypePagePositions(graph, fallbackOrigin);
  const pageIds = new Set(graph.nodes.filter((node) => node.kind === "page").map((node) => node.id));
  const topologyOffsets = layout.objects.flatMap((object) => {
    if (object.kind !== "node" || object.parentGroupId !== null || !pageIds.has(object.id)) return [];
    const predicted = pagePositions.get(object.id);
    return predicted ? [{ x: object.x - predicted.x, y: object.y - predicted.y }] : [];
  });
  if (topologyOffsets.length > 0) {
    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor((sorted.length - 1) / 2)]!;
    };
    const offsetX = median(topologyOffsets.map((offset) => offset.x));
    const offsetY = median(topologyOffsets.map((offset) => offset.y));
    for (const [nodeId, position] of pagePositions) {
      pagePositions.set(nodeId, { x: position.x + offsetX, y: position.y + offsetY });
    }
  }
  let gridIndex = 0;
  const orderedNodes = [
    ...graph.nodes.filter((node) => node.kind === "page"),
    ...graph.nodes.filter((node) => node.kind !== "page"),
  ];
  orderedNodes.forEach((node) => {
    if (existing.has(node.id)) return;
    const livePosition = livePositions?.get(node.id);
    const size = WORKSPACE_NODE_SIZES[node.kind];
    let position = livePosition;
    if (!position) {
      const topologyPosition = pagePositions.get(node.id);
      if (topologyPosition) {
        let candidate = topologyPosition;
        while (
          occupied.some((bounds) => (
            candidate.x < bounds.x + bounds.width + 24
            && candidate.x + size.width + 24 > bounds.x
            && candidate.y < bounds.y + bounds.height + 24
            && candidate.y + size.height + 24 > bounds.y
          ))
          || edgeCorridors.some((corridor) => segmentIntersectsPaddedBounds(corridor, {
            ...candidate,
            ...size,
          }))
        ) {
          candidate = { ...candidate, y: candidate.y + FALLBACK_ROW_STEP };
        }
        position = candidate;
      }
    }
    while (!position) {
      const candidate = fallbackPosition(gridIndex++, fallbackOrigin);
      const collision = occupied.some((bounds) => (
        candidate.x < bounds.x + bounds.width + 24
        && candidate.x + size.width + 24 > bounds.x
        && candidate.y < bounds.y + bounds.height + 24
        && candidate.y + size.height + 24 > bounds.y
      )) || edgeCorridors.some((corridor) => segmentIntersectsPaddedBounds(corridor, {
        ...candidate,
        ...size,
      }));
      if (!collision) position = candidate;
    }
    additions.push({
      id: node.id,
      kind: "node",
      x: position.x,
      y: position.y,
      parentGroupId: null,
    });
    occupied.push({ ...position, ...size });
  });
  return additions.length === 0 ? layout : { ...layout, objects: [...layout.objects, ...additions] };
}

function componentLibrarySlot(index: number): CanvasPoint {
  const componentSize = WORKSPACE_NODE_SIZES.component;
  return {
    x: COMPONENT_LIBRARY_PADDING_X
      + (index % COMPONENT_LIBRARY_COLUMNS) * (componentSize.width + COMPONENT_LIBRARY_GAP),
    y: COMPONENT_LIBRARY_PADDING_TOP
      + Math.floor(index / COMPONENT_LIBRARY_COLUMNS) * (componentSize.height + COMPONENT_LIBRARY_GAP),
  };
}

function componentLibrarySize(memberCount: number): CanvasSize {
  const count = Math.max(1, memberCount);
  const columns = Math.min(COMPONENT_LIBRARY_COLUMNS, count);
  const rows = Math.ceil(count / COMPONENT_LIBRARY_COLUMNS);
  const componentSize = WORKSPACE_NODE_SIZES.component;
  return {
    width: COMPONENT_LIBRARY_PADDING_X * 2
      + columns * componentSize.width
      + Math.max(0, columns - 1) * COMPONENT_LIBRARY_GAP,
    height: COMPONENT_LIBRARY_PADDING_TOP
      + rows * componentSize.height
      + Math.max(0, rows - 1) * COMPONENT_LIBRARY_GAP
      + COMPONENT_LIBRARY_PADDING_BOTTOM,
  };
}

function componentLibraryOrigin(
  graph: WorkspaceGraph,
  layout: WorkspaceLayout,
): CanvasPoint {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const bounds = layout.objects.flatMap((object) => {
    if (object.parentGroupId !== null || object.id === COMPONENT_LIBRARY_GROUP_ID) return [];
    if (object.kind === "group") return [{ x: object.x, y: object.y, width: object.width, height: object.height }];
    const node = graphNodes.get(object.id);
    if (!node || node.kind === "component") return [];
    return [{ x: object.x, y: object.y, ...WORKSPACE_NODE_SIZES[node.kind] }];
  });
  if (bounds.length === 0) return FALLBACK_ORIGIN;
  return {
    x: Math.min(...bounds.map((entry) => entry.x)),
    y: Math.max(...bounds.map((entry) => entry.y + entry.height)) + COMPONENT_LIBRARY_ROOT_GAP,
  };
}

/**
 * Persist the canonical Components shelf and migrate every component into its
 * first available slot so the workspace always exposes one unified library.
 */
export function buildComponentLibraryCommands(
  graph: WorkspaceGraph,
  sourceLayout: WorkspaceLayout,
): WorkspaceLayoutCommand[] {
  const componentIds = graph.nodes
    .filter((node) => node.kind === "component")
    .map((node) => node.id);
  if (componentIds.length === 0) return [];

  const storedById = layoutObjectMap(sourceLayout);
  const reserved = storedById.get(COMPONENT_LIBRARY_GROUP_ID);
  if (reserved && reserved.kind !== "group") return [];

  const layout = materializeWorkspaceLayout(
    graph,
    sourceLayout,
    undefined,
    { ignoreComponentLibraryBounds: true },
  );
  const byId = layoutObjectMap(layout);
  const existingGroup = byId.get(COMPONENT_LIBRARY_GROUP_ID);
  const currentMembers = componentIds.filter(
    (id) => byId.get(id)?.parentGroupId === COMPONENT_LIBRARY_GROUP_ID,
  );
  const eligible = componentIds.filter(
    (id) => byId.get(id)?.parentGroupId !== COMPONENT_LIBRARY_GROUP_ID,
  );

  if (!existingGroup && eligible.length === 0) return [];
  const commands: WorkspaceLayoutCommand[] = graph.nodes.flatMap((node): WorkspaceLayoutCommand[] => {
    if (node.kind === "component" || storedById.has(node.id)) return [];
    const object = byId.get(node.id);
    return object?.kind === "node"
      ? [{ type: "move", objectId: node.id, x: object.x, y: object.y }]
      : [];
  });
  const componentSize = WORKSPACE_NODE_SIZES.component;
  const occupiedBounds = currentMembers.flatMap((id) => {
    const object = byId.get(id);
    return object?.kind === "node"
      ? [{ x: object.x, y: object.y, width: componentSize.width, height: componentSize.height }]
      : [];
  });
  const assignedSlots: Array<{ index: number; position: CanvasPoint }> = [];
  eligible.forEach(() => {
    let index = 0;
    while (true) {
      const position = componentLibrarySlot(index);
      const overlaps = [...occupiedBounds, ...assignedSlots.map(({ position: assigned }) => ({
        ...assigned,
        width: componentSize.width,
        height: componentSize.height,
      }))].some((bounds) => (
        position.x < bounds.x + bounds.width + COMPONENT_LIBRARY_GAP / 2
        && position.x + componentSize.width + COMPONENT_LIBRARY_GAP / 2 > bounds.x
        && position.y < bounds.y + bounds.height + COMPONENT_LIBRARY_GAP / 2
        && position.y + componentSize.height + COMPONENT_LIBRARY_GAP / 2 > bounds.y
      ));
      if (!overlaps) {
        assignedSlots.push({ index, position });
        break;
      }
      index += 1;
    }
  });
  const requiredSlotCount = Math.max(
    1,
    currentMembers.length + eligible.length,
    ...assignedSlots.map(({ index }) => index + 1),
  );
  const canonicalSize = componentLibrarySize(requiredSlotCount);
  const requiredSize = occupiedBounds.reduce<CanvasSize>((size, bounds) => ({
    width: Math.max(size.width, bounds.x + bounds.width + COMPONENT_LIBRARY_PADDING_X),
    height: Math.max(size.height, bounds.y + bounds.height + COMPONENT_LIBRARY_PADDING_BOTTOM),
  }), canonicalSize);

  if (!existingGroup) {
    const origin = componentLibraryOrigin(graph, layout);
    commands.push({
      type: "add-group",
      groupId: COMPONENT_LIBRARY_GROUP_ID,
      label: COMPONENT_LIBRARY_GROUP_LABEL,
      bounds: { ...origin, ...requiredSize },
    });
  } else if (existingGroup.kind !== "group") {
    return [];
  } else {
    const origin = componentLibraryOrigin(graph, layout);
    if (existingGroup.y < origin.y) {
      commands.push({
        type: "move",
        objectId: COMPONENT_LIBRARY_GROUP_ID,
        x: existingGroup.x,
        y: origin.y,
      });
    }
    if (existingGroup.label !== COMPONENT_LIBRARY_GROUP_LABEL) {
      commands.push({
        type: "rename-group",
        groupId: COMPONENT_LIBRARY_GROUP_ID,
        label: COMPONENT_LIBRARY_GROUP_LABEL,
      });
    }
    const width = Math.max(existingGroup.width, requiredSize.width);
    const height = Math.max(existingGroup.height, requiredSize.height);
    if (width !== existingGroup.width || height !== existingGroup.height) {
      commands.push({
        type: "resize-group",
        groupId: COMPONENT_LIBRARY_GROUP_ID,
        width,
        height,
      });
    }
  }

  eligible.forEach((objectId, index) => {
    const slot = assignedSlots[index]!.position;
    commands.push(
      { type: "move", objectId, ...slot },
      { type: "set-parent", objectId, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    );
  });
  return commands;
}

export function rootPosition(layout: WorkspaceLayout, objectId: string): CanvasPoint | null {
  const byId = layoutObjectMap(layout);
  const start = byId.get(objectId);
  if (!start) return null;
  let x = start.x;
  let y = start.y;
  let parentId = start.parentGroupId;
  const visited = new Set([objectId]);
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "group") break;
    x += parent.x;
    y += parent.y;
    parentId = parent.parentGroupId;
  }
  return { x, y };
}

export function isValidLayoutParent(layout: WorkspaceLayout, objectId: string, parentGroupId: string | null): boolean {
  const byId = layoutObjectMap(layout);
  if (!byId.has(objectId)) return false;
  if (parentGroupId === null) return true;
  const parent = byId.get(parentGroupId);
  if (!parent || parent.kind !== "group" || parentGroupId === objectId) return false;
  const visited = new Set<string>();
  let candidate: WorkspaceLayoutObject | undefined = parent;
  while (candidate) {
    if (candidate.id === objectId || visited.has(candidate.id)) return false;
    visited.add(candidate.id);
    candidate = candidate.parentGroupId ? byId.get(candidate.parentGroupId) : undefined;
  }
  return true;
}

export function buildReparentCommands(
  layout: WorkspaceLayout,
  objectId: string,
  parentGroupId: string | null,
): WorkspaceLayoutCommand[] {
  if (!isValidLayoutParent(layout, objectId, parentGroupId)) return [];
  const objectRoot = rootPosition(layout, objectId);
  if (!objectRoot) return [];
  const parentRoot = parentGroupId ? rootPosition(layout, parentGroupId) : { x: 0, y: 0 };
  if (!parentRoot) return [];
  return [
    { type: "move", objectId, x: objectRoot.x - parentRoot.x, y: objectRoot.y - parentRoot.y },
    { type: "set-parent", objectId, parentGroupId },
  ];
}

function nodeSize(graph: WorkspaceGraph | undefined, object: WorkspaceLayoutObject): CanvasSize {
  if (object.kind === "group") return { width: object.width, height: object.height };
  const node = graph?.nodes.find((candidate) => candidate.id === object.id);
  return node ? WORKSPACE_NODE_SIZES[node.kind] : WORKSPACE_NODE_SIZES.page;
}

function withoutSelectedDescendants(layout: WorkspaceLayout, selectedIds: readonly string[]): string[] {
  const selected = new Set(selectedIds);
  const byId = layoutObjectMap(layout);
  return selectedIds.filter((id, index) => {
    if (selectedIds.indexOf(id) !== index || !byId.has(id)) return false;
    let parentId = byId.get(id)?.parentGroupId ?? null;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentGroupId ?? null;
    }
    return true;
  });
}

/**
 * Keep only the outer-most selected objects. React Flow moves descendants when
 * their selected parent moves, so persisting both would apply the same motion
 * twice after reload.
 */
export function topmostSelectedLayoutIds(
  layout: WorkspaceLayout,
  selectedIds: readonly string[],
): string[] {
  return withoutSelectedDescendants(layout, selectedIds);
}

/** Build parent-relative terminal move commands for one drag or keyboard step. */
export function buildMoveCommands(
  layout: WorkspaceLayout,
  selectedIds: readonly string[],
  positions: ReadonlyMap<string, CanvasPoint>,
): Extract<WorkspaceLayoutCommand, { type: "move" }>[] {
  const byId = layoutObjectMap(layout);
  return topmostSelectedLayoutIds(layout, selectedIds).flatMap((objectId) => {
    const object = byId.get(objectId);
    const position = positions.get(objectId);
    if (!object || !position) return [];
    return [{ type: "move" as const, objectId, x: position.x, y: position.y }];
  });
}

export interface BuildGroupOptions {
  groupId: string;
  label: string;
  graph: WorkspaceGraph;
  livePositions?: ReadonlyMap<string, CanvasPoint>;
}

export function buildGroupCommands(
  sourceLayout: WorkspaceLayout,
  selectedIds: readonly string[],
  options: BuildGroupOptions,
): WorkspaceLayoutCommand[] {
  const layout = materializeWorkspaceLayout(options.graph, sourceLayout, options.livePositions);
  const byId = layoutObjectMap(layout);
  if (byId.has(options.groupId)) return [];
  const ids = withoutSelectedDescendants(layout, selectedIds);
  const positioned = ids.flatMap((id) => {
    const object = byId.get(id);
    const position = rootPosition(layout, id);
    return object && position ? [{ id, object, position, size: nodeSize(options.graph, object) }] : [];
  });
  if (positioned.length === 0) return [];

  const minX = Math.min(...positioned.map(({ position }) => position.x));
  const minY = Math.min(...positioned.map(({ position }) => position.y));
  const maxX = Math.max(...positioned.map(({ position, size }) => position.x + size.width));
  const maxY = Math.max(...positioned.map(({ position, size }) => position.y + size.height));
  const groupX = minX - GROUP_PADDING;
  const groupY = minY - GROUP_PADDING;
  const commands: WorkspaceLayoutCommand[] = [{
    type: "add-group",
    groupId: options.groupId,
    label: options.label.trim() || "Group",
    bounds: {
      x: groupX,
      y: groupY,
      width: maxX - minX + GROUP_PADDING * 2,
      height: maxY - minY + GROUP_PADDING * 2,
    },
  }];
  for (const { id, position } of positioned) {
    commands.push(
      { type: "move", objectId: id, x: position.x - groupX, y: position.y - groupY },
      { type: "set-parent", objectId: id, parentGroupId: options.groupId },
    );
  }
  return commands;
}

export function buildUngroupCommands(layout: WorkspaceLayout, selectedIds: readonly string[]): WorkspaceLayoutCommand[] {
  const byId = layoutObjectMap(layout);
  const commands: WorkspaceLayoutCommand[] = [];
  for (const id of selectedIds) {
    const object = byId.get(id);
    if (!object?.parentGroupId) continue;
    const position = rootPosition(layout, id);
    if (!position) continue;
    commands.push(
      { type: "move", objectId: id, x: position.x, y: position.y },
      { type: "set-parent", objectId: id, parentGroupId: null },
    );
  }
  return commands;
}

export function buildDeleteGroupCommands(layout: WorkspaceLayout, groupId: string): WorkspaceLayoutCommand[] {
  const group = layoutObjectMap(layout).get(groupId);
  if (group?.kind !== "group") return [];
  const commands: WorkspaceLayoutCommand[] = [];
  for (const child of layout.objects) {
    if (child.parentGroupId !== groupId) continue;
    const position = rootPosition(layout, child.id);
    if (position) commands.push({ type: "move", objectId: child.id, x: position.x, y: position.y });
  }
  commands.push({ type: "delete-group", groupId, ungroupChildren: true });
  return commands;
}

export function applyWorkspaceLayoutCommands(
  layout: WorkspaceLayout,
  commands: readonly WorkspaceLayoutCommand[],
): WorkspaceLayout {
  let objects = layout.objects.map((object) => ({ ...object }));
  let viewport = { ...layout.viewport };
  const ensureNode = (objectId: string) => {
    if (objects.some((object) => object.id === objectId)) return;
    objects = [...objects, {
      id: objectId,
      kind: "node",
      x: 0,
      y: 0,
      parentGroupId: null,
    }];
  };
  for (const command of commands) {
    switch (command.type) {
      case "add-group":
        objects = [...objects, {
          id: command.groupId,
          kind: "group",
          x: command.bounds.x,
          y: command.bounds.y,
          width: command.bounds.width,
          height: command.bounds.height,
          parentGroupId: null,
          label: command.label,
          collapsed: false,
        }];
        break;
      case "rename-group":
        objects = objects.map((object) => object.id === command.groupId && object.kind === "group"
          ? { ...object, label: command.label }
          : object);
        break;
      case "delete-group":
        objects = objects
          .filter((object) => object.id !== command.groupId)
          .map((object) => object.parentGroupId === command.groupId ? { ...object, parentGroupId: null } : object);
        break;
      case "set-parent":
        ensureNode(command.objectId);
        objects = objects.map((object) => object.id === command.objectId
          ? { ...object, parentGroupId: command.parentGroupId }
          : object);
        break;
      case "move":
        ensureNode(command.objectId);
        objects = objects.map((object) => object.id === command.objectId
          ? { ...object, x: command.x, y: command.y }
          : object);
        break;
      case "resize-group":
        objects = objects.map((object) => object.id === command.groupId && object.kind === "group"
          ? { ...object, width: command.width, height: command.height }
          : object);
        break;
      case "set-collapsed":
        objects = objects.map((object) => object.id === command.groupId && object.kind === "group"
          ? { ...object, collapsed: command.collapsed }
          : object);
        break;
      case "set-viewport":
        viewport = { ...command.viewport };
        break;
    }
  }
  return { ...layout, objects, viewport };
}
