import assert from "node:assert/strict";
import test from "node:test";

import { createFigmaRestClient, FigmaRestError } from "../src/design/figma-rest-client.ts";

test("Figma REST client requests M metadata, exact V selected Nodes, and Variables without leaking PATs into URLs", async () => {
  const calls: Array<{ url: string; headers: Headers; redirect: "error" | "follow" | "manual" | undefined }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (url.endsWith("/variables/local")) return Response.json({ meta: { variables: {}, variableCollections: {} } });
    if (url.includes("?ids=")) return Response.json({ version: "V1", name: "Selected", document: { id: "0:0", type: "DOCUMENT", name: "Selected" } });
    return Response.json({ version: "M1", name: "Meta", document: { id: "0:0", type: "DOCUMENT", name: "Meta" } });
  };
  const client = createFigmaRestClient({ fetch });
  const credential = { token: "figd_private_token_0123456789" };
  await client.getMetadata({ fileKey: "AbC123xyZ", credential });
  await client.getFileVersion({
    fileKey: "AbC123xyZ",
    version: "V1",
    nodeIds: ["1:2", "3:4"],
    depth: 4,
    branchData: true,
    credential,
  });
  const variables = await client.getLocalVariables({ fileKey: "AbC123xyZ", credential });
  assert.equal(variables.kind, "available");
  assert.equal(calls[0]?.url, "https://api.figma.com/v1/files/AbC123xyZ/meta");
  assert.equal(calls[1]?.url, "https://api.figma.com/v1/files/AbC123xyZ?ids=1%3A2%2C3%3A4&version=V1&depth=4&branch_data=true");
  assert.equal(calls[2]?.url, "https://api.figma.com/v1/files/AbC123xyZ/variables/local");
  for (const call of calls) {
    assert.equal(call.url.includes(credential.token), false);
    assert.equal(call.headers.get("x-figma-token"), credential.token);
    assert.equal(call.redirect, "error");
  }
});

test("Figma REST cancellation preserves AbortError instead of converting it to an upstream failure", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  const client = createFigmaRestClient({ fetch: async () => { throw abort; } });
  await assert.rejects(
    client.getMetadata({ fileKey: "AbC123xyZ", credential: { token: "figd_private_token_0123456789" } }),
    (error: unknown) => error === abort,
  );
});

test("Figma REST client never retries before a long Retry-After window and honors a short bounded window", async () => {
  let calls = 0;
  const delays: number[] = [];
  const long = createFigmaRestClient({
    fetch: async () => {
      calls += 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "99" } });
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  await assert.rejects(long.getLocalVariables({
    fileKey: "AbC123xyZ",
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && error.status === 429);
  assert.equal(delays.length, 0);
  assert.equal(calls, 1);

  calls = 0;
  const short = createFigmaRestClient({
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
        : new Response("forbidden", { status: 403 });
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  const result = await short.getLocalVariables({
    fileKey: "AbC123xyZ",
    credential: { token: "figd_private_token_0123456789" },
  });
  assert.deepEqual(delays, [1_000]);
  assert.equal(calls, 2);
  assert.deepEqual(result, { kind: "unavailable", status: 403, reason: "Figma Variables are unavailable (HTTP 403)." });

  for (const retryAfter of [null, "garbage"]) {
    let unsafeCalls = 0;
    const noWindow = createFigmaRestClient({
      fetch: async () => {
        unsafeCalls += 1;
        return new Response("rate limited", {
          status: 429,
          ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
        });
      },
      sleep: async () => { throw new Error("must not wait without a valid window"); },
    });
    await assert.rejects(noWindow.getMetadata({
      fileKey: "AbC123xyZ",
      credential: { token: "figd_private_token_0123456789" },
    }), (error: unknown) => error instanceof FigmaRestError && error.status === 429);
    assert.equal(unsafeCalls, 1);
  }
});

test("Figma REST client bounds JSON bytes and sanitizes upstream errors", async () => {
  const secret = "figd_private_token_0123456789";
  const oversized = createFigmaRestClient({
    fetch: async () => new Response("x".repeat(128), { headers: { "content-type": "application/json" } }),
    maxResponseBytes: 64,
  });
  await assert.rejects(
    oversized.getMetadata({ fileKey: "AbC123xyZ", credential: { token: secret } }),
    (error: unknown) => error instanceof FigmaRestError && !error.message.includes(secret) && /byte budget/.test(error.message),
  );
  const denied = createFigmaRestClient({ fetch: async () => new Response(secret, { status: 401 }) });
  await assert.rejects(
    denied.getMetadata({ fileKey: "AbC123xyZ", credential: { token: secret } }),
    (error: unknown) => error instanceof FigmaRestError && error.status === 401 && !error.message.includes(secret),
  );
});

test("Figma REST attempts have a wall-clock deadline even when fetch never settles", async () => {
  const client = createFigmaRestClient({
    fetch: async () => new Promise<Response>(() => {}),
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    client.getMetadata({ fileKey: "AbC123xyZ", credential: { token: "figd_private_token_0123456789" } }),
    (error: unknown) => error instanceof FigmaRestError && /timed out/.test(error.message),
  );
});
