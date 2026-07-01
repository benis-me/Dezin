import type { MoodboardAsset, MoodboardNode, SaveMoodboardNodeInput } from "../lib/api.ts";
import { localId, toInput } from "./canvas-utils.ts";

export function materializeMoodboardNodes(
  boardId: string,
  inputs: SaveMoodboardNodeInput[],
  previous: MoodboardNode[],
): MoodboardNode[] {
  const now = Date.now();
  const old = new Map(previous.map((node) => [node.id, node]));
  return inputs.map((input, index) => {
    const id = input.id || localId();
    const prev = old.get(id);
    return {
      id,
      boardId,
      type: input.type,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex ?? index,
      data: input.data ?? {},
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

export async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return dataUrl.split(",")[1] ?? "";
}

export async function imageSize(file: File): Promise<{ width: number | undefined; height: number | undefined }> {
  if (!file.type.startsWith("image/")) return { width: undefined, height: undefined };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image failed"));
      image.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return { width: undefined, height: undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createNoteNode(count: number, point?: { x: number; y: number }): SaveMoodboardNodeInput {
  return {
    id: localId(),
    type: "note",
    x: point?.x ?? 80 + count * 18,
    y: point?.y ?? 80 + count * 18,
    width: 220,
    height: 140,
    zIndex: count,
    data: { content: "New note" },
  };
}

export function createSectionNode(count: number, point?: { x: number; y: number; width?: number; height?: number }): SaveMoodboardNodeInput {
  return {
    id: localId(),
    type: "section",
    x: point?.x ?? 40 + count * 18,
    y: point?.y ?? 40 + count * 18,
    width: Math.max(80, point?.width ?? 460),
    height: Math.max(80, point?.height ?? 300),
    zIndex: Math.max(0, count - 1),
    data: { title: "Section" },
  };
}

export function createImageGeneratorNode(count: number, point?: { x: number; y: number }): SaveMoodboardNodeInput {
  return {
    id: localId(),
    type: "image-generator",
    x: point?.x ?? 120 + count * 20,
    y: point?.y ?? 120 + count * 20,
    width: 360,
    height: 240,
    zIndex: Math.max(0, count),
    data: { generatorPrompt: "", generatorStatus: "ready" },
  };
}

export function createImageNode(
  asset: MoodboardAsset & { url: string },
  count: number,
  index: number,
  size: { width: number | undefined; height: number | undefined },
): SaveMoodboardNodeInput {
  return {
    id: localId(),
    type: "image",
    x: 80 + (count + index) * 24,
    y: 80 + (count + index) * 24,
    width: 320,
    height: size.width && size.height ? Math.max(160, Math.round(320 * (size.height / size.width))) : 240,
    zIndex: count + index,
    data: { assetId: asset.id, url: asset.url, fileName: asset.fileName, source: "upload" },
  };
}

export function materializeInputs(boardId: string, current: MoodboardNode[], next: SaveMoodboardNodeInput[]): MoodboardNode[] {
  return materializeMoodboardNodes(boardId, next, current);
}

export function appendInputs(boardId: string, current: MoodboardNode[], next: SaveMoodboardNodeInput[]): MoodboardNode[] {
  return materializeMoodboardNodes(boardId, [...current.map(toInput), ...next], current);
}
