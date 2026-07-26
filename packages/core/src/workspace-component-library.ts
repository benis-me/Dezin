import type {
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceNode,
} from "./workspace-types.ts";

export const COMPONENT_LIBRARY_GROUP_ID = "dezin-component-library";
export const COMPONENT_LIBRARY_GROUP_LABEL = "Components";

const ROOT_ORIGIN = { x: 80, y: 80 };
const ROOT_COLUMNS = 3;
const ROOT_COLUMN_STEP = 360;
const ROOT_ROW_STEP = 260;
const ROOT_COLLISION_GAP = 24;
const LIBRARY_COLUMNS = 3;
const LIBRARY_GAP = 28;
const LIBRARY_PADDING_X = 40;
const LIBRARY_PADDING_TOP = 64;
const LIBRARY_PADDING_BOTTOM = 48;
const LIBRARY_ROOT_GAP = 96;

const NODE_SIZES = {
  page: { width: 280, height: 222 },
  component: { width: 280, height: 188 },
  resource: { width: 240, height: 112 },
} as const satisfies Record<WorkspaceNode["kind"], { width: number; height: number }>;

type LayoutObject = WorkspaceLayout["objects"][number];
type Bounds = { x: number; y: number; width: number; height: number };

function rootSlot(index: number, origin = ROOT_ORIGIN): { x: number; y: number } {
  return {
    x: origin.x + (index % ROOT_COLUMNS) * ROOT_COLUMN_STEP,
    y: origin.y + Math.floor(index / ROOT_COLUMNS) * ROOT_ROW_STEP,
  };
}

function librarySlot(index: number): { x: number; y: number } {
  return {
    x: LIBRARY_PADDING_X
      + (index % LIBRARY_COLUMNS) * (NODE_SIZES.component.width + LIBRARY_GAP),
    y: LIBRARY_PADDING_TOP
      + Math.floor(index / LIBRARY_COLUMNS) * (NODE_SIZES.component.height + LIBRARY_GAP),
  };
}

function librarySize(memberCount: number): { width: number; height: number } {
  const count = Math.max(1, memberCount);
  const columns = Math.min(LIBRARY_COLUMNS, count);
  const rows = Math.ceil(count / LIBRARY_COLUMNS);
  return {
    width: LIBRARY_PADDING_X * 2
      + columns * NODE_SIZES.component.width
      + Math.max(0, columns - 1) * LIBRARY_GAP,
    height: LIBRARY_PADDING_TOP
      + rows * NODE_SIZES.component.height
      + Math.max(0, rows - 1) * LIBRARY_GAP
      + LIBRARY_PADDING_BOTTOM,
  };
}

