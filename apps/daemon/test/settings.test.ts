import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-settings-")) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

async function getSettings(base: string) {
  return (await (await fetch(`${base}/api/settings`)).json()) as Record<string, string | boolean>;
}
async function putSettings(base: string, patch: object) {
  return await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

test("GET /api/settings returns defaults", async () => {
  await withServer(async (base) => {
    const s = await getSettings(base);
    assert.equal(s.agentCommand, "claude");
    assert.equal(s.defaultDesignSystemId, "modern-minimal");
    assert.equal(s.model, "");
    assert.equal(s.visualQaEnabled, false);
    assert.equal(s.videoModel, "");
  });
});

test("PUT /api/settings merges and persists", async () => {
  await withServer(async (base) => {
    const res = await putSettings(base, {
      agentCommand: "codex",
      model: "o3",
      apiKey: "sk-local",
      videoModel: "sora",
      visualQaEnabled: true,
    });
    assert.equal(res.status, 200);
    const updated = (await res.json()) as Record<string, unknown>;
    assert.equal(updated.agentCommand, "codex");
    assert.equal(updated.model, "o3");
    assert.equal(updated.videoModel, "sora");
    assert.equal(updated.visualQaEnabled, true);

    const fetched = await getSettings(base);
    assert.equal(fetched.agentCommand, "codex");
    assert.equal(fetched.apiKey, "");
    assert.equal(fetched.videoModel, "sora");
    assert.equal(fetched.visualQaEnabled, true);
    assert.equal(fetched.defaultDesignSystemId, "modern-minimal"); // untouched default
  });
});

test("GET /api/settings redacts stored provider secrets", async () => {
  await withServer(async (base) => {
    const res = await putSettings(base, {
      apiKey: "sk-agent",
      imageApiKey: "sk-image",
      videoApiKey: "sk-video",
      imageApiBaseUrl: "https://images.example.test/v1",
      videoApiBaseUrl: "https://videos.example.test/v1",
    });
    assert.equal(res.status, 200);

    const fetched = await getSettings(base);
    assert.equal(fetched.apiKey, "");
    assert.equal(fetched.imageApiKey, "");
    assert.equal(fetched.videoApiKey, "");
    assert.equal(fetched.apiKeyConfigured, true);
    assert.equal(fetched.imageApiKeyConfigured, true);
    assert.equal(fetched.videoApiKeyConfigured, true);
    assert.equal(fetched.imageApiBaseUrl, "https://images.example.test/v1");
    assert.equal(fetched.videoApiBaseUrl, "https://videos.example.test/v1");
  });
});

test("PUT with a partial body only changes those fields", async () => {
  await withServer(async (base) => {
    await putSettings(base, { agentCommand: "gemini", customInstructions: "no emoji" });
    await putSettings(base, { model: "flash" });
    const s = await getSettings(base);
    assert.equal(s.model, "flash");
    assert.equal(s.agentCommand, "gemini");
    assert.equal(s.customInstructions, "no emoji");
  });
});

test("PUT with a non-object body is 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
  });
});
