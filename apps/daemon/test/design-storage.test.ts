import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesignRevisionConflictError,
  MAX_DESIGN_ASSET_BYTES,
  MAX_DESIGN_CONTEXT_BYTES,
  assertDesignFrozenContextBudget,
  createDesignJob,
  getDesignCanvas,
  getDesignJob,
  getDesignJobContext,
  getDesignThread,
  getDesignVersion,
  importDesignCanvasAssetBatch,
  listDesignAssets,
  listDesignVersions,
  publishDesignVersion,
  recoverInterruptedDesignJobs,
  redoDesignCanvas,
  resolveDesignAssetFile,
  resolveDesignVersionFile,
  storeDesignAsset,
  undoDesignCanvas,
  updateDesignJob,
  initializeDesignProject,
  mutateDesignCanvas,
} from "../src/design/design-storage.ts";
import { materializeDesignContext } from "../src/design/design-node-agent.ts";

test("a Design project starts as an empty revisioned canvas and mutations use CAS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-storage-"));
  const projectId = "project-one";
  try {
    const initialized = await initializeDesignProject(dataDir, projectId, 100);
    assert.equal(initialized.revision, 0);
    assert.deepEqual(initialized.nodes, []);
    assert.deepEqual(initialized.viewport, { x: 0, y: 0, zoom: 1 });

    const added = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{
        type: "add-node",
        node: {
          id: "node-page",
          kind: "page",
          name: "Home",
          geometry: { x: 120, y: 80, width: 640, height: 480 },
        },
      }],
    }, 110);
    assert.equal(added.revision, 1);
    assert.equal(added.nodes[0]?.state, "empty");
    assert.equal(added.nodes[0]?.name, "Home");

    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: 0,
        intents: [{ type: "remove-node", nodeId: "node-page" }],
      }),
      DesignRevisionConflictError,
    );

    const reloaded = await getDesignCanvas(dataDir, projectId);
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.nodes[0]?.id, "node-page");
    const projectJson = JSON.parse(await readFile(join(dataDir, "projects", projectId, "design", "project.json"), "utf8"));
    assert.equal(projectJson.schemaVersion, 1);
    assert.equal(projectJson.nodes[0].id, "node-page");
    await assert.rejects(readFile(join(dataDir, "projects", projectId, "design", "nodes", "node-page", "node.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design storage never lazily converts a legacy Project folder into an empty canvas", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-no-legacy-"));
  const projectId = "legacy-standard";
  try {
    await mkdir(join(dataDir, "projects", projectId), { recursive: true });
    await writeFile(join(dataDir, "projects", projectId, "package.json"), "{}\n");
    await assert.rejects(getDesignCanvas(dataDir, projectId), /not a Design Canvas project/i);
    await assert.rejects(readFile(join(dataDir, "projects", projectId, "design", "project.json")));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("restart recovery durably cancels interrupted Jobs without rolling back a good Node head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-recovery-"));
  const projectId = "project-recovery";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const good = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Good head</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const created = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      nodeId: "node-page",
    });
    await updateDesignJob(dataDir, projectId, created.job.id, { status: "running" });

    const recovered = await recoverInterruptedDesignJobs(dataDir, projectId, 900);
    assert.deepEqual(recovered.map((job) => job.id), [created.job.id]);
    const job = await getDesignJob(dataDir, projectId, created.job.id);
    assert.equal(job.status, "cancelled");
    assert.match(job.error ?? "", /restart|interrupted/i);
    const node = (await getDesignCanvas(dataDir, projectId)).nodes[0]!;
    assert.equal(node.currentVersionId, good.manifest.id);
    assert.equal(node.selectedVersionId, good.manifest.id);
    assert.equal(node.activeJobId, null);
    assert.equal(node.state, "cancelled");

    assert.deepEqual(await recoverInterruptedDesignJobs(dataDir, projectId, 901), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an exhausted idempotency receipt budget rejects before creating orphan Job files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-receipt-limit-"));
  const projectId = "project-receipt-limit";
  try {
    await initializeDesignProject(dataDir, projectId);
    const designDir = join(dataDir, "projects", projectId, "design");
    const projectPath = join(designDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.turnReceipts = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [
      `main-agent:main:receipt-${index}`,
      { jobId: `job-${String(index).padStart(36, "0")}`, kind: "main-agent", nodeId: null, createdAt: index },
    ]));
    await writeFile(projectPath, `${JSON.stringify(project)}\n`);

    await assert.rejects(createDesignJob(dataDir, projectId, {
      kind: "main-agent",
      idempotencyKey: "one-too-many",
    }), /receipt limit/i);
    assert.deepEqual(await readdir(join(designDir, "jobs")), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("project.json rejects identity and bounded Node-schema tampering", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-corrupt-project-"));
  const projectId = "project-corrupt";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const projectPath = join(dataDir, "projects", projectId, "design", "project.json");
    const original = JSON.parse(await readFile(projectPath, "utf8"));
    await writeFile(projectPath, `${JSON.stringify({ ...original, projectId: "another-project" })}\n`);
    await assert.rejects(getDesignCanvas(dataDir, projectId), /schema|identity|corrupt/i);

    const invalidNode = structuredClone(original);
    invalidNode.nodes[0].geometry.width = Number.POSITIVE_INFINITY;
    await writeFile(projectPath, `${JSON.stringify(invalidNode)}\n`);
    await assert.rejects(getDesignCanvas(dataDir, projectId), /invalid Node|corrupt/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("viewport-only saves do not consume undo history or clear redo", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-viewport-history-"));
  const projectId = "project-viewport-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { geometry: { x: 300 } } }],
    });
    const undone = await undoDesignCanvas(dataDir, projectId, 2);
    assert.equal(undone.undoDepth, 1);
    assert.equal(undone.redoDepth, 1);
    const viewportSaved = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: undone.revision,
      intents: [{ type: "set-viewport", viewport: { x: 90, y: -45, zoom: 1.4 } }],
    });
    assert.equal(viewportSaved.undoDepth, 1);
    assert.equal(viewportSaved.redoDepth, 1);
    const redone = await redoDesignCanvas(dataDir, projectId, viewportSaved.revision);
    assert.deepEqual(redone.viewport, { x: 90, y: -45, zoom: 1.4 });
    assert.equal(redone.nodes[0]?.geometry.x, 300);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("frozen context rejects a payload set beyond the global byte budget", () => {
  assert.throws(() => assertDesignFrozenContextBudget({
    schemaVersion: 1,
    projectId: "project-budget",
    canvasRevision: 1,
    targetNodeId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-large",
      kind: "file",
      name: "Large",
      state: "ready",
      geometry: { x: 0, y: 0, width: 320, height: 180 },
      selectedVersionId: null,
      selectedVersionChecksum: null,
      selectedVersionBytes: null,
      selectedVersionPath: null,
      selectedVersionAssetPins: [],
      assetId: `asset-${"a".repeat(32)}`,
      assetChecksum: "a".repeat(64),
      assetBytes: MAX_DESIGN_CONTEXT_BYTES + 1,
      assetPath: `.context/assets/asset-${"a".repeat(32)}/original.bin`,
      assetBundleFiles: [],
    }],
  }), /bounded payload budget/i);
});

