import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { applyArtifactThumbnailFrame } from "../src/capture-cover.ts";
import { injectRuntimeProbe } from "../src/serve-static.ts";
import { auditVisualArtifactReport } from "../src/visual-qa.ts";

const NONCE = "f".repeat(43);

test("the preview bridge receives the exact Frame state, fixture, background, and attempt", async () => {
  let request: Record<string, unknown> | null = null;
  const page = {
    async evaluate(_operation: unknown, value: Record<string, unknown>) {
      request = value;
      return { ok: true as const };
    },
  };
  await applyArtifactThumbnailFrame(
    page as never,
    `http://127.0.0.1:4173/#dezin-bridge=${NONCE}`,
    {
      frameId: "checkout-mobile",
      frameAttemptId: "quality-round-2-checkout-mobile",
      initialState: "payment",
      fixture: { cartCount: 2 },
      background: "#ffffff",
    } as never,
    new AbortController().signal,
  );

  const captured = request as unknown as Record<string, unknown>;
  assert.equal(captured.nonce, NONCE);
  assert.equal(captured.frameId, "checkout-mobile");
  assert.equal(captured.frameAttemptId, "quality-round-2-checkout-mobile");
  assert.equal(captured.initialState, "payment");
  assert.deepEqual(captured.fixture, { cartCount: 2 });
  assert.equal(captured.background, "#ffffff");
});

test("visual QA renders every immutable Task Frame through the Viewer bridge at exact dimensions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-frames-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const frames = [
    {
      id: "checkout-desktop",
      name: "Checkout desktop",
      width: 1280,
      height: 800,
      initialState: "payment",
      fixture: { label: "desktop" },
      background: "#ffffff",
    },
    {
      id: "checkout-mobile",
      name: "Checkout mobile",
      width: 390,
      height: 844,
      initialState: "summary",
      fixture: { label: "mobile" },
      background: "#ffffff",
    },
  ];
  const html = [
    "<!doctype html><html><head><meta charset='utf-8'><style>",
    "html,body{margin:0;background:#fff;color:#111;font:16px/1.5 system-ui}",
    "#surface{width:5000px;height:100px}",
    "</style></head><body><main id='surface'>Waiting for exact Dezin Frame bridge input.</main>",
    "<script>",
    "window.addEventListener('dezin:frame-change',(event)=>{",
    "const frame=event.detail||{},surface=document.getElementById('surface');",
    "const expected=frame.frameId==='checkout-desktop'",
    "? frame.initialState==='payment'&&frame.fixture&&frame.fixture.label==='desktop'&&innerWidth===1280&&innerHeight===800",
    ": frame.frameId==='checkout-mobile'&&frame.initialState==='summary'&&frame.fixture&&frame.fixture.label==='mobile'&&innerWidth===390&&innerHeight===844;",
    "if(expected){surface.style.width='auto';surface.style.height='100vh';surface.textContent='Exact '+frame.frameId+' Frame applied with immutable state and fixture.';}",
    "});",
    "</script></body></html>",
  ].join("");
  writeFileSync(htmlPath, injectRuntimeProbe(html), "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: true, agentCommand: "/usr/bin/true" } as never,
    agentCommand: "/usr/bin/true",
    renderFrames: frames,
    signal: new AbortController().signal,
  } as never);

  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  assert.ok(!report.findings.some((finding) => finding.id === "visual-horizontal-overflow"),
    "the pre-Frame overflow sentinel must be removed in every exact Frame");
  assert.ok(!report.findings.some((finding) => finding.id === "visual-render-failed"), JSON.stringify(report));
  assert.deepEqual(
    report.frames.map(({ frameId, frameAttemptId, width, height, status }) => ({ frameId, frameAttemptId, width, height, status })),
    [
      {
        frameId: "checkout-desktop",
        frameAttemptId: "visual-qa-0-checkout-desktop",
        width: 1280,
        height: 800,
        status: "passed",
      },
      {
        frameId: "checkout-mobile",
        frameAttemptId: "visual-qa-1-checkout-mobile",
        width: 390,
        height: 844,
        status: "passed",
      },
    ],
  );
  assert.ok(report.frames.every((frame) => frame.screenshotPath && existsSync(frame.screenshotPath)));
  assert.equal(existsSync(screenshotPath), true);
});

test("runtime Frame audit fails the exact Frame whose rendered application throws", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-runtime-frame-failure-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const frames = [
    { id: "healthy", name: "Healthy", width: 800, height: 600, initialState: "ready" },
    { id: "broken", name: "Broken", width: 390, height: 844, initialState: "broken" },
  ];
  writeFileSync(htmlPath, injectRuntimeProbe([
    "<!doctype html><html><head><meta charset='utf-8'></head><body>",
    "<main>Exact runtime Frame health verification surface.</main>",
    "<script>window.addEventListener('dezin:frame-change',(event)=>{",
    "if(event.detail&&event.detail.frameId==='broken')setTimeout(()=>{throw new Error('broken runtime frame')},0);",
    "});</script></body></html>",
  ].join("")), "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: false, agentCommand: "/usr/bin/true" } as never,
    renderFrames: frames,
    signal: new AbortController().signal,
    runtimeOnly: true,
  });
  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  assert.deepEqual(report.frames.map((frame) => [frame.frameId, frame.status]), [
    ["healthy", "passed"],
    ["broken", "failed"],
  ], JSON.stringify(report));
  assert.ok(report.findings.some((finding) => finding.id === "visual-runtime-error@broken"));

  const reviewPrompts: string[] = [];
  const reviewedReport = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    renderFrames: frames,
    signal: new AbortController().signal,
  }, async (request) => {
    reviewPrompts.push(request.message);
    return { providerId: "claude", text: '{"findings":[]}' };
  });
  assert.deepEqual(reviewedReport.frames.map((frame) => [frame.frameId, frame.status, frame.reviewed]), [
    ["healthy", "passed", true],
    ["broken", "failed", true],
  ], JSON.stringify(reviewedReport));
  assert.ok(reviewedReport.findings.some((finding) => finding.id === "visual-reviewed"),
    "a captured failed runtime Frame must still receive visual assessment");
  assert.equal(reviewPrompts.length, 2);
  assert.match(reviewPrompts[0]!, /"id": "healthy"[\s\S]*"width": 800[\s\S]*"height": 600[\s\S]*"initialState": "ready"/,
    "the reviewer prompt must name the exact healthy Frame contract");
  assert.match(reviewPrompts[1]!, /"id": "broken"[\s\S]*"width": 390[\s\S]*"height": 844[\s\S]*"initialState": "broken"/,
    "the reviewer prompt must name the exact broken Frame contract");
  assert.doesNotMatch(reviewPrompts[0]!, /broken runtime frame/,
    "the healthy Frame reviewer must not receive another Frame's runtime signals");
  assert.match(reviewPrompts[1]!, /broken runtime frame/,
    "the broken Frame reviewer must receive its own runtime signal");
});
