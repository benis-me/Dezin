import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { createFigmaRestClient, FigmaRestError } from "../src/design/figma-rest-client.ts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBytes.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([header, data, checksum]);
}

function pngFixture(width: number, height: number, ancillary: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((Math.ceil(width / 8) + 1) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    ...ancillary,
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
}

function inexactScanlinePngFixture(width: number, height: number): Buffer {
  const valid = pngFixture(width, height);
  const headerEnd = 8 + 12 + 13;
  return Buffer.concat([
    valid.subarray(0, headerEnd),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk("IEND"),
  ]);
}

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

test("Figma REST client resolves exact-Version render URLs internally and returns bounded PNG authority", async () => {
  const calls: Array<{ url: string; headers: Headers; redirect: RequestInit["redirect"] }> = [];
  const renders = new Map([
    ["https://s3-alpha-sig.figma.com/img/one?Signature=one", pngFixture(720, 564)],
    ["https://content.figmausercontent.com/render/two?Expires=42&Signature=two", pngFixture(720, 727)],
  ]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, redirect: init?.redirect });
    if (url.startsWith("https://api.figma.com/v1/images/")) {
      return Response.json({
        images: {
          "457:5027": "https://s3-alpha-sig.figma.com/img/one?Signature=one",
          "I457:5028;1:2": "https://content.figmausercontent.com/render/two?Expires=42&Signature=two",
          "457:5999": null,
        },
      });
    }
    const png = renders.get(url);
    assert.ok(png, `unexpected render URL ${url}`);
    return new Response(png, {
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  };
  const client = createFigmaRestClient({ fetch });
  const result = await client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["457:5027", "I457:5028;1:2", "457:5999"],
    credential: { token: "figd_private_token_0123456789" },
  });

  assert.equal(calls[0]?.url,
    "https://api.figma.com/v1/images/AbC123xyZ?ids=457%3A5027%2CI457%3A5028%3B1%3A2%2C457%3A5999&version=V42&format=png&scale=1&contents_only=true&use_absolute_bounds=true");
  assert.equal(calls[0]?.headers.get("x-figma-token"), "figd_private_token_0123456789");
  for (const call of calls) assert.equal(call.redirect, "error");
  for (const call of calls.slice(1)) {
    assert.equal(call.headers.has("x-figma-token"), false);
    assert.equal(call.headers.get("accept"), "image/png");
  }
  assert.deepEqual(result.renders.map(({ nodeId, width, height }) => ({ nodeId, width, height })), [
    { nodeId: "457:5027", width: 720, height: 564 },
    { nodeId: "I457:5028;1:2", width: 720, height: 727 },
  ]);
  assert.deepEqual(result.unavailableNodeIds, ["457:5999"]);
});

test("Figma render-map generation has a bounded budget longer than ordinary REST requests", async () => {
  const png = pngFixture(10, 10);
  const client = createFigmaRestClient({
    requestTimeoutMs: 20,
    renderMapTimeoutMs: 200,
    fetch: async (input) => {
      if (String(input).startsWith("https://api.figma.com/v1/images/")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return Response.json({ images: { "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one" } });
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });

  const result = await client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
  });
  assert.deepEqual(result.renders.map(({ nodeId, width, height }) => ({ nodeId, width, height })), [
    { nodeId: "1:1", width: 10, height: 10 },
  ]);
});

test("Figma render-map generation remains bounded by its dedicated deadline", async () => {
  const client = createFigmaRestClient({
    requestTimeoutMs: 200,
    renderMapTimeoutMs: 20,
    fetch: async () => new Promise<Response>(() => {}),
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && error.message === "Figma render map timed out");
});

test("Figma render-map timeout cancels a response body that ignores the request signal", async () => {
  let bodyCancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('{"images":'));
    },
    cancel() {
      bodyCancelled += 1;
    },
  });
  const client = createFigmaRestClient({
    requestTimeoutMs: 200,
    renderMapTimeoutMs: 20,
    fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && error.message === "Figma render map timed out");
  assert.equal(bodyCancelled, 1);
});

test("caller Abort interrupts slow Figma render-map generation immediately", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  const client = createFigmaRestClient({
    requestTimeoutMs: 200,
    renderMapTimeoutMs: 200,
    fetch: async () => new Promise<Response>(() => {}),
  });
  const pending = client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
    signal: controller.signal,
  }).then(
    () => "resolved" as const,
    (error: unknown) => error === reason ? "aborted" as const : "wrong-error" as const,
  );
  setTimeout(() => controller.abort(reason), 5);
  const outcome = await Promise.race([
    pending,
    new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 50)),
  ]);
  assert.equal(outcome, "aborted");
});

test("Figma REST client strips PNG text and compressed-text metadata before returning durable bytes", async () => {
  const signedUrl = "https://s3-alpha-sig.figma.com/private.png?X-Amz-Signature=secret&X-Amz-Expires=30";
  const png = pngFixture(720, 620, [
    pngChunk("tEXt", Buffer.from(`Comment\0${signedUrl}`)),
    pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(Buffer.from(signedUrl))])),
  ]);
  const client = createFigmaRestClient({
    fetch: async (input) => String(input).startsWith("https://api.figma.com/")
      ? Response.json({ images: { "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one" } })
      : new Response(png, { headers: { "content-type": "image/png" } }),
  });
  const result = await client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
  });
  const sanitized = result.renders[0]!.png;
  assert.equal(sanitized.includes(Buffer.from("tEXt")), false);
  assert.equal(sanitized.includes(Buffer.from("zTXt")), false);
  assert.equal(sanitized.includes(Buffer.from("s3-alpha-sig.figma.com")), false);
  assert.deepEqual(result.renders.map(({ width, height }) => ({ width, height })), [{ width: 720, height: 620 }]);
});

