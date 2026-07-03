import type { ImageGenerationParams, MoodboardNode } from "../lib/api.ts";

export type ImageProviderId = "openai" | "azure-openai" | "gemini" | "openai-compatible" | "fal" | "vertex" | string;

export const DEFAULT_IMAGE_GENERATION_PARAMS: Required<Pick<ImageGenerationParams, "quality" | "aspectRatio" | "size" | "background" | "moderation" | "count">> = {
  quality: "medium",
  aspectRatio: "1:1",
  size: "1024x1024",
  background: "auto",
  moderation: "auto",
  count: 1,
};

export const IMAGE_QUALITY_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
] as const satisfies ReadonlyArray<{ label: string; value: NonNullable<ImageGenerationParams["quality"]> }>;

export const IMAGE_SIZE_OPTIONS = [
  { label: "1024 x 1024", value: "1024x1024", aspectRatio: "1:1" },
  { label: "1536 x 1024", value: "1536x1024", aspectRatio: "3:2" },
  { label: "1024 x 1536", value: "1024x1536", aspectRatio: "2:3" },
] as const satisfies ReadonlyArray<{ label: string; value: NonNullable<ImageGenerationParams["size"]>; aspectRatio: NonNullable<ImageGenerationParams["aspectRatio"]> }>;

export const IMAGE_ASPECT_RATIO_OPTIONS = [
  { label: "1:1", value: "1:1", size: "1024x1024" },
  { label: "3:2", value: "3:2", size: "1536x1024" },
  { label: "2:3", value: "2:3", size: "1024x1536" },
  { label: "4:3", value: "4:3", size: "1536x1024" },
  { label: "3:4", value: "3:4", size: "1024x1536" },
  { label: "16:9", value: "16:9", size: "1536x1024" },
  { label: "9:16", value: "9:16", size: "1024x1536" },
  { label: "21:9", value: "21:9", size: "1536x1024" },
] as const satisfies ReadonlyArray<{ label: string; value: NonNullable<ImageGenerationParams["aspectRatio"]>; size: NonNullable<ImageGenerationParams["size"]> }>;

export const IMAGE_BACKGROUND_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Transparent", value: "transparent" },
  { label: "Opaque", value: "opaque" },
] as const satisfies ReadonlyArray<{ label: string; value: NonNullable<ImageGenerationParams["background"]> }>;

export const IMAGE_FORMAT_OPTIONS = [
  { label: "PNG", value: "png" },
  { label: "JPEG", value: "jpeg" },
  { label: "WebP", value: "webp" },
] as const satisfies ReadonlyArray<{ label: string; value: NonNullable<ImageGenerationParams["outputFormat"]> }>;

export function normalizeImageGenerationParams(value: unknown): ImageGenerationParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: ImageGenerationParams = {};
  if (isOneOf(input.quality, ["auto", "low", "medium", "high"])) next.quality = input.quality;
  if (isSize(input.size)) next.size = input.size;
  if (isAspectRatio(input.aspectRatio)) next.aspectRatio = input.aspectRatio;
  if (isOneOf(input.background, ["auto", "transparent", "opaque"])) next.background = input.background;
  if (isOneOf(input.outputFormat, ["png", "jpeg", "webp"])) next.outputFormat = input.outputFormat;
  if (isOneOf(input.moderation, ["auto", "low"])) next.moderation = input.moderation;
  const count = Number(input.count);
  if (Number.isFinite(count)) next.count = Math.max(1, Math.min(1, Math.round(count)));
  const compression = Number(input.outputCompression);
  if (Number.isFinite(compression)) next.outputCompression = Math.max(0, Math.min(100, Math.round(compression)));
  return next;
}

export function imageGenerationParamsFromNode(node: MoodboardNode): ImageGenerationParams {
  return normalizeImageGenerationParams(node.data.generationParams ?? node.data.generatorParams);
}

