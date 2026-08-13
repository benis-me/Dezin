const MAX_CANDIDATES = 12;
const MAX_SEARCH_DEPTH = 6;
const MAX_FIND_NODES = 100_000;
const MAX_CANDIDATE_VISITS = 25_000;
const MAX_TOTAL_CANDIDATE_VISITS = 100_000;
const MAX_LAYOUT_NODES = 4_000;
const MAX_LAYOUT_DEPTH = 8;
const MAX_RENDER_AXIS = 8_192;
const MAX_RENDER_PIXELS = 32_000_000;

type FigmaRecord = Record<string, unknown>;

export interface FigmaVisualGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaVisualCandidate {
  nodeId: string;
  selectedNodeId: string;
  name: string;
  type: "FRAME" | "COMPONENT" | "INSTANCE";
  depth: number;
  geometry: FigmaVisualGeometry;
  referenceIndex: number;
  referencePath: string;
  referenceAvailability: "pending" | "available" | "unavailable";
}

type FigmaVisualCandidateDraft = Omit<
  FigmaVisualCandidate,
  "referenceIndex" | "referencePath" | "referenceAvailability"
>;

export interface FigmaVisualProjection {
  layout: Record<string, unknown>;
  candidates: FigmaVisualCandidate[];
  truncated: boolean;
}

function record(value: unknown): FigmaRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as FigmaRecord
    : null;
}

function text(value: unknown, fallback: string, maxBytes = 1_024): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length <= maxBytes) return trimmed;
  let end = Math.max(0, maxBytes - 3);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function nodeId(value: unknown): string | null {
  return isSafeFigmaApiNodeId(value) ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function geometry(value: unknown): FigmaVisualGeometry | null {
  const source = record(value);
  if (!source) return null;
  const x = finite(source.x);
  const y = finite(source.y);
  const width = finite(source.width);
  const height = finite(source.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0
    || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 || width > 1_000_000 || height > 1_000_000) {
    return null;
  }
  return { x, y, width, height };
}

function children(value: FigmaRecord): FigmaRecord[] {
  if (value.children === undefined) return [];
  if (!Array.isArray(value.children)) return [];
  return value.children.map(record).filter((child): child is FigmaRecord => child !== null);
}

function visible(value: FigmaRecord, ancestorsVisible = true): boolean {
  return ancestorsVisible && value.visible !== false && value.opacity !== 0;
}

function renderableBox(value: FigmaVisualGeometry): boolean {
  return value.width <= MAX_RENDER_AXIS && value.height <= MAX_RENDER_AXIS
    && value.width * value.height <= MAX_RENDER_PIXELS;
}

function preferredBox(value: FigmaVisualGeometry): boolean {
  return value.width >= 480 && value.width <= 1_920 && value.height >= 320 && value.height <= 1_440;
}

function visualType(value: unknown): FigmaVisualCandidateDraft["type"] | null {
  return value === "FRAME" || value === "COMPONENT" || value === "INSTANCE" ? value : null;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateOrder(left: FigmaVisualCandidateDraft, right: FigmaVisualCandidateDraft): number {
  const typeRank = { FRAME: 0, COMPONENT: 1, INSTANCE: 2 } as const;
  return typeRank[left.type] - typeRank[right.type]
    || left.depth - right.depth
    || left.geometry.y - right.geometry.y
    || left.geometry.x - right.geometry.x
    || lexical(left.name, right.name)
    || lexical(left.nodeId, right.nodeId);
}

function findNodes(document: FigmaRecord, requested: readonly string[]): { roots: FigmaRecord[]; truncated: boolean } {
  if (requested.length === 0) return { roots: [document], truncated: false };
  const wanted = new Set(requested);
  const found = new Map<string, FigmaRecord>();
  const pending = [document];
  let cursor = 0;
  let visited = 0;
  while (cursor < pending.length && found.size < wanted.size && visited < MAX_FIND_NODES) {
    const current = pending[cursor++]!;
    visited += 1;
    const id = nodeId(current.id);
    if (id && wanted.has(id)) found.set(id, current);
    pending.push(...children(current));
  }
  return {
    roots: requested.map((id) => found.get(id)).filter((node): node is FigmaRecord => node !== undefined),
    truncated: visited >= MAX_FIND_NODES && found.size < wanted.size,
  };
}

function candidatesForRoot(
  root: FigmaRecord,
  selectedNodeId: string,
  aggregateBudget: { remaining: number },
): {
  candidates: FigmaVisualCandidateDraft[];
  truncated: boolean;
} {
  const preferred: FigmaVisualCandidateDraft[] = [];
  const fallback: FigmaVisualCandidateDraft[] = [];
  const pending: Array<{ node: FigmaRecord; depth: number; ancestorsVisible: boolean }> = [
    { node: root, depth: 0, ancestorsVisible: true },
  ];
  let cursor = 0;
  let visited = 0;
  while (cursor < pending.length && visited < MAX_CANDIDATE_VISITS && aggregateBudget.remaining > 0) {
    const current = pending[cursor++]!;
    visited += 1;
    aggregateBudget.remaining -= 1;
    const isVisible = visible(current.node, current.ancestorsVisible);
    const id = nodeId(current.node.id);
    const type = visualType(current.node.type);
    const bounds = geometry(current.node.absoluteBoundingBox);
    const name = text(current.node.name, "Untitled");
    if (isVisible && id && type && bounds && renderableBox(bounds)) {
      const candidate = { nodeId: id, selectedNodeId, name, type, depth: current.depth, geometry: bounds };
      (preferredBox(bounds) ? preferred : fallback).push(candidate);
    }
    if (current.depth >= MAX_SEARCH_DEPTH) continue;
    for (const child of children(current.node)) {
      pending.push({ node: child, depth: current.depth + 1, ancestorsVisible: isVisible });
    }
  }
  return {
    candidates: (preferred.length > 0 ? preferred : fallback).sort(candidateOrder),
    truncated: cursor < pending.length || aggregateBudget.remaining === 0,
  };
}

const VISUAL_PROPERTIES = [
  "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems",
  "counterAxisAlignItems", "itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight",
  "paddingTop", "paddingBottom", "clipsContent", "opacity", "blendMode", "cornerRadius",
  "rectangleCornerRadii", "strokeWeight", "strokeAlign", "fills", "strokes", "effects",
  "constraints", "relativeTransform", "characters", "fontName", "fontSize", "fontWeight",
  "textAlignHorizontal", "textAlignVertical", "textAutoResize", "lineHeight", "letterSpacing",
  "style", "styles", "componentId", "componentProperties",
] as const;

function safeVisualValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return text(value, "", 2_048);
  if (depth >= 5) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeVisualValue(item, depth + 1));
  const source = record(value);
  if (!source) return null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(lexical).slice(0, 64)) {
    if (source[key] !== undefined) result[key] = safeVisualValue(source[key], depth + 1);
  }
  return result;
}

