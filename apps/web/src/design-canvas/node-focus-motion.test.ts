import { expect, test } from "vitest";

import { focusVisualFrames, focusVisualStateFromTransform, rebaseFocusVisualState } from "./DesignCanvasNode.tsx";
import {
  focusedNodeLayoutMode,
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

test("focus interruption reads Chromium matrix3d transforms without snapping", () => {
  expect(focusVisualStateFromTransform(
    "matrix3d(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 42, 64, 0, 1)",
    0.75,
  )).toEqual({ x: 42, y: 64, scaleX: 2, scaleY: 3, opacity: 0.75 });
});

test("runtime focus frames stay on compositor properties while returning to the exact canvas presentation", () => {
  const canvas = { x: -160, y: -120, scaleX: 400 / 720, scaleY: 300 / 540, opacity: 1 };
  const focus = { x: 120, y: 80, scaleX: 1.25, scaleY: 1.25, opacity: 1 };
  const opening = focusVisualFrames(canvas, focus, 8, -12);
  const closing = focusVisualFrames(focus, canvas, -8, 12);

  for (const frame of [...opening, ...closing]) {
    expect(frame).not.toHaveProperty("width");
    expect(frame).not.toHaveProperty("height");
    expect(frame).toEqual(expect.objectContaining({ transform: expect.any(String), opacity: expect.any(Number) }));
  }
  expect(opening[0]?.transform).toContain("translate3d(-160px, -120px, 0)");
  expect(closing.at(-1)?.transform).toContain("translate3d(-160px, -120px, 0)");
});

test("focused layout changes rebase the live transform without a visual jump", () => {
  const live = { x: 120, y: 80, scaleX: 1.25, scaleY: 1.4, opacity: 1 };
  const rebased = rebaseFocusVisualState(live, { width: 720, height: 540 }, { width: 600, height: 720 });

  expect(rebased).toEqual({ x: 180, y: -10, scaleX: 1.5, scaleY: 1.05, opacity: 1 });
  expect(720 * live.scaleX).toBeCloseTo(600 * rebased.scaleX, 6);
  expect(540 * live.scaleY).toBeCloseTo(720 * rebased.scaleY, 6);
  expect(720 / 2 + live.x).toBeCloseTo(600 / 2 + rebased.x, 6);
  expect(540 / 2 + live.y).toBeCloseTo(720 / 2 + rebased.y, 6);
});

test("Node focus motion sends surrounding Nodes away on straight paths with stronger displacement nearby", () => {
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
  expect(near).toMatchObject({ startX: 0, startY: 0, arcX: 0, arcY: 0, startScaleX: 1, startScaleY: 1 });
  expect(far).toMatchObject({ arcX: 0, arcY: 0, scaleX: 1, scaleY: 1, layoutWidth: null, layoutHeight: null });
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
    expect(after.durationMs).toBe(before.durationMs);
  }
});

test("focused Node flies to its responsive content slot while preserving a net 1:1 preview scale", () => {
  const node = geometry(1_000, 500, 800, 600);
  const viewport = { x: -180, y: 75, zoom: 0.5 };
  const transform = focusedNodeTransform(node, { width: 1_600, height: 900 }, viewport, {
    reservedRight: 0,
    topInset: 48,
    bottomInset: 48,
  });
  const finalCenterX = (node.x + transform.layoutWidth / 2 + transform.shiftX) * viewport.zoom + viewport.x;
  const finalCenterY = (node.y + transform.layoutHeight / 2 + transform.shiftY) * viewport.zoom + viewport.y;

  expect(finalCenterX).toBeCloseTo(800, 4);
  expect(finalCenterY).toBeCloseTo(450, 4);
  expect(transform.scaleX * viewport.zoom).toBeCloseTo(1, 4);
  expect(transform.scaleY * viewport.zoom).toBeCloseTo(1, 4);
  expect(transform.scale).toBe(transform.scaleX);
  expect(transform).toMatchObject({
    startX: -136,
    startY: -102,
    startWidth: 800,
    startHeight: 600,
    layoutWidth: 1_072,
    layoutHeight: 804,
  });
  expect(transform.startScaleX).toBeCloseTo(800 / 1_072, 4);
  expect(transform.startScaleY).toBeCloseTo(600 / 804, 4);
  expect(transform.startScaleX).toBeCloseTo(transform.startScaleY, 4);
  const sourceMotion = nodeFocusMotions([{ id: "focus", geometry: node }], "focus", "opening", transform).get("focus")!;
  const frames = nodeFocusAnimationFrames(sourceMotion);
  expect(frames[0]).toMatchObject({
    transform: `translate3d(-136px, -102px, 0) scale(${transform.startScaleX}, ${transform.startScaleY})`,
  });
  expect(frames.at(-1)?.transform).toBe(`translate3d(${transform.shiftX}px, ${transform.shiftY}px, 0) scale(2, 2)`);
  for (const frame of frames) {
    expect(frame).not.toHaveProperty("width");
    expect(frame).not.toHaveProperty("height");
  }
});

