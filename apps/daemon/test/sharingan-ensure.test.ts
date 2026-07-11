import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptured, capturedPageCount, ensureProbeSession, releaseSharinganProject, SHARINGAN_PROBE_IDLE_MS } from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

function fakeThatCaptures(): SharinganSession {
  return {
    navigate: async () => ({ status: 200, finalUrl: "http://x.test/" }),
    readDom: async () => [{ tag: "h1", classes: "", text: "Home", box: { x: 0, y: 0, w: 10, h: 10 } }],
    readDomTree: async () => [{ tag: "h1", classes: "", text: "Home", box: { x: 0, y: 0, w: 10, h: 10 }, style: {}, children: [] }],
    readRenderMap: async () => ({ viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 900 }, elements: [] }),
    hasPasswordField: async () => false,
    setViewport: async () => {},
    settle: async () => {},
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

test("ensureCaptured writes a Run-scoped capture only into the supplied transaction checkout", async () => {
  const id = "transaction-capture";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-transaction-"));
  const transactionDir = join(dataDir, "run-worktrees", "project", "run");
  const options = {
    maxWaitMs: 5_000,
    pollMs: 30,
    artifactDir: transactionDir,
    open: async () => fakeThatCaptures(),
  } as Parameters<typeof ensureCaptured>[3] & { artifactDir: string };

  assert.equal(await ensureCaptured(id, dataDir, "http://x.test/", options), "captured");
  assert.equal(existsSync(join(transactionDir, ".sharingan", "pages.json")), true);
  assert.equal(existsSync(join(dataDir, "projects", id, ".sharingan", "pages.json")), false);
});

test("ensureCaptured aborts promptly instead of waiting for its polling interval", async () => {
  const id = `ensure-abort-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-abort-"));
  const controller = new AbortController();
  const open = async (_url: string, opts: { signal?: AbortSignal }) => new Promise<SharinganSession>((_resolve, reject) => {
    const rejectAbort = () => reject(opts.signal?.reason ?? Object.assign(new Error("capture aborted"), { name: "AbortError" }));
    if (opts.signal?.aborted) rejectAbort();
    else opts.signal?.addEventListener("abort", rejectAbort, { once: true });
  });
  const startedAt = performance.now();
  const capture = ensureCaptured(id, dataDir, "http://x.test/", {
    maxWaitMs: 250,
    pollMs: 250,
    signal: controller.signal,
    open,
  });
  setTimeout(() => controller.abort(Object.assign(new Error("run cancelled"), { name: "AbortError" })), 20);

  try {
    await assert.rejects(capture, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.ok(performance.now() - startedAt < 150, "abort must wake ensureCaptured before the 250 ms polling interval");
  } finally {
    await releaseSharinganProject(id);
  }
});

test("different capture scopes receive isolated persistent browser profiles", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "shar-profiles-"));
  const firstId = `profile-a-${Date.now()}`;
  const secondId = `profile-b-${Date.now()}`;
  const profileDirs: string[] = [];
  const open = async (_url: string, opts: { userDataDir?: string }) => {
    profileDirs.push(opts.userDataDir ?? "");
    return fakeThatCaptures();
  };

  try {
    await ensureCaptured(firstId, dataDir, "http://a.test/", { maxWaitMs: 5_000, pollMs: 20, open });
    await ensureCaptured(secondId, dataDir, "http://b.test/", { maxWaitMs: 5_000, pollMs: 20, open });
    assert.equal(profileDirs.length, 2);
    assert.notEqual(profileDirs[0], profileDirs[1], "capture scopes must not share a Chrome profile lock or cookies");
    assert.ok(profileDirs.every((dir) => dir.startsWith(join(dataDir, ".sharingan-profiles"))));
  } finally {
    await Promise.all([releaseSharinganProject(firstId), releaseSharinganProject(secondId)]);
  }
});
