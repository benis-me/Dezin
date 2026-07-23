import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { zlibSync } from "fflate";

import { applyArtifactThumbnailFrame } from "../src/capture-cover.ts";
import { standardRunPassed } from "../src/run-policy.ts";
import { injectRuntimeProbe } from "../src/serve-static.ts";
import { auditVisualArtifactReport, reviewScreenshotWithAgent } from "../src/visual-qa.ts";

const NONCE = "f".repeat(43);

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function solidRgbaPng(width: number, height: number, rgba: readonly [number, number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      raw.set(rgba, rowStart + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from(zlibSync(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("visual reviewer rejects a generated screenshot replaced after capture identity was fixed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-visual-review-identity-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, "capture.png");
  const reviewedBytes = solidRgbaPng(320, 320, [20, 30, 40, 255]);
  const replacementBytes = solidRgbaPng(320, 320, [200, 210, 220, 255]);
  writeFileSync(htmlPath, "<main>Visual evidence identity test surface.</main>");
  writeFileSync(screenshotPath, replacementBytes);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let reviewerInvoked = false;

  const findings = await reviewScreenshotWithAgent({
    htmlPath,
    projectRoot: root,
    screenshotEvidenceRoot: root,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    reviewScreenshotIdentity: {
      sha256: createHash("sha256").update(reviewedBytes).digest("hex"),
      byteLength: reviewedBytes.byteLength,
      width: 320,
      height: 320,
    },
  } as never, screenshotPath, async () => {
    reviewerInvoked = true;
    return { providerId: "claude", text: '{"findings":[]}' };
  });

  assert.equal(reviewerInvoked, false,
    "review transport must never receive bytes that differ from the fixed capture identity");
  assert.ok(findings.some((finding) => finding.id === "visual-agent-review-failed"));
});

test("visual reviewer rejects a Sharingan source screenshot replaced after audit identity was fixed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-source-review-identity-"));
  const htmlPath = join(root, "index.html");
  const generatedPath = join(root, "generated.png");
  const sourcePath = join(root, "source.png");
  const generatedBytes = solidRgbaPng(320, 320, [20, 30, 40, 255]);
  const reviewedSourceBytes = solidRgbaPng(320, 320, [60, 70, 80, 255]);
  writeFileSync(htmlPath, "<main>Sharingan source identity test surface.</main>");
  writeFileSync(generatedPath, generatedBytes);
  writeFileSync(sourcePath, solidRgbaPng(320, 320, [200, 210, 220, 255]));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let reviewerInvoked = false;

  const findings = await reviewScreenshotWithAgent({
    htmlPath,
    projectRoot: root,
    screenshotEvidenceRoot: root,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    isSharingan: true,
    sharinganReference: { screenshotPath: sourcePath },
    sharinganReviewMode: "source-parity",
    reviewScreenshotIdentity: {
      sha256: createHash("sha256").update(generatedBytes).digest("hex"),
      byteLength: generatedBytes.byteLength,
      width: 320,
      height: 320,
    },
    sharinganReferenceIdentity: {
      sha256: createHash("sha256").update(reviewedSourceBytes).digest("hex"),
      byteLength: reviewedSourceBytes.byteLength,
      width: 320,
      height: 320,
    },
  } as never, generatedPath, async () => {
    reviewerInvoked = true;
    return { providerId: "claude", text: '{"findings":[]}' };
  });

  assert.equal(reviewerInvoked, false,
    "review transport must never receive source bytes that differ from the audit-fixed identity");
  assert.ok(findings.some((finding) => finding.id === "visual-agent-review-failed"));
});

test("Sharingan audit rejects a source screenshot changed after the reviewer received its fixed bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-source-audit-stability-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const sourcePath = join(root, ".sharingan", "source.png");
  const renderMapPath = join(root, ".sharingan", "render-map.json");
  const sourceBytes = solidRgbaPng(320, 320, [30, 40, 50, 255]);
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  writeFileSync(renderMapPath, JSON.stringify({
    viewport: { width: 320, height: 320 },
    document: { width: 320, height: 320 },
    elements: [{
      selector: "main",
      tag: "main",
      text: "Stable source reconstruction surface",
      box: { x: 0, y: 0, w: 320, h: 320 },
      style: {},
    }],
  }));
  writeFileSync(htmlPath, [
    "<!doctype html><html><head><meta charset='utf-8'><style>",
    "html,body{margin:0;width:100%;min-height:100%;background:#1e2832;color:white}",
    "main{width:320px;min-height:320px;display:grid;place-items:center}",
    "</style></head><body><main>Stable source reconstruction surface</main></body></html>",
  ].join(""));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let reviewedSourceBase64 = "";

  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: pathToFileURL(htmlPath).href,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    isSharingan: true,
    sharinganReference: { screenshotPath: sourcePath, renderMapPath },
    signal: new AbortController().signal,
  }, async (request) => {
    reviewedSourceBase64 = request.images?.find((image) => image.label === "Sharingan source")?.data ?? "";
    writeFileSync(sourcePath, solidRgbaPng(320, 320, [200, 210, 220, 255]));
    return { providerId: "claude", text: '{"findings":[]}' };
  });

  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }
  assert.equal(reviewedSourceBase64, sourceBytes.toString("base64"),
    "the reviewer must receive the bytes fixed at audit start");
  assert.deepEqual(report.findings.map(({ id, severity }) => ({ id, severity })), [{
    id: "visual-source-evidence-changed",
    severity: "P0",
  }]);
  assert.equal(report.sourceCapture?.reviewed, false);
});

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
    "const consumption=frame.consumption;if(expected&&consumption)window.dispatchEvent(new CustomEvent('dezin:frame-consumed',{detail:{source:'dezin-artifact',nonce:consumption.nonce,frameAttemptId:consumption.frameAttemptId,digest:consumption.digest}}));",
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
  for (const frame of report.frames) {
    assert.ok(frame.captureIdentity, `Frame ${frame.frameId} must retain its capture-time identity`);
    assert.ok(frame.captureIdentity.width >= frame.width);
    assert.ok(frame.captureIdentity.height >= frame.height);
    const bytes = readFileSync(frame.screenshotPath!);
    assert.equal(frame.captureIdentity.byteLength, bytes.byteLength);
    assert.equal(frame.captureIdentity.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(existsSync(screenshotPath), true);
});

