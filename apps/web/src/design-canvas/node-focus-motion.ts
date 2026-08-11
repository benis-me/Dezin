import type { Viewport } from "@xyflow/react";

import type { DesignNode } from "./types.ts";

export type NodeFocusPhase = "opening" | "closing";
export type NodeFocusRole = "source" | "away" | "restoring";

export interface NodeFocusMotion {
  phase: NodeFocusPhase;
  role: NodeFocusRole;
  startX: number;
  startY: number;
  shiftX: number;
  shiftY: number;
  arcX: number;
  arcY: number;
  startScaleX: number;
  startScaleY: number;
  scaleX: number;
  scaleY: number;
  /** Kept for callers that only need the uniform focused scale. */
  scale: number;
  startWidth: number | null;
  startHeight: number | null;
  layoutWidth: number | null;
  layoutHeight: number | null;
  durationMs: number;
  delayMs: number;
  fadeDurationMs: number;
}

interface FocusMotionNode {
  id: string;
  geometry: DesignNode["geometry"];
}

interface SurfaceSize {
  width: number;
  height: number;
}

export type FocusedNodeLayoutMode = "web" | "media" | "document" | "code" | "preview";

export interface FocusedNodeContentDescriptor {
  kind: DesignNode["kind"];
  fileName?: string | null;
  mimeType?: string | null;
}

export interface FocusedNodeTransform {
  startX: number;
  startY: number;
  shiftX: number;
  shiftY: number;
  arcX: number;
  arcY: number;
  startScaleX: number;
  startScaleY: number;
  scaleX: number;
  scaleY: number;
  scale: number;
  startWidth: number;
  startHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  durationMs: number;
}

export interface FocusedNodeLayoutOptions {
  reservedRight?: number;
  targetWidth?: number;
  targetHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  contentAspectRatio?: number;
  layoutMode?: FocusedNodeLayoutMode;
  horizontalInset?: number;
  topInset?: number;
  bottomInset?: number;
}

// Focus is an occasional, viewport-scale spatial transition (modal tier), so
// its 380-460ms travel budget is intentional; high-frequency canvas controls
// remain immediate or sub-300ms.
export const NODE_FOCUS_FLIGHT_DURATION_MS = 380;
export const NODE_FOCUS_MAX_FLIGHT_DURATION_MS = 460;
export const NODE_FOCUS_DETAIL_DELAY_MS = 110;

export function nodeFocusEase(progress: number): number {
  const value = Math.max(0, Math.min(1, progress));
  if (value === 0 || value === 1) return value;

  // Strong ease-out from Emil Kowalski's interaction curve. Resolve the
  // cubic-bezier's x coordinate so callers receive the same timing whether
  // they use React Flow, WAAPI samples, or a pure function.
  let lower = 0;
  let upper = 1;
  let parameter = value;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const x = cubicBezierCoordinate(parameter, 0.23, 0.32);
    if (x < value) lower = parameter;
    else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return cubicBezierCoordinate(parameter, 1, 1);
}

/**
 * Chooses a focus surface from content identity, rather than assuming every
 * Node is a full-height webpage. The filename fallback keeps imported text
 * assets useful before their exact Version metadata has reached the Canvas.
 */
export function focusedNodeLayoutMode(content: FocusedNodeContentDescriptor): FocusedNodeLayoutMode {
  const mimeType = content.mimeType?.trim().toLowerCase() ?? "";
  const fileName = content.fileName?.trim().toLowerCase() ?? "";
  const extension = /(?:^|\/)[^/]+(\.[a-z0-9]+)$/.exec(fileName)?.[1] ?? "";

  if (content.kind === "image" || content.kind === "video") return "media";
  // Generated Nodes keep the layout implied by their Canvas kind even though
  // their immutable preview artifact is usually HTML. Otherwise every
  // component, design system, and document would collapse back into the same
  // full-height webpage treatment as soon as Version metadata arrives.
  if (content.kind === "page") return "web";
  if (content.kind === "research" || content.kind === "design-document" || content.kind === "knowledge") {
    return "document";
  }
  if (content.kind !== "document" && content.kind !== "file") return "preview";

  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) return "media";
  if (mimeType === "text/markdown" || extension === ".md" || extension === ".mdx") return "document";
  if (CODE_FILE_EXTENSIONS.has(extension) || CODE_MIME_PATTERN.test(mimeType)) return "code";
  if (content.kind === "document") return "document";
  return "preview";
}

