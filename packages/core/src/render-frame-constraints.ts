/** Browser-safe bounds shared by every RenderFrame persistence and runtime surface. */
export const RENDER_FRAME_NAME_LIMIT = 512;
export const RENDER_FRAME_CAPTURE_DIMENSION_LIMIT = 16_384;
// Decimal 64M leaves room for per-row PNG filter bytes under the decoded-byte ceiling.
export const RENDER_FRAME_CAPTURE_PIXEL_LIMIT = 64_000_000;

export function isExactRenderFrameCaptureViewport(width: unknown, height: unknown): boolean {
  return typeof width === "number"
    && typeof height === "number"
    && Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width >= 1
    && height >= 1
    && width <= RENDER_FRAME_CAPTURE_DIMENSION_LIMIT
    && height <= RENDER_FRAME_CAPTURE_DIMENSION_LIMIT
    && width * height <= RENDER_FRAME_CAPTURE_PIXEL_LIMIT;
}