export function imageGenerationParamsForNode(node: MoodboardNode, providerId: ImageProviderId): ImageGenerationParams {
  const stored = imageGenerationParamsFromNode(node);
  const defaultAspectRatio = stored.aspectRatio ?? DEFAULT_IMAGE_GENERATION_PARAMS.aspectRatio;
  const defaultSize = stored.size ?? sizeForAspectRatio(defaultAspectRatio);
  const base: ImageGenerationParams = {
    quality: DEFAULT_IMAGE_GENERATION_PARAMS.quality,
    aspectRatio: defaultAspectRatio,
    size: defaultSize,
    background: DEFAULT_IMAGE_GENERATION_PARAMS.background,
    moderation: DEFAULT_IMAGE_GENERATION_PARAMS.moderation,
    count: DEFAULT_IMAGE_GENERATION_PARAMS.count,
    ...stored,
  };
  if (isAspectRatioOnlyProvider(providerId)) {
    return {
      aspectRatio: base.aspectRatio,
      count: 1,
    };
  }
  if (providerId === "azure-openai") {
    const { outputFormat: _outputFormat, outputCompression: _outputCompression, ...azureParams } = base;
    return azureParams;
  }
  return base;
}

export function supportsImageQuality(providerId: ImageProviderId): boolean {
  return isOpenAiStyleProvider(providerId);
}

export function supportsImageSize(providerId: ImageProviderId): boolean {
  return isOpenAiStyleProvider(providerId);
}

export function supportsImageBackground(providerId: ImageProviderId): boolean {
  return isOpenAiStyleProvider(providerId);
}

export function supportsImageModeration(providerId: ImageProviderId): boolean {
  return providerId === "openai" || providerId === "azure-openai" || providerId === "openai-compatible";
}

export function supportsImageOutputFormat(providerId: ImageProviderId): boolean {
  return providerId === "openai" || providerId === "openai-compatible";
}

export function isGeneratedImageNode(node: MoodboardNode): boolean {
  const source = node.data.source;
  return node.type === "image" && (source === "generated" || source === "edited" || Boolean(node.data.prompt));
}

export function hasReusableImagePrompt(node: MoodboardNode): boolean {
  const prompt = node.data.prompt;
  return typeof prompt === "string" && prompt.trim().length > 0;
}

export function sizeForAspectRatio(aspectRatio: NonNullable<ImageGenerationParams["aspectRatio"]>): NonNullable<ImageGenerationParams["size"]> {
  return IMAGE_ASPECT_RATIO_OPTIONS.find((option) => option.value === aspectRatio)?.size ?? "1024x1024";
}

export function imageGeneratorNodeSizeForAspectRatio(
  node: Pick<MoodboardNode, "width" | "height">,
  aspectRatio: NonNullable<ImageGenerationParams["aspectRatio"]>,
): { width: number; height: number } {
  const ratio = parseAspectRatio(aspectRatio);
  if (!ratio) return { width: Math.round(node.width), height: Math.round(node.height) };
  const minSide = 120;
  if (ratio >= 1) {
    let width = Math.max(minSide, Math.round(node.width));
    let height = Math.round(width / ratio);
    if (height < minSide) {
      height = minSide;
      width = Math.round(height * ratio);
    }
    return { width, height };
  }
  let height = Math.max(minSide, Math.round(node.height));
  let width = Math.round(height * ratio);
  if (width < minSide) {
    width = minSide;
    height = Math.round(width / ratio);
  }
  return { width, height };
}

function isGeminiProvider(providerId: ImageProviderId): boolean {
  return providerId === "gemini" || providerId === "google" || providerId === "google-ai-studio";
}

function isAspectRatioOnlyProvider(providerId: ImageProviderId): boolean {
  return isGeminiProvider(providerId) || providerId === "vertex" || providerId === "fal";
}

function isOpenAiStyleProvider(providerId: ImageProviderId): boolean {
  return providerId === "openai" || providerId === "azure-openai" || providerId === "openai-compatible";
}

function isOneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function isSize(value: unknown): value is NonNullable<ImageGenerationParams["size"]> {
  return typeof value === "string" && /^\d{2,5}x\d{2,5}$/.test(value);
}

function isAspectRatio(value: unknown): value is NonNullable<ImageGenerationParams["aspectRatio"]> {
  return typeof value === "string" && /^\d{1,2}:\d{1,2}$/.test(value);
}

function parseAspectRatio(value: string): number | null {
  const [rawWidth, rawHeight] = value.split(":").map(Number);
  if (!rawWidth || !rawHeight || !Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return null;
  return rawWidth / rawHeight;
}
