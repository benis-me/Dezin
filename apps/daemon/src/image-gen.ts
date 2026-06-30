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
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
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

/** One image via the OpenAI Images-compatible endpoint; returns base64 PNG. */
export async function requestImage(opts: ImageGenOpts, prompt: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model: opts.model || "gpt-image-1", prompt, n: 1, size: "1024x1024", response_format: "b64_json" }),
  });
  if (!res.ok) throw new Error(`image API ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("image API returned no data");
  return b64;
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
