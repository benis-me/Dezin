import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { findChrome } from "../src/capture-cover.ts";
import {
  SHARINGAN_RELEASE_GRACE_MS,
  startCapture,
  handleSharinganStatus,
  releaseSharinganProject,
  sharinganCaptureRegistrySizeForTests,
} from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

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
