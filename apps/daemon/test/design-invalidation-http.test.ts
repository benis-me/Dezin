import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import {
  broadcastDesignInvalidation,
  designInvalidationRoot,
  persistDesignInvalidation,
} from "../src/design/design-invalidation-journal.ts";
import {
  initializeDesignProject,
  mutateDesignCanvas,
} from "../src/design/design-storage.ts";
import type { DesignInvalidationEvent } from "../src/design/design-types.ts";

interface SseBlock {
  id: string;
  event: string;
  data: { type: string; cursor: string; sequence: number; reason?: string; topics?: string[] };
}

async function firstSseBlock(url: string, headers: Record<string, string>): Promise<{ response: Response; block: SseBlock }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200) {
    assert.fail(`SSE returned ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "SSE closed before its first event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  const lines = buffer.slice(0, buffer.indexOf("\n\n")).split("\n");
  const value = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  return {
    response,
    block: {
      id: value("id"),
      event: value("event"),
      data: JSON.parse(value("data")) as SseBlock["data"],
    },
  };
}

async function firstSseBlocks(
  url: string,
  headers: Record<string, string>,
  count: number,
): Promise<{ response: Response; blocks: SseBlock[] }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200) {
    assert.fail(`SSE returned ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks: SseBlock[] = [];
  let buffer = "";
  try {
    while (blocks.length < count) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, `SSE closed after ${blocks.length} of ${count} expected events`);
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (raw.startsWith(":")) continue;
        const lines = raw.split("\n");
        const value = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
        blocks.push({
          id: value("id"),
          event: value("event"),
          data: JSON.parse(value("data")) as SseBlock["data"],
        });
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return { response, blocks };
}

test("authenticated Design SSE resets initially and replays from Last-Event-ID", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-sse-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    security: { token: "daemon-secret" },
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const projectId = "project-sse";
  await initializeDesignProject(dataDir, projectId, 1);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${base}/api/projects/${projectId}/design-canvas/events`;

  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);

  const initial = await firstSseBlock(url, { "x-dezin-daemon-token": "daemon-secret" });
  assert.equal(initial.block.event, "reset");
  assert.equal(initial.block.data.type, "reset");
  assert.equal(initial.block.data.reason, "initial");
  assert.equal(initial.block.id, initial.block.data.cursor);

  await mutateDesignCanvas(dataDir, projectId, {
    expectedRevision: 0,
    intents: [{ type: "add-node", node: { id: "page-1", kind: "page" } }],
  }, 2);

  const replay = await firstSseBlock(url, {
    "x-dezin-daemon-token": "daemon-secret",
    "Last-Event-ID": initial.block.id,
  });
  assert.equal(replay.block.event, "invalidate");
  assert.equal(replay.block.data.type, "invalidate");
  assert.deepEqual(replay.block.data.topics, ["canvas"]);
  assert.equal(replay.block.data.sequence, initial.block.data.sequence + 1);

  const reset = await firstSseBlock(url, {
    "x-dezin-daemon-token": "daemon-secret",
    "Last-Event-ID": "foreign-epoch:4",
  });
  assert.equal(reset.block.event, "reset");
  assert.equal(reset.block.data.reason, "epoch-mismatch");
  assert.equal(reset.block.id, replay.block.id);
});

test("Design SSE flushes replay before a live event delivered during header setup", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-sse-interleave-"));
  const store = new Store(":memory:");
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    dataDir,
    store,
    runtimeSupervisor,
    security: { token: "daemon-secret" },
  });
  t.after(async () => {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const projectId = "project-sse-interleave";
  await initializeDesignProject(dataDir, projectId, 1);
  const root = designInvalidationRoot(dataDir, projectId);
  const replayEvent = await persistDesignInvalidation(root, ["canvas"]);
  const liveEvent: DesignInvalidationEvent = {
    ...replayEvent,
    cursor: `${replayEvent.epoch}:${replayEvent.sequence + 1}`,
    sequence: replayEvent.sequence + 1,
    topics: ["jobs"],
  };
  let interleaved = false;
  server.prependListener("request", (request, response) => {
    if (request.url !== `/api/projects/${projectId}/design-canvas/events`) return;
    const originalWriteHead = response.writeHead;
    response.writeHead = function (this: typeof response, ...args: unknown[]) {
      if (!interleaved) {
        interleaved = true;
        broadcastDesignInvalidation(root, replayEvent);
        broadcastDesignInvalidation(root, liveEvent);
        broadcastDesignInvalidation(root, liveEvent);
      }
      return Reflect.apply(originalWriteHead, this, args) as typeof response;
    } as typeof response.writeHead;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${base}/api/projects/${projectId}/design-canvas/events`;

  const result = await firstSseBlocks(url, {
    "x-dezin-daemon-token": "daemon-secret",
    "Last-Event-ID": `${replayEvent.epoch}:${replayEvent.sequence - 1}`,
  }, 2);

  assert.equal(interleaved, true);
  assert.deepEqual(result.blocks.map((block) => block.id), [replayEvent.cursor, liveEvent.cursor]);
  assert.equal(new Set(result.blocks.map((block) => block.id)).size, 2);

  interleaved = false;
  const resumed = await firstSseBlocks(url, {
    "x-dezin-daemon-token": "daemon-secret",
    "Last-Event-ID": replayEvent.cursor,
  }, 1);
  assert.deepEqual(resumed.blocks.map((block) => block.id), [liveEvent.cursor]);
});
