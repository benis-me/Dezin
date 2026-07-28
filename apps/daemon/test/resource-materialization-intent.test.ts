import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import {
  beginResourceMaterializationPayloadIntent,
  recoverResourceMaterializationPayloadIntents,
  resourceMaterializationPayloadIntentPath,
} from "../src/resource-materialization-intent.ts";

test("startup recovery removes a sealed Resource payload whose database publication was interrupted", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-materialization-intent-orphan-"));
  const databasePath = join(dataDir, "store.sqlite");
  try {
    const store = new Store(databasePath);
    const project = store.createProject({ name: "Interrupted materialization", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const resourceId = randomUUID();
    const revisionId = randomUUID();
    const intent = beginResourceMaterializationPayloadIntent({
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      resourceId,
      revisionId,
      idempotencyKey: "startup-recovery-orphan",
    });
    await sealResourceRevisionPayload({
      storageRoot: dataDir,
      workspaceId: workspace.id,
      resourceId,
      revisionId,
      mimeType: "text/plain",
      bytes: Buffer.from("sealed before the database commit", "utf8"),
    });
    assert.equal(existsSync(join(dataDir, intent.manifestPath)), true);
    assert.equal(existsSync(resourceMaterializationPayloadIntentPath(dataDir, workspace.id, revisionId)), true);
    store.close();

    const reopened = new Store(databasePath);
    const runtimeSupervisor = createRuntimeSupervisor({ store: reopened, dataDir });
    createApp({ store: reopened, dataDir, runtimeSupervisor });
    assert.equal(existsSync(dirname(join(dataDir, intent.manifestPath))), false);
    await runtimeSupervisor.shutdown();
    reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery keeps a committed Resource payload and finalizes only its stale intent", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-materialization-intent-commit-"));
  const databasePath = join(dataDir, "store.sqlite");
  try {
    const store = new Store(databasePath);
    const project = store.createProject({ name: "Committed materialization", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const resourceId = randomUUID();
    const revisionId = randomUUID();
    const nodeId = randomUUID();
    const intent = beginResourceMaterializationPayloadIntent({
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      resourceId,
      revisionId,
      idempotencyKey: "startup-recovery-committed",
    });
    const sealed = await sealResourceRevisionPayload({
      storageRoot: dataDir,
      workspaceId: workspace.id,
      resourceId,
      revisionId,
      mimeType: "text/plain",
      bytes: Buffer.from("committed immutable bytes", "utf8"),
    });
    store.workspace.createPublishedResourceForProject(project.id, {
      resourceId,
      nodeId,
      commandId: randomUUID(),
      kind: "file",
      title: "Committed payload",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: workspace.graphRevision,
      expectedSnapshotId: workspace.activeSnapshotId,
      revision: {
        revisionId,
        parentRevisionId: null,
        manifestPath: sealed.manifestPath,
        summary: "Committed before process termination",
        metadata: { mimeType: sealed.mimeType, byteLength: sealed.byteSize },
        checksum: sealed.manifestChecksum,
        provenance: { payloadChecksum: sealed.payloadChecksum },
      },
      reason: "Commit exact payload before journal finalization",
    });
    store.close();

    const reopened = new Store(databasePath);
    const recovered = recoverResourceMaterializationPayloadIntents({ store: reopened, dataDir });
    assert.deepEqual(recovered, { recovered: 1, finalized: 1, retained: 1 });
    assert.equal(existsSync(resourceMaterializationPayloadIntentPath(dataDir, workspace.id, revisionId)), false);
    assert.equal(existsSync(join(dataDir, intent.manifestPath)), true);
    assert.equal(existsSync(join(dirname(join(dataDir, intent.manifestPath)), "payload.bin")), true);
    reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery removes an invalid partial intent only when no payload could have been sealed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-materialization-intent-partial-"));
  try {
    const store = new Store();
    const workspaceId = randomUUID();
    const revisionId = randomUUID();
    const intentPath = resourceMaterializationPayloadIntentPath(dataDir, workspaceId, revisionId);
    mkdirSync(dirname(intentPath), { recursive: true });
    writeFileSync(intentPath, "{\"protocol\":");

    const recovered = recoverResourceMaterializationPayloadIntents({ store, dataDir });

    assert.deepEqual(recovered, { recovered: 1, finalized: 0, retained: 0 });
    assert.equal(existsSync(dirname(intentPath)), false);
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery retains an invalid intent when any payload file is present", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-materialization-intent-corrupt-sealed-"));
  try {
    const store = new Store();
    const intentPath = resourceMaterializationPayloadIntentPath(dataDir, randomUUID(), randomUUID());
    const revisionDirectory = dirname(intentPath);
    mkdirSync(revisionDirectory, { recursive: true });
    writeFileSync(intentPath, "{\"protocol\":");
    writeFileSync(join(revisionDirectory, "payload.bin"), "possible sealed payload");

    const recovered = recoverResourceMaterializationPayloadIntents({ store, dataDir });

    assert.deepEqual(recovered, { recovered: 0, finalized: 0, retained: 0 });
    assert.equal(existsSync(intentPath), true);
    assert.equal(existsSync(join(revisionDirectory, "payload.bin")), true);
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery never recursively removes an unowned directory disguised as a payload file", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-materialization-intent-unowned-directory-"));
  try {
    const store = new Store();
    const project = store.createProject({ name: "Unowned recovery content", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const revisionId = randomUUID();
    const intent = beginResourceMaterializationPayloadIntent({
      dataDir,
      projectId: project.id,
      workspaceId: workspace.id,
      resourceId: randomUUID(),
      revisionId,
      idempotencyKey: "retain-unowned-directory",
    });
    const revisionDirectory = dirname(join(dataDir, intent.manifestPath));
    const disguisedDirectory = join(revisionDirectory, "payload.bin");
    const sentinel = join(disguisedDirectory, "must-not-be-removed.txt");
    mkdirSync(disguisedDirectory);
    writeFileSync(sentinel, "unowned content");

    const recovered = recoverResourceMaterializationPayloadIntents({ store, dataDir });

    assert.deepEqual(recovered, { recovered: 0, finalized: 0, retained: 0 });
    assert.equal(existsSync(resourceMaterializationPayloadIntentPath(dataDir, workspace.id, revisionId)), true);
    assert.equal(existsSync(sentinel), true);
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
