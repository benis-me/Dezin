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

interface FloatingRectBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface FloatingRectInput {
  containerWidth: number;
  containerHeight: number;
  containerLeft: number;
  containerTop: number;
  frame: FloatingRectBounds;
  tree?: { x?: number; y?: number; scale?: number; scaleX?: number };
  world?: FloatingRectBounds | null;
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

function dataColor(node: MoodboardNode, key: "fill" | "stroke", fallback: string): string {
  const value = node.data[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function nodeFill(node: MoodboardNode): string {
  if (node.type === "note") return dataColor(node, "fill", "#fff8c7");
  if (node.type === "section") return dataColor(node, "fill", "rgba(255,255,255,0.24)");
  if (node.type === "image-generator") return dataColor(node, "fill", "#f4f4f2");
  return dataColor(node, "fill", "#efefed");
}

export function nodeStroke(node: MoodboardNode): string {
  if (node.type === "note") return dataColor(node, "stroke", "#e7d980");
  if (node.type === "section") return dataColor(node, "stroke", "#cfcfca");
  if (node.type === "image-generator") return dataColor(node, "stroke", "#d7d7d2");
  return dataColor(node, "stroke", "#e7e7e2");
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

export function sameFloatingRect(a: FloatingRect | null, b: FloatingRect | null, tolerance = 0.5): boolean {
  return (
    a === b ||
    (a != null &&
      b != null &&
      Math.abs(a.left - b.left) < tolerance &&
      Math.abs(a.top - b.top) < tolerance &&
      Math.abs(a.bottom - b.bottom) < tolerance)
  );
}

export function resolveFloatingRect({
  containerWidth,
  containerHeight,
  containerLeft,
  containerTop,
  frame,
  tree,
  world,
}: FloatingRectInput): FloatingRect {
  const scale = Number(tree?.scale ?? tree?.scaleX ?? 1) || 1;
  const frameWidth = Number(frame.width ?? 160);
  const frameHeight = Number(frame.height ?? 120);
  const fallbackLeft = Number(tree?.x ?? 0) + (Number(frame.x ?? 0) + frameWidth / 2) * scale;
  const fallbackTop = Number(tree?.y ?? 0) + Number(frame.y ?? 0) * scale - 44;
  const fallbackBottom = Number(tree?.y ?? 0) + (Number(frame.y ?? 0) + frameHeight) * scale + 12;
  const rawLeft = world ? Number(world.x ?? 0) - containerLeft + Number(world.width ?? frameWidth) / 2 : fallbackLeft;
  const rawTop = world ? Number(world.y ?? 0) - containerTop - 44 : fallbackTop;
  const rawBottom = world ? Number(world.y ?? 0) - containerTop + Number(world.height ?? frameHeight) + 12 : fallbackBottom;

  return {
    left: Math.max(16, Math.min(containerWidth - 16, rawLeft)),
    top: Math.max(12, Math.min(containerHeight - 56, rawTop)),
    bottom: Math.max(12, Math.min(containerHeight - 132, rawBottom)),
  };
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
  const source = event?.origin ?? event?.nativeEvent ?? event?.event ?? event;
  return {
    x: Number(source?.clientX ?? source?.x ?? event?.clientX ?? event?.x ?? 0),
    y: Number(source?.clientY ?? source?.y ?? event?.clientY ?? event?.y ?? 0),
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