test("Sharingan reviews a dedicated source capture for parity and every Task Frame for state integrity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-responsive-review-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const sourceScreenshotPath = join(root, ".sharingan", "shot-desktop.png");
  const sourceRenderMapPath = join(root, ".sharingan", "render-map.json");
  const frames = [
    { id: "checkout-menu", name: "Checkout menu open", width: 1440, height: 900, initialState: "menu-open" },
    { id: "checkout-desktop", name: "Checkout desktop", width: 1440, height: 900 },
    { id: "checkout-mobile", name: "Checkout mobile", width: 390, height: 844 },
  ];
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(sourceScreenshotPath, solidRgbaPng(1440, 900, [15, 23, 42, 255]));
  writeFileSync(sourceRenderMapPath, JSON.stringify({
    viewport: { width: 1440, height: 900 },
    document: { width: 1440, height: 900 },
    elements: [{
      selector: "main",
      tag: "main",
      text: "Exact checkout reconstruction",
      box: { x: 0, y: 0, w: 1440, h: 900 },
      style: {},
    }],
  }));
  writeFileSync(htmlPath, injectRuntimeProbe([
    "<!doctype html><html><head><meta charset='utf-8'><style>",
    "html,body{margin:0;background:#fff;color:#111;font:16px/1.5 system-ui}",
    "main{min-height:100vh;display:grid;place-items:center;overflow:visible}",
    "#checkout{padding:32px;border:1px solid #ddd}",
    "@media(max-width:600px){#checkout{width:520px;box-sizing:border-box;white-space:nowrap}}",
    "</style></head><body><main><section id='checkout'>Exact checkout reconstruction <output id='frame-state'>source</output></section></main>",
    "<script>window.addEventListener('dezin:frame-change',(event)=>{const frame=event.detail||{},consumption=frame.consumption;document.querySelector('#frame-state').textContent=frame.frameId??'source';if(consumption)window.dispatchEvent(new CustomEvent('dezin:frame-consumed',{detail:{source:'dezin-artifact',nonce:consumption.nonce,frameAttemptId:consumption.frameAttemptId,digest:consumption.digest}}))});</script>",
    "</body></html>",
  ].join("")), "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const reviewRequests: Array<{ frameId: string; message: string; imageLabels: string[] }> = [];
  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    isSharingan: true,
    sharinganReference: {
      screenshotPath: sourceScreenshotPath,
      renderMapPath: sourceRenderMapPath,
      assetsSummary: "Source image inventory: checkout-hero.webp and trust-mark.svg are required media.",
    },
    renderFrames: frames,
    signal: new AbortController().signal,
  }, async (request) => {
    const frameId = frames.find((frame) => request.message.includes(`\"id\": \"${frame.id}\"`))?.id ?? "source-capture";
    reviewRequests.push({
      frameId,
      message: request.message,
      imageLabels: (request.images ?? []).map((image) => image.label),
    });
    return {
      providerId: "claude",
      text: frameId === "checkout-mobile"
        ? JSON.stringify({
            findings: [
              {
                kind: "defect",
                message: "The fixed-width checkout horizontally overflows the mobile viewport.",
                fix: "Constrain the checkout to the viewport width.",
              },
              {
                kind: "defect",
                message: "The right side of the checkout content is visibly cropped.",
                fix: "Allow the content to wrap without cropping.",
              },
            ],
          })
        : '{"findings":[]}',
    };
  });

  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }

  assert.equal(reviewRequests.length, 4,
    "the source capture must remain independent even when a stateful Task Frame has the same dimensions");
  const source = reviewRequests.find((request) => request.frameId === "source-capture")!;
  const menu = reviewRequests.find((request) => request.frameId === "checkout-menu")!;
  const desktop = reviewRequests.find((request) => request.frameId === "checkout-desktop")!;
  const mobile = reviewRequests.find((request) => request.frameId === "checkout-mobile")!;
  assert.deepEqual(source.imageLabels, ["generated artifact", "Sharingan source"]);
  assert.match(source.message, /every visible source mismatch/i);
  assert.doesNotMatch(source.message, /responsive-extrapolation/i);
  assert.deepEqual(menu.imageLabels, ["generated artifact"],
    "a same-size alternate state must not be compared with the default source screenshot");
  assert.match(menu.message, /responsive-extrapolation/i);
  assert.match(menu.message, /viewport and\/or state differs/i);
  assert.deepEqual(desktop.imageLabels, ["generated artifact"],
    "frameId alone can alter the rendered state, so even a same-size default-looking Frame is not source evidence");
  assert.match(desktop.message, /responsive-extrapolation/i);
  assert.deepEqual(mobile.imageLabels, ["generated artifact"],
    "a mobile Frame must not receive a mismatched desktop source image");
  assert.match(mobile.message, /responsive-extrapolation/i);
  assert.match(mobile.message, /horizontal overflow/i);
  assert.match(mobile.message, /cropp|clip/i);
  assert.match(mobile.message, /checkout-hero\.webp/,
    "responsive review must retain the source media inventory as semantic evidence");
  assert.doesNotMatch(mobile.message, /original source screenshot is supplied inline as Image 2/i);
  assert.doesNotMatch(mobile.message, /Source screenshot \(original reconstruction reference\)/i);
  assert.doesNotMatch(mobile.message, /Source render map \(browser-measured bounding boxes/i);

  assert.ok(report.findings.some((finding) => finding.id === "visual-source-screenshot-diff"),
    "the source-sized deterministic screenshot comparison must remain active");
  assert.deepEqual({ ...report.sourceCapture, captureIdentity: undefined }, {
    scope: "source",
    sourceAttemptId: "visual-qa-source",
    width: 1440,
    height: 900,
    status: "passed",
    screenshotPath,
    captureIdentity: undefined,
    reviewed: true,
  }, "the exact generated source-parity capture must remain explicit and independently retainable");
  assert.ok(report.sourceCapture?.captureIdentity);
  const sourceCaptureBytes = readFileSync(screenshotPath);
  assert.equal(report.sourceCapture.captureIdentity.sha256,
    createHash("sha256").update(sourceCaptureBytes).digest("hex"));
  assert.equal(report.sourceCapture.captureIdentity.byteLength, sourceCaptureBytes.byteLength);
  assert.ok(report.sourceCapture.captureIdentity.width >= report.sourceCapture.width);
  assert.ok(report.sourceCapture.captureIdentity.height >= report.sourceCapture.height);
  assert.ok(report.findings.some((finding) => finding.id.startsWith("visual-horizontal-overflow")),
    "responsive extrapolation must retain deterministic overflow detection");
  const mobileDefects = report.findings.filter((finding) =>
    finding.id.startsWith("visual-ai-review") && finding.id.endsWith("@checkout-mobile"));
  assert.equal(mobileDefects.length, 2);
  assert.ok(mobileDefects.every((finding) => finding.severity === "P1"));
  assert.equal(standardRunPassed(mobileDefects, true), false,
    "responsive overflow and cropping remain blocking Sharingan findings");
  assert.deepEqual(report.frames.map((frame) => frame.frameId), frames.map((frame) => frame.id),
    "source alignment must not reorder the immutable Task Frames");
});

