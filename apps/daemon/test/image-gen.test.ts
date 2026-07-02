import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImages, requestImage, requestImageEdit, type FetchLike } from "../src/image-gen.ts";

const OPTS = { baseUrl: "https://img.example/v1", apiKey: "sk-test", model: "gpt-image-1" };

const fakeFetch: FetchLike = async () =>
  new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
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

test("requestImage routes Azure v1 image generation with the deployment model in the body", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const imageBase64 = Buffer.from("PNG64").toString("base64");
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

  assert.equal(b64, imageBase64);
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview",
  );
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("api-key"), "azure-key");
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    model: "gpt-image-2",
    prompt: "a desk lamp",
    n: 1,
    size: "1024x1024",
  });
});

test("requestImage passes supported Azure GPT image parameters through provider options", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const imageBase64 = Buffer.from("PNG64").toString("base64");
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await requestImage(
    {
      baseUrl: "https://dezin-resource.openai.azure.com/openai/v1/",
      apiKey: "azure-key",
      model: "gpt-image-2",
      providerId: "azure-openai",
      apiVersion: "2025-04-01-preview",
      params: {
        quality: "high",
        size: "1536x1024",
        background: "transparent",
        moderation: "low",
        count: 1,
      },
    },
    "a desk lamp",
    fetcher,
  );

  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    model: "gpt-image-2",
    prompt: "a desk lamp",
    n: 1,
    size: "1536x1024",
    quality: "high",
    background: "transparent",
    moderation: "low",
  });
});

test("requestImage passes OpenAI output format parameters through provider options", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const imageBase64 = Buffer.from("PNG64").toString("base64");
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await requestImage(
    {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "gpt-image-2",
      providerId: "openai",
      params: {
        size: "1536x1024",
        outputFormat: "webp",
        outputCompression: 80,
      },
    },
    "a desk lamp",
    fetcher,
  );

  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    model: "gpt-image-2",
    prompt: "a desk lamp",
    n: 1,
    size: "1536x1024",
    output_format: "webp",
    output_compression: 80,
    response_format: "b64_json",
  });
});

test("requestImageEdit sends the source image as multipart form data", async () => {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const imageBase64 = Buffer.from("EDIT64").toString("base64");
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

  assert.equal(b64, imageBase64);
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
  assert.equal(form.get("model"), "gpt-image-2-deployment");
  const image = form.get("image") as File;
  assert.equal(image.type, "image/png");
  assert.equal(await image.text(), "PNGDATA");
});

test("requestImage logs Azure request context on API errors without leaking secrets", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const fetcher: FetchLike = async () =>
    new Response(JSON.stringify({ error: { code: "DeploymentNotFound", message: "deployment missing" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      () =>
        requestImage(
          {
            baseUrl: "https://dezin-resource.openai.azure.com/openai/v1/",
            apiKey: "azure-key",
            model: "gpt-image-2-deployment",
            providerId: "azure-openai",
            apiVersion: "2025-04-01-preview",
          },
          "private prompt text",
          fetcher,
        ),
      /image API 404: deployment missing/,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.[0], "[dezin:image-api] request failed");
  assert.deepEqual(warnings[0]?.[1], {
    operation: "generate",
    providerId: "azure-openai",
    azure: true,
    endpoint: "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2-deployment/images/generations?api-version=2025-04-01-preview",
    model: "gpt-image-2-deployment",
    apiVersion: "2025-04-01-preview",
    status: 404,
    response: '{"error":{"code":"DeploymentNotFound","message":"deployment missing"}}',
  });
  assert.doesNotMatch(JSON.stringify(warnings), /azure-key|private prompt text/);
});

test("requestImageEdit logs the Azure edit endpoint and multipart image field on API errors", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const fetcher: FetchLike = async () => new Response("resource not found", { status: 404 });

  try {
    await assert.rejects(
      () =>
        requestImageEdit(
          {
            baseUrl: "https://dezin-resource.openai.azure.com/openai",
            apiKey: "azure-key",
            model: "gpt-image-2-deployment",
            providerId: "azure-openai",
            apiVersion: "2025-04-01-preview",
          },
          "private edit prompt",
          { data: Buffer.from("PNGDATA"), mimeType: "image/png", fileName: "source.png" },
          fetcher,
        ),
      /image API 404/,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.[0], "[dezin:image-api] request failed");
  assert.deepEqual(warnings[0]?.[1], {
    operation: "edit",
    providerId: "azure-openai",
    azure: true,
    endpoint: "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2-deployment/images/edits?api-version=2025-04-01-preview",
    model: "gpt-image-2-deployment",
    apiVersion: "2025-04-01-preview",
    status: 404,
    response: "resource not found",
    imageField: "image",
    sourceMimeType: "image/png",
    sourceFileName: "source.png",
  });
  assert.doesNotMatch(JSON.stringify(warnings), /azure-key|private edit prompt/);
});

test("generateImages leaves the placeholder when the API fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-img-"));
  const failing: FetchLike = async () => new Response("server error", { status: 500 });
  const html = `<img src="" data-gen-prompt="x">`;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { generated } = await generateImages(html, OPTS, join(dir, "assets"), failing);
    assert.equal(generated, 0);
  } finally {
    console.warn = originalWarn;
  }
});
