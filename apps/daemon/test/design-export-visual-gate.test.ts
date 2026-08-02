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

function visualContext(): DesignFrozenContext {
  return {
    schemaVersion: 1,
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
      selectedVersionChecksum: "b".repeat(64),
      selectedVersionBytes: 128,
      selectedVersionPath: "nodes/node-page/versions/version-one/index.html",
      selectedVersionAssetPins: [],
      assetId: null,
      assetChecksum: null,
      assetBytes: null,
      assetPath: null,
      assetBundleFiles: [],
    }],
  };
}

test("Design Export visual comparison accepts byte-distinct PNGs with identical pixels", async () => {
  const source = solidPng(96, 64, "#f6f1e8");
  const output = Buffer.from(source);

  const result = await compareDesignExportScreenshots(source, output);

  assert.equal(result.passed, true);
  assert.deepEqual(result.metrics, {
    meanAbsoluteError: 0,
    changedPixelRatio: 0,
    meanSsim: 1,
    p05Ssim: 1,
    minimumSsim: 1,
  });
  assert.equal(result.diffPng.length > 0, true);
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

test("Design Export visual gate validates desktop and mobile and writes a byte-bound receipt", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-export-visual-receipt-"));
  const screenshot = patchedPng(128, 96, "#f6f1e8", "#17202a");
  const context = visualContext();
  let closed = false;
  const captureSession: DesignExportVisualCaptureSession = {
    browserVersion: "Chrome/fixture",
    outputOrigin: "http://127.0.0.1:45678",
    async capture(input) {
      assert.match(input.sourceUrl, /version-one\/preview\/$/);
      assert.match(input.outputUrl, /\?dezin-node=node-page$/);
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
    const result = await runDesignExportVisualGate({
      stagingDir,
      exportId: "export-visual",
      sourcePreviewOrigin: "http://127.0.0.1:34567",
      context,
      signal: new AbortController().signal,
    }, {
      openCaptureSession: async () => captureSession,
      now: () => 123_456,
    });

    assert.equal(closed, true);
    assert.equal(result.visualValidation.passed, true);
    assert.equal(result.visualValidation.caseCount, 2);
    const receiptBytes = await readFile(join(stagingDir, result.visualValidation.receiptPath));
    assert.equal(result.visualValidation.receiptChecksum.length, 64);
    assert.equal(result.visualValidation.receiptChecksum, result.receiptChecksum);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    assert.deepEqual(receipt.cases.map((entry: { viewport: { name: string } }) => entry.viewport.name), ["desktop", "mobile"]);
    assert.equal(receipt.cases.every((entry: { passed: boolean }) => entry.passed), true);
    assert.equal(receipt.createdAt, 123_456);
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
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }, {
        openCaptureSession: async () => ({
          browserVersion: "Chrome/fixture",
          outputOrigin: "http://127.0.0.1:45678",
          async capture() {
            return {
              sourcePng: screenshot,
              outputPng: screenshot,
              markerNodeIds: [],
              markerVisible: false,
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
        sourcePreviewOrigin: "http://127.0.0.1:34567",
        context: visualContext(),
        signal: new AbortController().signal,
      }, {
        openCaptureSession: async () => ({
          browserVersion: "Chrome/fixture",
          outputOrigin: "http://127.0.0.1:45678",
          async capture() {
            return {
              sourcePng: smallControlPng(true),
              outputPng: smallControlPng(false),
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{background:#f6f1e8;color:#17202a;font-family:Arial,sans-serif}
    *{box-sizing:border-box}body{margin:0}.page{min-height:100vh;display:grid;place-items:center;padding:48px}
    h1{margin:0;max-width:9ch;font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.07em}
  </style></head><body><main class="page" data-dezin-export-node-id="node-page"><h1>Exact visual route</h1></main></body></html>`;
  const sourceServer = createServer((request, response) => {
    if (request.url === "/api/projects/project-visual/design-canvas/nodes/node-page/versions/version-one/preview/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
  const { port } = sourceServer.address() as AddressInfo;
  try {
    await mkdir(join(stagingDir, "dist"), { recursive: true });
    await writeFile(join(stagingDir, "dist", "index.html"), html);
    const result = await runDesignExportVisualGate({
      stagingDir,
      exportId: "export-real-chrome",
      sourcePreviewOrigin: `http://127.0.0.1:${port}`,
      context: visualContext(),
      signal: new AbortController().signal,
    });
    assert.equal(result.visualValidation.passed, true);
    assert.equal(result.visualValidation.caseCount, 2);
    const receiptBytes = await readFile(join(stagingDir, result.visualValidation.receiptPath));
    assert.equal(result.visualValidation.receiptChecksum, sha256(receiptBytes));
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
      cases: Array<{
        passed: boolean;
        viewport: { name: string };
        evidence: Record<string, { path: string; checksum: string; bytes: number }>;
      }>;
    };
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
  const html = "<!doctype html><html><body style=\"margin:0\"><main style=\"min-height:100vh\">Markerless route</main></body></html>";
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
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /Home \(node-page\).*desktop 1280x800.*exactly one visible.*marker/i,
    );
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
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
        sourcePreviewOrigin: `http://127.0.0.1:${port}`,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /Home \(node-page\).*desktop 1280x800.*blocked external request.*network\.invalid/i,
    );
    await assert.rejects(readFile(join(stagingDir, "validation", "visual", "receipt.json")));
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
        sourcePreviewOrigin: sourceOrigin,
        context: visualContext(),
        signal: new AbortController().signal,
      }),
      /Home \(node-page\).*desktop 1280x800.*blocked external request.*forbidden-output-read/i,
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