test("Sharingan runs one strict source review when no immutable Frame matches the capture viewport", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-standalone-source-review-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const sourceScreenshotPath = join(root, ".sharingan", "shot-source.png");
  const sourceRenderMapPath = join(root, ".sharingan", "render-map.json");
  const frames = [
    { id: "production-desktop", name: "Production desktop", width: 1440, height: 900 },
    { id: "production-mobile", name: "Production mobile", width: 390, height: 844 },
  ];
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(sourceScreenshotPath, solidRgbaPng(1366, 768, [250, 250, 250, 255]));
  writeFileSync(sourceRenderMapPath, JSON.stringify({
    viewport: { width: 1366, height: 768 },
    document: { width: 1366, height: 768 },
    elements: [{
      selector: "main",
      tag: "main",
      text: "Source-aligned checkout",
      box: { x: 0, y: 0, w: 1366, h: 768 },
      style: {},
    }],
  }));
  writeFileSync(htmlPath, injectRuntimeProbe([
    "<!doctype html><html><head><meta charset='utf-8'><style>",
    "html,body{margin:0;background:#fafafa;color:#111;font:16px/1.5 system-ui}",
    "main{min-height:100vh;display:grid;place-items:center}",
    "</style></head><body><main>Source-aligned checkout</main></body></html>",
  ].join("")), "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const reviewRequests: Array<{ frameId: string; message: string; imageLabels: string[] }> = [];
  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    isSharingan: true,
    sharinganReference: {
      screenshotPath: sourceScreenshotPath,
      renderMapPath: sourceRenderMapPath,
      assetsSummary: "Source image inventory: checkout-mark.svg.",
    },
    renderFrames: frames,
    signal: new AbortController().signal,
  }, async (request) => {
    const frameId = frames.find((frame) => request.message.includes(`\"id\": \"${frame.id}\"`))?.id ?? "source-capture";
    reviewRequests.push({
      frameId,
      message: request.message,
      imageLabels: (request.images ?? []).map((image) => image.label),
    });
    return { providerId: "claude", text: '{"findings":[]}' };
  });

  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }

  assert.equal(reviewRequests.length, 3);
  const source = reviewRequests.find((request) => request.frameId === "source-capture")!;
  assert.deepEqual(source.imageLabels, ["generated artifact", "Sharingan source"]);
  assert.match(source.message, /every visible source mismatch/i);
  assert.doesNotMatch(source.message, /responsive-extrapolation/i);
  for (const frame of frames) {
    const request = reviewRequests.find((candidate) => candidate.frameId === frame.id)!;
    assert.deepEqual(request.imageLabels, ["generated artifact"]);
    assert.match(request.message, /responsive-extrapolation/i);
  }
  assert.deepEqual(report.frames.map((frame) => frame.frameId), frames.map((frame) => frame.id));
  assert.ok(report.findings.some((finding) => finding.id === "visual-reviewed"),
    "the aggregate review marker requires both source parity and every immutable Frame review");
});