export function nodeFocusMotions(
  nodes: readonly FocusMotionNode[],
  focusedNodeId: string,
  phase: NodeFocusPhase,
  focusedTransform: FocusedNodeTransform = {
    startX: 0,
    startY: 0,
    shiftX: 0,
    shiftY: 0,
    arcX: 0,
    arcY: 0,
    startScaleX: 1,
    startScaleY: 1,
    scaleX: 1,
    scaleY: 1,
    scale: 1,
    startWidth: 0,
    startHeight: 0,
    layoutWidth: 0,
    layoutHeight: 0,
    durationMs: NODE_FOCUS_FLIGHT_DURATION_MS,
  },
): ReadonlyMap<string, NodeFocusMotion> {
  const focused = nodes.find((node) => node.id === focusedNodeId);
  if (!focused) return new Map();
  const focusCenter = center(focused.geometry);
  const distances = nodes.map((node) => distance(center(node.geometry), focusCenter));
  const maximumDistance = Math.max(1, ...distances);
  const result = new Map<string, NodeFocusMotion>();

  nodes.forEach((node, index) => {
    if (node.id === focusedNodeId) {
      result.set(node.id, {
        phase,
        role: "source",
        startX: focusedTransform.startX,
        startY: focusedTransform.startY,
        shiftX: focusedTransform.shiftX,
        shiftY: focusedTransform.shiftY,
        arcX: focusedTransform.arcX,
        arcY: focusedTransform.arcY,
        startScaleX: focusedTransform.startScaleX,
        startScaleY: focusedTransform.startScaleY,
        scaleX: focusedTransform.scaleX,
        scaleY: focusedTransform.scaleY,
        scale: focusedTransform.scale,
        startWidth: focusedTransform.startWidth || focused.geometry.width,
        startHeight: focusedTransform.startHeight || focused.geometry.height,
        layoutWidth: focusedTransform.layoutWidth || focused.geometry.width,
        layoutHeight: focusedTransform.layoutHeight || focused.geometry.height,
        durationMs: focusedTransform.durationMs,
        delayMs: 0,
        fadeDurationMs: 170,
      });
      return;
    }

    const nodeCenter = center(node.geometry);
    const dx = nodeCenter.x - focusCenter.x;
    const dy = nodeCenter.y - focusCenter.y;
    const nodeDistance = Math.hypot(dx, dy);
    const normalizedDistance = Math.min(1, nodeDistance / maximumDistance);
    const direction = nodeDistance > 0.5
      ? { x: dx / nodeDistance, y: dy / nodeDistance }
      : fallbackDirection(node.id, index);
    const proximity = (1 - normalizedDistance) ** 1.55;
    const displacement = 32 + proximity * 112;
    const openingShift = {
      x: Math.round(direction.x * displacement * 100) / 100,
      y: Math.round(direction.y * displacement * 100) / 100,
    };

    result.set(node.id, {
      phase,
      role: phase === "opening" ? "away" : "restoring",
      startX: 0,
      startY: 0,
      shiftX: openingShift.x,
      shiftY: openingShift.y,
      arcX: 0,
      arcY: 0,
      startScaleX: 1,
      startScaleY: 1,
      scaleX: 1,
      scaleY: 1,
      scale: 1,
      startWidth: null,
      startHeight: null,
      layoutWidth: null,
      layoutHeight: null,
      durationMs: Math.round(clamp(300 + displacement * 0.72, 330, 405)),
      delayMs: phase === "opening"
        ? Math.round(normalizedDistance * 28)
        : 0,
      fadeDurationMs: Math.round(150 + normalizedDistance * 35),
    });
  });

  return result;
}

