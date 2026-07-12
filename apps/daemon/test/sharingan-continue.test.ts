import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startCapture, continueCapture, handleSharinganStatus, handleSharinganFocus, releaseSharinganProject } from "../src/sharingan-handler.ts";
import type { SharinganSession } from "../src/sharingan-browser.ts";

function callHandler(fn: (res: import("node:http").ServerResponse) => void): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => fn(res));
    server.listen(0, "127.0.0.1", async () => {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/`);
      const json = await r.json().catch(() => null);
      server.close(() => resolve({ status: r.status, json }));
    });
  });
}

function makeFake(over: Partial<Record<string, unknown>> = {}): { session: SharinganSession; calls: string[] } {
  const calls: string[] = [];
  let nav = 0;
  const session = {
    navigate: async () => { calls.push("navigate"); return { status: nav++ === 0 ? 401 : 200, finalUrl: "http://x.test/" }; },
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
    bringToFront: async () => { calls.push("bringToFront"); },
    close: async () => { calls.push("close"); },
    ...over,
  } as unknown as SharinganSession;
  return { session, calls };
}

test("continueCapture resumes only from a login pause; focus raises the browser", async () => {
  const id = "cont";
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cont-"));
  const { session, calls } = makeFake();

  await startCapture(id, "http://x.test/", dataDir, "/tmp/unused", async () => session);
  const s1 = await callHandler((res) => handleSharinganStatus(res, id, dataDir));
  assert.equal(s1.json.phase, "login-required", "first capture hits the 401 login wall");

  // Focus raises the browser without changing phase.
  const f = await callHandler((res) => handleSharinganFocus(res, id));
  assert.equal(f.status, 200);
  assert.ok(calls.includes("bringToFront"), "focus called bringToFront on the session");

  await continueCapture(id, dataDir);
  const s2 = await callHandler((res) => handleSharinganStatus(res, id, dataDir));
  assert.equal(s2.json.phase, "captured", "continue re-runs the capture on the authenticated session");
});

test("continueCapture preserves a cross-origin OAuth authorize login wall and resumes the original source", async () => {
  const id = `oauth-continue-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-oauth-cont-"));
  const requestedUrl = "https://app.x.test/workspace";
  let navigations = 0;
  const { session } = makeFake({
    navigate: async () => navigations++ === 0
      ? { status: 200, finalUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc" }
      : { status: 200, finalUrl: requestedUrl },
    readDom: async () => navigations === 1
      ? [
          { tag: "h1", classes: "", text: "Sign in", box: { x: 0, y: 0, w: 10, h: 10 } },
          { tag: "button", classes: "", text: "Next", box: { x: 0, y: 0, w: 10, h: 10 } },
          { tag: "p", classes: "", text: "Use your work account to continue securely. ".repeat(12), box: { x: 0, y: 0, w: 10, h: 10 } },
        ]
      : [{ tag: "h1", classes: "", text: "Workspace", box: { x: 0, y: 0, w: 10, h: 10 } }],
  });

  await startCapture(id, requestedUrl, dataDir, "/tmp/unused", async () => session);
  const paused = await callHandler((res) => handleSharinganStatus(res, id, dataDir));
  assert.equal(paused.json.phase, "login-required");

  await continueCapture(id, dataDir);
  const complete = await callHandler((res) => handleSharinganStatus(res, id, dataDir));
  assert.equal(complete.json.phase, "captured");
  await releaseSharinganProject(id);
});

test("project release closes an established session exactly once when continue concurrently fails", async () => {
  let navigations = 0;
  let continuationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { continuationEntered = resolve; });
  let rejectContinuation!: (error: Error) => void;
  const continuation = new Promise<never>((_resolve, reject) => { rejectContinuation = reject; });
  let closes = 0;
  const { session } = makeFake({
    navigate: async () => {
      navigations += 1;
      if (navigations === 1) return { status: 401, finalUrl: "http://x.test/login" };
      continuationEntered();
      return continuation;
    },
    close: async () => {
      closes += 1;
      if (closes > 1) throw new Error("session close is not idempotent");
    },
  });
  const id = `continue-release-${Date.now()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "shar-cont-release-"));

  await startCapture(id, "http://x.test/", dataDir, "/tmp/unused", async () => session);
  const continuing = continueCapture(id, dataDir);
  await entered;
  const release = releaseSharinganProject(id);
  rejectContinuation(new Error("continue failed during project deletion"));
  await Promise.all([continuing, release]);

  assert.equal(closes, 1, "continue failure and project deletion share one close owner");
});