test("focused layout adapts until the first viewport bound while preserving a uniform content scale", () => {
  const node = geometry(240, 160, 800, 600);
  const viewport = { x: 20, y: -30, zoom: 0.6 };
  const short = focusedNodeTransform(node, { width: 1_200, height: 620 }, viewport);
  const tall = focusedNodeTransform(node, { width: 1_200, height: 920 }, viewport);
  expect(short.layoutHeight).toBe(530);
  expect(short.layoutWidth).toBeCloseTo(706.6667, 4);
  expect(tall.layoutHeight).toBe(576);
  expect(tall.layoutWidth).toBe(768);
  expect(tall.layoutHeight).toBeGreaterThan(short.layoutHeight);
  expect(short.startScaleX).toBeCloseTo(short.startScaleY, 4);
  expect(tall.startScaleX).toBeCloseTo(tall.startScaleY, 4);
  expect(short.scaleX * viewport.zoom).toBeCloseTo(1, 4);
  expect(short.scaleY * viewport.zoom).toBeCloseTo(1, 4);
  expect(tall.scaleX * viewport.zoom).toBeCloseTo(1, 4);
  expect(tall.scaleY * viewport.zoom).toBeCloseTo(1, 4);
});

test("focus layout mode follows the Node's actual content instead of treating every preview as a webpage", () => {
  expect(focusedNodeLayoutMode({ kind: "page", fileName: "landing.html" })).toBe("web");
  expect(focusedNodeLayoutMode({ kind: "document", fileName: "captured-page.html" })).toBe("code");
  expect(focusedNodeLayoutMode({ kind: "component", mimeType: "text/html", fileName: "Hero" })).toBe("preview");
  expect(focusedNodeLayoutMode({ kind: "image", fileName: "poster.png" })).toBe("media");
  expect(focusedNodeLayoutMode({ kind: "video", fileName: "motion.mp4" })).toBe("media");
  expect(focusedNodeLayoutMode({ kind: "document", mimeType: "text/markdown", fileName: "brief.md" })).toBe("document");
  expect(focusedNodeLayoutMode({ kind: "file", fileName: "tokens.ts" })).toBe("code");
  expect(focusedNodeLayoutMode({ kind: "component", fileName: "Hero" })).toBe("preview");
});

test("media focus stays bounded and preserves the Canvas card's intrinsic aspect ratio", () => {
  const node = geometry(300, 220, 420, 280);
  const viewport = { x: 0, y: 0, zoom: 0.75 };
  const transform = focusedNodeTransform(node, { width: 1_600, height: 900 }, viewport, {
    reservedRight: 0,
    layoutMode: "media",
  });

  expect(transform.layoutWidth).toBe(651);
  expect(transform.layoutHeight).toBe(434);
  expect(transform.layoutWidth / transform.layoutHeight).toBeCloseTo(node.width / node.height, 3);
  expect(transform.layoutHeight).toBeLessThan(810);
  expect(transform.startScaleX).toBeCloseTo(node.width / transform.layoutWidth, 4);
  expect(transform.startScaleY).toBeCloseTo(node.height / transform.layoutHeight, 4);
  expect(transform.scaleX * viewport.zoom).toBeCloseTo(1, 4);
  expect(transform.scaleY * viewport.zoom).toBeCloseTo(1, 4);
});

test("special-ratio media keeps one uniform coordinate space across Canvas and focus", () => {
  const node = geometry(300, 220, 400, 300);
  const transform = focusedNodeTransform(
    node,
    { width: 1_600, height: 900 },
    { x: 0, y: 0, zoom: 0.75 },
    {
      reservedRight: 0,
      layoutMode: "media",
      contentAspectRatio: 64 / 27,
    },
  );

  expect(transform.layoutWidth / transform.layoutHeight).toBeCloseTo(node.width / node.height, 4);
  expect(transform.startScaleX).toBeCloseTo(transform.startScaleY, 4);
});

test("documents, code, and webpages use bounded 1:1 surfaces without distorting their Canvas aspect", () => {
  const node = geometry(240, 160, 420, 280);
  const surface = { width: 1_600, height: 900 };
  const viewport = { x: 0, y: 0, zoom: 0.6 };
  const shared = { reservedRight: 0 } as const;
  const web = focusedNodeTransform(node, surface, viewport, { ...shared, layoutMode: "web" });
  const document = focusedNodeTransform(node, surface, viewport, { ...shared, layoutMode: "document" });
  const code = focusedNodeTransform(node, surface, viewport, { ...shared, layoutMode: "code" });
  const preview = focusedNodeTransform(geometry(240, 160, 480, 360), surface, viewport, {
    ...shared,
    layoutMode: "preview",
  });

  expect(web).toMatchObject({ layoutWidth: 1_215, layoutHeight: 810 });
  expect(document).toMatchObject({ layoutWidth: 720, layoutHeight: 480 });
  expect(code).toMatchObject({ layoutWidth: 900, layoutHeight: 600 });
  expect(preview).toMatchObject({ layoutWidth: 648, layoutHeight: 486 });
  for (const transform of [web, document, code, preview]) {
    expect(transform.startScaleX).toBeCloseTo(transform.startScaleY, 4);
    expect(transform.scaleX * viewport.zoom).toBeCloseTo(1, 4);
    expect(transform.scaleY * viewport.zoom).toBeCloseTo(1, 4);
  }
});

