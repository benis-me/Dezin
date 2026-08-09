import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  compareDesignExportScreenshots,
  findDesignExportChrome,
  runDesignExportVisualGate,
  type DesignExportVisualCaptureSession,
} from "../src/design/design-export-visual-gate.ts";
import { DESIGN_EXPORT_CONTENT_SECURITY_POLICY } from "../src/design/design-export-policy.ts";
import type { DesignFrozenContext } from "../src/design/design-types.ts";

function solidPng(width: number, height: number, color: string): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patchedPng(width: number, height: number, background: string, patch: string): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = patch;
  context.fillRect(width / 2, 0, width / 2, height / 2);
  return canvas.toBuffer("image/png");
}

function hairlinePng(color: string): Buffer {
  const canvas = createCanvas(128, 96);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f1e8";
  context.fillRect(0, 0, 128, 96);
  context.fillStyle = color;
  context.fillRect(63, 12, 1, 72);
  return canvas.toBuffer("image/png");
}

function smallControlPng(includeControl: boolean): Buffer {
  const canvas = createCanvas(640, 400);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f1e8";
  context.fillRect(0, 0, 640, 400);
  if (includeControl) {
    context.fillStyle = "#17202a";
    context.fillRect(304, 190, 32, 20);
  }
  return canvas.toBuffer("image/png");
}

function registrationPatternPng(offsetX: number, offsetY: number): Buffer {
  const canvas = createCanvas(256, 192);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f1e8";
  context.fillRect(0, 0, 256, 192);
  context.save();
  context.translate(offsetX, offsetY);
  context.fillStyle = "#17202a";
  for (let x = 12; x < 244; x += 4) context.fillRect(x, 12, 1, 168);
  context.fillStyle = "#c48b9f";
  for (let y = 16; y < 176; y += 8) context.fillRect(16, y, 224, 2);
  context.restore();
  return canvas.toBuffer("image/png");
}

function visualContext(): DesignFrozenContext {
  return {
    schemaVersion: 2,
    projectId: "project-visual",
    canvasRevision: 7,
    targetNodeId: null,
    checksum: "a".repeat(64),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-page",
      kind: "page",
      name: "Home",
      state: "ready",
      geometry: { x: 0, y: 0, width: 1280, height: 800 },
      selectedVersionId: "version-one",
      selectedVersionContentKind: "html",
      selectedVersionChecksum: "b".repeat(64),
      selectedVersionBytes: 128,
      selectedVersionPath: "nodes/node-page/versions/version-one/index.html",
      selectedVersionJobId: "job-source",
      selectedVersionRunnerId: "codebuddy",
      selectedVersionModel: "hy3-ioa",
      selectedVersionAssetPins: [],
      assetId: null,
      assetChecksum: null,
      assetBytes: null,
      assetPath: null,
      assetBundleFiles: [],
    }],
  };
}

function visualProvenance() {
  return {
    execution: { jobId: "job-export", providerId: "codebuddy", model: "hy3-ioa" },
    sources: [{
      nodeId: "node-page",
      nodeKind: "page" as const,
      versionId: "version-one",
      checksum: "b".repeat(64),
      sourceJobId: "job-source",
      sourceProviderId: "codebuddy",
      sourceModel: "hy3-ioa",
    }],
  };
}

test("Design Export runtime CSP forbids every network connection", () => {
  const directives = new Map(DESIGN_EXPORT_CONTENT_SECURITY_POLICY
    .split("; ")
    .map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")] as const;
    }));

  assert.equal(directives.get("connect-src"), "'none'");
  assert.equal(directives.get("script-src"), "'self'");
  assert.equal(directives.get("style-src"), "'self'");
});

test("Design Export visual comparison accepts byte-distinct PNGs with identical pixels", async () => {
  const source = solidPng(96, 64, "#f6f1e8");
  const output = Buffer.from(source);

  const result = await compareDesignExportScreenshots(source, output);

  assert.equal(result.passed, true);
  assert.deepEqual(result.alignment, { offsetX: 0, offsetY: 0 });
  assert.deepEqual(result.metrics, {
    meanAbsoluteError: 0,
    changedPixelRatio: 0,
    meanSsim: 1,
    p05Ssim: 1,
    minimumSsim: 1,
  });
  assert.equal(result.diffPng.length > 0, true);
});

test("Design Export visual comparison registers a bounded one-pixel viewport offset", async () => {
  const result = await compareDesignExportScreenshots(
    registrationPatternPng(0, 0),
    registrationPatternPng(1, 1),
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.alignment, { offsetX: 1, offsetY: 1 });
  assert.equal(result.metrics.changedPixelRatio, 0);
});

