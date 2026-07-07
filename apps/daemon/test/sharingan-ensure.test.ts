import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptured, capturedPageCount } from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

function fakeThatCaptures(): SharinganSession {
  return {
    navigate: async () => ({ status: 200, finalUrl: "http://x.test/" }),
    readDom: async () => [{ tag: "h1", classes: "", text: "Home", box: { x: 0, y: 0, w: 10, h: 10 } }],
    hasPasswordField: async () => false,
    setViewport: async () => {},
    screenshot: async () => Buffer.from("x"),
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    assets: async () => [],
    discoverLinks: async () => [],
    close: async () => {},
  } as unknown as SharinganSession;
}

test("ensureCaptured kicks the capture from idle and resolves 'captured'", async () => {
  const id = "ensure-ok";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens-"));
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  assert.equal(phase, "captured");
  assert.equal(capturedPageCount(id), 1);
});

test("ensureCaptured returns immediately when already captured", async () => {
  const id = "ensure-done";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens2-"));
  await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  const t0 = process.hrtime.bigint();
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 10_000, pollMs: 50, open: async () => fakeThatCaptures() });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(phase, "captured");
  assert.ok(elapsedMs < 40, "second call short-circuits without re-capturing");
});

test("ensureCaptured resolves (does not hang) on a stuck capture past the timeout", async () => {
  const id = "ensure-stuck";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-ens3-"));
  // Fake whose navigate never resolves → phase stays "capturing"; ensureCaptured must time out, not hang.
  const stuck = { navigate: () => new Promise<never>(() => {}), close: async () => {} } as unknown as SharinganSession;
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 300, pollMs: 50, open: async () => stuck });
  assert.ok(phase !== "captured", "timed out without a successful capture");
});
