import { createHash } from "node:crypto";

export {
  RENDER_FRAME_CAPTURE_DIMENSION_LIMIT,
  RENDER_FRAME_CAPTURE_PIXEL_LIMIT,
  RENDER_FRAME_NAME_LIMIT,
  isExactRenderFrameCaptureViewport,
} from "./render-frame-constraints.ts";

const RENDER_FRAME_STORAGE_SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Keeps legacy ASCII Frame locators readable while mapping every other valid
 * Viewer Frame id to one injective, filesystem-safe content segment.
 */
export function generationTaskVisualEvidenceFrameStorageSegment(frameId: string): string {
  if (RENDER_FRAME_STORAGE_SAFE_SEGMENT.test(frameId) && frameId !== "." && frameId !== "..") {
    return frameId;
  }
  return `frame-${createHash("sha256").update(frameId, "utf8").digest("hex")}`;
}
