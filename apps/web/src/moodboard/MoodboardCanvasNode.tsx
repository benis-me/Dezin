import { Frame, Img, Rect, Txt } from "@dezin/leafer-react";
import { IconImageMountainFill18 } from "nucleo-ui-essential-fill-18";
import { Platform } from "leafer-editor";
import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MoodboardNode } from "../lib/api.ts";
import {
  assetUrl,
  effectiveLayerZIndex,
  generatorPrompt,
  isNodeLocked,
  isNodeVisible,
  nodeFill,
  nodeStroke,
  nodeText,
  nodeTitle,
} from "./canvas-utils.ts";

export function MoodboardCanvasNode({ node }: { node: MoodboardNode }) {
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
      zIndex={effectiveLayerZIndex(node)}
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
      <NodeBody node={node} data={data} />
    </Frame>
  );
}

function NodeBody({ node, data }: { node: MoodboardNode; data: Record<string, unknown> }) {
  if (node.type === "image") {
    return (
      <>
        <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} data={data} />
        {assetUrl(node) ? (
          <Img url={assetUrl(node)} x={0} y={0} width={node.width} height={node.height} draggable={false} data={data} />
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
          hittable={false}
          data={data}
        />
      </>
    );
  }

  if (node.type === "image-generator") {
    return <ImageGeneratorNodeBody node={node} data={data} />;
  }

  if (node.type === "video") {
    return (
      <>
        <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} stroke={nodeStroke(node)} strokeWidth={1} data={data} />
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
      <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} stroke={nodeStroke(node)} strokeWidth={1} data={data} />
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
const GENERATOR_LOADING_SWEEP_MS = 1400;
const IMAGE_GENERATOR_ICON_URL = Platform.toURL(
  renderToStaticMarkup(<IconImageMountainFill18 data-nucleo-icon="IconImageMountainFill18" color={GENERATOR_ICON_COLOR} />),
  "svg",
);

function ImageGeneratorNodeBody({ node, data }: { node: MoodboardNode; data: Record<string, unknown> }) {
  const iconSize = generatorIconSize(node.width, node.height);
  const generating = node.data.generatorStatus === "generating";
  const sweepProgress = useGeneratorLoadingSweep(generating);
  const sweepCenter = sweepProgress * node.width;
  const wideBand = loadingSweepBand(sweepCenter, Math.max(64, Math.min(180, node.width * 0.42)), node.width);
  const midBand = loadingSweepBand(sweepCenter, Math.max(42, Math.min(124, node.width * 0.28)), node.width);
  const coreBand = loadingSweepBand(sweepCenter, Math.max(18, Math.min(54, node.width * 0.12)), node.width);

  return (
    <>
      <Rect x={0} y={0} width={node.width} height={node.height} fill={nodeFill(node)} stroke={nodeStroke(node)} strokeWidth={1} data={data} />
      {generating ? (
        <>
          <Rect
            data-loading-sweep="true"
            x={wideBand.x}
            y={0}
            width={wideBand.width}
            height={node.height}
            fill="rgba(255,255,255,0.08)"
            hittable={false}
            draggable={false}
            data={data}
          />
          <Rect
            data-loading-sweep="true"
            x={midBand.x}
            y={0}
            width={midBand.width}
            height={node.height}
            fill="rgba(255,255,255,0.12)"
            hittable={false}
            draggable={false}
            data={data}
          />
          <Rect
            data-loading-sweep="true"
            x={coreBand.x}
            y={0}
            width={coreBand.width}
            height={node.height}
            fill="rgba(255,255,255,0.18)"
            hittable={false}
            draggable={false}
            data={data}
          />
        </>
      ) : null}
      <Img
        url={IMAGE_GENERATOR_ICON_URL}
        x={Math.max(0, (node.width - iconSize) / 2)}
        y={Math.max(0, (node.height - iconSize) / 2)}
        width={iconSize}
        height={iconSize}
        hittable={false}
        draggable={false}
        data={data}
      />
    </>
  );
}

function useGeneratorLoadingSweep(active: boolean): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }

    let animationFrame = 0;
    const start = window.performance.now();
    const tick = (time: number) => {
      setProgress(((time - start) % GENERATOR_LOADING_SWEEP_MS) / GENERATOR_LOADING_SWEEP_MS);
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active]);

  return progress;
}

function loadingSweepBand(center: number, width: number, nodeWidth: number): { x: number; width: number } {
  const left = Math.max(0, center - width / 2);
  const right = Math.min(nodeWidth, center + width / 2);
  return { x: left, width: Math.max(0, right - left) };
}

function generatorIconSize(width: number, height: number): number {
  const base = Math.min(width, height) * 0.16;
  return Math.min(128, Math.max(36, Math.round(base)));
}
