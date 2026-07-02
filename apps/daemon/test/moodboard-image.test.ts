import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

test("POST /api/moodboards/:id/generate-image sends source asset bytes for Quick Edit", async () => {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-moodboard-image-"));
  const board = store.createMoodboard({ name: "Board" });
  store.updateSettings({
    aiProviderId: "azure-openai",
    aiProviderEnabled: true,
    imageApiBaseUrl: "https://dezin-resource.openai.azure.com/openai",
    imageApiKey: "azure-key",
    imageModel: "gpt-image-2-deployment",
    aiProviderOrganization: "2025-04-01-preview",
    aiProviderProfiles: "",
  });
  const source = store.createMoodboardAsset(board.id, {
    kind: "image",
    fileName: "source.png",
    mimeType: "image/png",
    width: 320,
    height: 240,
    source: "upload",
  });
  const assetsDir = join(dataDir, "moodboards", board.id, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, `${source.id}.png`), Buffer.from("PNGDATA"));
  store.replaceMoodboardNodes(board.id, [
    {
      id: "img1",
      type: "image",
      x: 20,
      y: 30,
      width: 320,
      height: 240,
      data: { assetId: source.id, url: `/api/moodboards/${board.id}/assets/${source.id}` },
    },
  ]);

  const imageRequests: Array<{ url: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  const httpFetch = previousFetch.bind(globalThis);
  globalThis.fetch = (async (input, init) => {
    imageRequests.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("EDITED").toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const server = createApp({ store, dataDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let responseBody!: { messages?: unknown[] };
  try {
    const res = await httpFetch(`http://127.0.0.1:${port}/api/moodboards/${board.id}/generate-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "make it warmer",
        sourceAssetId: source.id,
        model: "gpt-image-2-deployment",
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    responseBody = JSON.parse(text) as { messages?: unknown[] };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = previousFetch;
  }

  const imageRequest = imageRequests[0];
  assert.ok(imageRequest);
  assert.equal(
    imageRequest.url,
    "https://dezin-resource.openai.azure.com/openai/deployments/gpt-image-2-deployment/images/edits?api-version=2025-04-01-preview",
  );
  const form = imageRequest.init?.body as FormData;
  assert.equal(form.get("prompt"), "make it warmer");
  assert.equal(form.get("model"), "gpt-image-2-deployment");
  const image = form.get("image") as File;
  assert.equal(await image.text(), "PNGDATA");
  assert.deepEqual(responseBody.messages ?? [], []);
  assert.equal(store.listMoodboardMessages(board.id).length, 0);
  store.close();
});

test("POST /api/moodboards/:id/generate-image can notify an agent conversation when requested", async () => {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-moodboard-image-"));
  const board = store.createMoodboard({ name: "Board" });
  const conversation = store.ensureMoodboardConversation(board.id);
  store.updateSettings({
    aiProviderId: "openai",
    aiProviderEnabled: true,
    imageApiBaseUrl: "https://api.openai.com/v1",
    imageApiKey: "openai-key",
    imageModel: "gpt-image-2",
    aiProviderProfiles: "",
  });

  const previousFetch = globalThis.fetch;
  const httpFetch = previousFetch.bind(globalThis);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("GENERATED").toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const server = createApp({ store, dataDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await httpFetch(`http://127.0.0.1:${port}/api/moodboards/${board.id}/generate-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "warm editorial lamp",
        conversationId: conversation.id,
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const body = JSON.parse(text) as { messages: Array<{ role: string; conversationId: string; content: string }> };
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]?.role, "assistant");
    assert.equal(body.messages[0]?.conversationId, conversation.id);
    assert.match(body.messages[0]?.content ?? "", /Generating image/);
    assert.match(body.messages[1]?.content ?? "", /Generated an image/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = previousFetch;
    store.close();
  }
});