test("removing a Node with an active scoped Agent Job is rejected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-active-remove-"));
  const projectId = "project-active-remove";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await createDesignJob(dataDir, projectId, { kind: "node-generation", nodeId: "node-page" });
    const current = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: current.revision,
      intents: [{ type: "remove-node", nodeId: "node-page" }],
    }), /cancel.*active|active.*Job/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undo and redo refuse to remove or revive an active-Job Node without consuming history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-active-history-"));
  const projectId = "project-active-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const active = await createDesignJob(dataDir, projectId, {
      kind: "node-generation",
      nodeId: "node-page",
    });
    const beforeUndo = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(
      undoDesignCanvas(dataDir, projectId, beforeUndo.revision),
      /Cancel active scoped Agent Jobs/i,
    );
    const afterUndo = await getDesignCanvas(dataDir, projectId);
    assert.equal(afterUndo.revision, beforeUndo.revision);
    assert.equal(afterUndo.undoDepth, beforeUndo.undoDepth);
    assert.equal(afterUndo.redoDepth, beforeUndo.redoDepth);
    assert.equal(afterUndo.nodes[0]?.activeJobId, active.job.id);

    await updateDesignJob(dataDir, projectId, active.job.id, { status: "cancelled" });
    const projectPath = join(dataDir, "projects", projectId, "design", "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.nodes[0].activeJobId = null;
    project.nodes[0].state = "cancelled";
    await writeFile(projectPath, `${JSON.stringify(project)}\n`);
    const removed = await undoDesignCanvas(dataDir, projectId, project.revision);
    assert.deepEqual(removed.nodes, []);

    const withStaleRedo = JSON.parse(await readFile(projectPath, "utf8"));
    withStaleRedo.redo.at(-1).nodes[0].activeJobId = active.job.id;
    await writeFile(projectPath, `${JSON.stringify(withStaleRedo)}\n`);
    const beforeRedo = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(
      redoDesignCanvas(dataDir, projectId, beforeRedo.revision),
      /Cancel active scoped Agent Jobs/i,
    );
    const afterRedo = await getDesignCanvas(dataDir, projectId);
    assert.equal(afterRedo.revision, beforeRedo.revision);
    assert.equal(afterRedo.undoDepth, beforeRedo.undoDepth);
    assert.equal(afterRedo.redoDepth, beforeRedo.redoDepth);
    assert.deepEqual(afterRedo.nodes, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a removed Node identity cannot be explicitly reused for a new Node", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-retired-node-"));
  const projectId = "project-retired-node";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "remove-node", nodeId: "node-page" }],
    });
    await assert.rejects(mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 2,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "component" } }],
    }), /retired|already exists/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undoing a move after a newer publish preserves the immutable Node head", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-head-history-"));
  const projectId = "project-head-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v1</body></html>",
      contextHash: "a".repeat(64), canvasRevision: 1, expectedHeadVersionId: null,
      jobId: null, runnerId: "fixture", model: null,
    });
    const beforeMove = await getDesignCanvas(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: beforeMove.revision,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { geometry: { x: 600 } } }],
    });
    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v2</body></html>",
      contextHash: "b".repeat(64), canvasRevision: beforeMove.revision + 1,
      expectedHeadVersionId: first.manifest.id, jobId: null, runnerId: "fixture", model: null,
    });
    const undone = await undoDesignCanvas(dataDir, projectId, (await getDesignCanvas(dataDir, projectId)).revision);
    assert.equal(undone.nodes[0]?.geometry.x, 0);
    assert.equal(undone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.selectedVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.versionCount, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ordinary selected-Version changes remain undoable when the generation head is unchanged", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-version-selection-history-"));
  const projectId = "project-version-selection-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v1</body></html>",
      contextHash: "a".repeat(64), canvasRevision: 1, expectedHeadVersionId: null,
      jobId: null, runnerId: "fixture", model: null,
    });
    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>v2</body></html>",
      contextHash: "b".repeat(64), canvasRevision: 2, expectedHeadVersionId: first.manifest.id,
      jobId: null, runnerId: "fixture", model: null,
    });
    const beforeSelection = await getDesignCanvas(dataDir, projectId);
    const selectedOld = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: beforeSelection.revision,
      intents: [{ type: "update-node", nodeId: "node-page", patch: { selectedVersionId: first.manifest.id } }],
    });
    assert.equal(selectedOld.nodes[0]?.selectedVersionId, first.manifest.id);

    const undone = await undoDesignCanvas(dataDir, projectId, selectedOld.revision);
    assert.equal(undone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(undone.nodes[0]?.selectedVersionId, second.manifest.id);
    const redone = await redoDesignCanvas(dataDir, projectId, undone.revision);
    assert.equal(redone.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(redone.nodes[0]?.selectedVersionId, first.manifest.id);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("undo and redo restore ordinary canvas snapshots behind the same revision CAS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-history-"));
  const projectId = "project-history";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-card", kind: "component" } }],
    });
    const moved = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 1,
      intents: [{ type: "update-node", nodeId: "node-card", patch: { geometry: { x: 800, y: 400 } } }],
    });
    assert.equal(moved.nodes[0]?.geometry.x, 800);

    const undone = await undoDesignCanvas(dataDir, projectId, 2);
    assert.equal(undone.revision, 3);
    assert.equal(undone.nodes[0]?.geometry.x, 0);
    assert.equal(undone.redoDepth, 1);

    const redone = await redoDesignCanvas(dataDir, projectId, 3);
    assert.equal(redone.revision, 4);
    assert.equal(redone.nodes[0]?.geometry.x, 800);
    await assert.rejects(undoDesignCanvas(dataDir, projectId, 3), DesignRevisionConflictError);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("single-HTML Node versions publish immutably and late head-CAS results become superseded", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-versions-"));
  const projectId = "project-versions";
  try {
    await initializeDesignProject(dataDir, projectId);
    const asset = await storeDesignAsset(dataDir, projectId, {
      name: "photo.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("photo bytes"),
      ]).toString("base64"),
    });
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-home", kind: "page", name: "Home" } }],
    });

    const first = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: `<!doctype html><html><head><style>body{margin:0}</style></head><body><img src="dezin-asset://${asset.id}"><script>document.body.dataset.ready='yes'</script></body></html>`,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: "job-first",
      runnerId: "fake",
      model: null,
    }, 300);
    assert.equal(first.manifest.publicationStatus, "published");
    assert.deepEqual(first.manifest.assetPins, [{ assetId: asset.id, checksum: asset.checksum }]);
    const firstFile = await resolveDesignVersionFile(dataDir, projectId, "node-home", first.manifest.id, "index.html");
    const servedHtml = await readFile(firstFile.path, "utf8");
    assert.match(servedHtml, new RegExp(`versionId=${first.manifest.id}`));
    assert.match(servedHtml, new RegExp(`checksum=${asset.checksum}`));

    const second = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: "<!doctype html><html><head><style>body{color:blue}</style></head><body>second</body></html>",
      contextHash: "b".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: first.manifest.id,
      jobId: "job-second",
      runnerId: "fake",
      model: null,
    });
    const late = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: "<!doctype html><html><head><style>body{color:red}</style></head><body>late</body></html>",
      contextHash: "c".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: first.manifest.id,
      jobId: "job-late",
      runnerId: "fake",
      model: null,
    });
    assert.equal(late.manifest.publicationStatus, "superseded");
    const canvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(canvas.nodes[0]?.currentVersionId, second.manifest.id);
    assert.equal(canvas.nodes[0]?.selectedVersionId, second.manifest.id);
    assert.equal((await listDesignVersions(dataDir, projectId, "node-home")).length, 3);
    assert.equal((await getDesignVersion(dataDir, projectId, "node-home", late.manifest.id)).publicationStatus, "superseded");

    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><script>window.top.location='https://evil.example'</script></body></html>",
        contextHash: "d".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: "job-unsafe",
        runnerId: "fake",
        model: null,
      }),
      /parent|top|navigation/i,
    );
    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><img src=\"/api/settings\"></body></html>",
        contextHash: "f".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: "job-self-probe",
        runnerId: "fake",
        model: null,
      }),
      /unpinned|external URL/i,
    );
    await assert.rejects(
      publishDesignVersion(dataDir, projectId, {
        nodeId: "node-home",
        html: "<!doctype html><html><head></head><body><img srcset=\"https://evil.example/a.png 1x, https://evil.example/b.png 2x\"></body></html>",
        contextHash: "f".repeat(64),
        canvasRevision: 1,
        expectedHeadVersionId: second.manifest.id,
        jobId: "job-srcset",
        runnerId: "fake",
        model: null,
      }),
      /responsive-image|external/i,
    );
    assert.equal((await getDesignCanvas(dataDir, projectId)).nodes[0]?.currentVersionId, second.manifest.id);

    const selectedOld = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: (await getDesignCanvas(dataDir, projectId)).revision,
      intents: [{ type: "update-node", nodeId: "node-home", patch: { selectedVersionId: first.manifest.id } }],
    });
    const third = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-home",
      html: "<!doctype html><html><head><style>body{color:green}</style></head><body>third</body></html>",
      contextHash: "e".repeat(64),
      canvasRevision: selectedOld.revision,
      expectedHeadVersionId: second.manifest.id,
      jobId: "job-third",
      runnerId: "fake",
      model: null,
    });
    const selectedCanvas = await getDesignCanvas(dataDir, projectId);
    assert.equal(selectedCanvas.nodes[0]?.currentVersionId, third.manifest.id);
    assert.equal(selectedCanvas.nodes[0]?.selectedVersionId, first.manifest.id);

    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: selectedCanvas.revision,
        intents: [{ type: "update-node", nodeId: "node-home", patch: { selectedVersionId: "version-missing" } }],
      }),
      /unavailable|missing/i,
    );

    const undoneAfterPublish = await undoDesignCanvas(
      dataDir,
      projectId,
      (await getDesignCanvas(dataDir, projectId)).revision,
    );
    assert.equal(undoneAfterPublish.nodes[0]?.currentVersionId, third.manifest.id);
    assert.equal(
      (await resolveDesignVersionFile(dataDir, projectId, "node-home", third.manifest.id, "index.html")).manifest.id,
      third.manifest.id,
    );

    await writeFile(firstFile.path, "<!doctype html><html><head></head><body>tampered</body></html>");
    await assert.rejects(
      resolveDesignVersionFile(dataDir, projectId, "node-home", first.manifest.id, "index.html"),
      /checksum|invalid/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Design assets are project-owned, content-addressed, and can ingest an existing safe ref", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-assets-"));
  const projectId = "project-assets";
  try {
    await initializeDesignProject(dataDir, projectId);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("a stable image payload"),
    ]);
    const first = await storeDesignAsset(dataDir, projectId, {
      name: "hero image.png",
      mimeType: "image/png",
      base64: bytes.toString("base64"),
    }, 200);
    assert.match(first.id, /^asset-[a-f0-9]{32}$/);
    assert.equal(first.bytes, bytes.length);

    const refs = join(dataDir, "projects", projectId, ".refs");
    await mkdir(refs, { recursive: true });
    await writeFile(join(refs, "hero.png"), bytes);
    const second = await storeDesignAsset(dataDir, projectId, {
      name: "hero image.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/hero.png",
    });
    assert.equal(second.id, first.id);

    const served = await resolveDesignAssetFile(dataDir, projectId, first.id, first.fileName);
    assert.deepEqual(await readFile(served.path), bytes);
    assert.equal(served.manifest.checksum, first.checksum);

    const beforeCanvas = await getDesignCanvas(dataDir, projectId);
    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: beforeCanvas.revision,
        intents: [{ type: "add-node", node: { id: "bad-video", kind: "video", assetId: first.id } }],
      }),
      /mimeType.*kind/i,
    );
    await assert.rejects(
      mutateDesignCanvas(dataDir, projectId, {
        expectedRevision: beforeCanvas.revision,
        intents: [{ type: "add-node", node: { id: "missing-image", kind: "image", assetId: "asset-00000000000000000000000000000000" } }],
      }),
      /unavailable|missing/i,
    );

    await assert.rejects(
      storeDesignAsset(dataDir, projectId, {
        name: "escape.png",
        mimeType: "image/png",
        uploadedFileId: ".refs/../escape.png",
      }),
      /uploadedFileId/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Asset batches atomically bind material Nodes, roll back failures, and recover crash WAL state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-asset-batch-"));
  const projectId = "project-asset-batch";
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("bounded batch image"),
  ]);
  try {
    await initializeDesignProject(dataDir, projectId);
    const existing = await storeDesignAsset(dataDir, projectId, {
      name: "existing.png",
      mimeType: "image/png",
      base64: png.toString("base64"),
    });

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "new-before-failure.png", mimeType: "image/png", base64: png.toString("base64") },
          node: { id: "node-new-before-failure", kind: "image" },
        },
        {
          asset: { name: "invalid.png", mimeType: "image/png", base64: "not-canonical-base64" },
          node: { id: "node-invalid", kind: "image" },
        },
      ],
    }), /base64/i);
    assert.equal((await getDesignCanvas(dataDir, projectId)).revision, 0);
    assert.deepEqual((await getDesignCanvas(dataDir, projectId)).nodes, []);
    assert.deepEqual((await listDesignAssets(dataDir, projectId)).map((asset) => asset.id), [existing.id]);

    const imported = await importDesignCanvasAssetBatch(dataDir, projectId, {
      expectedRevision: 0,
      items: [
        {
          asset: { name: "hero.png", mimeType: "image/png", base64: png.toString("base64") },
          node: { id: "node-hero", kind: "image", name: "Hero", geometry: { x: 20, y: 40 } },
        },
        {
          asset: { name: "detail.png", mimeType: "image/png", base64: png.toString("base64") },
          node: { id: "node-detail", kind: "image", name: "Detail", geometry: { x: 420, y: 40 } },
        },
      ],
    }, 500);
    assert.equal(imported.revision, 1);
    assert.equal(imported.undoDepth, 1);
    assert.deepEqual(imported.nodes.map((node) => ({ id: node.id, state: node.state })), [
      { id: "node-hero", state: "ready" },
      { id: "node-detail", state: "ready" },
    ]);
    assert.equal((await listDesignAssets(dataDir, projectId)).length, 3);

    const orphan = await storeDesignAsset(dataDir, projectId, {
      name: "crash-orphan.png",
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    const transactionRoot = join(
      dataDir,
      "projects",
      projectId,
      "design",
      "assets",
      ".transactions",
      "import-crash-test",
    );
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(transactionRoot, "transaction.json"), `${JSON.stringify({
      schemaVersion: 1,
      expectedRevision: 1,
      nextRevision: 2,
      createdAssetIds: [orphan.id],
      bindings: [{ nodeId: "node-never-committed", assetId: orphan.id }],
    })}\n`);

    const recovered = await getDesignCanvas(dataDir, projectId);
    assert.equal(recovered.revision, 1);
    assert.ok(!(await listDesignAssets(dataDir, projectId)).some((asset) => asset.id === orphan.id));
    await assert.rejects(readFile(join(transactionRoot, "transaction.json")), /ENOENT/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Asset batch byte limits include every bundled byte copied from a cross-project Version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-asset-batch-bundle-budget-"));
  const sourceProjectId = "project-bundle-budget-source";
  const targetProjectId = "project-bundle-budget-target";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const largePng = Buffer.alloc(MAX_DESIGN_ASSET_BYTES);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largePng);
    const refs = join(dataDir, "projects", sourceProjectId, ".refs");
    await mkdir(refs, { recursive: true });
    await Promise.all([
      writeFile(join(refs, "first-large.png"), largePng),
      writeFile(join(refs, "second-large.png"), largePng),
    ]);
    const first = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "first-large.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/first-large.png",
    });
    const second = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "second-large.png",
      mimeType: "image/png",
      uploadedFileId: ".refs/second-large.png",
    });
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: `<!doctype html><html><head></head><body><img src="dezin-asset://${first.id}"><img src="dezin-asset://${second.id}"></body></html>`,
      contextHash: "b".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });

    await assert.rejects(importDesignCanvasAssetBatch(dataDir, targetProjectId, {
      expectedRevision: 0,
      items: [{
        asset: {
          name: "Oversized copied Version",
          sourceVersion: {
            projectId: sourceProjectId,
            nodeId: "node-source",
            versionId: version.manifest.id,
          },
        },
        node: { id: "node-import", kind: "document" },
      }],
    }), /batch exceeds its bounded size/i);

    const target = await getDesignCanvas(dataDir, targetProjectId);
    assert.equal(target.revision, 0);
    assert.deepEqual(target.nodes, []);
    assert.deepEqual(await listDesignAssets(dataDir, targetProjectId), []);
    await assert.rejects(
      readdir(join(dataDir, "projects", targetProjectId, "design", "assets", ".transactions")),
      /ENOENT/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an exact cross-project Design Version is checksum-verified and byte-copied as an HTML Asset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-source-version-"));
  const sourceProjectId = "project-source";
  const targetProjectId = "project-target";
  try {
    await initializeDesignProject(dataDir, sourceProjectId);
    await initializeDesignProject(dataDir, targetProjectId);
    await mutateDesignCanvas(dataDir, sourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const sourceImage = await storeDesignAsset(dataDir, sourceProjectId, {
      name: "source-context.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("source pinned image"),
      ]).toString("base64"),
    });
    const sourceHtml = `<!doctype html><html><head></head><body>Exact source HTML<img src="dezin-asset://${sourceImage.id}"></body></html>`;
    const version = await publishDesignVersion(dataDir, sourceProjectId, {
      nodeId: "node-source",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const asset = await storeDesignAsset(dataDir, targetProjectId, {
      name: "Imported exact version",
      sourceVersion: {
        projectId: sourceProjectId,
        nodeId: "node-source",
        versionId: version.manifest.id,
      },
    });
    assert.equal(asset.mimeType, "text/html");
    assert.equal(asset.fileName, "original.html");
    assert.equal(asset.sourceVersion?.projectId, sourceProjectId);
    assert.equal(asset.sourceVersion?.nodeId, "node-source");
    assert.equal(asset.sourceVersion?.versionId, version.manifest.id);
    assert.equal(asset.sourceVersion?.checksum, version.manifest.checksum);
    assert.deepEqual(asset.sourceVersion?.assetPins.map((pin) => ({ assetId: pin.assetId, checksum: pin.checksum })), [{
      assetId: sourceImage.id,
      checksum: sourceImage.checksum,
    }]);
    assert.ok(asset.bundleFiles.some((file) => file.path.includes(sourceImage.id) && file.checksum === sourceImage.checksum));
    const copied = await resolveDesignAssetFile(dataDir, targetProjectId, asset.id, asset.fileName);
    const copiedHtml = await readFile(copied.path, "utf8");
    assert.match(copiedHtml, /Exact source HTML/);
    assert.match(copiedHtml, new RegExp(`bundle/assets/${sourceImage.id}/`));
    assert.doesNotMatch(copiedHtml, new RegExp(`/api/projects/${sourceProjectId}/`));

    const alternateSourceProjectId = "project-source-alternate";
    await initializeDesignProject(dataDir, alternateSourceProjectId);
    await mutateDesignCanvas(dataDir, alternateSourceProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-source", kind: "page" } }],
    });
    const alternateSourceImage = await storeDesignAsset(dataDir, alternateSourceProjectId, {
      name: "source-context.png",
      mimeType: "image/png",
      base64: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("source pinned image"),
      ]).toString("base64"),
    });
    assert.equal(alternateSourceImage.id, sourceImage.id);
    const alternateVersion = await publishDesignVersion(dataDir, alternateSourceProjectId, {
      nodeId: "node-source",
      html: sourceHtml,
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const alternateAsset = await storeDesignAsset(dataDir, targetProjectId, {
      name: "Imported exact version",
      sourceVersion: {
        projectId: alternateSourceProjectId,
        nodeId: "node-source",
        versionId: alternateVersion.manifest.id,
      },
    });
    assert.equal(alternateAsset.checksum, asset.checksum);
    assert.notEqual(alternateAsset.id, asset.id);

    await assert.rejects(storeDesignAsset(dataDir, targetProjectId, {
      name: "Missing source",
      sourceVersion: { projectId: sourceProjectId, nodeId: "node-foreign", versionId: version.manifest.id },
    }), /unavailable|missing/i);

    const sourceFile = await resolveDesignVersionFile(
      dataDir,
      sourceProjectId,
      "node-source",
      version.manifest.id,
      "index.html",
    );
    await writeFile(sourceFile.path, "<!doctype html><html><head></head><body>Tampered</body></html>");
    await assert.rejects(storeDesignAsset(dataDir, targetProjectId, {
      name: "Tampered source",
      sourceVersion: { projectId: sourceProjectId, nodeId: "node-source", versionId: version.manifest.id },
    }), /checksum|invalid/i);

    // Restore the immutable canonical bytes before proving the target bundle no longer depends on the source Project.
    const canonicalSource = sourceHtml.replace(
      `dezin-asset://${sourceImage.id}`,
      `/api/projects/${sourceProjectId}/design-canvas/assets/${sourceImage.id}/${sourceImage.fileName}?nodeId=node-source&versionId=${version.manifest.id}&checksum=${sourceImage.checksum}`,
    );
    await writeFile(sourceFile.path, canonicalSource);
    await mutateDesignCanvas(dataDir, targetProjectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-import", kind: "document", assetId: asset.id } }],
    });
    await rm(join(dataDir, "projects", sourceProjectId, "design"), { recursive: true, force: true });
    const created = await createDesignJob(dataDir, targetProjectId, { kind: "node-analysis", nodeId: "node-import" });
    const context = await getDesignJobContext(dataDir, targetProjectId, created.job.id);
    const stagingDir = join(dataDir, "materialized-import");
    await mkdir(stagingDir, { recursive: true });
    await materializeDesignContext({
      dataDir,
      projectId: targetProjectId,
      targetNodeId: "node-import",
      job: created.job,
      context,
      stagingDir,
      priorityNodeIds: ["node-import"],
    });
    const materialized = JSON.parse(await readFile(join(stagingDir, ".context", "canvas.json"), "utf8"));
    const importedNode = materialized.nodes.find((node: { id: string }) => node.id === "node-import");
    assert.match(await readFile(join(stagingDir, importedNode.assetPath), "utf8"), /Exact source HTML/);
    const bundledImage = importedNode.assetBundleFiles.find((file: { checksum: string }) => file.checksum === sourceImage.checksum);
    assert.ok(bundledImage);
    assert.deepEqual(
      [...(await readFile(join(stagingDir, bundledImage.path))).subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persisted Design Version, Thread, and Job records reject unbounded or unexpected fields", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-record-validation-"));
  const projectId = "project-record-validation";
  try {
    await initializeDesignProject(dataDir, projectId);
    await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [{ type: "add-node", node: { id: "node-page", kind: "page" } }],
    });
    const version = await publishDesignVersion(dataDir, projectId, {
      nodeId: "node-page",
      html: "<!doctype html><html><head></head><body>Valid</body></html>",
      contextHash: "a".repeat(64),
      canvasRevision: 1,
      expectedHeadVersionId: null,
      jobId: null,
      runnerId: "fixture",
      model: null,
    });
    const versionPath = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "versions", version.manifest.id, "manifest.json");
    const validVersion = JSON.parse(await readFile(versionPath, "utf8"));
    await writeFile(versionPath, `${JSON.stringify({ ...validVersion, legacyProposalId: "proposal-old" })}\n`);
    await assert.rejects(getDesignVersion(dataDir, projectId, "node-page", version.manifest.id), /invalid|unexpected|corrupt/i);
    await writeFile(versionPath, `${JSON.stringify({ ...validVersion, assetPins: [{ assetId: "asset-bad", checksum: "bad" }] })}\n`);
    await assert.rejects(getDesignVersion(dataDir, projectId, "node-page", version.manifest.id), /invalid|corrupt/i);
    await writeFile(versionPath, `${JSON.stringify(validVersion)}\n`);

    const thread = await getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" });
    const threadPath = join(dataDir, "projects", projectId, "design", "nodes", "node-page", "agent", "thread.json");
    await writeFile(threadPath, `${JSON.stringify({ ...thread, messages: [{
      id: "message-bad",
      role: "owner",
      content: "x".repeat(256 * 1024 + 1),
      jobId: null,
      createdAt: 1,
      legacy: true,
    }] })}\n`);
    await assert.rejects(getDesignThread(dataDir, projectId, { type: "node", nodeId: "node-page" }), /invalid|unexpected|corrupt/i);

    const created = await createDesignJob(dataDir, projectId, { kind: "node-generation", nodeId: "node-page" });
    const jobPath = join(dataDir, "projects", projectId, "design", "jobs", `${created.job.id}.json`);
    await writeFile(jobPath, `${JSON.stringify({
      ...created.job,
      status: "ready",
      finishedAt: null,
      activity: [{ id: "activity-bad", kind: "shell", text: "x", createdAt: 1, legacy: true }],
    })}\n`);
    await assert.rejects(getDesignJob(dataDir, projectId, created.job.id), /invalid|corrupt/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("document Nodes accept common Office MIME types and identical bytes cannot acquire a second MIME", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-design-office-assets-"));
  const projectId = "project-office";
  try {
    await initializeDesignProject(dataDir, projectId);
    const docx = await storeDesignAsset(dataDir, projectId, {
      name: "brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64: Buffer.from("opaque docx").toString("base64"),
    });
    const pptx = await storeDesignAsset(dataDir, projectId, {
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      base64: Buffer.from("opaque pptx").toString("base64"),
    });
    const added = await mutateDesignCanvas(dataDir, projectId, {
      expectedRevision: 0,
      intents: [
        { type: "add-node", node: { id: "node-docx", kind: "document", assetId: docx.id } },
        { type: "add-node", node: { id: "node-pptx", kind: "document", assetId: pptx.id } },
      ],
    });
    assert.deepEqual(added.nodes.map((node) => node.state), ["ready", "ready"]);

    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("same bytes"),
    ]);
    const opaque = await storeDesignAsset(dataDir, projectId, {
      name: "opaque.bin",
      mimeType: "application/octet-stream",
      base64: pngBytes.toString("base64"),
    });
    const png = await storeDesignAsset(dataDir, projectId, {
      name: "later.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    assert.notEqual(png.id, opaque.id);
    assert.equal(opaque.mimeType, "application/octet-stream");
    assert.equal(png.mimeType, "image/png");

    const renamed = await storeDesignAsset(dataDir, projectId, {
      name: "renamed.png",
      mimeType: "image/png",
      base64: pngBytes.toString("base64"),
    });
    assert.notEqual(renamed.id, png.id);
    assert.equal(renamed.checksum, png.checksum);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
