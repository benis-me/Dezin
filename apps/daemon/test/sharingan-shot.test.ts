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
  // Plant a fake shot exactly where capturePage writes it, and record its path exactly as
  // capturePage stores it in CapturedPage.screenshots: project-dir-relative, WITH the
  // ".sharingan" segment (see sharingan-capture.ts: `rel = join(".sharingan", pageDir(url))`).
  const shotDir = join(projectDir(dataDir, project.id), ".sharingan", "example-test");
  mkdirSync(shotDir, { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
  writeFileSync(join(shotDir, "shot-desktop.png"), png);
  // Also plant a real project file OUTSIDE .sharingan, to prove /shot is contained to
  // .sharingan and can't serve arbitrary project files.
  writeFileSync(join(projectDir(dataDir, project.id), "package.json"), "{}");

  const app = createApp({ store, dataDir });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    // The seam: request the ACTUAL value capturePage would store (.sharingan/-prefixed,
    // project-dir-relative), not a hand-rolled path that skips the ".sharingan" prefix.
    // Before the fix, the handler re-prepends ".sharingan" onto this already-prefixed
    // path, doubling it to ".sharingan/.sharingan/..." -> 404 for every real screenshot.
    const ok = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent(".sharingan/example-test/shot-desktop.png")}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.ok((await ok.arrayBuffer()).byteLength >= 8);

    const traversal = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("../../secret")}`);
    assert.equal(traversal.status, 400);

    const traversalViaSharingan = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent(".sharingan/../../secret")}`);
    assert.equal(traversalViaSharingan.status, 400);

    const missing = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent(".sharingan/example-test/nope.png")}`);
    assert.equal(missing.status, 404);

    // A real file that exists in the project dir but OUTSIDE .sharingan must still be
    // rejected: /shot is contained to .sharingan, not the whole project dir.
    const outsideShotRoot = await fetch(`${base}/api/sharingan/${project.id}/shot?path=${encodeURIComponent("package.json")}`);
    assert.equal(outsideShotRoot.status, 400);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    store.close();
  }
});
