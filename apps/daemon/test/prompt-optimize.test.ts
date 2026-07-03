import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, type AppDeps } from "../src/index.ts";

async function withServer(fn: (base: string) => Promise<void>, extraDeps: Partial<AppDeps> = {}): Promise<void> {
  const store = new Store(":memory:");
  const server = createApp({ ...extraDeps, store, dataDir: mkdtempSync(join(tmpdir(), "dezin-prompt-optimize-")) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

test("POST /api/prompts/optimize returns an optimized prompt from the injected optimizer", async () => {
  const calls: unknown[] = [];
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/api/prompts/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "make a cool shader site",
          agentCommand: "codebuddy",
          model: "hunyuan",
          mode: "standard",
          skillId: "frontend-design",
          designSystemId: "modern-minimal",
        }),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { prompt: "Create a finished Standard-mode shader microsite..." });
    },
    {
      promptOptimizer: async (input) => {
        calls.push(input);
        return "Create a finished Standard-mode shader microsite...";
      },
    } as Partial<AppDeps>,
  );

  assert.equal(calls.length, 1);
  const call = calls[0] as Record<string, unknown>;
  assert.equal(call.prompt, "make a cool shader site");
  assert.equal(call.agentCommand, "codebuddy");
  assert.equal(call.model, "hunyuan");
  assert.equal(call.mode, "standard");
  assert.equal(call.skillId, "frontend-design");
  assert.equal(call.designSystemId, "modern-minimal");
  assert.equal(typeof call.cwd, "string");
});

test("POST /api/prompts/optimize rejects an empty prompt", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prompts/optimize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /prompt is required/);
  });
});