test("content-specific focus geometry is deterministic so closing can exactly reverse opening", () => {
  const node = geometry(-520, 410, 320, 190);
  const surface = { width: 1_280, height: 760 };
  const viewport = { x: 72, y: -34, zoom: 0.7 };
  const options = { reservedRight: 360, layoutMode: "document" } as const;

  expect(focusedNodeTransform(node, surface, viewport, options)).toEqual(
    focusedNodeTransform(node, surface, viewport, options),
  );
});

test("longer flights receive more time so near and far openings keep a consistent perceived rate", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const near = focusedNodeTransform(geometry(28, 18, 768, 630), { width: 1_200, height: 720 }, viewport);
  const far = focusedNodeTransform(geometry(-900, -600, 768, 630), { width: 1_200, height: 720 }, viewport);

  expect(near.durationMs).toBeGreaterThanOrEqual(NODE_FOCUS_FLIGHT_DURATION_MS);
  expect(far.durationMs).toBeGreaterThan(near.durationMs);
  expect(far.durationMs).toBeLessThanOrEqual(NODE_FOCUS_MAX_FLIGHT_DURATION_MS);
});

test("focused Node flight keeps a clearly visible curved arc in screen space", () => {
  const viewport = { x: 0, y: 0, zoom: 0.8 };
  const transform = focusedNodeTransform(
    geometry(-920, -620, 520, 340),
    { width: 1_280, height: 760 },
    viewport,
    { reservedRight: 360, layoutMode: "preview" },
  );
  const screenArc = Math.hypot(transform.arcX, transform.arcY) * viewport.zoom;

  expect(screenArc).toBeGreaterThanOrEqual(52);
  expect(screenArc).toBeLessThanOrEqual(76.1);
});

test("sampled focus frames follow a real curve with continuous progress rather than a two-segment pause", () => {
  const motion = nodeFocusMotions(
    [{ id: "focus", geometry: geometry(0, 0) }],
    "focus",
    "opening",
    {
      startX: -20,
      startY: 12,
      shiftX: 420,
      shiftY: 120,
      arcX: -18,
      arcY: -28,
      startScaleX: 0.5,
      startScaleY: 0.75,
      scaleX: 1.4,
      scaleY: 1.4,
      scale: 1.4,
      startWidth: 400,
      startHeight: 300,
      layoutWidth: 900,
      layoutHeight: 700,
      durationMs: 500,
    },
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
  expect(frames[0]?.transform).toContain("translate3d(-20px, 12px, 0)");
  expect(frames.at(-1)?.transform).toContain("translate3d(420px, 120px, 0)");
  expect(frames.every((frame) => !("width" in frame) && !("height" in frame))).toBe(true);
});

test("closing frames return the source renderer to its canonical visual bounds without layout animation", () => {
  const transform = focusedNodeTransform(
    geometry(180, 120, 420, 280),
    { width: 1_280, height: 760 },
    { x: -20, y: 45, zoom: 0.7 },
    { reservedRight: 360, layoutMode: "media" },
  );
  const closing = nodeFocusMotions(nodes, "focus", "closing", transform).get("focus")!;
  const frames = nodeFocusAnimationFrames(closing);

  expect(frames[0]?.transform).toBe(
    `translate3d(${transform.shiftX}px, ${transform.shiftY}px, 0) scale(${transform.scaleX}, ${transform.scaleY})`,
  );
  expect(frames.at(-1)?.transform).toBe(
    `translate3d(${transform.startX}px, ${transform.startY}px, 0) scale(${transform.startScaleX}, ${transform.startScaleY})`,
  );
  expect(frames.every((frame) => !("width" in frame) && !("height" in frame))).toBe(true);
});

test("focus easing starts promptly, settles smoothly, and delays detail behind the flight", () => {
  expect(NODE_FOCUS_FLIGHT_DURATION_MS).toBe(380);
  expect(NODE_FOCUS_MAX_FLIGHT_DURATION_MS).toBe(460);
  expect(NODE_FOCUS_DETAIL_DELAY_MS).toBe(110);
  expect(NODE_FOCUS_DETAIL_DELAY_MS).toBeLessThan(NODE_FOCUS_FLIGHT_DURATION_MS);
  expect(nodeFocusEase(0)).toBe(0);
  expect(nodeFocusEase(0.25)).toBeGreaterThan(0.25);
  expect(nodeFocusEase(0.5)).toBeGreaterThan(0.5);
  expect(nodeFocusEase(0.75)).toBeGreaterThan(0.75);
  expect(nodeFocusEase(1)).toBe(1);
});
