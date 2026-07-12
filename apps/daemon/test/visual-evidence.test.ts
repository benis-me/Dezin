import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/index.ts";
import { persistVisualEvidence } from "../src/visual-evidence.ts";

test("persistVisualEvidence creates content-addressed immutable evidence for a run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-"));
  const source = join(dataDir, "current.png");
  writeFileSync(source, Buffer.from("first screenshot"));

  const first = await persistVisualEvidence({ dataDir, projectId: "project-1", runId: "run-1", round: 0, sourcePath: source });
  assert.ok(first);
  assert.equal(readFileSync(first!.path, "utf8"), "first screenshot");
  assert.match(first!.url, /^\/api\/projects\/project-1\/runs\/run-1\/evidence\/round-0-[a-f0-9]{12}\.png$/);

  writeFileSync(source, Buffer.from("later screenshot"));
  const later = await persistVisualEvidence({ dataDir, projectId: "project-1", runId: "run-1", round: 0, sourcePath: source });
  assert.ok(later);
  assert.notEqual(later!.path, first!.path, "changed pixels get a new immutable filename");
  assert.equal(readFileSync(first!.path, "utf8"), "first screenshot", "later captures never overwrite historical evidence");
  assert.equal(readFileSync(later!.path, "utf8"), "later screenshot");
});

test("persistVisualEvidence returns undefined when the capture is unavailable and sanitizes identity segments", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-missing-"));
  assert.equal(
    await persistVisualEvidence({ dataDir, projectId: "../project", runId: "../run", round: 2, sourcePath: join(dataDir, "missing.png") }),
    undefined,
  );
  assert.equal(existsSync(join(dataDir, "version-evidence", "project", "run", "visual")), false);
});

test("run evidence route serves only immutable evidence owned by that project and run", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-route-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Evidence" });
  const conversation = store.createConversation(project.id);
  const variant = store.ensureMainVariant(project.id);
  const run = store.createRun(project.id, conversation.id, variant.id);
  const source = join(dataDir, "shot.png");
  writeFileSync(source, Buffer.from("immutable pixels"));
  const evidence = await persistVisualEvidence({ dataDir, projectId: project.id, runId: run.id, round: 1, sourcePath: source });
  assert.ok(evidence);

  const server = createApp({ store, dataDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${evidence!.url}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "immutable pixels");

    const wrongRun = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/runs/not-this-run/evidence/${evidence!.url.split("/").at(-1)}`);
    assert.equal(wrongRun.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