test("Sharingan fails closed before Frame review when the source viewport is outside the capture budget", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-unsupported-source-viewport-"));
  const htmlPath = join(root, "index.html");
  const sourceScreenshotPath = join(root, ".sharingan", "shot-source.png");
  const sourceRenderMapPath = join(root, ".sharingan", "render-map.json");
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(htmlPath, "<!doctype html><main>Generated surface with enough content to render.</main>");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const width of [319, 3001]) {
    writeFileSync(sourceScreenshotPath, solidRgbaPng(width, 900, [15, 23, 42, 255]));
    writeFileSync(sourceRenderMapPath, JSON.stringify({
      viewport: { width, height: 900 },
      document: { width, height: 900 },
      elements: [{
        selector: "main",
        tag: "main",
        text: "Unsupported-width source",
        box: { x: 0, y: 0, w: width, h: 900 },
        style: {},
      }],
    }));
    let reviewCalls = 0;
    const report = await auditVisualArtifactReport({
      htmlPath,
      projectRoot: root,
      settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
      agentCommand: "claude",
      isSharingan: true,
      sharinganReference: {
        screenshotPath: sourceScreenshotPath,
        renderMapPath: sourceRenderMapPath,
      },
      renderFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
      signal: new AbortController().signal,
    }, async () => {
      reviewCalls += 1;
      return { providerId: "claude", text: '{"findings":[]}' };
    });

    assert.equal(reviewCalls, 0,
      `unsupported source width ${width} must never fall back to reviewing a Task Frame as source evidence`);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.id, "visual-source-evidence-invalid");
    assert.equal(report.findings[0]?.severity, "P0");
    assert.deepEqual(report.frames.map((frame) => [frame.frameId, frame.status, frame.reviewed]), [
      ["desktop", "failed", false],
    ]);
  }
});

