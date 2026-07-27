import { createCanvas, loadImage } from "@napi-rs/canvas";

import { inspectBoundedPngImage, MAX_PNG_IMAGE_BYTES } from "./artifact-thumbnail.ts";

/**
 * Image providers used by Moodboard currently return at most 1536x1024 or
 * 1024x1536. The larger cap leaves room for provider variance while bounding
 * Skia's source and destination RGBA surfaces to 16 MiB each.
 */
export const MAX_MOODBOARD_CROP_PIXELS = 4_194_304;

export interface CenterCropPngInput {
  readonly bytes: Uint8Array;
  readonly aspectRatio: `${number}:${number}`;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export class PngCenterCropError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PngCenterCropError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("PNG center crop aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function parseAspectRatio(value: string): readonly [number, number] {
  const match = /^([1-9]\d{0,4}):([1-9]\d{0,4})$/.exec(value);
  if (!match) throw new PngCenterCropError("requested PNG aspect ratio is invalid");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new PngCenterCropError("requested PNG aspect ratio is invalid");
  }
  return [width, height];
}

function boundedPixelCount(width: number, height: number): number {
  if (!Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > Math.floor(MAX_MOODBOARD_CROP_PIXELS / height)) {
    throw new PngCenterCropError("provider PNG exceeds the bounded Moodboard crop pixel budget");
  }
  return width * height;
}

/**
 * Produces an exact-ratio center crop with non-lossy PNG encoding. Source and
 * destination rectangles have identical dimensions, so pixels are never
 * resampled, stretched, or upscaled and opaque provider imagery is visually
 * preserved. Exact-ratio provider output remains byte-identical.
 *
 * Peak image storage is bounded by the 8 MiB input/output budgets plus one
 * 16 MiB source RGBA surface and one 16 MiB destination RGBA surface. Skia's
 * encoder has additional bounded native working memory.
 */
export async function centerCropPngToAspectRatio(input: CenterCropPngInput): Promise<Buffer> {
  checkAbort(input.signal);
  if (!(input.bytes instanceof Uint8Array)
    || !Number.isSafeInteger(input.maxOutputBytes)
    || input.maxOutputBytes < 1
    || input.maxOutputBytes > MAX_PNG_IMAGE_BYTES) {
    throw new PngCenterCropError("PNG center crop input is invalid or unbounded");
  }
  const sourceBytes = Buffer.from(input.bytes);
  if (sourceBytes.byteLength > input.maxOutputBytes) {
    throw new PngCenterCropError("provider PNG exceeds its immutable output budget");
  }
  const [ratioWidth, ratioHeight] = parseAspectRatio(input.aspectRatio);
  const dimensions = await inspectBoundedPngImage(sourceBytes, input.signal);
  checkAbort(input.signal);
  if (dimensions.width * ratioHeight === dimensions.height * ratioWidth) {
    return sourceBytes;
  }
  boundedPixelCount(dimensions.width, dimensions.height);
  const unit = Math.min(
    Math.floor(dimensions.width / ratioWidth),
    Math.floor(dimensions.height / ratioHeight),
  );
  const targetWidth = unit * ratioWidth;
  const targetHeight = unit * ratioHeight;
  if (unit < 1 || targetWidth > dimensions.width || targetHeight > dimensions.height) {
    throw new PngCenterCropError("provider PNG is too small for its requested center crop");
  }
  boundedPixelCount(targetWidth, targetHeight);
  const cropX = Math.floor((dimensions.width - targetWidth) / 2);
  const cropY = Math.floor((dimensions.height - targetHeight) / 2);

  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(sourceBytes);
  } catch (error) {
    throw new PngCenterCropError("bounded provider PNG could not be decoded", { cause: error });
  }
  checkAbort(input.signal);
  if (image.width !== dimensions.width || image.height !== dimensions.height) {
    throw new PngCenterCropError("provider PNG decoder substituted intrinsic dimensions");
  }

  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext("2d", { alpha: true, colorSpace: "srgb" });
  context.imageSmoothingEnabled = false;
  context.drawImage(
    image,
    cropX,
    cropY,
    targetWidth,
    targetHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  checkAbort(input.signal);

  let output: Buffer;
  try {
    output = await canvas.encode("png");
  } catch (error) {
    throw new PngCenterCropError("bounded provider PNG crop could not be encoded", { cause: error });
  }
  checkAbort(input.signal);
  if (output.byteLength < 1 || output.byteLength > input.maxOutputBytes) {
    throw new PngCenterCropError("cropped PNG exceeds its immutable output budget");
  }
  const croppedDimensions = await inspectBoundedPngImage(output, input.signal);
  if (croppedDimensions.width !== targetWidth || croppedDimensions.height !== targetHeight
    || croppedDimensions.width * ratioHeight !== croppedDimensions.height * ratioWidth) {
    throw new PngCenterCropError("cropped PNG does not match its immutable requested ratio");
  }
  return output;
}
