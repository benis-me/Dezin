/**
 * Image/media generation, woven into the run. The agent emits placeholder images
 * with a `data-gen-prompt` describing what to draw; after generation we call an
 * AI SDK image model, save each result under assets/, and rewrite the <img src>.
 * No key configured -> artifact passes through untouched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAzure } from "@ai-sdk/azure";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateImage, type GenerateImageResult, type ImageModel } from "ai";

export type ImageGenerationParams = {
  quality?: "auto" | "low" | "medium" | "high";
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  background?: "auto" | "transparent" | "opaque";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  moderation?: "auto" | "low";
  count?: number;
};

export interface ImageGenOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
  apiVersion?: string;
  params?: ImageGenerationParams;
}

export type SourceImageInput = {
  data: Buffer;
  mimeType: string;
  fileName: string;
};

export type FetchLike = typeof fetch;

type ImageOperation = "generate" | "edit";
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | { [key: string]: JsonValue | undefined } | JsonValue[];
type ProviderOptions = Record<string, { [key: string]: JsonValue | undefined }>;

interface ImageRequestLogContext {
  operation: ImageOperation;
  opts: ImageGenOpts;
  imageField?: string;
  sourceMimeType?: string;
  sourceFileName?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function withoutTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isAzureOpenAi(opts: ImageGenOpts): boolean {
  if (opts.providerId === "azure-openai") return true;
  try {
    return new URL(opts.baseUrl).hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function isGoogle(opts: ImageGenOpts): boolean {
  return opts.providerId === "gemini";
}

function azureApiVersion(opts: ImageGenOpts): string {
  return opts.apiVersion?.trim() || "2025-04-01-preview";
}

function azureBaseUrl(opts: ImageGenOpts): string {
  const url = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, "");
  const openaiIndex = path.indexOf("/openai");
  url.pathname = openaiIndex >= 0 ? path.slice(0, openaiIndex + "/openai".length) : `${path}/openai`;
  url.search = "";
  return withoutTrailingSlash(url.toString());
}

function googleBaseUrl(opts: ImageGenOpts): string {
  const baseUrl = opts.baseUrl.trim() || "https://generativelanguage.googleapis.com/v1beta";
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/openai$/, "");
  url.search = "";
  return withoutTrailingSlash(url.toString());
}

function clipLogValue(value: string, max = 2000): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

async function imageErrorResponseText(res: Response): Promise<string> {
  try {
    return clipLogValue(await res.clone().text());
  } catch {
    return "";
  }
}

function fetchInputUrl(input: Parameters<FetchLike>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

async function logImageRequestFailure(res: Response, context: ImageRequestLogContext & { endpoint: string }): Promise<void> {
  const response = await imageErrorResponseText(res);
  console.warn("[dezin:image-api] request failed", {
    operation: context.operation,
    providerId: context.opts.providerId || "custom",
    azure: isAzureOpenAi(context.opts),
    endpoint: context.endpoint,
    model: context.opts.model || "gpt-image-1",
    apiVersion: context.opts.apiVersion,
    status: res.status,
    response,
    ...(context.imageField ? { imageField: context.imageField } : {}),
    ...(context.sourceMimeType ? { sourceMimeType: context.sourceMimeType } : {}),
    ...(context.sourceFileName ? { sourceFileName: context.sourceFileName } : {}),
  });
}

function withFailureLogging(fetchImpl: FetchLike, context: ImageRequestLogContext): FetchLike {
  return (async (input, init) => {
    const res = await fetchImpl(input, init);
    if (!res.ok) await logImageRequestFailure(res, { ...context, endpoint: fetchInputUrl(input) });
    return res;
  }) as FetchLike;
}

function imageModel(opts: ImageGenOpts, fetchImpl: FetchLike): ImageModel {
  if (isAzureOpenAi(opts)) {
    const model = opts.model.trim() || "gpt-image-1";
    return createAzure({
      apiKey: opts.apiKey,
      baseURL: azureBaseUrl(opts),
      apiVersion: azureApiVersion(opts),
      useDeploymentBasedUrls: true,
      fetch: fetchImpl,
    }).image(model);
  }
  if (isGoogle(opts)) {
    const model = opts.model.trim() || "gemini-2.5-flash-image";
    return createGoogle({
      apiKey: opts.apiKey,
      baseURL: googleBaseUrl(opts),
      fetch: fetchImpl,
    }).image(model);
  }
  const baseURL = withoutTrailingSlash(opts.baseUrl);
  if (!baseURL) throw new Error("Missing image API base URL.");
  const model = opts.model.trim() || "gpt-image-1";
  return createOpenAICompatible({
    name: opts.providerId || "openai-compatible",
    apiKey: opts.apiKey || undefined,
    baseURL,
    fetch: fetchImpl,
  }).imageModel(model);
}

function clampCount(value: number | undefined): 1 {
  return value === 1 ? 1 : 1;
}

function imageProviderOptions(opts: ImageGenOpts): ProviderOptions | undefined {
  const params = opts.params;
  if (!params || isGoogle(opts)) return undefined;
  const openaiOptions: { [key: string]: JsonValue | undefined } = {};
  if (params.quality && params.quality !== "auto") openaiOptions.quality = params.quality;
  if (params.background && params.background !== "auto") openaiOptions.background = params.background;
  if (params.outputFormat) openaiOptions.output_format = params.outputFormat;
  if (typeof params.outputCompression === "number" && Number.isFinite(params.outputCompression)) {
    openaiOptions.output_compression = Math.max(0, Math.min(100, Math.round(params.outputCompression)));
  }
  if (params.moderation && params.moderation !== "auto") openaiOptions.moderation = params.moderation;
  if (!Object.keys(openaiOptions).length) return undefined;
  return { openai: openaiOptions };
}

function generationSettings(opts: ImageGenOpts): {
  n: 1;
  maxRetries: 0;
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  providerOptions?: ProviderOptions;
} {
  const params = opts.params;
  if (isGoogle(opts)) {
    return {
      n: clampCount(params?.count),
      maxRetries: 0,
      aspectRatio: params?.aspectRatio ?? "1:1",
    };
  }
  return {
    n: clampCount(params?.count),
    maxRetries: 0,
    size: params?.size ?? "1024x1024",
    providerOptions: imageProviderOptions(opts),
  };
}

function base64FromResult(result: GenerateImageResult): string {
  const b64 = result.image?.base64.replace(/^data:[^,]+;base64,/, "");
  if (!b64) throw new Error("image API returned no data");
  return b64;
}

function imageApiErrorDetail(err: unknown): string {
  const error = err as { responseBody?: unknown; data?: unknown; message?: unknown };
  const candidates = [error.responseBody, error.data];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate) as { error?: { message?: unknown }; message?: unknown };
        const message = parsed.error?.message ?? parsed.message;
        if (typeof message === "string" && message.trim()) return message.trim();
      } catch {
        if (candidate.trim()) return clipLogValue(candidate.trim(), 500);
      }
    }
    if (typeof candidate === "object") {
      const value = candidate as { error?: { message?: unknown }; message?: unknown };
      const message = value.error?.message ?? value.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return typeof error.message === "string" && error.message.trim() ? error.message.trim() : "";
}

function imageApiError(err: unknown): Error {
  const status = typeof err === "object" && err !== null ? (err as { statusCode?: unknown; status?: unknown }).statusCode ?? (err as { status?: unknown }).status : undefined;
  const detail = imageApiErrorDetail(err);
  if (typeof status === "number") return new Error(`image API ${status}${detail ? `: ${detail}` : ""}`);
  if (typeof status === "string" && status) return new Error(`image API ${status}${detail ? `: ${detail}` : ""}`);
  return err instanceof Error ? err : new Error("image API failed");
}

/** One image via an AI SDK image model; returns base64 PNG data. */
export async function requestImage(opts: ImageGenOpts, prompt: string, fetchImpl: FetchLike): Promise<string> {
  const loggedFetch = withFailureLogging(fetchImpl, { operation: "generate", opts });
  try {
    const result = await generateImage({
      model: imageModel(opts, loggedFetch),
      prompt,
      ...generationSettings(opts),
    });
    return base64FromResult(result);
  } catch (err) {
    throw imageApiError(err);
  }
}

