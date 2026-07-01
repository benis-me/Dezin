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

export interface CanvasRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingChromeInput {
  anchor: FloatingRect;
  containerWidth: number;
  containerHeight: number;
  surfaceWidth: number;
  surfaceHeight: number;
  placement: "top" | "bottom";
  occluders?: CanvasRect[];
  padding?: number;
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

export function resolveFloatingChromeRect({
  anchor,
  containerWidth,
  containerHeight,
  surfaceWidth,
  surfaceHeight,
  placement,
  occluders = [],
  padding = 8,
}: FloatingChromeInput): { left: number; top: number } {
  const containerRect = rectFromBounds(0, 0, containerWidth, containerHeight);
  const safeRect = getFloatingChromeSafeRect(containerRect, occluders, padding);
  const availableWidth = Math.max(0, safeRect.width);
  const availableHeight = Math.max(0, safeRect.height);
  const width = Math.min(Math.max(0, surfaceWidth), availableWidth);
  const height = Math.min(Math.max(0, surfaceHeight), availableHeight);
  const targetRect = rectFromBounds(anchor.left, anchor.top, anchor.left, anchor.bottom);
  const anchorRect = intersectRects(targetRect, safeRect) ?? targetRect;
  const placements = placement === "top" ? ["top", "bottom"] : ["bottom", "top"];

  for (const nextPlacement of placements) {
    const top = nextPlacement === "top" ? anchorRect.top - height : anchorRect.bottom;
    if (top >= safeRect.top && top + height <= safeRect.bottom) {
      return {
        left: clamp(anchorRect.left - width / 2, safeRect.left, Math.max(safeRect.left, safeRect.right - width)),
        top,
      };
    }
  }

  const fallbackTop = placement === "top" ? anchorRect.top - height : anchorRect.bottom;
  return {
    left: clamp(anchorRect.left - width / 2, safeRect.left, Math.max(safeRect.left, safeRect.right - width)),
    top: clamp(fallbackTop, safeRect.top, Math.max(safeRect.top, safeRect.bottom - height)),
  };
}

export function rectFromBounds(left: number, top: number, right: number, bottom: number): CanvasRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function getFloatingChromeSafeRect(containerRect: CanvasRect, occluders: CanvasRect[], padding = 8): CanvasRect {
  const edgeThreshold = 24;
  const sideMinHeight = 120;
  const edgeMinWidth = 48;
  let left = containerRect.left + padding;
  let top = containerRect.top + padding;
  let right = containerRect.right - padding;
  let bottom = containerRect.bottom - padding;

  for (const raw of occluders) {
    const rect = intersectRects(containerRect, raw);
    if (!rect) continue;

    const touchesLeft = rect.left <= containerRect.left + edgeThreshold;
    const touchesRight = rect.right >= containerRect.right - edgeThreshold;
    const touchesTop = rect.top <= containerRect.top + edgeThreshold;
    const touchesBottom = rect.bottom >= containerRect.bottom - edgeThreshold;
    const sidePanel = rect.height >= sideMinHeight;

    if (touchesLeft && sidePanel) {
      left = Math.max(left, rect.right + padding);
      continue;
    }
    if (touchesRight && sidePanel) {
      right = Math.min(right, rect.left - padding);
      continue;
    }
    if (touchesTop && rect.width >= edgeMinWidth) {
      top = Math.max(top, rect.bottom + padding);
      continue;
    }
    if (touchesBottom && rect.width >= edgeMinWidth) {
      bottom = Math.min(bottom, rect.top - padding);
    }
  }

  if (right <= left) {
    left = containerRect.left + padding;
    right = containerRect.right - padding;
  }
  if (bottom <= top) {
    top = containerRect.top + padding;
    bottom = containerRect.bottom - padding;
  }

  return rectFromBounds(left, top, right, bottom);
}

function intersectRects(a: CanvasRect, b: CanvasRect): CanvasRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return rectFromBounds(left, top, right, bottom);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function numberFromEvent(value: string, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function nodeIdFromTarget(target: any): string | null {
  const first = Array.isArray(target) ? target[0] : target;
  let cur = first;
  while (cur) {
    const nodeId = cur.data?.nodeId ?? cur.data?.id;
    if (typeof nodeId === "string") return nodeId;
    cur = cur.parent;
  }
  return null;
}

export function contextTargetIdFromEvent(eventTarget: unknown, editorTarget: unknown): string | null {
  return nodeIdFromTarget(eventTarget) ?? nodeIdFromTarget(editorTarget);
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

export function moveContainedNodesWithSections(previous: MoodboardNode[], inputs: SaveMoodboardNodeInput[]): SaveMoodboardNodeInput[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const movedSections = inputs
    .map((input) => {
      if (!input.id) return null;
      const previousNode = previousById.get(input.id);
      if (!previousNode || previousNode.type !== "section") return null;
      const dx = input.x - previousNode.x;
      const dy = input.y - previousNode.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
      return { previousNode, dx, dy };
    })
    .filter((item): item is { previousNode: MoodboardNode; dx: number; dy: number } => Boolean(item));

  if (!movedSections.length) return inputs;

  return inputs.map((input) => {
    if (!input.id) return input;
    const previousNode = previousById.get(input.id);
    if (!previousNode || previousNode.type === "section") return input;
    const movedIndependently = Math.abs(input.x - previousNode.x) >= 0.5 || Math.abs(input.y - previousNode.y) >= 0.5;
    if (movedIndependently) return input;

    const containingSection = movedSections.find(({ previousNode: section }) => centerInside(section, previousNode));
    if (!containingSection) return input;
    return {
      ...input,
      x: input.x + containingSection.dx,
      y: input.y + containingSection.dy,
    };
  });
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

export function reorderLayerInputs(nodes: MoodboardNode[], sourceId: string, targetId: string): SaveMoodboardNodeInput[] {
  if (sourceId === targetId) return nodes.map(toInput);
  const order = [...nodes].sort(sortByLayer);
  const sourceIndex = order.findIndex((node) => node.id === sourceId);
  if (sourceIndex < 0) return nodes.map(toInput);
  const [source] = order.splice(sourceIndex, 1);
  const targetIndex = order.findIndex((node) => node.id === targetId);
  if (!source || targetIndex < 0) return nodes.map(toInput);
  order.splice(targetIndex, 0, source);
  return order.map((node, index) => ({
    ...toInput(node),
    zIndex: order.length - index,
  }));
}
