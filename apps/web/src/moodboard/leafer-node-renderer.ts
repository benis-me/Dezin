import type { MoodboardNode } from "../lib/api.ts";
import {
  assetUrl,
  generatorPrompt,
  isNodeLocked,
  isNodeVisible,
  layerLabel,
  nodeText,
  nodeTitle,
  promptText,
  type LeaferRuntime,
} from "./canvas-utils.ts";

export function makeNodeFrame(
  runtime: LeaferRuntime,
  node: MoodboardNode,
  selected: boolean,
  hovered: boolean,
  onSelect: (id: string) => void,
): any {
  const { Frame, Rect, Image, Text, PointerEvent } = runtime;
  const radius = node.type === "section" ? 6 : 8;
  const locked = isNodeLocked(node);
  const visible = isNodeVisible(node);
  const selectionStroke = selected ? "#2563eb" : hovered ? "#9ca3af" : undefined;
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
        fill: "#efefed",
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
        fill: "rgba(255,255,255,0.24)",
        stroke: selectionStroke ?? "#cfcfca",
        strokeWidth: selected || hovered ? 2 : 1,
        dashPattern: selected ? undefined : [8, 6],
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
        fill: "#f4f4f2",
        stroke: selectionStroke ?? "#d7d7d2",
        strokeWidth: selected || hovered ? 2 : 1,
        dashPattern: selected ? undefined : [10, 7],
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
        fill: "#f1f1ef",
        stroke: "#d7d7d2",
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
        fill: "#fff8c7",
        stroke: selectionStroke ?? "#e7d980",
        strokeWidth: selected || hovered ? 2 : 1,
        cornerRadius: radius,
        shadow: selected ? undefined : { x: 0, y: 6, blur: 18, color: "rgba(0,0,0,0.08)" },
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

  if ((selected || hovered) && node.type !== "section" && node.type !== "note" && node.type !== "image-generator") {
    frame.add(
      new Rect({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: "transparent",
        stroke: selectionStroke ?? "#2563eb",
        strokeWidth: selected ? 2 : 1,
        cornerRadius: radius,
        data: { nodeId: node.id },
      }),
    );
  }

  return frame;
}
