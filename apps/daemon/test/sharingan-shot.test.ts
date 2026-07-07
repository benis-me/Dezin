import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { projectDir } from "../src/serve-static.ts";

test("GET /shot serves a captured screenshot and blocks path traversal", async () => {
  const store = new Store(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "shar-shot-"));
  const project = store.createProject({ name: "clone", mode: "standard", sharingan: true, sourceUrl: "https://example.test/" });
  // Plant a fake shot where capturePage would write it.
  const shotDir = join(projectDir(dataDir, project.id), ".sharingan", "example-test");
  mkdirSync(shotDir, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
  writeFileSync(join(shotDir, "shot-desktop.png"), png);

  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("example-test/shot-desktop.png")}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.ok((await ok.arrayBuffer()).byteLength >= 8);

    const traversal = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("../../secret")}`);
    assert.equal(traversal.status, 400);

    const missing = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("example-test/nope.png")}`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});