export async function requestImageEdit(
  opts: ImageGenOpts,
  prompt: string,
  image: SourceImageInput,
  fetchImpl: FetchLike,
): Promise<string> {
  const loggedFetch = withFailureLogging(fetchImpl, {
    operation: "edit",
    opts,
    imageField: "image",
    sourceMimeType: image.mimeType,
    sourceFileName: image.fileName,
  });
  const imageBytes = new Uint8Array(image.data.length);
  imageBytes.set(image.data);
  try {
    const result = await generateImage({
      model: imageModel(opts, loggedFetch),
      prompt: { text: prompt, images: [imageBytes] },
      ...generationSettings(opts),
    });
    return base64FromResult(result);
  } catch (err) {
    throw imageApiError(err);
  }
}

/**
 * Replace every `<img ... data-gen-prompt="...">` in html with a generated asset.
 * Returns the rewritten html and the number of images generated.
 */
export async function generateImages(
  html: string,
  opts: ImageGenOpts,
  assetsDir: string,
  fetchImpl: FetchLike,
): Promise<{ html: string; generated: number }> {
  if (!opts.apiKey || !opts.baseUrl) return { html, generated: 0 };
  const re = /<img\b[^>]*?\bdata-gen-prompt="([^"]*)"[^>]*?>/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) return { html, generated: 0 };

  await mkdir(assetsDir, { recursive: true });
  let out = html;
  let generated = 0;
  for (let i = 0; i < matches.length; i++) {
    const tag = matches[i]![0];
    const prompt = decodeEntities(matches[i]![1] ?? "");
    try {
      const b64 = await requestImage(opts, prompt, fetchImpl);
      const rel = `assets/gen-${i + 1}.png`;
      await writeFile(join(assetsDir, `gen-${i + 1}.png`), Buffer.from(b64, "base64"));
      let newTag = /\bsrc="[^"]*"/i.test(tag) ? tag.replace(/\bsrc="[^"]*"/i, `src="${rel}"`) : tag.replace(/<img\b/i, `<img src="${rel}"`);
      newTag = newTag.replace(/\s*data-gen-prompt="[^"]*"/i, "");
      out = out.replace(tag, newTag);
      generated++;
    } catch {
      // Leave the placeholder in place on failure (the run still succeeds).
    }
  }
  return { html: out, generated };
}
