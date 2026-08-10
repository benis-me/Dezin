import type { Viewport } from "@xyflow/react";

import type { DesignNode } from "./types.ts";

export type NodeFocusPhase = "opening" | "closing";
export type NodeFocusRole = "source" | "away" | "restoring";

export interface NodeFocusMotion {
  phase: NodeFocusPhase;
  role: NodeFocusRole;
  shiftX: number;
  shiftY: number;
  arcX: number;
  arcY: number;
  scale: number;
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
  shiftX: number;
  shiftY: number;
  arcX: number;
  arcY: number;
  scale: number;
  durationMs: number;
}

export const NODE_FOCUS_FLIGHT_DURATION_MS = 420;
export const NODE_FOCUS_MAX_FLIGHT_DURATION_MS = 540;
export const NODE_FOCUS_DETAIL_DELAY_MS = 130;

export function nodeFocusEase(progress: number): number {
  const value = Math.max(0, Math.min(1, progress));
  return 1 - ((1 - value) ** 3);
}

export function nodeFocusMotions(
  nodes: readonly FocusMotionNode[],
  focusedNodeId: string,
  phase: NodeFocusPhase,
  focusedTransform: FocusedNodeTransform = {
    shiftX: 0,
    shiftY: 0,
    arcX: 0,
    arcY: 0,
    scale: 1,
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
        shiftX: focusedTransform.shiftX,
        shiftY: focusedTransform.shiftY,
        arcX: focusedTransform.arcX,
        arcY: focusedTransform.arcY,
        scale: focusedTransform.scale,
        durationMs: focusedTransform.durationMs,
        delayMs: 0,
        fadeDurationMs: 180,
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
    const displacement = 44 + (1 - normalizedDistance) * 72;
    const openingShift = {
      x: Math.round(direction.x * displacement * 100) / 100,
      y: Math.round(direction.y * displacement * 100) / 100,
    };
    const curve = curvedOffset(openingShift.x, openingShift.y, clamp(displacement * 0.12, 7, 14));

    result.set(node.id, {
      phase,
      role: phase === "opening" ? "away" : "restoring",
      shiftX: openingShift.x,
      shiftY: openingShift.y,
      arcX: curve.x,
      arcY: curve.y,
      scale: 1,
      durationMs: phase === "opening"
        ? Math.round(clamp(320 + displacement, 360, 440))
        : Math.round(clamp(285 + displacement * 0.9, 325, 405)),
      delayMs: phase === "opening"
        ? Math.round(normalizedDistance * 42)
        : Math.round((1 - normalizedDistance) * 14),
      fadeDurationMs: phase === "opening"
        ? Math.round(170 + normalizedDistance * 55)
        : Math.round(140 + normalizedDistance * 35),
    });
  });

  return result;
}

export function focusedNodeTransform(
  geometry: DesignNode["geometry"],
  surface: SurfaceSize,
  viewport: Viewport,
): FocusedNodeTransform {
  const width = surface.width > 0 ? surface.width : 1_280;
  const height = surface.height > 0 ? surface.height : 720;
  const viewportZoom = Math.max(0.01, viewport.zoom);
  const availableWidth = Math.max(240, width - 96);
  const availableHeight = Math.max(180, height - 112);
  const focusedScreenScale = clamp(
    Math.min(availableWidth / geometry.width, availableHeight / geometry.height),
    0.4,
    1.28,
  );
  const centerX = geometry.x + geometry.width / 2;
  const centerY = geometry.y + geometry.height / 2;
  const currentScreenCenterX = centerX * viewportZoom + viewport.x;
  const currentScreenCenterY = centerY * viewportZoom + viewport.y;

  const screenShiftX = width / 2 - currentScreenCenterX;
  const screenShiftY = height / 2 - currentScreenCenterY;
  const scaleTravel = Math.hypot(
    geometry.width * Math.abs(focusedScreenScale - viewportZoom) / 2,
    geometry.height * Math.abs(focusedScreenScale - viewportZoom) / 2,
  );
  const screenDistance = Math.hypot(screenShiftX, screenShiftY);
  const perceivedTravel = screenDistance + scaleTravel;
  const curve = curvedOffset(
    screenShiftX / viewportZoom,
    screenShiftY / viewportZoom,
    clamp(Math.sqrt(screenDistance) * 1.25 / viewportZoom, 0, 36 / viewportZoom),
  );

  return {
    shiftX: roundMotionValue(screenShiftX / viewportZoom),
    shiftY: roundMotionValue(screenShiftY / viewportZoom),
    arcX: roundMotionValue(curve.x),
    arcY: roundMotionValue(curve.y),
    scale: roundMotionValue(focusedScreenScale / viewportZoom),
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
    const controlX = motion.shiftX * 0.5 + motion.arcX * 2;
    const controlY = motion.shiftY * 0.5 + motion.arcY * 2;
    const x = 2 * inverse * progress * controlX + progress * progress * motion.shiftX;
    const y = 2 * inverse * progress * controlY + progress * progress * motion.shiftY;
    const scale = 1 + (motion.scale - 1) * progress;
    return {
      offset,
      transform: `translate3d(${roundMotionValue(x)}px, ${roundMotionValue(y)}px, 0) scale(${roundMotionValue(scale)})`,
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
