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

test("POST /api/model-providers/models uses the Gemini native list endpoint", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "gemini",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: "gemini-local",
      });

      const res = await fetch(`${base}/api/model-providers/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "gemini" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { models: { id: string; name?: string }[] };
      assert.deepEqual(body.models, [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    },
  );

  assert.equal(calls[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-local");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), null);
});

test("POST /api/model-providers/test verifies WaveSpeed through its authenticated model list", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ model_id: "wavespeed-ai/flux-kontext-pro", name: "FLUX Kontext Pro" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "wavespeed",
        apiBaseUrl: "https://api.wavespeed.ai/api/v3",
        apiKey: "wavespeed-local",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "wavespeed" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, true);
      assert.match(body.message, /WaveSpeed/);
    },
  );

  assert.equal(calls[0]?.url, "https://api.wavespeed.ai/api/v3/models");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer wavespeed-local");
});

test("POST /api/model-providers/test returns provider JSON error messages cleanly", async () => {
  await withServer(
    {
      modelProviderFetch: async () =>
        new Response(JSON.stringify({ code: 401, message: "Unauthorized." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "wavespeed",
        apiBaseUrl: "https://api.wavespeed.ai/api/v3",
        apiKey: "wavespeed-local",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "wavespeed" }),
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "WaveSpeed model list request failed (401): Unauthorized.");
    },
  );
});

test("POST /api/model-providers/test verifies Vertex AI with project and location", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ publisherModels: [{ name: "publishers/google/models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "vertex-ai",
        apiBaseUrl: "https://aiplatform.googleapis.com/v1",
        apiKey: "ya29.local",
        aiProviderOrganization: "demo-project:us-central1",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "vertex-ai" }),
      });
      await assertOk(res);
    },
  );

  assert.equal(calls[0]?.url, "https://aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer ya29.local");
});

test("POST /api/model-providers/test probes Fal without submitting generation work", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ detail: "request not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "fal",
        apiBaseUrl: "https://fal.run",
        apiKey: "fal-local",
        aiProviderModels: "fal-ai/flux-pro",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "fal" }),
      });
      await assertOk(res);
    },
  );

  assert.equal(calls[0]?.url, "https://queue.fal.run/fal-ai/flux-pro/requests/dezin-connection-test/status");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Key fal-local");
});

test("POST /api/model-providers/test probes a Midjourney gateway without creating a job", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ error: "job not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "midjourney-gateway",
        apiBaseUrl: "https://api.ttapi.io",
        apiKey: "ttapi-local",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "midjourney-gateway" }),
      });
      await assertOk(res);
    },
  );

  assert.equal(calls[0]?.url, "https://api.ttapi.io/midjourney/v1/fetch?jobId=dezin-connection-test");
  assert.equal(new Headers(calls[0]?.init?.headers).get("tt-api-key"), "ttapi-local");
});