function overlaps(left: Bounds, right: Bounds, gap = 0): boolean {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function rootBounds(
  object: LayoutObject,
  nodesById: ReadonlyMap<string, WorkspaceNode>,
): Bounds | null {
  if (object.parentGroupId !== null) return null;
  if (object.kind === "group") {
    return { x: object.x, y: object.y, width: object.width, height: object.height };
  }
  const node = nodesById.get(object.id);
  return node ? { x: object.x, y: object.y, ...NODE_SIZES[node.kind] } : null;
}

/**
 * Returns the idempotent layout commands required by the durable Workspace
 * invariant: every Component belongs to one protected Components shelf.
 */
export function componentLibraryInvariantCommands(
  graph: WorkspaceGraph,
  sourceLayout: WorkspaceLayout,
): WorkspaceLayoutCommand[] {
  const componentIds = graph.nodes
    .filter((node) => node.kind === "component")
    .map((node) => node.id);
  if (componentIds.length === 0) return [];

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const storedById = new Map(sourceLayout.objects.map((object) => [object.id, object]));
  const reserved = storedById.get(COMPONENT_LIBRARY_GROUP_ID);
  if (reserved !== undefined && reserved.kind !== "group") {
    throw new Error(`Reserved Component library id ${COMPONENT_LIBRARY_GROUP_ID} is not a Workspace group`);
  }

  const workingObjects = [...sourceLayout.objects];
  const occupiedRootBounds = workingObjects.flatMap((object) => {
    const bounds = rootBounds(object, nodesById);
    return bounds === null ? [] : [bounds];
  });
  const existingRoots = workingObjects.filter(
    (object) => object.parentGroupId === null && object.id !== COMPONENT_LIBRARY_GROUP_ID,
  );
  const fallbackOrigin = existingRoots.length === 0
    ? ROOT_ORIGIN
    : {
        x: Math.min(...existingRoots.map((object) => object.x)),
        y: Math.min(...existingRoots.map((object) => object.y)),
  };
  const commands: WorkspaceLayoutCommand[] = [];
  let rootIndex = 0;
  const rootNodes = [
    ...graph.nodes.filter((node) => node.kind === "page"),
    ...graph.nodes.filter((node) => node.kind === "resource"),
  ];
  for (const node of rootNodes) {
    if (storedById.has(node.id)) continue;
    const size = NODE_SIZES[node.kind];
    let position: { x: number; y: number };
    while (true) {
      position = rootSlot(rootIndex++, fallbackOrigin);
      if (!occupiedRootBounds.some((bounds) => overlaps({ ...position, ...size }, bounds, ROOT_COLLISION_GAP))) {
        break;
      }
    }
    const object = {
      id: node.id,
      kind: "node" as const,
      x: position.x,
      y: position.y,
      parentGroupId: null,
    };
    workingObjects.push(object);
    storedById.set(node.id, object);
    occupiedRootBounds.push({ ...position, ...size });
    commands.push({ type: "move", objectId: node.id, ...position });
  }

  const existingGroup = storedById.get(COMPONENT_LIBRARY_GROUP_ID);
  const currentMembers = componentIds.filter(
    (id) => storedById.get(id)?.parentGroupId === COMPONENT_LIBRARY_GROUP_ID,
  );
  const eligible = componentIds.filter(
    (id) => storedById.get(id)?.parentGroupId !== COMPONENT_LIBRARY_GROUP_ID,
  );
  const occupiedMembers = currentMembers.flatMap((id) => {
    const object = storedById.get(id);
    return object?.kind === "node"
      ? [{ x: object.x, y: object.y, ...NODE_SIZES.component }]
      : [];
  });
  const assignedSlots: Array<{ index: number; x: number; y: number }> = [];
  for (const _componentId of eligible) {
    let index = 0;
    while (true) {
      const position = librarySlot(index);
      const candidate = { ...position, ...NODE_SIZES.component };
      if (![...occupiedMembers, ...assignedSlots.map((slot) => ({
        x: slot.x,
        y: slot.y,
        ...NODE_SIZES.component,
      }))].some((bounds) => overlaps(candidate, bounds, LIBRARY_GAP / 2))) {
        assignedSlots.push({ index, ...position });
        break;
      }
      index += 1;
    }
  }

  const requiredSlotCount = Math.max(
    1,
    currentMembers.length + eligible.length,
    ...assignedSlots.map(({ index }) => index + 1),
  );
  const canonicalSize = librarySize(requiredSlotCount);
  const requiredSize = occupiedMembers.reduce((size, bounds) => ({
    width: Math.max(size.width, bounds.x + bounds.width + LIBRARY_PADDING_X),
    height: Math.max(size.height, bounds.y + bounds.height + LIBRARY_PADDING_BOTTOM),
  }), canonicalSize);
  const origin = occupiedRootBounds.length === 0
    ? ROOT_ORIGIN
    : {
        x: Math.min(...occupiedRootBounds.map(({ x }) => x)),
        y: Math.max(...occupiedRootBounds.map(({ y, height }) => y + height)) + LIBRARY_ROOT_GAP,
      };

  if (existingGroup === undefined) {
    commands.push({
      type: "add-group",
      groupId: COMPONENT_LIBRARY_GROUP_ID,
      label: COMPONENT_LIBRARY_GROUP_LABEL,
      bounds: { ...origin, ...requiredSize },
    });
  } else if (existingGroup.kind === "group") {
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
    const slot = assignedSlots[index]!;
    commands.push(
      { type: "move", objectId, x: slot.x, y: slot.y },
      { type: "set-parent", objectId, parentGroupId: COMPONENT_LIBRARY_GROUP_ID },
    );
  });
  return commands;
}