test("Design Export visual comparison does not hide a two-pixel viewport offset", async () => {
  const result = await compareDesignExportScreenshots(
    registrationPatternPng(0, 0),
    registrationPatternPng(2, 0),
  );

  assert.equal(result.passed, false);
  assert.equal(Math.abs(result.alignment.offsetX) <= 1, true);
  assert.equal(Math.abs(result.alignment.offsetY) <= 1, true);
});

test("Design Export visual comparison rejects a missing local region", async () => {
  const source = patchedPng(128, 96, "#f6f1e8", "#17202a");
  const output = solidPng(128, 96, "#f6f1e8");

  const result = await compareDesignExportScreenshots(source, output);

  assert.equal(result.passed, false);
  assert.equal(result.metrics.changedPixelRatio, 0.25);
  assert.equal(result.metrics.meanSsim < 0.95, true);
});

test("Design Export visual comparison tolerates a sub-threshold antialiasing hairline", async () => {
  const result = await compareDesignExportScreenshots(hairlinePng("#17202a"), hairlinePng("#1d2630"));

  assert.equal(result.passed, true);
  assert.equal(result.metrics.meanAbsoluteError > 0, true);
  assert.equal(result.metrics.meanAbsoluteError < 0.001, true);
  assert.equal(result.metrics.meanSsim > 0.99, true);
});

test("Design Export visual comparison rejects one missing local control on a large quiet canvas", async () => {
  const result = await compareDesignExportScreenshots(smallControlPng(true), smallControlPng(false));

  assert.equal(result.metrics.changedPixelRatio < 0.01, true);
  assert.equal(result.metrics.meanSsim > 0.95, true);
  assert.equal(result.passed, false);
});

