import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  decodeSharinganCaptureResourceBundle,
  encodeSharinganCaptureResourceBundle,
  normalizeSharinganCaptureBundlePath,
  SharinganCaptureResourceBundleError,
  validateSharinganCaptureResourceBundleSemantics,
  type SharinganCaptureBundleFileInput,
} from "../src/orchestration/sharingan-capture-resource-bundle.ts";
import {
  semanticSharinganCaptureFiles,
  sharinganFixturePng,
} from "./support/sharingan-capture-fixture.ts";

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function file(path: string, value: string): SharinganCaptureBundleFileInput {
  const bytes = Buffer.from(value);
  return { path, bytes, checksum: checksum(bytes) };
}

function files(): SharinganCaptureBundleFileInput[] {
  return semanticSharinganCaptureFiles();
}

const SOURCE = Object.freeze({
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  capturedAt: 1,
});

async function validateSemantics(exportedFiles: SharinganCaptureBundleFileInput[]) {
  return validateSharinganCaptureResourceBundleSemantics({ source: SOURCE, files: exportedFiles });
}

function encode(exportedFiles = files(), maxOutputBytes = 1024 * 1024) {
  return encodeSharinganCaptureResourceBundle({
    scope: {
      taskId: "task-1",
      planId: "plan-1",
      attempt: 1,
      inputHash: "a".repeat(64),
      workspaceId: "workspace-1",
      resourceId: "capture-1",
      parentRevisionId: null,
      contextPackId: "context-pack-1",
      operation: "create",
      nodeId: "capture-node",
      title: "Exact capture",
      resourceKind: "sharingan-capture",
    },
    source: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      capturedAt: 1,
    },
    exporter: { id: "fixture", version: 1 },
    files: exportedFiles,
    maxOutputBytes,
  });
}

test("Sharingan Capture bundle v2 round-trips both immutable roots canonically", () => {
  const encoded = encode();
  const decoded = decodeSharinganCaptureResourceBundle(encoded.bytes);

  assert.equal(decoded.protocol, "dezin.sharingan-capture-resource-bundle.v2");
  assert.deepEqual(decoded.roots, [".sharingan", "public/_assets"]);
  assert.deepEqual(decoded.files.map((item) => item.path), [
    ".sharingan/entry/assets.json",
    ".sharingan/entry/dom.json",
    ".sharingan/entry/render-map.json",
    ".sharingan/entry/shot.png",
    ".sharingan/entry/styles.json",
    ".sharingan/pages.json",
    ".sharingan/probe.mjs",
    "public/_assets/source.png",
  ]);
});

test("Sharingan Capture bundle rejects missing, extra, traversal, and unreferenced Asset files", () => {
  const cases: SharinganCaptureBundleFileInput[][] = [
    files().filter((item) => item.path !== ".sharingan/probe.mjs"),
    files().filter((item) => item.path !== "public/_assets/source.png"),
    [...files(), file(".sharingan/extra.json", "{}")],
    [...files(), file("public/_assets/unreferenced.png", "unused")],
    files().map((item) => item.path === ".sharingan/probe.mjs" ? { ...item, path: ".sharingan/../probe.mjs" } : item),
  ];
  for (const exportedFiles of cases) {
    assert.throws(
      () => encode(exportedFiles),
      (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
    );
  }
});

test("Sharingan Capture bundle decoder rejects checksum, root, order, and output-budget substitution", () => {
  const encoded = encode();
  const mutations = [
    (value: any) => { value.files[0].checksum = "f".repeat(64); },
    (value: any) => { value.roots = [".sharingan"]; },
    (value: any) => { value.files.reverse(); },
  ];
  for (const mutate of mutations) {
    const parsed = JSON.parse(Buffer.from(encoded.bytes).toString("utf8"));
    mutate(parsed);
    assert.throws(
      () => decodeSharinganCaptureResourceBundle(Buffer.from(JSON.stringify(parsed))),
      (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
    );
  }
  assert.throws(
    () => decodeSharinganCaptureResourceBundle(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(encoded.bytes).toString("utf8")), null, 2))),
    (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
  );
  assert.throws(
    () => encode(files(), 16),
    (error: unknown) => error instanceof SharinganCaptureResourceBundleError
      && /output budget/i.test(error.message),
  );
});

test("Sharingan Capture bundle paths use one portable ASCII spelling", () => {
  assert.equal(normalizeSharinganCaptureBundlePath(".sharingan/entry/shot-desktop.png"), ".sharingan/entry/shot-desktop.png");
  for (const path of [
    ".sharingan/entry/line\nbreak.json",
    ".sharingan/entry/caf\u00e9.json",
    ".sharingan/entry/file name.json",
  ]) {
    assert.throws(
      () => normalizeSharinganCaptureBundlePath(path),
      (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
    );
  }
});

test("Sharingan Capture semantic validation accepts fully decoded measured source evidence", async () => {
  assert.deepEqual(await validateSemantics(files()), {
    protocol: "dezin.sharingan-capture-semantic-receipt.v1",
    pageCount: 1,
    screenshotCount: 1,
    viewportCount: 1,
  });
});

test("Sharingan Capture semantic validation rejects fake pixels and empty measured JSON", async () => {
  const cases = [
    semanticSharinganCaptureFiles({ screenshotBytes: Buffer.from("not png pixels") }),
    semanticSharinganCaptureFiles({ assetBytes: Buffer.from("not png asset pixels") }),
    semanticSharinganCaptureFiles({ dom: [] }),
    semanticSharinganCaptureFiles({ styles: { colors: [], fontFamilies: [], fontSizes: [], radii: [], shadows: [] } }),
    semanticSharinganCaptureFiles({ renderMap: {} }),
  ];
  for (const exportedFiles of cases) {
    await assert.rejects(
      () => validateSemantics(exportedFiles),
      (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
    );
  }
});

test("Sharingan Capture semantic validation rejects a forged tiny viewport and a partial-page screenshot", async () => {
  const tiny = semanticSharinganCaptureFiles({
    screenshotBytes: sharinganFixturePng(1, 1),
    dom: [{
      tag: "body", classes: "", text: "", box: { x: 0, y: 0, w: 1, h: 1 },
      style: { display: "block" }, children: [],
    }],
    renderMap: {
      viewport: { width: 1, height: 1 },
      document: { width: 1, height: 1 },
      elements: [{ selector: "body", tag: "body", box: { x: 0, y: 0, w: 1, h: 1 }, style: { display: "block" } }],
    },
  });
  const partialPage = semanticSharinganCaptureFiles({ screenshotBytes: sharinganFixturePng(1440, 900) });
  for (const exportedFiles of [tiny, partialPage]) {
    await assert.rejects(
      () => validateSemantics(exportedFiles),
      (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
    );
  }
});

test("Sharingan Capture semantic validation rejects accessor-backed file data without invoking it", async () => {
  let reads = 0;
  const hostile = {} as { path: string; bytes: Uint8Array };
  Object.defineProperties(hostile, {
    path: { enumerable: true, get() { reads += 1; return ".sharingan/pages.json"; } },
    bytes: { enumerable: true, get() { reads += 1; return Buffer.from("{}"); } },
  });
  await assert.rejects(
    () => validateSharinganCaptureResourceBundleSemantics({
      source: SOURCE,
      files: [hostile],
    }),
    (error: unknown) => error instanceof SharinganCaptureResourceBundleError,
  );
  assert.equal(reads, 0);
});
