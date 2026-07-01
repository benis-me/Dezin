import { FileVideo, Image, ImagePlus, StickyNote, SquareDashedMousePointer, type LucideIcon } from "lucide-react";
import type { MoodboardNodeType } from "../lib/api.ts";

export interface MoodboardNodeMeta {
  type: MoodboardNodeType;
  label: string;
  icon: LucideIcon;
  defaultSize: { width: number; height: number };
}

export const MOODBOARD_NODE_REGISTRY: Record<MoodboardNodeType, MoodboardNodeMeta> = {
  image: { type: "image", label: "Image", icon: Image, defaultSize: { width: 320, height: 240 } },
  "image-generator": { type: "image-generator", label: "Image generator", icon: ImagePlus, defaultSize: { width: 360, height: 240 } },
  note: { type: "note", label: "Note", icon: StickyNote, defaultSize: { width: 220, height: 140 } },
  section: { type: "section", label: "Section", icon: SquareDashedMousePointer, defaultSize: { width: 420, height: 280 } },
  video: { type: "video", label: "Video", icon: FileVideo, defaultSize: { width: 360, height: 220 } },
};
