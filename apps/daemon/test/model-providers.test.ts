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

test("POST /api/model-providers/models does not return the Azure model catalog as deployment names", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: Array.from({ length: 200 }, (_, index) => ({ id: `catalog-model-${index}` })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "azure-openai",
        apiBaseUrl: "https://dezin-resource.openai.azure.com/openai/v1",
        apiKey: "azure-local",
      });

      const res = await fetch(`${base}/api/model-providers/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "azure-openai" }),
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Azure OpenAI deployment names must be entered manually/);
    },
  );

  assert.equal(calls.length, 0);
});

test("POST /api/model-providers/test checks Azure through the resource openai endpoint", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "azure-openai",
        apiBaseUrl: "https://dezin-resource.openai.azure.com",
        apiKey: "azure-local",
        aiProviderOrganization: "2025-04-01-preview",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "azure-openai" }),
      });
      await assertOk(res);
      const body = (await res.json()) as { message: string };
      assert.match(body.message, /Deployment names must be entered manually/);
    },
  );

  assert.equal(calls[0]?.url, "https://dezin-resource.openai.azure.com/openai/models?api-version=2025-04-01-preview");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("api-key"), "azure-local");
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

test("POST /api/model-providers/models uses the Google AI Studio model list endpoint", async () => {
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
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
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

test("POST /api/model-providers/models uses the selected provider profile API key", async () => {
  const calls: FetchCall[] = [];
  await withServer(
    {
      modelProviderFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash-image", displayName: "Gemini Image" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    async (base) => {
      await putSettings(base, {
        aiProviderId: "openai",
        aiProviderEnabled: true,
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "openai-global-key",
        aiProviderProfiles: JSON.stringify({
          openai: {
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            apiKey: "openai-profile-key",
            models: "gpt-image-1",
            organization: "",
          },
          gemini: {
            enabled: true,
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "gemini-profile-key",
            models: "gemini-2.5-flash-image",
            organization: "",
          },
        }),
      });

      const res = await fetch(`${base}/api/model-providers/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "gemini" }),
      });
      await assertOk(res);
    },
  );

  assert.equal(calls[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-profile-key");
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
        aiProviderId: "openai",
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "sk-local",
      });

      const res = await fetch(`${base}/api/model-providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "openai" }),
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "OpenAI model list request failed (401): Unauthorized.");
    },
  );
});
