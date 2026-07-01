import type { MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";

export type MoodboardCanvasTool = "select" | "hand" | "note" | "section";
export type MoodboardAlignType = "left" | "center-v" | "right" | "top" | "center-h" | "bottom";

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

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasDrawRect extends CanvasPoint {
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

export interface ClientPointFallback {
  containerLeft: number;
  containerTop: number;
  tree?: { x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number };
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

export function generatorModel(node: MoodboardNode): string {
  const model = node.data.generatorModel;
  return typeof model === "string" ? model : "";
}

export const MOODBOARD_LAYERS_OPEN_KEY = "dezin:moodboard:layers-open";

export function readInitialLayersOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  return storage.getItem(MOODBOARD_LAYERS_OPEN_KEY) === "1";
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

export function sameIdList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable || hasEditableShortcutAncestor(element);
}

export function isTemporaryHandShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return event.key === " " && !event.metaKey && !event.ctrlKey && !event.altKey;
}

function hasEditableShortcutAncestor(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const contentEditable = current.getAttribute("contenteditable");
    if (contentEditable != null && contentEditable.toLowerCase() !== "false") return true;
    if (current.getAttribute("role") === "textbox") return true;
  }
  return false;
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
  const fallbackTop = Number(tree?.y ?? 0) + Number(frame.y ?? 0) * scale - 8;
  const fallbackBottom = Number(tree?.y ?? 0) + (Number(frame.y ?? 0) + frameHeight) * scale + 12;
  const hasLiveTreeTransform =
    tree != null &&
    (tree.x != null || tree.y != null || tree.scale != null || tree.scaleX != null) &&
    frame.x != null &&
    frame.y != null &&
    frame.width != null &&
    frame.height != null;
  let rawLeft = fallbackLeft;
  let rawTop = fallbackTop;
  let rawBottom = fallbackBottom;

  if (!hasLiveTreeTransform && world) {
    const worldWidth = Number(world.width ?? frameWidth);
    const worldHeight = Number(world.height ?? frameHeight);
    const localCandidate = {
      left: Number(world.x ?? 0) + worldWidth / 2,
      top: Number(world.y ?? 0) - 8,
      bottom: Number(world.y ?? 0) + worldHeight + 12,
    };
    const viewportCandidate = {
      left: Number(world.x ?? 0) - containerLeft + worldWidth / 2,
      top: Number(world.y ?? 0) - containerTop - 8,
      bottom: Number(world.y ?? 0) - containerTop + worldHeight + 12,
    };
    const localDistance = floatingCandidateDistance(localCandidate, fallbackLeft, fallbackTop, fallbackBottom);
    const viewportDistance = floatingCandidateDistance(viewportCandidate, fallbackLeft, fallbackTop, fallbackBottom);
    const candidate = localDistance <= viewportDistance ? localCandidate : viewportCandidate;
    rawLeft = candidate.left;
    rawTop = candidate.top;
    rawBottom = candidate.bottom;
  }

  return {
    left: Math.max(16, Math.min(containerWidth - 16, rawLeft)),
    top: Math.max(12, Math.min(containerHeight - 56, rawTop)),
    bottom: Math.max(12, Math.min(containerHeight - 132, rawBottom)),
  };
}

function floatingCandidateDistance(
  candidate: { left: number; top: number; bottom: number },
  left: number,
  top: number,
  bottom: number,
): number {
  return Math.abs(candidate.left - left) + Math.abs(candidate.top - top) + Math.abs(candidate.bottom - bottom);
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

export function normalizeCanvasRect(start: CanvasPoint, end: CanvasPoint): CanvasDrawRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
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

export function nodeIdsFromTarget(target: any): string[] {
  const targets = Array.isArray(target) ? target : [target];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of targets) {
    const id = nodeIdFromTarget(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function contextTargetIdFromEvent(eventTarget: unknown, _editorTarget: unknown): string | null {
  return nodeIdFromTarget(eventTarget);
}

export function eventClientPoint(event: any, fallback?: ClientPointFallback): { x: number; y: number } {
  const source = event?.origin ?? event?.nativeEvent ?? event?.event ?? event;
  if (hasFiniteNumber(source?.clientX) && hasFiniteNumber(source?.clientY)) {
    return { x: Number(source.clientX), y: Number(source.clientY) };
  }
  if (fallback && typeof event?.getPagePoint === "function") {
    const point = event.getPagePoint();
    const scaleX = Number(fallback.tree?.scaleX ?? fallback.tree?.scale ?? 1) || 1;
    const scaleY = Number(fallback.tree?.scaleY ?? fallback.tree?.scale ?? 1) || 1;
    return {
      x: fallback.containerLeft + Number(fallback.tree?.x ?? 0) + Number(point?.x ?? 0) * scaleX,
      y: fallback.containerTop + Number(fallback.tree?.y ?? 0) + Number(point?.y ?? 0) * scaleY,
    };
  }
  return {
    x: Number(source?.x ?? event?.clientX ?? event?.x ?? 0),
    y: Number(source?.y ?? event?.clientY ?? event?.y ?? 0),
  };
}

function hasFiniteNumber(value: unknown): boolean {
  return Number.isFinite(Number(value));
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

export function nudgeNodeInputs(nodes: MoodboardNode[], ids: string[], delta: CanvasPoint): SaveMoodboardNodeInput[] {
  const targetIds = new Set(ids);
  if (targetIds.size === 0) return nodes.map(toInput);
  const inputs = nodes.map((node) => (targetIds.has(node.id) ? { ...toInput(node), x: node.x + delta.x, y: node.y + delta.y } : toInput(node)));
  return moveContainedNodesWithSections(nodes, inputs);
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