test("Figma REST client rejects CRC-valid PNG containers with an inexact decoded scanline layout", async () => {
  const invalid = inexactScanlinePngFixture(720, 620);
  const client = createFigmaRestClient({
    fetch: async (input) => String(input).startsWith("https://api.figma.com/")
      ? Response.json({ images: { "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one" } })
      : new Response(invalid, { headers: { "content-type": "image/png" } }),
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && /scanline|compressed input/.test(error.message));
});

test("Figma REST client rejects a render batch that exceeds its aggregate byte budget", async () => {
  const png = pngFixture(1, 1);
  const client = createFigmaRestClient({
    maxRenderBytes: png.length,
    maxTotalRenderBytes: png.length + 1,
    fetch: async (input) => String(input).startsWith("https://api.figma.com/")
      ? Response.json({
        images: {
          "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one",
          "1:2": "https://s3-alpha-sig.figma.com/b?Signature=two",
        },
      })
      : new Response(png, { headers: { "content-type": "image/png" } }),
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1", "1:2"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && /total byte budget/.test(error.message));
});

test("Figma REST client aborts and settles sibling workers before returning a download failure", async () => {
  let siblingAborts = 0;
  let downloadIndex = 0;
  const png = pngFixture(10, 10);
  const client = createFigmaRestClient({
    fetch: async (input, init) => {
      if (String(input).startsWith("https://api.figma.com/")) {
        return Response.json({ images: {
          "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one",
          "1:2": "https://s3-alpha-sig.figma.com/b?Signature=two",
          "1:3": "https://s3-alpha-sig.figma.com/c?Signature=three",
        } });
      }
      downloadIndex += 1;
      if (downloadIndex === 1) throw new Error("download exploded");
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(png, { headers: { "content-type": "image/png" } })), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          siblingAborts += 1;
          reject(init.signal?.reason);
        }, { once: true });
      });
    },
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1", "1:2", "1:3"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && error.message === "Figma render download failed");
  assert.equal(siblingAborts, 2);
});

test("Figma REST client rejects a render batch that exceeds its aggregate pixel budget", async () => {
  const png = pngFixture(10, 10);
  const client = createFigmaRestClient({
    maxTotalRenderPixels: 150,
    fetch: async (input) => String(input).startsWith("https://api.figma.com/")
      ? Response.json({ images: {
        "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one",
        "1:2": "https://s3-alpha-sig.figma.com/b?Signature=two",
      } })
      : new Response(png, { headers: { "content-type": "image/png" } }),
  });
  await assert.rejects(client.getNodeRenders!({
    fileKey: "AbC123xyZ",
    version: "V42",
    nodeIds: ["1:1", "1:2"],
    credential: { token: "figd_private_token_0123456789" },
  }), (error: unknown) => error instanceof FigmaRestError && /total pixel budget/.test(error.message));
});

test("Figma REST client rejects hostile render URLs before any download", async (t) => {
  const token = "figd_private_token_0123456789";
  for (const [label, renderUrl] of [
    ["untrusted-host", "https://example.com/reference.png?Signature=one"],
    ["credential-canary", `https://s3-alpha-sig.figma.com/reference.png?token=${encodeURIComponent(token)}`],
  ] as const) {
    await t.test(label, async () => {
      let downloads = 0;
      const client = createFigmaRestClient({
        fetch: async (input) => {
          if (!String(input).startsWith("https://api.figma.com/")) downloads += 1;
          return Response.json({ images: { "1:1": renderUrl } });
        },
      });
      await assert.rejects(client.getNodeRenders!({
        fileKey: "AbC123xyZ",
        version: "V42",
        nodeIds: ["1:1"],
        credential: { token },
      }), (error: unknown) => error instanceof FigmaRestError
        && error.message === "Figma render URL is invalid"
        && !error.message.includes(token));
      assert.equal(downloads, 0);
    });
  }
});

test("Figma REST client rejects mislabeled or malformed PNG downloads", async (t) => {
  for (const [label, contentType, bytes, message] of [
    ["content-type", "text/html", Buffer.from("not an image"), "Figma render content type is invalid"],
    ["signature", "image/png", Buffer.alloc(33), "Figma render is not a valid PNG"],
  ] as const) {
    await t.test(label, async () => {
      const client = createFigmaRestClient({
        fetch: async (input) => String(input).startsWith("https://api.figma.com/")
          ? Response.json({ images: { "1:1": "https://s3-alpha-sig.figma.com/a?Signature=one" } })
          : new Response(bytes, { headers: { "content-type": contentType } }),
      });
      await assert.rejects(client.getNodeRenders!({
        fileKey: "AbC123xyZ",
        version: "V42",
        nodeIds: ["1:1"],
        credential: { token: "figd_private_token_0123456789" },
      }), (error: unknown) => error instanceof FigmaRestError && error.message === message);
    });
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
