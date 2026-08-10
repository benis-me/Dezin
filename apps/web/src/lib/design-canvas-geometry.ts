/**
 * Fit an image into the preferred Canvas footprint without changing its
 * intrinsic ratio. Scaling both axes together also keeps unusually narrow or
 * wide images inside the storage contract whenever that is mathematically
 * possible.
 */
export function fittedImageNodeSize(source: { width: number; height: number }): { width: number; height: number } {
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
    return { width: 360, height: 260 };
  }
  const fitScale = Math.min(420 / source.width, 360 / source.height);
  let width = source.width * fitScale;
  let height = source.height * fitScale;
  const minimumScale = Math.max(1, 120 / width, 80 / height);
  width *= minimumScale;
  height *= minimumScale;
  // Ratios outside the storage envelope (> 51.2:1 or < 120:4096) cannot
  // satisfy both minimum and maximum dimensions. Clamp only that impossible
  // edge case; every representable image keeps its exact ratio.
  if (width > 4_096 || height > 4_096) {
    return source.width >= source.height
      ? { width: 4_096, height: 80 }
      : { width: 120, height: 4_096 };
  }
  return {
    width: Math.round(width * 1_000) / 1_000,
    height: Math.round(height * 1_000) / 1_000,
  };
}
