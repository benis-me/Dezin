import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";

export interface MoodboardHistorySnapshot {
  nodes: SaveMoodboardNodeInput[];
  selectedIds: string[];
}

export interface MoodboardHistoryState {
  undoStack: MoodboardHistorySnapshot[];
  redoStack: MoodboardHistorySnapshot[];
}

export const MOODBOARD_HISTORY_LIMIT = 80;

export function createMoodboardHistorySnapshot(
  nodes: Array<MoodboardNode | SaveMoodboardNodeInput>,
  selectedIds: string[],
): MoodboardHistorySnapshot {
  return {
    nodes: nodes.map(cloneMoodboardInput),
    selectedIds: uniqueExistingIds(selectedIds, nodes.map((node) => node.id)),
  };
}

export function pushMoodboardUndo(
  state: MoodboardHistoryState,
  snapshot: MoodboardHistorySnapshot,
  limit = MOODBOARD_HISTORY_LIMIT,
): MoodboardHistoryState {
  const previous = state.undoStack.at(-1);
  if (previous && sameMoodboardHistorySnapshot(previous, snapshot)) return state;
  return {
    undoStack: [...state.undoStack.slice(-limit + 1), cloneMoodboardSnapshot(snapshot)],
    redoStack: [],
  };
}

export function undoMoodboardHistory(
  state: MoodboardHistoryState,
  current: MoodboardHistorySnapshot,
): { state: MoodboardHistoryState; snapshot: MoodboardHistorySnapshot | null } {
  const snapshot = state.undoStack.at(-1);
  if (!snapshot) return { state, snapshot: null };
  return {
    state: {
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, cloneMoodboardSnapshot(current)],
    },
    snapshot: cloneMoodboardSnapshot(snapshot),
  };
}

export function redoMoodboardHistory(
  state: MoodboardHistoryState,
  current: MoodboardHistorySnapshot,
  limit = MOODBOARD_HISTORY_LIMIT,
): { state: MoodboardHistoryState; snapshot: MoodboardHistorySnapshot | null } {
  const snapshot = state.redoStack.at(-1);
  if (!snapshot) return { state, snapshot: null };
  return {
    state: {
      undoStack: [...state.undoStack.slice(-limit + 1), cloneMoodboardSnapshot(current)],
      redoStack: state.redoStack.slice(0, -1),
    },
    snapshot: cloneMoodboardSnapshot(snapshot),
  };
}

export function cloneMoodboardSnapshot(snapshot: MoodboardHistorySnapshot): MoodboardHistorySnapshot {
  return {
    nodes: snapshot.nodes.map(cloneMoodboardInput),
    selectedIds: [...snapshot.selectedIds],
  };
}

export function cloneMoodboardInput(node: MoodboardNode | SaveMoodboardNodeInput): SaveMoodboardNodeInput {
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    data: { ...node.data },
  };
}

export function sameMoodboardNodeInputs(a: SaveMoodboardNodeInput[], b: SaveMoodboardNodeInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((node, index) => sameMoodboardInput(node, b[index]!));
}

export function uniqueExistingIds(ids: string[], existingIds: Array<string | undefined>): string[] {
  const existing = new Set(existingIds.filter((id): id is string => typeof id === "string" && id.length > 0));
  return ids.filter((id, index) => existing.has(id) && ids.indexOf(id) === index);
}

function sameMoodboardHistorySnapshot(a: MoodboardHistorySnapshot, b: MoodboardHistorySnapshot): boolean {
  return sameMoodboardNodeInputs(a.nodes, b.nodes) && a.selectedIds.length === b.selectedIds.length && a.selectedIds.every((id, index) => id === b.selectedIds[index]);
}

function sameMoodboardInput(a: SaveMoodboardNodeInput, b: SaveMoodboardNodeInput): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.rotation === b.rotation &&
    a.zIndex === b.zIndex &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}
