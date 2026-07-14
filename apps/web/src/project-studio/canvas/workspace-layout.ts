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
  page: { width: 280, height: 188 },
  component: { width: 280, height: 188 },
  resource: { width: 240, height: 112 },
} as const satisfies Record<WorkspaceNode["kind"], CanvasSize>;

const FALLBACK_ORIGIN = { x: 80, y: 80 };
const FALLBACK_COLUMNS = 3;
const FALLBACK_COLUMN_STEP = 360;
const FALLBACK_ROW_STEP = 260;
const GROUP_PADDING = 48;

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
  };
}

export function fallbackPosition(index: number): CanvasPoint {
  return {
    x: FALLBACK_ORIGIN.x + (index % FALLBACK_COLUMNS) * FALLBACK_COLUMN_STEP,
    y: FALLBACK_ORIGIN.y + Math.floor(index / FALLBACK_COLUMNS) * FALLBACK_ROW_STEP,
  };
}

export function layoutObjectMap(layout: WorkspaceLayout): Map<string, WorkspaceLayoutObject> {
  return new Map(layout.objects.map((object) => [object.id, object]));
}

export function materializeWorkspaceLayout(
  graph: WorkspaceGraph,
  layout: WorkspaceLayout,
  livePositions?: ReadonlyMap<string, CanvasPoint>,
): WorkspaceLayout {
  const existing = layoutObjectMap(layout);
  const additions: WorkspaceLayoutObject[] = [];
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const occupied = layout.objects
    .filter((object) => object.parentGroupId === null)
    .map((object) => {
      const size = object.kind === "group"
        ? { width: object.width, height: object.height }
        : WORKSPACE_NODE_SIZES[graphNodes.get(object.id)?.kind ?? "page"];
      return { x: object.x, y: object.y, ...size };
    });
  let gridIndex = 0;
  graph.nodes.forEach((node) => {
    if (existing.has(node.id)) return;
    const livePosition = livePositions?.get(node.id);
    const size = WORKSPACE_NODE_SIZES[node.kind];
    let position = livePosition;
    while (!position) {
      const candidate = fallbackPosition(gridIndex++);
      const collision = occupied.some((bounds) => (
        candidate.x < bounds.x + bounds.width + 24
        && candidate.x + size.width + 24 > bounds.x
        && candidate.y < bounds.y + bounds.height + 24
        && candidate.y + size.height + 24 > bounds.y
      ));
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
        objects = objects.map((object) => object.id === command.objectId
          ? { ...object, parentGroupId: command.parentGroupId }
          : object);
        break;
      case "move":
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
