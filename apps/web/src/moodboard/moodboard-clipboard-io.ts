import type { SaveMoodboardNodeInput } from "../lib/api.ts";
import { serializeMoodboardClipboardNodes } from "./moodboard-clipboard.ts";

/** Copied node payload plus, for a single image node, a PNG blob so other apps receive an image. */
export async function writeMoodboardNodesToClipboard(boardId: string, inputs: SaveMoodboardNodeInput[]): Promise<void> {
  if (inputs.length === 0 || typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return;
  }
  const parts: Record<string, Blob> = {
    "text/plain": new Blob([serializeMoodboardClipboardNodes(boardId, inputs)], { type: "text/plain" }),
  };
  if (inputs.length === 1) {
    const imageBlob = await imageInputToPngBlob(inputs[0]!).catch(() => null);
    if (imageBlob) parts["image/png"] = imageBlob;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  } catch {
    // Best-effort: clipboard writes can be blocked by focus or permissions.
  }
}

/** Read the system clipboard into normalized text + image files, or null when the API is unavailable/denied. */
export async function readMoodboardClipboardContent(): Promise<{ text: string; files: File[] } | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
  let clipboardItems: Array<{ types?: readonly string[]; getType: (type: string) => Promise<Blob> }>;
  try {
    clipboardItems = (await navigator.clipboard.read()) as never;
  } catch {
    return null;
  }
  let text = "";
  const files: File[] = [];
  for (const item of clipboardItems) {
    for (const type of item.types ?? []) {
      if (type === "text/plain" && !text) {
        text = await item
          .getType(type)
          .then((blob) => blob.text())
          .catch(() => "");
      } else if (typeof type === "string" && type.startsWith("image/")) {
        const file = await item
          .getType(type)
          .then((blob) => new File([blob], `pasted-image.${type.split("/")[1] || "png"}`, { type }))
          .catch(() => null);
        if (file) files.push(file);
      }
    }
  }
  return { text, files };
}

async function imageInputToPngBlob(input: SaveMoodboardNodeInput): Promise<Blob | null> {
  if (input.type !== "image") return null;
  const url = typeof input.data?.url === "string" ? input.data.url : null;
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return toPngBlob(await response.blob());
}

async function toPngBlob(blob: Blob): Promise<Blob | null> {
  if (blob.type === "image/png") return blob;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}