test("Sharingan fails closed when the selected source PNG does not match its render-map dimensions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-source-dimension-mismatch-"));
  const htmlPath = join(root, "index.html");
  const sourceScreenshotPath = join(root, ".sharingan", "shot-source.png");
  const sourceRenderMapPath = join(root, ".sharingan", "render-map.json");
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(htmlPath, "<!doctype html><main>Generated surface with enough content to render safely.</main>");
  writeFileSync(sourceRenderMapPath, JSON.stringify({
    viewport: { width: 800, height: 600 },
    document: { width: 800, height: 900 },
    elements: [{
      selector: "main",
      tag: "main",
      text: "Dimension-bound source evidence",
      box: { x: 0, y: 0, w: 800, h: 900 },
      style: {},
    }],
  }));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const sourceSize of [
    { width: 799, height: 900, label: "viewport width" },
    { width: 800, height: 899, label: "full document height" },
  ]) {
    writeFileSync(sourceScreenshotPath, solidRgbaPng(sourceSize.width, sourceSize.height, [15, 23, 42, 255]));
    let reviewCalls = 0;
    const report = await auditVisualArtifactReport({
      htmlPath,
      projectRoot: root,
      settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
      agentCommand: "claude",
      isSharingan: true,
      sharinganReference: {
        screenshotPath: sourceScreenshotPath,
        renderMapPath: sourceRenderMapPath,
      },
      renderFrames: [{ id: "desktop", name: "Desktop", width: 800, height: 600 }],
      signal: new AbortController().signal,
    }, async () => {
      reviewCalls += 1;
      return { providerId: "claude", text: '{"findings":[]}' };
    });

    assert.equal(reviewCalls, 0, `${sourceSize.label} mismatch must stop before source or Frame review`);
    assert.deepEqual(report.findings.map(({ id, severity }) => ({ id, severity })), [{
      id: "visual-source-evidence-invalid",
      severity: "P0",
    }]);
    assert.deepEqual(report.frames.map((frame) => [frame.frameId, frame.status, frame.reviewed]), [
      ["desktop", "failed", false],
    ]);
  }
});

