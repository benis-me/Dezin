import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";

interface Ctx {
  base: string;
  store: Store;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const store = new Store(":memory:");
  const server = createApp({ store, dataDir: mkdtempSync(join(tmpdir(), "dezin-msg-")) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("GET conversation + messages rehydrates a transcript in order", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "P" });
    const conv = store.createConversation(project.id, "Chat");
    store.addMessage(conv.id, "user", "make a hero");
    store.addMessage(conv.id, "assistant", "done");

    // the conversation
    const cRes = await fetch(`${base}/api/projects/${project.id}/conversations/${conv.id}`);
    assert.equal(cRes.status, 200);
    assert.equal(((await cRes.json()) as { id: string }).id, conv.id);

    // its messages, in order
    const mRes = await fetch(`${base}/api/projects/${project.id}/conversations/${conv.id}/messages`);
    assert.equal(mRes.status, 200);
    const msgs = (await mRes.json()) as Array<{ role: string; content: string }>;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.role, "user");
    assert.equal(msgs[0]?.content, "make a hero");
    assert.equal(msgs[1]?.role, "assistant");

    // conversations list still works (web picks the latest)
    const listRes = await fetch(`${base}/api/projects/${project.id}/conversations`);
    assert.equal(((await listRes.json()) as unknown[]).length, 1);
  });
});

test("404s for unknown project/conversation or a mismatched pair", async () => {
  await withServer(async ({ base, store }) => {
    const a = store.createProject({ name: "A" });
    const b = store.createProject({ name: "B" });
    const convA = store.createConversation(a.id);

    // unknown project
    assert.equal((await fetch(`${base}/api/projects/nope/conversations/${convA.id}/messages`)).status, 404);
    // unknown conversation
    assert.equal((await fetch(`${base}/api/projects/${a.id}/conversations/nope/messages`)).status, 404);
    // conversation belongs to a different project
    assert.equal((await fetch(`${base}/api/projects/${b.id}/conversations/${convA.id}/messages`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/${b.id}/conversations/${convA.id}`)).status, 404);
  });
});
