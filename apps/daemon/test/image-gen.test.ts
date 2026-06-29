import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImages, type FetchLike } from "../src/image-gen.ts";

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

test("generateImages leaves the placeholder when the API fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-img-"));
  const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const html = `<img src="" data-gen-prompt="x">`;
  const { generated } = await generateImages(html, OPTS, join(dir, "assets"), failing);
  assert.equal(generated, 0);
});
