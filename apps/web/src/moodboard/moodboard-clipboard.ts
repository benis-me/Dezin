import type { MoodboardNodeType, SaveMoodboardNodeInput } from "../lib/api.ts";

/** Marker embedded in the clipboard payload so we only re-hydrate our own copied nodes. */
export const MOODBOARD_CLIPBOARD_MARKER = "dezin/moodboard-nodes";
export const MOODBOARD_CLIPBOARD_VERSION = 1;

const NODE_TYPES: readonly MoodboardNodeType[] = ["image", "image-generator", "note", "section", "video"];

export interface MoodboardClipboardPayload {
  boardId: string;
  nodes: SaveMoodboardNodeInput[];
}

export type ClipboardPasteContent =
  | { kind: "nodes"; boardId: string; nodes: SaveMoodboardNodeInput[] }
  | { kind: "images"; files: File[] }
  | { kind: "none" };

/** Serialize the selected node inputs as a marked JSON payload for the system clipboard's text/plain slot. */
export function serializeMoodboardClipboardNodes(boardId: string, nodes: SaveMoodboardNodeInput[]): string {
  return JSON.stringify({ marker: MOODBOARD_CLIPBOARD_MARKER, version: MOODBOARD_CLIPBOARD_VERSION, boardId, nodes });
}

/** Parse clipboard text back into node inputs, returning null for anything that isn't our payload. */
export function parseMoodboardClipboardNodes(text: string | null | undefined): MoodboardClipboardPayload | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.marker !== MOODBOARD_CLIPBOARD_MARKER || !Array.isArray(value.nodes)) return null;
  const nodes = value.nodes.filter(isNodeInput);
  if (nodes.length === 0 || nodes.length !== value.nodes.length) return null;
  return { boardId: typeof value.boardId === "string" ? value.boardId : "", nodes };
}

/** Decide what a paste should do: re-hydrate our nodes, drop in pasted images, or nothing. */
export function classifyClipboardPaste(input: { text?: string | null; files?: File[] | null }): ClipboardPasteContent {
  const payload = parseMoodboardClipboardNodes(input.text);
  if (payload) return { kind: "nodes", boardId: payload.boardId, nodes: payload.nodes };
  const images = (input.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (images.length > 0) return { kind: "images", files: images };
  return { kind: "none" };
}

/** Clone node inputs for a paste: fresh ids, stacked z-indexes, offset so the top-left node lands on the paste point. */
export function buildPastedNodeInputs(
  nodes: SaveMoodboardNodeInput[],
  options: { point?: { x: number; y: number }; startZIndex: number; createId: () => string },
): Array<SaveMoodboardNodeInput & { id: string }> {
  if (nodes.length === 0) return [];
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const dx = options.point ? options.point.x - minX : 32;
  const dy = options.point ? options.point.y - minY : 32;
  let zIndex = options.startZIndex;
  return nodes.map((node) => ({
    ...node,
    id: options.createId(),
    x: Math.round(node.x + dx),
    y: Math.round(node.y + dy),
    zIndex: zIndex++,
    data: { ...node.data },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNodeInput(value: unknown): value is SaveMoodboardNodeInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === "string" &&
    NODE_TYPES.includes(value.type as MoodboardNodeType) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
