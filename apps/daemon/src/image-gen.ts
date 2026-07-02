/**
 * Image/media generation, woven into the run. The agent emits placeholder images
 * with a `data-gen-prompt` describing what to draw; after generation we call a
 * BYOK image endpoint (OpenAI Images-compatible), save each result under assets/,
 * and rewrite the <img src>. No key configured → artifact passes through untouched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ImageGenOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
  apiVersion?: string;
}

export type SourceImageInput = {
  data: Buffer;
  mimeType: string;
  fileName: string;
};

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isAzureOpenAi(opts: ImageGenOpts): boolean {
  if (opts.providerId === "azure-openai") return true;
  try {
    return new URL(opts.baseUrl).hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function azureApiVersion(opts: ImageGenOpts): string {
  return opts.apiVersion?.trim() || "preview";
}

function azureResourceUrl(opts: ImageGenOpts): URL {
  const url = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, "");
  const openaiIndex = path.indexOf("/openai");
  url.pathname = openaiIndex >= 0 ? path.slice(0, openaiIndex) || "/" : path || "/";
  url.search = "";
  return url;
}

function azureV1ImageGenerationEndpoint(opts: ImageGenOpts): string {
  const url = azureResourceUrl(opts);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/openai/v1/images/generations`;
  url.searchParams.set("api-version", "preview");
  return url.toString();
}

function azureDeploymentEndpoint(opts: ImageGenOpts, operation: "images/generations" | "images/edits"): string {
  const deployment = (opts.model || "gpt-image-1").trim();
  const url = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, "");
  const existing = path.match(/^(.*\/openai\/deployments\/)([^/]+)(?:\/.*)?$/);
  if (existing) {
    url.pathname = `${existing[1]}${encodeURIComponent(deployment || decodeURIComponent(existing[2] ?? ""))}/${operation}`;
  } else {
    const openaiIndex = path.indexOf("/openai");
    const openaiRoot = openaiIndex >= 0 ? path.slice(0, openaiIndex + "/openai".length) : `${path}/openai`;
    url.pathname = `${openaiRoot}/deployments/${encodeURIComponent(deployment)}/${operation}`;
  }
  url.search = "";
  url.searchParams.set("api-version", azureApiVersion(opts));
  return url.toString();
}

function imageGenerationEndpoint(opts: ImageGenOpts): string {
  if (isAzureOpenAi(opts)) return azureV1ImageGenerationEndpoint(opts);
  return `${opts.baseUrl.replace(/\/$/, "")}/images/generations`;
}

function imageEditEndpoint(opts: ImageGenOpts): string {
  if (isAzureOpenAi(opts)) return azureDeploymentEndpoint(opts, "images/edits");
  return `${opts.baseUrl.replace(/\/$/, "")}/images/edits`;
}

function jsonHeaders(opts: ImageGenOpts): Record<string, string> {
  return isAzureOpenAi(opts)
    ? { "content-type": "application/json", "api-key": opts.apiKey }
    : { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` };
}

function multipartHeaders(opts: ImageGenOpts): Record<string, string> {
  return isAzureOpenAi(opts) ? { "api-key": opts.apiKey } : { authorization: `Bearer ${opts.apiKey}` };
}

function imagePayload(opts: ImageGenOpts, prompt: string): Record<string, unknown> {
  if (isAzureOpenAi(opts)) return { model: opts.model || "gpt-image-1", prompt, n: 1, size: "1024x1024" };
  return { model: opts.model || "gpt-image-1", prompt, n: 1, size: "1024x1024", response_format: "b64_json" };
}

async function base64FromImageResponse(res: Awaited<ReturnType<FetchLike>>): Promise<string> {
  if (!res.ok) throw new Error(`image API ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("image API returned no data");
  return b64;
}

/** One image via the OpenAI Images-compatible endpoint; returns base64 PNG. */
export async function requestImage(opts: ImageGenOpts, prompt: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(imageGenerationEndpoint(opts), {
    method: "POST",
    headers: jsonHeaders(opts),
    body: JSON.stringify(imagePayload(opts, prompt)),
  });
  return base64FromImageResponse(res);
}

export async function requestImageEdit(
  opts: ImageGenOpts,
  prompt: string,
  image: SourceImageInput,
  fetchImpl: FetchLike,
): Promise<string> {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", "1024x1024");
  form.append("model", opts.model || "gpt-image-1");
  if (!isAzureOpenAi(opts)) {
    form.append("response_format", "b64_json");
  }
  const imageBytes = new Uint8Array(image.data.length);
  imageBytes.set(image.data);
  form.append(isAzureOpenAi(opts) ? "image[]" : "image", new Blob([imageBytes], { type: image.mimeType }), image.fileName);
  const res = await fetchImpl(imageEditEndpoint(opts), {
    method: "POST",
    headers: multipartHeaders(opts),
    body: form,
  });
  return base64FromImageResponse(res);
}

/**
 * Replace every `<img … data-gen-prompt="…">` in html with a generated asset.
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
