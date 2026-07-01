import { Frame, Img, Rect, Txt } from "@dezin/leafer-react";
import { Platform } from "leafer-editor";
import type { MoodboardNode } from "../lib/api.ts";
import {
  assetUrl,
  generatorPrompt,
  isNodeLocked,
  isNodeVisible,
  nodeFill,
  nodeStroke,
  nodeText,
  nodeTitle,
  promptText,
} from "./canvas-utils.ts";

export function MoodboardCanvasNode({ node }: { node: MoodboardNode }) {
  const radius = node.type === "section" ? 6 : 8;
  const locked = isNodeLocked(node);
  const visible = isNodeVisible(node);
  const data = { nodeId: node.id, node };

  return (
    <Frame
      id={node.id}
      name={nodeLabel(node)}
      className="Node"
      x={node.x}
      y={node.y}
      width={node.width}
      height={node.height}
      rotation={node.rotation ?? 0}
      zIndex={node.zIndex ?? 0}
      visible={visible}
      fill="transparent"
      strokeWidth={0}
      draggable={!locked}
      editable={!locked}
      locked={locked}
      isSnap
      lockRatio={node.type === "image" || node.type === "video" || node.type === "image-generator"}
      resizeChildren
      data={data}
    >
      <NodeBody node={node} radius={radius} data={data} />
    </Frame>
  );
}

function NodeBody({ node, radius, data }: { node: MoodboardNode; radius: number; data: Record<string, unknown> }) {
  if (node.type === "image") {
    return (
      <>
        <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} cornerRadius={radius} data={data} />
        {assetUrl(node) ? (
          <Img url={assetUrl(node)} x={0} y={0} width={node.width} height={node.height} cornerRadius={radius} draggable={false} data={data} />
        ) : null}
        {promptText(node) ? (
          <>
            <Rect x={0} y={Math.max(0, node.height - 44)} width={node.width} height={44} fill="rgba(255,255,255,0.86)" data={data} />
            <Txt
              text={promptText(node)}
              x={10}
              y={Math.max(0, node.height - 36)}
              width={Math.max(24, node.width - 20)}
              fontSize={11}
              lineHeight={15}
              fill="#5f5f5f"
              hittable={false}
              draggable={false}
              data={data}
            />
          </>
        ) : null}
      </>
    );
  }

  if (node.type === "section") {
    return (
      <>
        <Rect
          x={0}
          y={0}
          width={node.width}
          height={node.height}
          fill={nodeFill(node)}
          stroke={nodeStroke(node)}
          strokeWidth={1}
          dashPattern={[8, 6]}
          cornerRadius={radius}
          data={data}
        />
        <Txt
          text={nodeTitle(node)}
          x={12}
          y={10}
          width={Math.max(24, node.width - 24)}
          fontSize={13}
          fontWeight={600}
          fill="#222222"
          hittable={false}
          draggable={false}
          data={data}
        />
      </>
    );
  }

  if (node.type === "image-generator") {
    const iconSize = generatorIconSize(node.width, node.height);
    return (
      <>
        <Rect
          x={0}
          y={0}
          width={node.width}
          height={node.height}
          fill={nodeFill(node)}
          stroke={nodeStroke(node)}
          strokeWidth={1}
          dashPattern={[10, 7]}
          cornerRadius={10}
          data={data}
        />
        <Rect
          x={Math.max(0, (node.width - iconSize) / 2)}
          y={Math.max(0, (node.height - iconSize) / 2)}
          width={iconSize}
          height={iconSize}
          fill={IMAGE_GENERATOR_ICON_FILL}
          hittable={false}
          draggable={false}
          data={data}
        />
      </>
    );
  }

  if (node.type === "video") {
    return (
      <>
        <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} stroke={nodeStroke(node)} strokeWidth={1} cornerRadius={radius} data={data} />
        <Txt
          text="Video"
          x={0}
          y={Math.max(0, node.height / 2 - 8)}
          width={node.width}
          fontSize={13}
          textAlign="center"
          fill="#777777"
          hittable={false}
          draggable={false}
          data={data}
        />
      </>
    );
  }

  return (
    <>
      <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} stroke={nodeStroke(node)} strokeWidth={1} cornerRadius={radius} data={data} />
      <Txt text="Note" x={12} y={10} width={Math.max(24, node.width - 24)} fontSize={11} fill="#8a7b16" hittable={false} draggable={false} data={data} />
      <Txt
        text={nodeText(node) || "New note"}
        x={12}
        y={34}
        width={Math.max(24, node.width - 24)}
        height={Math.max(24, node.height - 46)}
        fontSize={14}
        lineHeight={20}
        fill="#24210f"
        hittable={false}
        draggable={false}
        data={data}
      />
    </>
  );
}

function nodeLabel(node: MoodboardNode): string {
  if (node.type === "image-generator") return generatorPrompt(node) || "Image generator";
  if (node.type === "section") return nodeTitle(node);
  if (node.type === "note") return nodeText(node) || "Note";
  return node.type;
}

const GENERATOR_ICON_COLOR = "#c2c2bd";
const IMAGE_GENERATOR_ICON_FILL = {
  type: "image",
  url: Platform.toURL(
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${GENERATOR_ICON_COLOR}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/><circle cx="9" cy="9" r="2"/></svg>`,
    "svg",
  ),
};

function generatorIconSize(width: number, height: number): number {
  const base = Math.min(width, height) * 0.22;
  return Math.min(180, Math.max(72, Math.round(base)));
}
