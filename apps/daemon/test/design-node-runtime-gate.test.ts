import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findDesignExportChrome } from "../src/design/design-export-visual-gate.ts";
import { runDesignNodeRuntimeGate } from "../src/design/design-node-runtime-gate.ts";

test("Node runtime gate requires non-empty exact frozen Asset ownership", async () => {
  await assert.rejects(runDesignNodeRuntimeGate({
    html: "<!doctype html><html><body><main>Visible</main></body></html>",
    signal: new AbortController().signal,
    assets: [{
      assetId: `asset-${"f".repeat(32)}`,
      stagingPath: "/not-read",
      mimeType: "application/x_test",
      checksum: "a".repeat(64),
      bytes: 1,
      ownerNodeIds: [],
    }],
  }), /invalid frozen Asset descriptor/i);
});

test("Node runtime gate observes real synchronous rendering at desktop and mobile", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const result = await runDesignNodeRuntimeGate({
    html: "<!doctype html><html><head><title>Checked</title><style>body{margin:0}main{max-width:100%;padding:20px;box-sizing:border-box}</style></head><body><main><h1>Visible</h1><button aria-label=\"Continue\"></button></main></body></html>",
    signal: new AbortController().signal,
    assets: [],
  });
  assert.equal(result.viewports, 2);
  assert.ok(result.meaningfulElements > 0);
});

test("Node runtime gate serves an exact checksum-bound frozen Asset at every viewport", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
  );
  const assetId = `asset-${"a".repeat(32)}`;
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-runtime-asset-"));
  const stagingPath = join(stagingDir, "original.svg");
  await writeFile(stagingPath, bytes);
  try {
    const result = await runDesignNodeRuntimeGate({
      html: `<!doctype html><html><head><title>Frozen Asset</title><style>body{margin:0}main{padding:20px}img{width:40px;height:40px}</style></head><body><main>Visible<img alt="Frozen reference" src="dezin-asset://${assetId}"></main></body></html>`,
      signal: new AbortController().signal,
      assets: [{
        assetId,
        stagingPath,
        bytes: bytes.byteLength,
        mimeType: "image/svg+xml",
        checksum: createHash("sha256").update(bytes).digest("hex"),
        ownerNodeIds: ["node-image"],
      }],
    });
    assert.equal(result.viewports, 2);
    assert.ok(result.meaningfulElements > 0);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Node runtime gate rejects a frozen Asset payload changed after materialization", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const expected = Buffer.from("expected-payload");
  const tampered = Buffer.from("tampered-payload");
  assert.equal(tampered.byteLength, expected.byteLength);
  const assetId = `asset-${"b".repeat(32)}`;
  const stagingDir = await mkdtemp(join(tmpdir(), "dezin-runtime-tamper-"));
  const stagingPath = join(stagingDir, "original.bin");
  await writeFile(stagingPath, tampered);
  try {
    await assert.rejects(runDesignNodeRuntimeGate({
      html: `<!doctype html><html><head><title>Tamper</title><style>img{width:20px;height:20px}</style></head><body><main>Visible<img alt="Asset" src="dezin-asset://${assetId}"></main></body></html>`,
      signal: new AbortController().signal,
      assets: [{
        assetId,
        stagingPath,
        bytes: expected.byteLength,
        mimeType: "application/octet-stream",
        checksum: createHash("sha256").update(expected).digest("hex"),
        ownerNodeIds: ["node-owner"],
      }],
    }), /checksum mismatch.*asset-b+/i);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("Node runtime gate reports exact unknown and external blocked URLs without guard console noise", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const unknown = `dezin-asset://asset-${"c".repeat(32)}`;
  for (const scenario of [
    { url: unknown, error: /desktop: .*unknown frozen Asset: dezin-asset:\/\/asset-c+/i },
    { url: "https://example.invalid/tracker.png", error: /desktop: .*blocked external request: https:\/\/example\.invalid\/tracker\.png/i },
  ]) {
    await assert.rejects(
      runDesignNodeRuntimeGate({
        html: `<!doctype html><html><head><title>Blocked</title><style>img{width:20px;height:20px}</style></head><body><main>Visible<img alt="Blocked" src="${scenario.url}"></main></body></html>`,
        signal: new AbortController().signal,
        assets: [],
      }),
      (error: unknown) => error instanceof Error
        && scenario.error.test(error.message)
        && !/ERR_BLOCKED_BY_CLIENT/i.test(error.message),
    );
  }
});

test("Node runtime gate isolates a mobile-only blocked request from the desktop viewport", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='green'/%3E%3C/svg%3E";
  await assert.rejects(
    runDesignNodeRuntimeGate({
      html: `<!doctype html><html><head><title>Responsive request</title><style>img{width:20px;height:20px}</style></head><body><main>Visible<picture><source media="(max-width: 500px)" srcset="https://example.invalid/mobile.png"><img alt="Responsive" src="${fallback}"></picture></main></body></html>`,
      signal: new AbortController().signal,
      assets: [],
    }),
    (error: unknown) => error instanceof Error
      && /mobile: .*blocked external request: https:\/\/example\.invalid\/mobile\.png/i.test(error.message)
      && !/desktop:/i.test(error.message),
  );
});

