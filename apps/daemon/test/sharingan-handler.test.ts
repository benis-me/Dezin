import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";
import {
  SHARINGAN_RELEASE_GRACE_MS,
  cancelSharinganProject,
  ensureProbeSession,
  handleSharinganCapture,
  handleSharinganNavigate,
  handleSharinganEvents,
  handleSharinganReadDom,
  peekSharinganStatus,
  startCapture,
  handleSharinganStatus,
  releaseSharinganProject,
  sharinganCaptureRegistrySizeForTests,
} from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";
import { projectDir } from "../src/serve-static.ts";

test("POST /start begins a capture and GET /status reports progress", { skip: !findChrome() && "no Chrome" }, async () => {
  const fixture = createServer((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>T</title><h1>Acme</h1><p>" + "w ".repeat(60) + "</p>"); });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-dd-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: target });
  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const started = await fetch(`${base}/api/sharingan/${project.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target }) });
    assert.equal(started.status, 200);
    // Poll status until the capture finishes.
    let phase = "";
    for (let i = 0; i < 120; i++) {
      const s = (await (await fetch(`${base}/api/sharingan/${project.id}/status`)).json()) as { phase: string };
      phase = s.phase;
      if (phase === "captured" || phase === "login-required" || phase === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(phase, "captured");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    await new Promise<void>((r) => fixture.close(() => r()));
    store.close();
  }
});

/** Minimal raw HTTP server that proxies a single id's status via handleSharinganStatus. */
function statusServer(id: string, dataDir = mkdtempSync(join(tmpdir(), "shar-status-"))): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => handleSharinganStatus(res, id, dataDir));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function probeCaptureServer(id: string, dataDir: string): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { void handleSharinganCapture(req, res, id, dataDir); });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function probeNavigationServer(id: string, dataDir: string): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/navigate") void handleSharinganNavigate(req, res, id, dataDir);
      else void handleSharinganCapture(req, res, id, dataDir);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function fakeProbeCaptureSession(options: { screenshotError?: Error; url?: string; finalUrl?: string } = {}): SharinganSession {
  return {
    currentUrl: () => options.finalUrl ?? options.url ?? "https://x.test/",
    navigate: async (url: string) => ({ status: 200, finalUrl: options.finalUrl ?? url }),
    readDom: async () => [{ tag: "main", classes: "", text: "Captured source page", box: { x: 0, y: 0, w: 100, h: 100 } }],
    hasPasswordField: async () => false,
    setViewport: async () => {},
    settle: async () => {},
    screenshot: async () => {
      if (options.screenshotError) throw options.screenshotError;
      return Buffer.from("png");
    },
    readRenderMap: async () => ({ viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 900 }, elements: [] }),
    readDomTree: async () => [],
    styleTokens: async () => ({ colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] }),
    assets: async () => [],
    fetchAsset: async () => null,
    discoverLinks: async () => [],
    close: async () => {},
  } as unknown as SharinganSession;
}

test("entry capture persists requested and real final identities for an allowed canonical redirect", async () => {
  const id = `entry-canonical-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-entry-canonical-"));
  const requestedUrl = "https://x.test/products";
  const finalUrl = "https://x.test/products/";

  await startCapture(
    id,
    requestedUrl,
    dataDir,
    "/tmp/unused-profile",
    async () => fakeProbeCaptureSession({ url: requestedUrl, finalUrl }),
  );

  try {
    assert.equal(peekSharinganStatus(id, dataDir)?.phase, "captured");
    const manifest = JSON.parse(
      readFileSync(join(projectDir(dataDir, id), ".sharingan", "pages.json"), "utf8"),
    ) as {
      requestedSourceUrl?: string;
      sourceUrl?: string;
      pages?: Array<{ requestedUrl?: string; url?: string }>;
    };
    assert.equal(manifest.requestedSourceUrl, requestedUrl);
    assert.equal(manifest.sourceUrl, finalUrl, "the manifest source identity follows the pixels actually captured");
    assert.equal(manifest.pages?.[0]?.requestedUrl, requestedUrl);
    assert.equal(manifest.pages?.[0]?.url, finalUrl);
  } finally {
    await releaseSharinganProject(id);
  }
});

function seedProbeManifest(root: string, sourceUrl: string): void {
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(join(root, ".sharingan", "pages.json"), JSON.stringify({ sourceUrl, pages: [] }));
}

function seedProbeDerivedArtifacts(root: string): string[] {
  const staleFiles = [
    join(".sharingan", "source-scaffold", "index.html"),
    join(".sharingan", "region-plan.json"),
    join(".sharingan", "region-build.json"),
    join(".sharingan", "region-work", "state.json"),
    join("src", "sharingan-regions", "Hero.tsx"),
  ];
  for (const rel of staleFiles) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "stale");
  }
  return staleFiles;
}

test("probe entry recapture invalidates stale Sharingan derivatives after success", async () => {
  const id = `probe-recapture-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-recapture-"));
  const root = projectDir(dataDir, id);
  const staleFiles = seedProbeDerivedArtifacts(root);
  const sourceUrl = "https://x.test/entry";
  seedProbeManifest(root, sourceUrl);
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ url: sourceUrl }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    for (const rel of staleFiles) assert.equal(existsSync(join(root, rel)), false, `${rel} is invalidated`);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as {
      requestedSourceUrl?: string;
      sourceUrl?: string;
      pages?: Array<{ requestedUrl?: string; url?: string }>;
    };
    assert.equal(manifest.requestedSourceUrl, sourceUrl);
    assert.equal(manifest.sourceUrl, sourceUrl);
    assert.equal(manifest.pages?.[0]?.requestedUrl, sourceUrl, "a no-navigation entry recapture retains a verifiable requested identity");
    assert.equal(manifest.pages?.[0]?.url, sourceUrl);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe secondary-page capture preserves entry-derived Sharingan artifacts", async () => {
  const id = `probe-secondary-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-secondary-"));
  const root = projectDir(dataDir, id);
  const staleFiles = seedProbeDerivedArtifacts(root);
  const sourceUrl = "https://x.test/entry";
  seedProbeManifest(root, sourceUrl);
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ url: "https://x.test/secondary" }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    for (const rel of staleFiles) assert.equal(existsSync(join(root, rel)), true, `${rel} remains for a secondary capture`);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as { sourceUrl?: string };
    assert.equal(manifest.sourceUrl, sourceUrl, "capturing a secondary page keeps the entry sourceUrl");
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe capture rejects a cross-origin navigation redirect before persisting redirected pixels", async () => {
  const id = `probe-cross-origin-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-cross-origin-"));
  const root = projectDir(dataDir, id);
  seedProbeManifest(root, "https://x.test/entry");
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ finalUrl: "https://evil.test/landing" }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/products" }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /cross-origin redirect/i);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as { pages?: unknown[] };
    assert.deepEqual(manifest.pages, [], "the redirected page never enters the evidence manifest");
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe capture refuses a cross-origin current page reached by a prior navigation", async () => {
  const id = `probe-cross-origin-current-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-cross-origin-current-"));
  const root = projectDir(dataDir, id);
  seedProbeManifest(root, "https://x.test/entry");
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ url: "https://evil.test/landing" }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /outside the entry origin/i);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as { pages?: unknown[] };
    assert.deepEqual(manifest.pages, []);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe capture records requested and final identities for an allowed canonical navigation redirect", async () => {
  const id = `probe-canonical-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-canonical-"));
  const root = projectDir(dataDir, id);
  const requestedUrl = "https://x.test/products";
  const finalUrl = "https://x.test/products/";
  seedProbeManifest(root, "https://x.test/entry");
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ finalUrl }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: requestedUrl }),
    });
    assert.equal(response.status, 200);
    const captured = (await response.json()) as { requestedUrl?: string; url?: string };
    assert.equal(captured.requestedUrl, requestedUrl);
    assert.equal(captured.url, finalUrl);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as {
      sourceUrl?: string;
      pages?: Array<{ requestedUrl?: string; url?: string }>;
    };
    assert.equal(manifest.sourceUrl, "https://x.test/entry", "a secondary canonical redirect cannot replace the entry contract");
    assert.equal(manifest.pages?.[0]?.requestedUrl, requestedUrl);
    assert.equal(manifest.pages?.[0]?.url, finalUrl);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe navigate rejects and remembers a non-canonical redirect so capture-current cannot relabel it", async () => {
  const id = `probe-pending-reject-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-pending-reject-"));
  const root = projectDir(dataDir, id);
  seedProbeManifest(root, "https://x.test/entry");
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ finalUrl: "https://x.test/dashboard" }));
  const endpoint = await probeNavigationServer(id, dataDir);
  try {
    const navigate = await fetch(`${endpoint.base}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/products" }),
    });
    assert.equal(navigate.status, 409);
    assert.match(await navigate.text(), /non-canonical redirect.*retry.*final URL/i);

    const capture = await fetch(`${endpoint.base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(capture.status, 409, "capture-current cannot erase the rejected A to B navigation identity");
    assert.match(await capture.text(), /non-canonical redirect/i);
    const manifest = JSON.parse(readFileSync(join(root, ".sharingan", "pages.json"), "utf8")) as { pages?: unknown[] };
    assert.deepEqual(manifest.pages, []);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe navigate carries an allowed canonical requested identity into capture-current", async () => {
  const id = `probe-pending-canonical-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-pending-canonical-"));
  const root = projectDir(dataDir, id);
  const requestedUrl = "https://x.test/products";
  const finalUrl = "https://x.test/products/";
  seedProbeManifest(root, "https://x.test/entry");
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ finalUrl }));
  const endpoint = await probeNavigationServer(id, dataDir);
  try {
    const navigate = await fetch(`${endpoint.base}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: requestedUrl }),
    });
    assert.equal(navigate.status, 200);

    const capture = await fetch(`${endpoint.base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(capture.status, 200);
    const page = (await capture.json()) as { requestedUrl?: string; url?: string };
    assert.equal(page.requestedUrl, requestedUrl);
    assert.equal(page.url, finalUrl);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("a failed probe navigate clears the prior requested identity before capture-current", async () => {
  const id = `probe-pending-navigate-failure-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-pending-navigate-failure-"));
  const root = projectDir(dataDir, id);
  const requestedUrl = "https://x.test/products";
  const finalUrl = "https://x.test/products/";
  seedProbeManifest(root, "https://x.test/entry");
  let navigationCount = 0;
  const session = {
    ...fakeProbeCaptureSession({ finalUrl }),
    navigate: async () => {
      navigationCount += 1;
      if (navigationCount === 1) return { status: 200, finalUrl };
      throw new Error("probe navigation failed");
    },
  } as unknown as SharinganSession;
  await ensureProbeSession(id, dataDir, async () => session);
  const endpoint = await probeNavigationServer(id, dataDir);
  try {
    const firstNavigate = await fetch(`${endpoint.base}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: requestedUrl }),
    });
    assert.equal(firstNavigate.status, 200);

    const failedNavigate = await fetch(`${endpoint.base}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/other" }),
    });
    assert.equal(failedNavigate.status, 409);
    assert.match(await failedNavigate.text(), /probe navigation failed/i);

    const capture = await fetch(`${endpoint.base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(capture.status, 200);
    const page = (await capture.json()) as { requestedUrl?: string; url?: string };
    assert.equal(page.requestedUrl, finalUrl, "capture-current self-labels after the newer navigation attempt failed");
    assert.equal(page.url, finalUrl);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("a failed explicit capture navigation clears the prior requested identity", async () => {
  const id = `probe-pending-capture-failure-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-pending-capture-failure-"));
  const root = projectDir(dataDir, id);
  const requestedUrl = "https://x.test/products";
  const finalUrl = "https://x.test/products/";
  seedProbeManifest(root, "https://x.test/entry");
  let navigationCount = 0;
  const session = {
    ...fakeProbeCaptureSession({ finalUrl }),
    navigate: async () => {
      navigationCount += 1;
      if (navigationCount === 1) return { status: 200, finalUrl };
      throw new Error("capture navigation failed");
    },
  } as unknown as SharinganSession;
  await ensureProbeSession(id, dataDir, async () => session);
  const endpoint = await probeNavigationServer(id, dataDir);
  try {
    const firstNavigate = await fetch(`${endpoint.base}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: requestedUrl }),
    });
    assert.equal(firstNavigate.status, 200);

    const failedCapture = await fetch(`${endpoint.base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/other" }),
    });
    assert.equal(failedCapture.status, 409);
    assert.match(await failedCapture.text(), /capture navigation failed/i);

    const captureCurrent = await fetch(`${endpoint.base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(captureCurrent.status, 200);
    const page = (await captureCurrent.json()) as { requestedUrl?: string; url?: string };
    assert.equal(page.requestedUrl, finalUrl, "capture-current does not inherit the superseded navigation identity");
    assert.equal(page.url, finalUrl);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("probe capture preserves Sharingan derivatives when recapture fails", async () => {
  const id = `probe-recapture-failed-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-probe-recapture-failed-"));
  const root = projectDir(dataDir, id);
  const staleFiles = seedProbeDerivedArtifacts(root);
  const sourceUrl = "https://x.test/entry";
  seedProbeManifest(root, sourceUrl);
  await ensureProbeSession(id, dataDir, async () => fakeProbeCaptureSession({ screenshotError: new Error("capture failed"), url: sourceUrl }));
  const endpoint = await probeCaptureServer(id, dataDir);
  try {
    const response = await fetch(endpoint.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    for (const rel of staleFiles) assert.equal(existsSync(join(root, rel)), true, `${rel} remains after a failed capture`);
  } finally {
    await endpoint.close();
    await releaseSharinganProject(id);
  }
});

test("GET /status peeks at an idle project without allocating capture ownership", async () => {
  const before = sharinganCaptureRegistrySizeForTests();
  const status = await statusServer(`status-peek-${Date.now()}`);
  try {
    const response = await fetch(`${status.base}/status`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { phase: string }).phase, "idle");
    assert.equal(
      sharinganCaptureRegistrySizeForTests(),
      before,
      "a read-only status request must not create an owned capture scope",
    );
  } finally {
    await status.close();
  }
});

test("a failed capture closes the browser session and clears it, so a launched browser cannot leak", async () => {
  // The contract under test is the handler's ERROR-path cleanup, not the browser
  // itself: `open()` launches a real (in production, headful) Chrome that holds a lock
  // on the persistent profile, so if capture throws afterward the handler MUST close
  // that session. We inject a fake session whose capture throws mid-flight and assert
  // close() ran — deterministic, no real Chrome, no profile-lock games.
  let closed = false;
  const fakeSession = {
    navigate: async () => { throw new Error("boom: navigation blew up mid-capture"); },
    close: async () => { closed = true; },
  } as unknown as SharinganSession;

  const id = "leak-check";
  const status = await statusServer(id);
  try {
    await startCapture(id, "http://irrelevant.test/", "/tmp/unused-datadir", "/tmp/unused-profile", async () => fakeSession);
    const s = (await (await fetch(`${status.base}/status`)).json()) as { phase: string; error?: string };
    assert.equal(s.phase, "error", "a thrown capture lands the run in the error phase");
    assert.equal(closed, true, "the handler must close the session on the error path so the browser cannot leak");
  } finally {
    await status.close();
  }
});

test("project release closes an established session exactly once when capture concurrently fails", async () => {
  let navigationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { navigationEntered = resolve; });
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<never>((_resolve, reject) => { rejectNavigation = reject; });
  let closes = 0;
  const session = {
    navigate: async () => {
      navigationEntered();
      return navigation;
    },
    close: async () => {
      closes += 1;
      if (closes > 1) throw new Error("session close is not idempotent");
    },
  } as unknown as SharinganSession;
  const id = `capture-release-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-release-"));

  const capture = startCapture(id, "http://x.test/", dataDir, "/tmp/unused", async () => session);
  await entered;
  const release = releaseSharinganProject(id);
  rejectNavigation(new Error("capture failed during project deletion"));
  await Promise.all([capture, release]);

  assert.equal(closes, 1, "capture failure and project deletion share one close owner");
});

test("project release still awaits established capture work after the opener has settled", async () => {
  let navigationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { navigationEntered = resolve; });
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<never>((_resolve, reject) => { rejectNavigation = reject; });
  const session = {
    navigate: async () => {
      navigationEntered();
      return navigation;
    },
    close: async () => {},
  } as unknown as SharinganSession;
  const id = `capture-established-release-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-established-release-"));

  const capture = startCapture(id, "http://x.test/", dataDir, "/tmp/unused", async () => session);
  await entered;
  let releaseSettled = false;
  const release = releaseSharinganProject(id).then(() => { releaseSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, SHARINGAN_RELEASE_GRACE_MS + 25));

  assert.equal(releaseSettled, false, "the opener-only grace must not detach established work that can still write files");
  rejectNavigation(new Error("capture stopped during project deletion"));
  await Promise.all([capture, release]);
});

test("a re-start while paused for login does not orphan the open login session", async () => {
  // After a login wall the phase is "login-required" and the session stays OPEN by design
  // (for user sign-in). A second POST /start must NOT open a second browser and overwrite
  // c.session — that would strand the paused headful Chrome and its persistent-profile lock.
  let opens = 0;
  const open = async () => {
    opens += 1;
    return {
      navigate: async () => ({ status: 401, finalUrl: "http://x.test/login" }),
      readDom: async () => [],
      hasPasswordField: async () => false,
      close: async () => {},
    } as unknown as SharinganSession;
  };

  const id = "relogin";
  const status = await statusServer(id);
  try {
    await startCapture(id, "http://x.test/", "/tmp/unused-datadir", "/tmp/unused-profile", open);
    const s1 = (await (await fetch(`${status.base}/status`)).json()) as { phase: string };
    assert.equal(s1.phase, "login-required", "capture #1 pauses at the login wall");

    // Re-start while paused — must be refused, not launch a second browser.
    await startCapture(id, "http://x.test/", "/tmp/unused-datadir", "/tmp/unused-profile", open);
    assert.equal(opens, 1, "re-start during login-required must not launch a second browser (would orphan the paused one)");
  } finally {
    await status.close();
  }
});

test("Sharingan retains and replays only the newest 500 steps, and release clears the scope", async () => {
  const id = `bounded-steps-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-steps-"));
  let closes = 0;
  const session = {
    readDom: async () => [],
    close: async () => { closes += 1; },
  } as unknown as SharinganSession;
  const response = () => {
    const writes: string[] = [];
    const res = {
      writeHead: () => res,
      write: (chunk: string) => { writes.push(String(chunk)); return true; },
      end: () => res,
      on: () => res,
    } as unknown as ServerResponse;
    return { res, writes };
  };

  try {
    await ensureProbeSession(id, dataDir, async () => session);
    for (let index = 0; index < 505; index += 1) {
      await handleSharinganReadDom(response().res, id, dataDir);
    }

    assert.equal(peekSharinganStatus(id, dataDir).steps, 500, "the in-memory work log has a fixed upper bound");
    const replay = response();
    handleSharinganEvents(replay.res, id);
    assert.equal(replay.writes.length, 500, "new SSE listeners receive only the retained tail");
    assert.match(replay.writes[0] ?? "", /Agent reading DOM/);
  } finally {
    await releaseSharinganProject(id);
  }

  assert.equal(closes, 1, "release closes the established probe session exactly once");
  assert.deepEqual(peekSharinganStatus(id, dataDir), { phase: "idle", steps: 0, pages: [] });
});

test("POST /cancel releases capture resources and exposes a resource-free cancelled status", async () => {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cancel-"));
  const project = store.createProject({ name: "cancel clone", mode: "standard", sharingan: true, sourceUrl: "http://x.test/" });
  let navigationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { navigationEntered = resolve; });
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<never>((_resolve, reject) => { rejectNavigation = reject; });
  let closes = 0;
  const session = {
    navigate: async () => { navigationEntered(); return navigation; },
    close: async () => {
      closes += 1;
      rejectNavigation(Object.assign(new Error("capture cancelled"), { name: "AbortError" }));
    },
  } as unknown as SharinganSession;
  let opens = 0;
  const app = createApp({
    store,
    dataDir,
    sharinganOpen: async () => {
      opens += 1;
      return session;
    },
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  try {
    const started = await fetch(`${base}/api/sharingan/${project.id}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://x.test/" }),
    });
    assert.equal(started.status, 200);
    await entered;

    const cancelled = await fetch(`${base}/api/sharingan/${project.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    const status = await (await fetch(`${base}/api/sharingan/${project.id}/status`)).json() as { phase: string; steps: number; pages: unknown[] };
    assert.deepEqual(status, { phase: "cancelled", steps: 0, pages: [] });
    assert.equal(closes, 1);

    const probe = await fetch(`${base}/api/sharingan/${project.id}/read-dom`);
    assert.equal(probe.status, 409, "cancelled captures cannot be revived by a probe endpoint");
    const afterProbe = await (await fetch(`${base}/api/sharingan/${project.id}/status`)).json() as { phase: string; steps: number; pages: unknown[] };
    assert.deepEqual(afterProbe, { phase: "cancelled", steps: 0, pages: [] });
    assert.equal(opens, 1, "only an explicit Retry may open another browser session");
  } finally {
    await releaseSharinganProject(project.id);
    await new Promise<void>((resolve) => app.close(() => resolve()));
    store.close();
  }
});

test("cancel releases a capture generation that starts while profile cleanup is pending", async () => {
  const id = `cancel-start-race-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cancel-start-"));
  let rejectNavigation!: (error: Error) => void;
  const navigation = new Promise<never>((_resolve, reject) => { rejectNavigation = reject; });
  let closes = 0;
  const session = {
    navigate: async () => navigation,
    close: async () => {
      closes += 1;
      rejectNavigation(Object.assign(new Error("concurrent capture cancelled"), { name: "AbortError" }));
    },
  } as unknown as SharinganSession;

  const cancelling = cancelSharinganProject(id, dataDir);
  const capturing = startCapture(id, "http://x.test/", dataDir, join(dataDir, "manual-profile"), async () => session);
  try {
    await cancelling;
    assert.equal(closes, 1, "the generation admitted during cancellation is still closed");
    assert.deepEqual(peekSharinganStatus(id, dataDir), { phase: "cancelled", steps: 0, pages: [] });
  } finally {
    rejectNavigation(Object.assign(new Error("test cleanup"), { name: "AbortError" }));
    await releaseSharinganProject(id);
    await capturing;
  }
});
