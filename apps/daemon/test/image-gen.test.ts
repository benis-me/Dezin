import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImages, requestImage, requestImageEdit, type FetchLike } from "../src/image-gen.ts";

const OPTS = { baseUrl: "https://img.example/v1", apiKey: "sk-test", model: "gpt-image-1" };

const fakeFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }] }),
});

test("generateImages replaces data-gen-prompt placeholders with saved assets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-img-"));
  const html = `<main><img src="" data-gen-prompt="a calm mountain" alt="hero" width="800"></main>`;
  const { html: out, generated } = await generateImages(html, OPTS, join(dir, "assets"), fakeFetch);

  assert.equal(generated, 1);
  assert.match(out, /src="assets\/gen-1\.png"/);
  assert.doesNotMatch(out, /data-gen-prompt/);
  assert.match(out, /alt="hero"/); // other attributes preserved
  assert.ok(existsSync(join(dir, "assets", "gen-1.png")), "asset written to disk");
});

test("generateImages is a no-op without an API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-img-"));
  const html = `<img src="" data-gen-prompt="x">`;
  const { html: out, generated } = await generateImages(html, { ...OPTS, apiKey: "" }, join(dir, "assets"), fakeFetch);
  assert.equal(generated, 0);
  assert.equal(out, html);
});

test("requestImage routes Azure images through a deployment endpoint with api-key auth", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "PNG64" }] }) };
  };

  const b64 = await requestImage(
    {
      baseUrl: "https://dezin-resource.openai.azure.com/openai/v1/",
      apiKey: "azure-key",
      model: "gpt-image-2",
      providerId: "azure-openai",
      apiVersion: "2025-04-01-preview",
    },
    "a desk lamp",
    fetcher,
  );

  assert.equal(b64, "PNG64");
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview",
  );
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("api-key"), "azure-key");
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(String(call.init?.body)), { prompt: "a desk lamp", n: 1, size: "1024x1024" });
});

test("requestImageEdit sends the source image as multipart form data", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "EDIT64" }] }) };
  };

  const b64 = await requestImageEdit(
    {
      baseUrl: "https://dezin-resource.openai.azure.com/openai",
      apiKey: "azure-key",
      model: "gpt-image-2-deployment",
      providerId: "azure-openai",
      apiVersion: "2025-04-01-preview",
    },
    "make it warmer",
    { data: Buffer.from("PNGDATA"), mimeType: "image/png", fileName: "source.png" },
    fetcher,
  );

  assert.equal(b64, "EDIT64");
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2-deployment/images/edits?api-version=2025-04-01-preview",
  );
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("api-key"), "azure-key");
  assert.equal(headers.get("content-type"), null);
  const form = call.init?.body as FormData;
  assert.equal(form.get("prompt"), "make it warmer");
  assert.equal(form.get("size"), "1024x1024");
  const image = form.get("image") as File;
  assert.equal(image.name, "source.png");
  assert.equal(image.type, "image/png");
  assert.equal(await image.text(), "PNGDATA");
});

test("generateImages leaves the placeholder when the API fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-img-"));
  const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const html = `<img src="" data-gen-prompt="x">`;
  const { generated } = await generateImages(html, OPTS, join(dir, "assets"), failing);
  assert.equal(generated, 0);
});
