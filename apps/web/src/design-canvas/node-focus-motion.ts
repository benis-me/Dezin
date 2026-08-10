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
  layoutWidth: number;
  layoutHeight: number;
  durationMs: number;
}

export interface FocusedNodeLayoutOptions {
  reservedRight?: number;
  targetWidth?: number;
  horizontalInset?: number;
  topInset?: number;
  bottomInset?: number;
}

export const NODE_FOCUS_FLIGHT_DURATION_MS = 380;
export const NODE_FOCUS_MAX_FLIGHT_DURATION_MS = 460;
export const NODE_FOCUS_DETAIL_DELAY_MS = 110;

export function nodeFocusEase(progress: number): number {
  const value = Math.max(0, Math.min(1, progress));
  return 1 - ((1 - value) ** 3);
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
  const layoutWidth = roundMotionValue(clamp(options.targetWidth ?? availableWidth, 280, availableWidth));
  const layoutHeight = roundMotionValue(availableHeight);
  const targetCenterX = horizontalInset + availableWidth / 2;
  const targetCenterY = topInset + availableHeight / 2;
  const layoutCenterX = geometry.x + layoutWidth / 2;
  const layoutCenterY = geometry.y + layoutHeight / 2;
  const currentScreenCenterX = layoutCenterX * viewportZoom + viewport.x;
  const currentScreenCenterY = layoutCenterY * viewportZoom + viewport.y;

  const screenShiftX = targetCenterX - currentScreenCenterX;
  const screenShiftY = targetCenterY - currentScreenCenterY;
  const startX = (geometry.width - layoutWidth) / 2;
  const startY = (geometry.height - layoutHeight) / 2;
  const shiftX = screenShiftX / viewportZoom;
  const shiftY = screenShiftY / viewportZoom;
  const startScaleX = geometry.width / layoutWidth;
  const startScaleY = geometry.height / layoutHeight;
  const focusedScale = 1 / viewportZoom;
  const scaleTravel = Math.hypot(
    layoutWidth * Math.abs(focusedScale - startScaleX) * viewportZoom / 2,
    layoutHeight * Math.abs(focusedScale - startScaleY) * viewportZoom / 2,
  );
  const screenDistance = Math.hypot((shiftX - startX) * viewportZoom, (shiftY - startY) * viewportZoom);
  const perceivedTravel = screenDistance + scaleTravel;
  const curve = curvedOffset(
    shiftX - startX,
    shiftY - startY,
    clamp(Math.sqrt(screenDistance) * 1.25 / viewportZoom, 0, 36 / viewportZoom),
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
    layoutWidth,
    layoutHeight,
    durationMs: focusFlightDuration(perceivedTravel),
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