function projectedNode(
  node: FigmaRecord,
  depth: number,
  budget: { nodes: number; truncated: boolean },
): Record<string, unknown> | null {
  if (budget.nodes >= MAX_LAYOUT_NODES) {
    budget.truncated = true;
    return null;
  }
  budget.nodes += 1;
  const result: Record<string, unknown> = {
    id: nodeId(node.id) ?? "unknown",
    name: text(node.name, "Untitled"),
    type: text(node.type, "UNKNOWN", 128),
    visible: visible(node),
    geometry: geometry(node.absoluteBoundingBox),
  };
  for (const property of VISUAL_PROPERTIES) {
    if (node[property] !== undefined) result[property] = safeVisualValue(node[property]);
  }
  if (depth >= MAX_LAYOUT_DEPTH) {
    if (children(node).length > 0) budget.truncated = true;
    return result;
  }
  const projectedChildren = children(node)
    .map((child) => projectedNode(child, depth + 1, budget))
    .filter((child): child is Record<string, unknown> => child !== null);
  if (projectedChildren.length > 0) result.children = projectedChildren;
  return result;
}

export function projectFigmaVisualLayout(
  document: Record<string, unknown>,
  selectedNodeIds: readonly string[],
): FigmaVisualProjection {
  const found = findNodes(document, selectedNodeIds);
  const roots = found.roots;
  if (selectedNodeIds.length > 0 && roots.length !== new Set(selectedNodeIds).size) {
    throw new Error("Figma selected Node tree is incomplete");
  }
  const candidateGroups: FigmaVisualCandidateDraft[][] = [];
  const aggregateCandidateBudget = { remaining: MAX_TOTAL_CANDIDATE_VISITS };
  let traversalTruncated = found.truncated;
  for (const root of roots) {
    const selectedId = nodeId(root.id) ?? "0:0";
    const projected = candidatesForRoot(root, selectedId, aggregateCandidateBudget);
    candidateGroups.push(projected.candidates);
    traversalTruncated ||= projected.truncated;
  }
  const seenCandidateIds = new Set<string>();
  const candidateCursors = candidateGroups.map(() => 0);
  const fairCandidates: FigmaVisualCandidateDraft[] = [];
  while (fairCandidates.length < MAX_CANDIDATES) {
    let progressed = false;
    for (let groupIndex = 0; groupIndex < candidateGroups.length && fairCandidates.length < MAX_CANDIDATES; groupIndex += 1) {
      const group = candidateGroups[groupIndex]!;
      while (candidateCursors[groupIndex]! < group.length) {
        const candidateIndex = candidateCursors[groupIndex]!;
        const candidate = group[candidateIndex]!;
        candidateCursors[groupIndex] = candidateIndex + 1;
        if (seenCandidateIds.has(candidate.nodeId)) continue;
        seenCandidateIds.add(candidate.nodeId);
        fairCandidates.push(candidate);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  if (candidateGroups.some((group, index) => candidateCursors[index]! < group.length)) {
    traversalTruncated = true;
  }
  const stableCandidates = fairCandidates
    .map((candidate, referenceIndex): FigmaVisualCandidate => ({
      ...candidate,
      referenceIndex,
      referencePath: `derived/references/reference-frame-${String(referenceIndex + 1).padStart(3, "0")}.png`,
      referenceAvailability: "pending",
    }));
  const budget = { nodes: 0, truncated: false };
  const selectedNodes = roots
    .map((root) => projectedNode(root, 0, budget))
    .filter((node): node is Record<string, unknown> => node !== null);
  return {
    layout: {
      schemaVersion: 1,
      selectedNodeIds: selectedNodeIds.length > 0 ? [...selectedNodeIds] : selectedNodes.map((node) => node.id),
      selectedNodes,
      candidates: stableCandidates,
      diagnostics: {
        candidateLimit: MAX_CANDIDATES,
        projectedNodeCount: budget.nodes,
        truncated: budget.truncated || traversalTruncated,
      },
    },
    candidates: stableCandidates,
    truncated: budget.truncated || traversalTruncated,
  };
}
import { isSafeFigmaApiNodeId } from "./figma-url.ts";