test("Node runtime gate rejects blank, horizontal overflow, runtime errors, and unnamed controls", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const cases = [
    {
      html: "<!doctype html><html><head><title>Blank</title></head><body></body></html>",
      error: /rendered output is blank/i,
    },
    {
      html: "<!doctype html><html><head><title>Overflow</title></head><body><main style=\"width:1000px\">Wide</main></body></html>",
      error: /overflows horizontally/i,
    },
    {
      html: "<!doctype html><html><head><title>Runtime</title></head><body><main>Visible</main><script>throw new Error('runtime-boom')</script></body></html>",
      error: /runtime-boom/i,
    },
    {
      html: "<!doctype html><html><head><title>A11y</title></head><body><main>Visible</main><button><svg></svg></button></body></html>",
      error: /accessible name/i,
    },
    {
      html: "<!doctype html><html><head><title>Broken image</title><style>img{width:20px;height:20px}</style></head><body><main>Visible<img alt=\"Broken\" src=\"data:image/png;base64,AAAA\"></main></body></html>",
      error: /visible image.*failed to load/i,
    },
  ];
  for (const scenario of cases) {
    await assert.rejects(
      runDesignNodeRuntimeGate({ html: scenario.html, signal: new AbortController().signal, assets: [] }),
      scenario.error,
    );
  }
});

test("Node runtime gate quality lint reports contrast, filler copy, and overlap, and screenshots are bounded captures", async (t) => {
  if (!findDesignExportChrome()) {
    t.skip("Chrome is required for the production Node runtime gate");
    return;
  }
  const shell = (body: string, css = "") => `<!doctype html><html><head><title>Lint</title><style>body{margin:0;font-family:Arial,sans-serif}main{padding:24px;max-width:100%;box-sizing:border-box}${css}</style></head><body><main>${body}</main></body></html>`;
  await assert.rejects(runDesignNodeRuntimeGate({
    html: shell('<p style="color:#999;background:#fff">Lorem ipsum dolor sit amet, filler paragraph</p>'),
    signal: new AbortController().signal,
    assets: [],
    options: { lint: true },
  }), (error: Error) => /Quality lint failed at desktop/.test(error.message)
    && /placeholder copy "lorem ipsum"/i.test(error.message)
    && /contrast .*WCAG AA needs 4\.5:1/.test(error.message));
  await assert.rejects(runDesignNodeRuntimeGate({
    html: shell('<div style="position:relative;height:40px"><p style="position:absolute;top:0;left:0;margin:0">First headline text</p><p style="position:absolute;top:4px;left:8px;margin:0">Second headline text</p></div>'),
    signal: new AbortController().signal,
    assets: [],
    options: { lint: true },
  }), /text elements overlap/);
  const clean = await runDesignNodeRuntimeGate({
    html: shell('<h1 style="color:#111">Readable</h1><p style="color:#333">Real copy with enough contrast.</p><div style="height:2400px"></div>'),
    signal: new AbortController().signal,
    assets: [],
    options: { lint: true, screenshots: true },
  });
  assert.equal(clean.screenshots?.length, 2);
  const desktop = clean.screenshots!.find((shot) => shot.viewport === "desktop")!;
  assert.equal(desktop.width, 1280);
  assert.ok(desktop.height > 800 && desktop.height <= 4000, `bounded full-page height, got ${desktop.height}`);
  assert.deepEqual([...desktop.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const silent = await runDesignNodeRuntimeGate({
    html: shell('<p style="color:#999">Lorem ipsum dolor sit amet</p>'),
    signal: new AbortController().signal,
    assets: [],
  });
  assert.equal(silent.screenshots, undefined);
});