test("Design Export visual gate validates desktop and mobile while ignoring material Version routes", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-receipt-"));
  const screenshot = patchedPng(128, 96, "#f6f1e8", "#17202a");
  const context = visualContext();
  context.nodes.push({
    id: "node-image",
    kind: "image",
    name: "Reference",
    state: "ready",
    geometry: { x: 1300, y: 0, width: 320, height: 240 },
    selectedVersionId: "version-image",
    selectedVersionContentKind: "asset",
    selectedVersionChecksum: "c".repeat(64),
    selectedVersionBytes: 64,
    selectedVersionPath: ".context/assets/asset-image/original.webp",
    selectedVersionJobId: null,
    selectedVersionRunnerId: null,
    selectedVersionModel: null,
    selectedVersionAssetPins: [],
    assetId: "asset-image",
    assetChecksum: "c".repeat(64),
    assetBytes: 64,
    assetPath: ".context/assets/asset-image/original.webp",
    assetBundleFiles: [],
  });
  let closed = false;
  const captureSession: DesignExportVisualCaptureSession = {
    browserVersion: "Chrome/fixture",
    outputOrigin: "http://127.0.0.1:45678",
    async capture(input) {
      assert.match(input.sourceUrl, /version-one\/preview\/$/);
      assert.match(input.outputUrl, input.outputUrl.endsWith("/") ? /\/$/ : /\?dezin-node=node-page$/);
      return {
        sourcePng: screenshot,
        outputPng: screenshot,
        markerNodeIds: ["node-page"],
        markerVisible: true,
        blockedRequests: [],
      };
    },
    async close() { closed = true; },
  };
  try {
    await mkdir(join(stagingDir, "dist"));
    const provenance = visualProvenance();
    const result = await runDesignExportVisualGate({
      stagingDir,
      exportId: "export-visual",
      execution: provenance.execution,
      sources: [...provenance.sources, {
        nodeId: "node-image",
        nodeKind: "image",
        versionId: "version-image",
        checksum: "c".repeat(64),
        sourceJobId: null,
        sourceProviderId: null,
        sourceModel: null,
      }],
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      context,
      signal: new AbortController().signal,
    }, {
      openCaptureSession: async () => captureSession,
      now: () => 123_456,
    });

    assert.equal(closed, true);
    assert.equal(result.visualValidation.passed, true);
    assert.equal(result.visualValidation.caseCount, 4);
    const receiptBytes = await readFile(join(stagingDir, result.visualValidation.receiptPath));
    assert.equal(result.visualValidation.receiptChecksum.length, 64);
    assert.equal(result.visualValidation.receiptChecksum, result.receiptChecksum);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    assert.equal(receipt.jobId, "job-export");
    assert.equal(receipt.providerId, "codebuddy");
    assert.equal(receipt.model, "hy3-ioa");
    assert.equal(receipt.capturePolicy.screenshotRegistration, "bounded-to-one-css-pixel-per-axis");
    assert.deepEqual(receipt.rootChecks.map((entry: { viewport: { name: string } }) => entry.viewport.name), ["desktop", "mobile"]);
    assert.equal(receipt.rootChecks.every((entry: { passed: boolean }) => entry.passed), true);
    assert.equal(receipt.rootChecks.every((entry: { nodeId: string }) => entry.nodeId === "node-page"), true);
    assert.equal(receipt.rootChecks.every((entry: { versionId: string }) => entry.versionId === "version-one"), true);
    assert.equal(receipt.rootChecks.every((entry: { sourceJobId: string }) => entry.sourceJobId === "job-source"), true);
    assert.equal(receipt.rootChecks.every((entry: {
      metrics: { meanSsim: number };
      alignment: { offsetX: number; offsetY: number };
    }) => entry.metrics.meanSsim === 1 && entry.alignment.offsetX === 0 && entry.alignment.offsetY === 0), true);
    for (const rootCheck of receipt.rootChecks as Array<{ evidence: Record<string, { path: string; checksum: string; bytes: number }> }>) {
      assert.deepEqual(Object.keys(rootCheck.evidence), ["source", "output", "diff"]);
      for (const evidence of Object.values(rootCheck.evidence)) {
        const bytes = await readFile(join(stagingDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(sha256(bytes), evidence.checksum);
      }
    }
    assert.deepEqual(receipt.cases.map((entry: { viewport: { name: string } }) => entry.viewport.name), ["desktop", "mobile"]);
    assert.equal(receipt.cases.every((entry: {
      passed: boolean;
      alignment: { offsetX: number; offsetY: number };
    }) => entry.passed && Math.abs(entry.alignment.offsetX) <= 1 && Math.abs(entry.alignment.offsetY) <= 1), true);
    assert.equal(receipt.cases.every((entry: { sourceJobId: string }) => entry.sourceJobId === "job-source"), true);
    assert.equal(receipt.cases.every((entry: { sourceProviderId: string }) => entry.sourceProviderId === "codebuddy"), true);
    assert.equal(receipt.cases.every((entry: { sourceModel: string }) => entry.sourceModel === "hy3-ioa"), true);
    assert.equal(receipt.createdAt, 123_456);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects an extra material source outside the frozen context", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-extra-source-"));
  try {
    const provenance = visualProvenance();
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-extra-source",
        ...provenance,
        sources: [...provenance.sources, {
          nodeId: "node-extra-image",
          nodeKind: "image",
          versionId: "version-extra-image",
          checksum: "d".repeat(64),
          sourceJobId: null,
          sourceProviderId: null,
          sourceModel: null,
        }],
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /source Version provenance does not match the frozen Canvas/i,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects source provenance outside the frozen context", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-provenance-"));
  try {
    await mkdir(join(stagingDir, "dist"));
    const provenance = visualProvenance();
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-forged-provenance",
        ...provenance,
        sources: provenance.sources.map((source) => ({ ...source, sourceModel: "forged-model" })),
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /source Version provenance is invalid/i,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a missing route marker and removes partial evidence", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-marker-"));
  const screenshot = solidPng(64, 64, "#f6f1e8");
  let closed = false;
  try {
    await mkdir(join(stagingDir, "dist"));
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-marker-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }, {
        openCaptureSession: async () => ({
          browserVersion: "Chrome/fixture",
          outputOrigin: "http://127.0.0.1:45678",
          async capture(input) {
            const root = input.outputUrl.endsWith("/");
            return {
              sourcePng: screenshot,
              outputPng: screenshot,
              markerNodeIds: root ? ["node-page"] : [],
              markerVisible: root,
              blockedRequests: [],
            };
          },
          async close() { closed = true; },
        }),
      }),
      /Home \(node-page\).*desktop 1280x800.*exactly one visible.*marker/i,
    );
    assert.equal(closed, true);
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a screenshot mismatch with Node and viewport metrics", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-mismatch-"));
  let closed = false;
  try {
    await mkdir(join(stagingDir, "dist"));
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-visual-mismatch",
        ...visualProvenance(),
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }, {
        openCaptureSession: async () => ({
          browserVersion: "Chrome/fixture",
          outputOrigin: "http://127.0.0.1:45678",
          async capture(input) {
            const root = input.outputUrl.endsWith("/");
            return {
              sourcePng: smallControlPng(true),
              outputPng: root ? smallControlPng(true) : smallControlPng(false),
              markerNodeIds: ["node-page"],
              markerVisible: true,
              blockedRequests: [],
            };
          },
          async close() { closed = true; },
        }),
      }),
      /Home \(node-page\).*desktop 1280x800.*MAE .*changed .*SSIM .*p05 .*min /i,
    );
    assert.equal(closed, true);
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate renders the exact source and built route in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-chrome-"));
  const css = `:root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}
    *{box-sizing:border-box}body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}
    h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}`;
  const sourceHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="page" data-dezin-export-node-id="node-page"><h1>Exact visual route</h1></main></body></html>`;
  const outputHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><main class="page" data-dezin-export-node-id="node-page"><h1>Exact visual route</h1></main></body></html>`;
  const sourceServer = createServer((request, response) => {
    if (request.url === "/api/projects/project-visual/design-canvas/nodes/node-page/versions/version-one/preview/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(sourceHtml);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(join(stagingDir, "dist", "style.css"), css),
    ]);
    const result = await runDesignExportVisualGate({
      stagingDir,
      exportId: "export-real-chrome",
      ...visualProvenance(),
      sourcePreviewOrigin: `http://127.0.0.1:${port}`,
      context: visualContext(),
      signal: new AbortController().signal,
    });
    assert.equal(result.visualValidation.passed, true);
    assert.equal(result.visualValidation.caseCount, 4);
    const receiptBytes = await readFile(join(stagingDir, result.visualValidation.receiptPath));
    assert.equal(result.visualValidation.receiptChecksum, sha256(receiptBytes));
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      rootChecks: Array<{
        passed: boolean;
        nodeId: string;
        viewport: { name: string };
        metrics: { meanSsim: number };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
      cases: Array<{
        passed: boolean;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
    assert.deepEqual(receipt.rootChecks.map((entry) => entry.viewport.name), ["desktop", "mobile"]);
    assert.equal(receipt.rootChecks.every((entry) => entry.passed && entry.nodeId === "node-page"), true);
    for (const entry of receipt.rootChecks) {
      assert.ok(entry.metrics.meanSsim >= 0.95);
      assert.deepEqual(Object.keys(entry.evidence), ["source", "output", "diff"]);
    }
    assert.deepEqual(receipt.cases.map((entry) => entry.viewport.name), ["desktop", "mobile"]);
    for (const entry of receipt.cases) {
      assert.equal(entry.passed, true);
      for (const evidence of Object.values(entry.evidence)) {
        const bytes = await readFile(join(stagingDir, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(sha256(bytes), evidence.checksum);
      }
    }
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a built route without its runtime marker in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-real-marker-"));
  const html = "<!doctype html><html><body><main>Markerless route</main></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await writeFile(join(stagingDir, "dist", "index.html"), html);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-real-marker-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*exactly one visible.*marker/i,
    );
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a runtime marker occluded at its center point", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-occluded-marker-"));
  const css = `html,body{margin:0;min-height:100%;background:#f6f1e8;color:#17202a}
    main,.cover{position:fixed;inset:0;display:grid;place-items:center;background:#f6f1e8}
    .cover{z-index:2}`;
  const body = `<main data-dezin-export-node-id="node-page">Occluded marker</main><div class="cover">Occluded marker</div>`;
  const sourceHtml = `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;
  const outputHtml = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>${body}</body></html>`;
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(join(stagingDir, "dist", "style.css"), css),
    ]);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-occluded-marker-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*exactly one visible.*marker/i,
    );
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a runtime marker below the minimum visible area", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-tiny-marker-"));
  const css = `html,body{margin:0;min-height:100%;background:#f6f1e8}
    main{position:fixed;left:50px;top:50px;width:1px;height:1px;background:#17202a}`;
  const body = `<main data-dezin-export-node-id="node-page"></main>`;
  const sourceHtml = `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;
  const outputHtml = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>${body}</body></html>`;
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(join(stagingDir, "dist", "style.css"), css),
    ]);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-tiny-marker-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*exactly one visible.*marker/i,
    );
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate blocks external network in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-network-"));
  const html = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Network boundary<img src=\"https://network.invalid/tracker.png\"></main></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await writeFile(join(stagingDir, "dist", "index.html"), html);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-network-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*blocked external request.*network\.invalid/i,
    );
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate eagerly settles off-screen lazy images", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-lazy-image-"));
  const pixel = solidPng(8, 8, "#c48b9f");
  const css = `html,body{margin:0;background:#f6f1e8;color:#17202a}
    main{min-height:7000px}.visible{height:800px;display:grid;place-items:center}
    .spacer{height:6000px}img{display:block;width:8px;height:8px}`;
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>
    <main data-dezin-export-node-id="node-page"><div class="visible">Lazy image boundary</div>
    <div class="spacer"></div><img loading="lazy" src="/pixel.png" alt=""></main></body></html>`;
  const sourceServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://source.local").pathname;
    if (pathname === "/style.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(css);
      return;
    }
    if (pathname === "/pixel.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(pixel);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), html),
      writeFile(join(stagingDir, "dist", "style.css"), css),
      writeFile(join(stagingDir, "dist", "pixel.png"), pixel),
    ]);
    const result = await runDesignExportVisualGate({
      stagingDir,
      exportId: "export-lazy-image-settle",
      ...visualProvenance(),
      sourcePreviewOrigin: `http://127.0.0.1:${port}`,
      context: visualContext(),
      signal: new AbortController().signal,
    });
    assert.match(result.receiptChecksum, /^[a-f0-9]{64}$/);
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate validates the ordinary root route in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-root-route-"));
  const sourceHtml = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Root route boundary</main></body></html>";
  const outputHtml = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Root route boundary</main><script src=\"/app.js\"></script></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(
        join(stagingDir, "dist", "app.js"),
        "if (!location.search) { const image = new Image(); image.src = ['ht', 'tps:', '//network.invalid/root.png'].join(''); }\n",
      ),
    ]);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-root-route-network-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*blocked external request.*network\.invalid/i,
    );
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a blank ordinary root route in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-blank-root-"));
  const sourceHtml = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Root content</main></body></html>";
  const outputHtml = "<!doctype html><html><body><div id=\"app\"></div><script src=\"/app.js\"></script></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(join(stagingDir, "dist", "app.js"), `
        if (location.search) {
          const main = document.createElement("main");
          main.dataset.dezinExportNodeId = "node-page";
          main.textContent = "Root content";
          document.querySelector("#app")?.append(main);
        }
      `),
    ]);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-blank-root-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*exactly one visible.*marker/i,
    );
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate rejects a mismatched ordinary root route in real Chrome", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-root-mismatch-"));
  const sourceHtml = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Exact root content</main></body></html>";
  const outputHtml = "<!doctype html><html><body><main data-dezin-export-node-id=\"node-page\">Wrong root content</main><script src=\"/app.js\"></script></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingDir, "dist", "index.html"), outputHtml),
      writeFile(join(stagingDir, "dist", "app.js"), `
        if (location.search) document.querySelector("main").textContent = "Exact root content";
      `),
    ]);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-root-mismatch-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*MAE .*changed .*SSIM .*p05 .*min /i,
    );
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export built route cannot read the trusted source preview origin", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-phase-network-"));
  const sourceHtml = "<!doctype html><html><body><main>Phase isolated</main></body></html>";
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(sourceHtml);
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  const sourceOrigin = `http://127.0.0.1:${port}`;
  const outputHtml = `<!doctype html><html><body><main data-dezin-export-node-id="node-page">Phase isolated<img src="${sourceOrigin}/forbidden-output-read"></main></body></html>`;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await writeFile(join(stagingDir, "dist", "index.html"), outputHtml);
    await assert.rejects(
      runDesignExportVisualGate({
        stagingDir,
        exportId: "export-phase-network-failure",
        ...visualProvenance(),
        sourcePreviewOrigin: sourceOrigin,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /root application.*desktop 1280x800.*blocked external request.*forbidden-output-read/i,
    );
  } finally {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Design Export visual gate abort closes Chrome and its loopback server without evidence", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the Design Export visual gate adapter");
    return;
  }
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-abort-"));
  let enterSource!: () => void;
  const sourceEntered = new Promise<void>((resolve) => { enterSource = resolve; });
  const sourceServer = createServer((_request, _response) => {
    enterSource();
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  const controller = new AbortController();
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await writeFile(
      join(stagingDir, "dist", "index.html"),
      "<!doctype html><main data-dezin-export-node-id=\"node-page\">abort</main>",
    );
    const gate = runDesignExportVisualGate({
      stagingDir,
      exportId: "export-aborted",
      ...visualProvenance(),
      sourcePreviewOrigin: `http://127.0.0.1:${port}`,
      context: visualContext(),
      signal: controller.signal,
    });
    await new Promise<void>((resolveEntered, rejectEntered) => {
      const timer = setTimeout(() => rejectEntered(new Error("Chrome did not enter the source route")), 5_000);
      void sourceEntered.then(() => {
        clearTimeout(timer);
        resolveEntered();
      }, rejectEntered);
    });
    controller.abort(new DOMException("cancelled by test", "AbortError"));
    await assert.rejects(gate, /cancelled by test|aborted/i);
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
  } finally {
    sourceServer.closeAllConnections();
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
    await rm(stagingDir, { recursive: true, force: true });
  }
});
