import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptured, capturedPageCount, ensureProbeSession, SHARINGAN_PROBE_IDLE_MS } from "../src/sharingan-handler.ts";
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

test("SHARINGAN_PROBE_IDLE_MS is at least 5 minutes", () => {
  assert.ok(SHARINGAN_PROBE_IDLE_MS >= 300_000, "idle window raised from the too-aggressive 2 minutes");
});

test("ensureCaptured with keepSessionForProbe keeps the entry session open for probe reuse", async () => {
  const id = "keep-probe";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-keep-"));
  let opens = 0;
  const fake = fakeThatCaptures();
  const open = async () => { opens += 1; return fake; };
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 5000, pollMs: 30, keepSessionForProbe: true, open });
  assert.equal(phase, "probing", "kept open (probing), not closed to captured");
  assert.equal(capturedPageCount(id), 1, "entry page still captured");
  const s = await ensureProbeSession(id, dataDir, open);
  assert.equal(opens, 1, "probe reuses the kept-open entry session — no reopen");
  assert.equal(s, fake);
});

test("ensureCaptured without keepSessionForProbe closes the entry session (probe reopens)", async () => {
  const id = "no-keep";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-nokeep-"));
  let opens = 0, closes = 0;
  const fake = { ...fakeThatCaptures(), close: async () => { closes += 1; } } as unknown as import("../src/sharingan-browser.ts").SharinganSession;
  const open = async () => { opens += 1; return fake; };
  const phase = await ensureCaptured(id, dataDir, "http://x.test/", { maxWaitMs: 5000, pollMs: 30, open });
  assert.equal(phase, "captured");
  assert.ok(closes >= 1, "entry session closed on captured");
  await ensureProbeSession(id, dataDir, open);
  assert.equal(opens, 2, "probe had to reopen a fresh session");
});