export function focusedNodeTransform(
  geometry: DesignNode["geometry"],
  surface: SurfaceSize,
  viewport: Viewport,
  options: FocusedNodeLayoutOptions = {},
): FocusedNodeTransform {
  const width = surface.width > 0 ? surface.width : 1_280;
  const height = surface.height > 0 ? surface.height : 720;
  const viewportZoom = Math.max(0.01, viewport.zoom);
  const horizontalInset = clamp(options.horizontalInset ?? 28, 16, Math.max(16, width / 4));
  const topInset = clamp(options.topInset ?? 18, 12, Math.max(12, height / 3));
  const bottomInset = clamp(options.bottomInset ?? 72, 32, Math.max(32, height / 2));
  const reservedRight = clamp(options.reservedRight ?? 376, 0, Math.max(0, width - 320));
  const availableWidth = Math.max(280, width - horizontalInset * 2 - reservedRight);
  const availableHeight = Math.max(200, height - topInset - bottomInset);
  const { layoutWidth, layoutHeight } = focusedLayoutSize(
    geometry,
    { width: availableWidth, height: availableHeight },
    options,
  );
  const targetCenterX = horizontalInset + availableWidth / 2;
  const targetCenterY = topInset + availableHeight / 2;
  const layoutCenterX = geometry.x + layoutWidth / 2;
  const layoutCenterY = geometry.y + layoutHeight / 2;
  const canonicalCenterX = geometry.x + geometry.width / 2;
  const canonicalCenterY = geometry.y + geometry.height / 2;
  const currentScreenCenterX = layoutCenterX * viewportZoom + viewport.x;
  const currentScreenCenterY = layoutCenterY * viewportZoom + viewport.y;
  const canonicalScreenCenterX = canonicalCenterX * viewportZoom + viewport.x;
  const canonicalScreenCenterY = canonicalCenterY * viewportZoom + viewport.y;

  const screenShiftX = targetCenterX - currentScreenCenterX;
  const screenShiftY = targetCenterY - currentScreenCenterY;
  // FLIP the canonical card into the focused layout. The focused dimensions
  // can be committed before the first paint while these compositor-only
  // transforms preserve the exact canvas presentation at progress zero.
  const startX = (geometry.width - layoutWidth) / 2;
  const startY = (geometry.height - layoutHeight) / 2;
  const shiftX = screenShiftX / viewportZoom;
  const shiftY = screenShiftY / viewportZoom;
  const startScaleX = geometry.width / layoutWidth;
  const startScaleY = geometry.height / layoutHeight;
  const focusedScale = 1 / viewportZoom;
  const scaleTravel = Math.hypot(
    Math.abs(layoutWidth - geometry.width * viewportZoom) / 2,
    Math.abs(layoutHeight - geometry.height * viewportZoom) / 2,
  );
  const screenDistance = Math.hypot(
    targetCenterX - canonicalScreenCenterX,
    targetCenterY - canonicalScreenCenterY,
  );
  const perceivedTravel = screenDistance + scaleTravel;
  const totalShiftX = shiftX + (layoutWidth - geometry.width) / 2;
  const totalShiftY = shiftY + (layoutHeight - geometry.height) / 2;
  const curve = curvedOffset(
    totalShiftX,
    totalShiftY,
    clamp(Math.sqrt(screenDistance) * 2.75 / viewportZoom, 0, 76 / viewportZoom),
  );

  return {
    startX: roundMotionValue(startX),
    startY: roundMotionValue(startY),
    shiftX: roundMotionValue(shiftX),
    shiftY: roundMotionValue(shiftY),
    arcX: roundMotionValue(curve.x),
    arcY: roundMotionValue(curve.y),
    startScaleX: roundMotionValue(startScaleX),
    startScaleY: roundMotionValue(startScaleY),
    scaleX: roundMotionValue(focusedScale),
    scaleY: roundMotionValue(focusedScale),
    scale: roundMotionValue(focusedScale),
    startWidth: roundMotionValue(geometry.width),
    startHeight: roundMotionValue(geometry.height),
    layoutWidth,
    layoutHeight,
    durationMs: focusFlightDuration(perceivedTravel),
  };
}

function focusedLayoutSize(
  geometry: DesignNode["geometry"],
  available: SurfaceSize,
  options: FocusedNodeLayoutOptions,
): { layoutWidth: number; layoutHeight: number } {
  const mode = options.layoutMode ?? "web";
  if (mode === "web") {
    return containedLayoutSize(
      geometry,
      Math.min(available.width, options.targetWidth ?? Number.POSITIVE_INFINITY),
      Math.min(available.height, options.targetHeight ?? Number.POSITIVE_INFINITY),
    );
  }

  if (mode === "document" || mode === "code") {
    const defaultWidth = mode === "document" ? 720 : 900;
    const defaultHeight = mode === "document" ? 760 : 720;
    const maximumWidth = Math.min(available.width, options.maxWidth ?? defaultWidth);
    const maximumHeight = Math.min(available.height, options.maxHeight ?? defaultHeight);
    return containedLayoutSize(geometry, maximumWidth, maximumHeight);
  }

  const defaultMaxWidth = mode === "media" ? 760 : 960;
  const defaultMaxHeight = mode === "media" ? 640 : 720;
  const maximumScale = mode === "media" ? 1.55 : 1.35;
  const maximumWidth = Math.min(available.width, options.maxWidth ?? defaultMaxWidth, options.targetWidth ?? Number.POSITIVE_INFINITY);
  const maximumHeight = Math.min(available.height, options.maxHeight ?? defaultMaxHeight, options.targetHeight ?? Number.POSITIVE_INFINITY);
  // The outer FLIP must retain the canonical card's aspect ratio. Intrinsic
  // media is contained inside that stable coordinate space until its metadata
  // updates the canonical geometry; using its ratio here would make the outer
  // start scales non-uniform and visibly stretch the media on focus handoff.
  const aspectRatio = mode === "media"
    ? clamp(geometry.width / Math.max(1, geometry.height), 0.05, 20)
    : Number.isFinite(options.contentAspectRatio) && (options.contentAspectRatio ?? 0) > 0
      ? clamp(options.contentAspectRatio!, 0.05, 20)
      : clamp(geometry.width / Math.max(1, geometry.height), 0.05, 20);
  return containedLayoutSize(geometry, maximumWidth, maximumHeight, maximumScale, aspectRatio);
}

