import { expect, test } from "vitest";

import {
  focusedNodeTransform,
  NODE_FOCUS_DETAIL_DELAY_MS,
  NODE_FOCUS_FLIGHT_DURATION_MS,
  NODE_FOCUS_MAX_FLIGHT_DURATION_MS,
  nodeFocusAnimationFrames,
  nodeFocusEase,
  nodeFocusMotions,
} from "./node-focus-motion.ts";
import type { DesignNode } from "./types.ts";

function geometry(x: number, y: number, width = 400, height = 300): DesignNode["geometry"] {
  return { x, y, width, height };
}

const nodes = [
  { id: "focus", geometry: geometry(0, 0) },
  { id: "near-right", geometry: geometry(460, 20) },
  { id: "far-right", geometry: geometry(1_600, 80) },
  { id: "left", geometry: geometry(-760, -120) },
];

test("Node focus motion radiates away from the opened Node along bounded curved paths", () => {
  const sourceTransform = focusedNodeTransform(nodes[0]!.geometry, { width: 1_280, height: 720 }, { x: 80, y: 40, zoom: 0.8 });
  const motion = nodeFocusMotions(nodes, "focus", "opening", sourceTransform);
  const source = motion.get("focus");
  const near = motion.get("near-right");
  const far = motion.get("far-right");
  const left = motion.get("left");

  expect(source).toMatchObject({ role: "source", ...sourceTransform });
  expect(near?.role).toBe("away");
  expect(near?.shiftX).toBeGreaterThan(0);
  expect(left?.shiftX).toBeLessThan(0);
  expect(Math.hypot(near?.arcX ?? 0, near?.arcY ?? 0)).toBeGreaterThan(0);
  expect(Math.hypot(near?.shiftX ?? 0, near?.shiftY ?? 0)).toBeGreaterThan(
    Math.hypot(far?.shiftX ?? 0, far?.shiftY ?? 0),
  );
  expect(far?.delayMs).toBeGreaterThan(near?.delayMs ?? 0);
  expect(far?.durationMs).toBeLessThan(near?.durationMs ?? 0);
});

test("closing preserves each flight path so an in-progress opening can reverse without a jump", () => {
  const transform = focusedNodeTransform(nodes[0]!.geometry, { width: 1_280, height: 720 }, { x: 0, y: 0, zoom: 0.7 });
  const opening = nodeFocusMotions(nodes, "focus", "opening", transform);
  const closing = nodeFocusMotions(nodes, "focus", "closing", transform);

  for (const node of nodes) {
    const before = opening.get(node.id)!;
    const after = closing.get(node.id)!;
    expect(after.shiftX).toBe(before.shiftX);
    expect(after.shiftY).toBe(before.shiftY);
    expect(after.arcX).toBe(before.arcX);
    expect(after.arcY).toBe(before.arcY);
    expect(after.role).toBe(node.id === "focus" ? "source" : "restoring");
    if (node.id !== "focus") expect(after.durationMs).toBeLessThan(before.durationMs);
  }
});

test("focused Node flies to the exact viewport center at a bounded adaptive preview scale without moving the canvas", () => {
  const node = geometry(1_000, 500, 800, 600);
  const viewport = { x: -180, y: 75, zoom: 0.5 };
  const transform = focusedNodeTransform(node, { width: 1_600, height: 900 }, viewport);
  const finalCenterX = (node.x + node.width / 2 + transform.shiftX) * viewport.zoom + viewport.x;
  const finalCenterY = (node.y + node.height / 2 + transform.shiftY) * viewport.zoom + viewport.y;

  expect(finalCenterX).toBeCloseTo(800, 4);
  expect(finalCenterY).toBeCloseTo(450, 4);
  expect(node.width * viewport.zoom * transform.scale).toBeCloseTo(node.width * 1.28, 4);
  expect(node.height * viewport.zoom * transform.scale).toBeCloseTo(node.height * 1.28, 4);
});

test("focused scale adapts continuously to window height while preserving center", () => {
  const node = geometry(240, 160, 800, 600);
  const viewport = { x: 20, y: -30, zoom: 0.6 };
  const short = focusedNodeTransform(node, { width: 1_200, height: 620 }, viewport);
  const tall = focusedNodeTransform(node, { width: 1_200, height: 920 }, viewport);
  const shortScreenScale = viewport.zoom * short.scale;
  const tallScreenScale = viewport.zoom * tall.scale;

  expect(shortScreenScale).toBeCloseTo((620 - 112) / 600, 4);
  expect(tallScreenScale).toBeGreaterThan(shortScreenScale);
  expect(tallScreenScale).toBeLessThanOrEqual(1.28);
});

test("longer flights receive more time so near and far openings keep a consistent perceived rate", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const near = focusedNodeTransform(geometry(390, 210), { width: 1_200, height: 720 }, viewport);
  const far = focusedNodeTransform(geometry(-900, -600), { width: 1_200, height: 720 }, viewport);

  expect(near.durationMs).toBeGreaterThanOrEqual(NODE_FOCUS_FLIGHT_DURATION_MS);
  expect(far.durationMs).toBeGreaterThan(near.durationMs);
  expect(far.durationMs).toBeLessThanOrEqual(NODE_FOCUS_MAX_FLIGHT_DURATION_MS);
});

test("sampled focus frames follow a real curve with continuous progress rather than a two-segment pause", () => {
  const motion = nodeFocusMotions(
    [{ id: "focus", geometry: geometry(0, 0) }],
    "focus",
    "opening",
    { shiftX: 420, shiftY: 120, arcX: -18, arcY: -28, scale: 1.4, durationMs: 500 },
  ).get("focus")!;
  const frames = nodeFocusAnimationFrames(motion);
  const translations = frames.map((frame) => {
    const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(frame.transform)!;
    return { x: Number(match[1]), y: Number(match[2]) };
  });
  const middle = translations[Math.floor(translations.length / 2)]!;

  expect(Math.abs(middle.x * motion.shiftY - middle.y * motion.shiftX)).toBeGreaterThan(100);
  for (let index = 1; index < translations.length; index += 1) {
    expect(Math.hypot(
      translations[index]!.x - translations[index - 1]!.x,
      translations[index]!.y - translations[index - 1]!.y,
    )).toBeGreaterThan(0);
  }
});

test("focus easing starts promptly, settles smoothly, and delays detail behind the flight", () => {
  expect(NODE_FOCUS_FLIGHT_DURATION_MS).toBe(420);
  expect(NODE_FOCUS_MAX_FLIGHT_DURATION_MS).toBe(540);
  expect(NODE_FOCUS_DETAIL_DELAY_MS).toBe(130);
  expect(NODE_FOCUS_DETAIL_DELAY_MS).toBeLessThan(NODE_FOCUS_FLIGHT_DURATION_MS);
  expect(nodeFocusEase(0)).toBe(0);
  expect(nodeFocusEase(0.25)).toBeGreaterThan(0.25);
  expect(nodeFocusEase(0.5)).toBeGreaterThan(0.5);
  expect(nodeFocusEase(0.75)).toBeGreaterThan(0.75);
  expect(nodeFocusEase(1)).toBe(1);
});
