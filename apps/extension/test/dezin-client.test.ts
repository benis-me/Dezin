import { test } from "node:test";
import assert from "node:assert/strict";
import { createDezinClient } from "../dezin-client.js";

function storageArea(data: Record<string, unknown>, writes: Array<Record<string, unknown>>) {
  return {
    async get(key: string) {
      return { [key]: data[key] };
    },
    async set(values: Record<string, unknown>) {
      writes.push(values);
      Object.assign(data, values);
    },
    async remove(key: string) {
      delete data[key];
    },
  };
}

function fakeChrome() {
  const syncData: Record<string, unknown> = { dezinUrl: "http://127.0.0.1:7457" };
  const localData: Record<string, unknown> = {};
  const syncWrites: Array<Record<string, unknown>> = [];
  const localWrites: Array<Record<string, unknown>> = [];
  return {
    chromeApi: {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      storage: {
        sync: storageArea(syncData, syncWrites),
        local: storageArea(localData, localWrites),
      },
    },
    syncData,
    localData,
    syncWrites,
    localWrites,
  };
}

test("pair stores the issued credential only in chrome.storage.local", async () => {
  const storage = fakeChrome();
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        token: "dezin_ext_secret",
        credential: {
          id: "credential-1",
          extensionId: storage.chromeApi.runtime.id,
          scopes: ["capture:write", "image:analyze"],
          createdAt: 1,
          lastUsedAt: null,
          revokedAt: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = createDezinClient({ chromeApi: storage.chromeApi, fetchImpl });

  await client.pair("123456");

  assert.equal((storage.localData.dezinCredential as { token: string }).token, "dezin_ext_secret");
  assert.equal(JSON.stringify(storage.localWrites).includes("dezin_ext_secret"), true);
  assert.equal(JSON.stringify(storage.syncWrites).includes("dezin_ext_secret"), false);
  assert.equal(JSON.stringify(storage.syncData).includes("dezin_ext_secret"), false);
});

test("capture and analyze attach the local bearer credential", async () => {
  const storage = fakeChrome();
  storage.localData.dezinCredential = { token: "dezin_ext_local", credential: { id: "credential-1" } };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(requests.length === 1 ? { ok: true } : { brief: "brief", agent: "claude" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createDezinClient({ chromeApi: storage.chromeApi, fetchImpl });

  await client.capture({ images: [{ name: "shot.png", base64: "YWJjZA==" }] });
  await client.analyze({ image: "YWJjZA==" });

  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:7457/api/capture",
    "http://127.0.0.1:7457/api/analyze-image",
  ]);
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer dezin_ext_local");
  }
});

test("a 401 clears the rejected local credential without touching the synced URL", async () => {
  const storage = fakeChrome();
  storage.localData.dezinCredential = { token: "dezin_ext_rejected", credential: { id: "credential-1" } };
  const client = createDezinClient({
    chromeApi: storage.chromeApi,
    fetchImpl: async () => new Response(JSON.stringify({ error: "rejected" }), { status: 401 }),
  });

  await assert.rejects(() => client.capture({ images: [{ name: "shot.png", base64: "YWJjZA==" }] }), /rejected/);

  assert.equal(storage.localData.dezinCredential, undefined);
  assert.equal(storage.syncData.dezinUrl, "http://127.0.0.1:7457");
});

test("forget removes only the local credential", async () => {
  const storage = fakeChrome();
  storage.localData.dezinCredential = { token: "dezin_ext_local", credential: { id: "credential-1" } };
  const client = createDezinClient({ chromeApi: storage.chromeApi, fetchImpl: async () => new Response() });

  await client.forget();

  assert.equal(storage.localData.dezinCredential, undefined);
  assert.equal(storage.syncData.dezinUrl, "http://127.0.0.1:7457");
});