function containedLayoutSize(
  geometry: DesignNode["geometry"],
  maximumWidth: number,
  maximumHeight: number,
  maximumScale = Number.POSITIVE_INFINITY,
  aspectRatio = geometry.width / Math.max(1, geometry.height),
): { layoutWidth: number; layoutHeight: number } {
  const ratio = clamp(aspectRatio, 0.05, 20);
  const basisWidth = Math.max(1, geometry.width);
  const basisHeight = basisWidth / ratio;
  const scale = Math.min(maximumScale, maximumWidth / basisWidth, maximumHeight / basisHeight);
  return {
    layoutWidth: roundMotionValue(basisWidth * scale),
    layoutHeight: roundMotionValue(basisHeight * scale),
  };
}

function center(geometry: DesignNode["geometry"]): { x: number; y: number } {
  return {
    x: geometry.x + geometry.width / 2,
    y: geometry.y + geometry.height / 2,
  };
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function curvedOffset(x: number, y: number, magnitude: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length < 0.5 || magnitude <= 0) return { x: 0, y: 0 };
  let arcX = (-y / length) * magnitude;
  let arcY = (x / length) * magnitude;
  if (arcY > 0) {
    arcX *= -1;
    arcY *= -1;
  }
  return { x: roundMotionValue(arcX), y: roundMotionValue(arcY) };
}

function fallbackDirection(id: string, index: number): { x: number; y: number } {
  let hash = index + 1;
  for (let offset = 0; offset < id.length; offset += 1) hash = ((hash * 31) + id.charCodeAt(offset)) >>> 0;
  const angle = (hash % 360) * (Math.PI / 180);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

const CODE_FILE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".cts", ".go", ".graphql", ".gql", ".h", ".hpp",
  ".htm", ".html", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".kts", ".less", ".lua",
  ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".sass", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

const CODE_MIME_PATTERN = /(?:javascript|typescript|json|graphql|yaml|toml|html|xhtml|xml|css|x-(?:c|c\+\+|go|java|python|ruby|rust|shellscript|swift)|sql)/;

export interface NodeFocusAnimationFrame {
  offset: number;
  transform: string;
  opacity: number;
}

export function nodeFocusAnimationFrames(
  motion: NodeFocusMotion,
  fromProgress = motion.phase === "closing" ? 1 : 0,
  toProgress = motion.phase === "closing" ? 0 : 1,
): NodeFocusAnimationFrame[] {
  const fades = motion.role !== "source";
  const samples = 16;
  return Array.from({ length: samples + 1 }, (_, index) => {
    const offset = index / samples;
    const eased = nodeFocusEase(offset);
    const progress = fromProgress + (toProgress - fromProgress) * eased;
    const inverse = 1 - progress;
    const controlX = (motion.startX + motion.shiftX) * 0.5 + motion.arcX * 2;
    const controlY = (motion.startY + motion.shiftY) * 0.5 + motion.arcY * 2;
    const x = inverse * inverse * motion.startX + 2 * inverse * progress * controlX + progress * progress * motion.shiftX;
    const y = inverse * inverse * motion.startY + 2 * inverse * progress * controlY + progress * progress * motion.shiftY;
    const scaleX = motion.startScaleX + (motion.scaleX - motion.startScaleX) * progress;
    const scaleY = motion.startScaleY + (motion.scaleY - motion.startScaleY) * progress;
    return {
      offset,
      transform: `translate3d(${roundMotionValue(x)}px, ${roundMotionValue(y)}px, 0) scale(${roundMotionValue(scaleX)}, ${roundMotionValue(scaleY)})`,
      opacity: fades ? roundMotionValue(1 - progress) : 1,
    };
  });
}

export function focusFlightDuration(perceivedTravel: number): number {
  return Math.round(clamp(
    NODE_FOCUS_FLIGHT_DURATION_MS + Math.sqrt(Math.max(0, perceivedTravel)) * 4.6,
    NODE_FOCUS_FLIGHT_DURATION_MS,
    NODE_FOCUS_MAX_FLIGHT_DURATION_MS,
  ));
}

function roundMotionValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function cubicBezierCoordinate(parameter: number, first: number, second: number): number {
  const inverse = 1 - parameter;
  return 3 * inverse * inverse * parameter * first
    + 3 * inverse * parameter * parameter * second
    + parameter * parameter * parameter;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
