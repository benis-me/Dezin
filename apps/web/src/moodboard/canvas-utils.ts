import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";

export type MoodboardCanvasTool = "select" | "hand" | "note" | "section";

export interface ContextMenuState {
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
  targetId: string | null;
}

export interface FloatingRect {
  left: number;
  top: number;
  bottom: number;
}

export interface LeaferRuntime {
  app: any;
  layer: any;
  Frame: any;
  Rect: any;
  Image: any;
  Text: any;
  PointerEvent: any;
  DragEvent: any;
  EditorEvent: any;
  EditorMoveEvent: any;
  EditorRotateEvent: any;
  EditorScaleEvent: any;
  ZoomEvent: any;
}

export interface LayerTreeItem {
  node: MoodboardNode;
  children: LayerTreeItem[];
}

export function localId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function toInput(node: MoodboardNode): SaveMoodboardNodeInput {
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    data: node.data,
  };
}

export function nodeText(node: MoodboardNode): string {
  const content = node.data.content;
  return typeof content === "string" ? content : "";
}

export function nodeTitle(node: MoodboardNode): string {
  const title = node.data.title;
  return typeof title === "string" ? title : node.type === "section" ? "Section" : node.type === "image" ? "Image" : "Note";
}

export function assetUrl(node: MoodboardNode): string {
  const url = node.data.url;
  return typeof url === "string" ? url : "";
}

export function promptText(node: MoodboardNode): string {
  const prompt = node.data.prompt;
  return typeof prompt === "string" ? prompt : "";
}

export function fileName(node: MoodboardNode): string {
  const name = node.data.fileName;
  return typeof name === "string" ? name : "";
}

export function dataName(node: MoodboardNode): string {
  const name = node.data.name;
  return typeof name === "string" ? name.trim() : "";
}

export function isNodeVisible(node: MoodboardNode): boolean {
  return node.data.visible !== false;
}

export function isNodeLocked(node: MoodboardNode): boolean {
  return node.data.locked === true;
}

export function generatorPrompt(node: MoodboardNode): string {
  const prompt = node.data.generatorPrompt;
  return typeof prompt === "string" ? prompt : "";
}

export function generatorStatus(node: MoodboardNode): string {
  const status = node.data.generatorStatus;
  return typeof status === "string" ? status : "";
}

export function rounded(value: unknown, fallback = 0): number {
  return Math.round(Number(value ?? fallback));
}

export function numberFromEvent(value: string, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function nodeIdFromTarget(target: any): string | null {
  const first = Array.isArray(target) ? target[0] : target;
  let cur = first;
  while (cur) {
    const nodeId = cur.data?.nodeId;
    if (typeof nodeId === "string") return nodeId;
    cur = cur.parent;
  }
  return null;
}

export function eventClientPoint(event: any): { x: number; y: number } {
  const source = event?.event ?? event;
  return {
    x: Number(source?.clientX ?? event?.clientX ?? 0),
    y: Number(source?.clientY ?? event?.clientY ?? 0),
  };
}

export function eventCanvasPoint(event: any): { x: number; y: number } {
  if (typeof event?.getPagePoint === "function") {
    const point = event.getPagePoint();
    return { x: rounded(point?.x), y: rounded(point?.y) };
  }
  return { x: 0, y: 0 };
}

export function clampMenu(point: { x: number; y: number }): { x: number; y: number } {
  const width = typeof window === "undefined" ? 260 : window.innerWidth;
  const height = typeof window === "undefined" ? 700 : window.innerHeight;
  return {
    x: Math.max(8, Math.min(point.x, width - 224)),
    y: Math.max(8, Math.min(point.y, height - 260)),
  };
}

export function layerLabel(node: MoodboardNode): string {
  const name = dataName(node);
  if (name) return name;
  if (node.type === "image-generator") return generatorPrompt(node) || "Image generator";
  if (node.type === "image") return fileName(node) || promptText(node) || "Image";
  if (node.type === "section") return nodeTitle(node);
  if (node.type === "video") return "Video";
  return nodeText(node) || "Note";
}

function centerInside(parent: MoodboardNode, child: MoodboardNode): boolean {
  if (parent.id === child.id || parent.type !== "section") return false;
  const cx = child.x + child.width / 2;
  const cy = child.y + child.height / 2;
  return cx >= parent.x && cx <= parent.x + parent.width && cy >= parent.y && cy <= parent.y + parent.height;
}

function sortByLayer(a: MoodboardNode, b: MoodboardNode): number {
  return (b.zIndex ?? 0) - (a.zIndex ?? 0);
}

export function buildLayerTree(nodes: MoodboardNode[]): LayerTreeItem[] {
  const sorted = [...nodes].sort(sortByLayer);
  const sections = sorted.filter((node) => node.type === "section");
  const contained = new Set<string>();
  const sectionChildren = new Map<string, MoodboardNode[]>();

  for (const section of sections) {
    const children = sorted.filter((node) => node.type !== "section" && centerInside(section, node));
    children.forEach((child) => contained.add(child.id));
    sectionChildren.set(section.id, children);
  }

  return sorted
    .filter((node) => node.type === "section" || !contained.has(node.id))
    .map((node) => ({
      node,
      children: (sectionChildren.get(node.id) ?? []).map((child) => ({ node: child, children: [] })),
    }));
}
