import type { MoodboardNode } from "../lib/api.ts";
import {
  assetUrl,
  generatorPrompt,
  isNodeLocked,
  isNodeVisible,
  layerLabel,
  nodeFill,
  nodeStroke,
  nodeText,
  nodeTitle,
  promptText,
  type LeaferRuntime,
} from "./canvas-utils.ts";

export function makeNodeFrame(
  runtime: LeaferRuntime,
  node: MoodboardNode,
  onSelect: (id: string) => void,
): any {
  const { Frame, Rect, Image, Text, PointerEvent } = runtime;
  const radius = node.type === "section" ? 6 : 8;
  const locked = isNodeLocked(node);
  const visible = isNodeVisible(node);
  const frame = new Frame({
    id: node.id,
    name: layerLabel(node),
    className: "MoodboardNode",
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation ?? 0,
    zIndex: node.zIndex ?? 0,
    visible,
    fill: "transparent",
    strokeWidth: 0,
    draggable: !locked,
    editable: !locked,
    locked,
    isSnap: true,
    lockRatio: node.type === "image" || node.type === "video",
    resizeChildren: true,
    data: { nodeId: node.id, node },
  });

  if (PointerEvent.DOWN) {
    frame.on(PointerEvent.DOWN, () => {
      onSelect(node.id);
    });
  }

  frame.on(PointerEvent.TAP, (event: any) => {
    event?.stop?.();
    onSelect(node.id);
  });

  if (node.type === "image") {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: nodeFill(node),
        cornerRadius: radius,
        data: { nodeId: node.id },
      }),
    );
    if (assetUrl(node)) {
      frame.add(
        new Image({
          url: assetUrl(node),
          x: 0,
          y: 0,
          width: node.width,
          height: node.height,
          cornerRadius: radius,
          data: { nodeId: node.id },
        }),
      );
    }
    if (promptText(node)) {
      frame.add(
        new Rect({
          x: 0,
          y: Math.max(0, node.height - 44),
          width: node.width,
          height: 44,
          fill: "rgba(255,255,255,0.86)",
          data: { nodeId: node.id },
        }),
      );
      frame.add(
        new Text({
          text: promptText(node),
          x: 10,
          y: Math.max(0, node.height - 36),
          width: Math.max(24, node.width - 20),
          fontSize: 11,
          lineHeight: 15,
          fill: "#5f5f5f",
          data: { nodeId: node.id },
        }),
      );
    }
  } else if (node.type === "section") {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: nodeFill(node),
        stroke: nodeStroke(node),
        strokeWidth: 1,
        dashPattern: [8, 6],
        cornerRadius: radius,
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: nodeTitle(node),
        x: 12,
        y: 10,
        width: Math.max(24, node.width - 24),
        fontSize: 13,
        fontWeight: 600,
        fill: "#222222",
        data: { nodeId: node.id },
      }),
    );
  } else if (node.type === "image-generator") {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: nodeFill(node),
        stroke: nodeStroke(node),
        strokeWidth: 1,
        dashPattern: [10, 7],
        cornerRadius: 10,
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: "+",
        x: 0,
        y: Math.max(24, node.height / 2 - 56),
        width: node.width,
        fontSize: 58,
        fontWeight: 300,
        textAlign: "center",
        fill: "#b8b8b2",
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: "Image generator",
        x: 18,
        y: Math.max(24, node.height / 2 + 12),
        width: Math.max(24, node.width - 36),
        fontSize: 14,
        fontWeight: 600,
        textAlign: "center",
        fill: "#41413d",
        data: { nodeId: node.id },
      }),
    );
    const prompt = generatorPrompt(node);
    frame.add(
      new Text({
        text: prompt || "Select this node and write a prompt below.",
        x: 22,
        y: Math.max(48, node.height / 2 + 38),
        width: Math.max(24, node.width - 44),
        fontSize: 11,
        lineHeight: 15,
        textAlign: "center",
        fill: prompt ? "#6f6f68" : "#9b9b94",
        data: { nodeId: node.id },
      }),
    );
  } else if (node.type === "video") {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: nodeFill(node),
        stroke: nodeStroke(node),
        strokeWidth: 1,
        cornerRadius: radius,
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: "Video",
        x: 0,
        y: Math.max(0, node.height / 2 - 8),
        width: node.width,
        fontSize: 13,
        textAlign: "center",
        fill: "#777777",
        data: { nodeId: node.id },
      }),
    );
  } else {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: nodeFill(node),
        stroke: nodeStroke(node),
        strokeWidth: 1,
        cornerRadius: radius,
        shadow: { x: 0, y: 1, blur: 2, color: "rgba(0,0,0,0.04)" },
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: "Note",
        x: 12,
        y: 10,
        width: Math.max(24, node.width - 24),
        fontSize: 11,
        fill: "#8a7b16",
        data: { nodeId: node.id },
      }),
    );
    frame.add(
      new Text({
        text: nodeText(node) || "New note",
        x: 12,
        y: 34,
        width: Math.max(24, node.width - 24),
        height: Math.max(24, node.height - 46),
        fontSize: 14,
        lineHeight: 20,
        fill: "#24210f",
        data: { nodeId: node.id },
      }),
    );
  }

  frame.children?.forEach?.((child: any) => {
    child.draggable = false;
    child.editable = false;
    child.data = { ...(child.data ?? {}), nodeId: node.id };
  });

  return frame;
}
