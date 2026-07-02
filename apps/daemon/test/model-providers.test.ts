import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, type AppDeps } from "../src/index.ts";

type FetchCall = { url: string; init?: RequestInit };

async function withServer(
  over: Partial<AppDeps> & { modelProviderFetch?: typeof fetch },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const store = over.store ?? new Store(":memory:");
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-model-providers-")), ...over });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

async function putSettings(base: string, patch: object) {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  assert.equal(res.status, 200, await res.text());
}

async function assertOk(res: Response): Promise<void> {
  if (res.status !== 200) assert.fail(await res.text());
}

test("POST /api/model-providers/test verifies the selected provider with the stored API key", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-image-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "openai",
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "sk-local",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "openai" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, true);
      assert.match(body.message, /2 models/);
    },
  );

  assert.equal(calls[0]?.url, "https://api.openai.com/v1/models");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer sk-local");
});

test("POST /api/model-providers/models returns live OpenAI-compatible models", async () => {
  await withServer(
    {
      modelProviderFetch: async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-image-1", owned_by: "openai" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "openai",
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "sk-local",
      });

      const res = await fetch(`${base}/api/model-providers/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "openai" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { models: { id: string; name?: string }[] };
      assert.deepEqual(body.models, [{ id: "gpt-4o" }, { id: "gpt-image-1" }]);
    },
  );
});

test("POST /api/model-providers/models uses Anthropic model-list headers", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "anthropic",
        apiBaseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-local",
      });

      const res = await fetch(`${base}/api/model-providers/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "anthropic" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { models: { id: string; name?: string }[] };
      assert.deepEqual(body.models, [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]);
    },
  );

  assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("x-api-key"), "sk-ant-local");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("authorization"), null);
});