test("Sharingan scopes runtime and geometry evidence independently to source and every Task Frame", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-scoped-geometry-"));
  const htmlPath = join(root, "index.html");
  const screenshotPath = join(root, ".visual-qa", "screenshot.png");
  const sourceScreenshotPath = join(root, ".sharingan", "shot-source.png");
  const sourceRenderMapPath = join(root, ".sharingan", "render-map.json");
  const frames = [
    { id: "source", name: "Frame whose id uses the source scope word", width: 800, height: 600 },
    { id: "broken", name: "Broken state", width: 390, height: 600 },
  ];
  mkdirSync(join(root, ".sharingan"), { recursive: true });
  writeFileSync(sourceScreenshotPath, solidRgbaPng(800, 600, [15, 23, 42, 255]));
  writeFileSync(sourceRenderMapPath, JSON.stringify({
    viewport: { width: 800, height: 600 },
    document: { width: 800, height: 600 },
    elements: [{
      selector: "#clip",
      tag: "p",
      text: "This deliberately clipped source line is valid only for the exact source capture",
      box: { x: 0, y: 0, w: 200, h: 24 },
      style: {},
    }],
  }));
  writeFileSync(htmlPath, injectRuntimeProbe([
    "<!doctype html><html><head><meta charset='utf-8'><style>",
    "html,body{margin:0;min-height:100%;font:16px/1.5 system-ui}main{width:960px;min-height:600px}",
    "#clip{width:200px;height:24px;margin:0;overflow:hidden;white-space:nowrap}",
    "</style></head><body><main><p id='clip'>This deliberately clipped source line is valid only for the exact source capture</p></main><script>",
    "let activeFrame='source-capture';for(let i=0;i<35;i+=1)console.log('viewport-noise-'+i);",
    "window.addEventListener('dezin:frame-change',(event)=>{activeFrame=event.detail?.frameId??'source-capture';",
    "if(activeFrame==='broken')setTimeout(()=>{throw new Error('broken-frame-runtime')},10);});",
    "setTimeout(()=>{if(activeFrame==='source-capture')throw new Error('source-default-runtime')},200);",
    "</script></body></html>",
  ].join("")), "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const reviewPrompts = new Map<string, string>();
  const report = await auditVisualArtifactReport({
    htmlPath,
    projectRoot: root,
    screenshotPath,
    renderUrl: `${pathToFileURL(htmlPath).href}#dezin-bridge=${NONCE}`,
    settings: { visualQaEnabled: true, agentCommand: "claude" } as never,
    agentCommand: "claude",
    isSharingan: true,
    sharinganReference: {
      screenshotPath: sourceScreenshotPath,
      renderMapPath: sourceRenderMapPath,
    },
    renderFrames: frames,
    signal: new AbortController().signal,
  }, async (request) => {
    const frameId = frames.find((frame) => request.message.includes(`\"id\": \"${frame.id}\"`))?.id ?? "source-capture";
    reviewPrompts.set(frameId, request.message);
    return { providerId: "claude", text: '{"findings":[]}' };
  });
  if (report.findings.some((finding) => finding.id === "visual-chrome-unavailable")) {
    t.skip("Chrome is unavailable in this environment");
    return;
  }

  const ids = new Set(report.findings.map((finding) => finding.id));
  assert.ok(ids.has("visual-horizontal-overflow@source"), "source geometry must retain its own actionable identity");
  assert.ok(ids.has("visual-horizontal-overflow@frame:source"),
    "a Task Frame named source must not collide with the dedicated source capture scope");
  assert.ok(ids.has("visual-horizontal-overflow@broken"), "the later Task Frame geometry must not be globally deduplicated");
  assert.ok(!ids.has("visual-text-clipped@source"),
    `a clip measured in the exact source capture remains faithful source evidence: ${JSON.stringify(report.findings)}`);
  assert.ok(ids.has("visual-text-clipped@frame:source"),
    "a same-size alternate Task Frame must not inherit source-geometry exemptions");
  assert.ok(ids.has("visual-text-clipped@broken"));
  assert.ok(ids.has("visual-runtime-error@source"), "the unframed source state runtime must deterministically block acceptance");
  assert.ok(ids.has("visual-runtime-error@broken"), "a later Frame error must survive earlier viewports filling their log budgets");
  assert.ok(!ids.has("visual-runtime-error@frame:source"));
  assert.match(report.findings.find((finding) => finding.id === "visual-runtime-error@source")?.message ?? "", /source-default-runtime/);
  assert.match(report.findings.find((finding) => finding.id === "visual-runtime-error@broken")?.message ?? "", /broken-frame-runtime/);
  assert.deepEqual(report.frames.map((frame) => frame.frameId), frames.map((frame) => frame.id));
  assert.equal(reviewPrompts.size, 3);
  assert.match(reviewPrompts.get("source-capture") ?? "", /source-default-runtime/);
  assert.doesNotMatch(reviewPrompts.get("source-capture") ?? "", /broken-frame-runtime/);
  assert.doesNotMatch(reviewPrompts.get("source") ?? "", /source-default-runtime|broken-frame-runtime/);
  assert.match(reviewPrompts.get("broken") ?? "", /broken-frame-runtime/);
  assert.doesNotMatch(reviewPrompts.get("broken") ?? "", /source-default-runtime/);
  assert.ok(ids.has("visual-reviewed"), "runtime defects remain blocking findings even after every state is independently reviewed");
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
    "const consumption=event.detail&&event.detail.consumption;if(consumption)window.dispatchEvent(new CustomEvent('dezin:frame-consumed',{detail:{source:'dezin-artifact',nonce:consumption.nonce,frameAttemptId:consumption.frameAttemptId,digest:consumption.digest}}));",
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
