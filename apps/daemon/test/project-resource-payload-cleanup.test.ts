import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import { snapshotBytes } from "../src/context/adapters/file.ts";
import {
  beginProjectResourcePayloadCleanup,
  recoverProjectResourcePayloadCleanups,
} from "../src/project-resource-payload-cleanup.ts";
import { resourceRevisionManifestRelativePath } from "../src/resource-revision-payload.ts";
import {
  createSharinganBootstrapService,
  type SharinganBootstrapPort,
} from "../src/sharingan-bootstrap.ts";
import { semanticSharinganCaptureFiles } from "./support/sharingan-capture-fixture.ts";

const SOURCE_URL = "https://example.com/";
const TURN_ID = "turn-22222222-2222-4222-8222-222222222222";
const NEVER = new AbortController().signal;

function bootstrap(store: Store, dataDir: string): SharinganBootstrapPort {
  return createSharinganBootstrapService({
    store,
    dataDir,
    capture: {
      async capture(request) {
        return {
          protocol: "dezin.sharingan-bootstrap-capture.v1",
          exporter: { id: "dezin-sharingan-capture", version: 1 },
          source: {
            requestedUrl: request.sourceUrl,
            finalUrl: new URL("captured", request.sourceUrl).href,
            capturedAt: 10,
          },
          files: semanticSharinganCaptureFiles({
            requestedUrl: request.sourceUrl,
            finalUrl: new URL("captured", request.sourceUrl).href,
          }),
        };
      },
    },
  });
}

async function seededProject(store: Store, dataDir: string) {
  const project = store.createProject({
    name: "Delete all Resource payloads",
    mode: "standard",
    sharingan: true,
    sourceUrl: SOURCE_URL,
  });
  store.workspace.ensureWorkspaceRecord(project.id);
  const sharinganBootstrap = bootstrap(store, dataDir);
  await sharinganBootstrap.register(project.id, TURN_ID);
  const capture = await sharinganBootstrap.ensure(project.id, NEVER);

  const current = store.workspace.getWorkspace(project.id)!;
  const file = store.workspace.createResourceForProject(project.id, {
    kind: "file",
    title: "Home reference",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: current.graphRevision,
    expectedSnapshotId: current.activeSnapshotId,
  });
  const revisionId = randomUUID();
  const snapshot = await snapshotBytes({
    workspaceId: current.id,
    resourceId: file.resource.id,
    revisionId,
    kind: "file",
    workspaceRoot: dataDir,
    snapshotRoot: dataDir,
    source: {
      type: "owned-bytes",
      bytes: Buffer.from("home reference"),
      mimeType: "text/plain",
    },
    provenance: { kind: "test-home-reference" },
    createdAt: 11,
  }, Buffer.from("home reference"), "text/plain");
  store.workspace.createResourceRevisionCandidateForProject(project.id, file.resource.id, {
    revisionId,
    parentRevisionId: null,
    manifestPath: snapshot.manifestPath,
    summary: "Home reference",
    metadata: {
      mimeType: snapshot.mimeType,
      byteLength: snapshot.byteSize,
      payloadChecksum: snapshot.payloadChecksum,
    },
    checksum: snapshot.checksum,
    provenance: snapshot.provenance,
  });
  store.workspace.publishResourceRevisionForProject(project.id, file.resource.id, revisionId, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: store.workspace.getWorkspace(project.id)!.activeSnapshotId,
    reason: "Publish Home reference",
  });
  return {
    project,
    sharinganBootstrap,
    payloadDirectories: [
      dirname(join(dataDir, store.workspace.getResourceRevisionForProject(
        project.id,
        capture.resourceId,
        capture.revisionId,
      )!.manifestPath)),
      dirname(join(dataDir, snapshot.manifestPath)),
    ],
    statePath: join(dataDir, "sharingan-bootstrap", `${project.id}.json`),
  };
}

test("DELETE Project removes Sharingan state and every exact global Resource payload", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-payload-delete-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  const seeded = await seededProject(store, dataDir);
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    sharinganBootstrap: seeded.sharinganBootstrap,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(seeded.payloadDirectories.every(existsSync), true);
    assert.equal(existsSync(seeded.statePath), true);
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${seeded.project.id}`, {
      method: "DELETE",
    });
    assert.equal(response.status, 204, await response.text());
    assert.equal(store.getProject(seeded.project.id), null);
    assert.equal(seeded.payloadDirectories.some(existsSync), false);
    assert.equal(existsSync(seeded.statePath), false);
    const journals = join(dataDir, "project-resource-cleanup");
    assert.deepEqual(existsSync(journals) ? readdirSync(journals) : [], []);
    const missing = await fetch(`http://127.0.0.1:${port}/api/projects/${seeded.project.id}`, {
      method: "DELETE",
    });
    assert.equal(missing.status, 404);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("DELETE waits for an untracked Workspace bootstrap route through the universal project lease", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-route-admission-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  const project = store.createProject({
    name: "Leased workspace bootstrap",
    mode: "standard",
    sharingan: true,
    sourceUrl: SOURCE_URL,
  });
  store.workspace.ensureWorkspaceRecord(project.id);
  let ensureEntered!: () => void;
  let releaseEnsure!: () => void;
  const entered = new Promise<void>((resolve) => {
    ensureEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  const sharinganBootstrap: SharinganBootstrapPort = {
    async register() {
      return {} as never;
    },
    async ensure() {
      ensureEntered();
      await gate;
      return {} as never;
    },
    async getState() {
      return null;
    },
    async cancel() {},
    resume() {},
    async remove() {},
  };
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({ store, dataDir, runtimeSupervisor, sharinganBootstrap });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/projects/${project.id}`;
  try {
    const workspaceResponse = fetch(`${base}/workspace`);
    await entered;
    let deletionSettled = false;
    const deletionResponse = fetch(base, { method: "DELETE" }).then((response) => {
      deletionSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false);
    assert.ok(store.getProject(project.id), "the DB cascade must wait for the outer route lease");

    releaseEnsure();
    assert.equal((await workspaceResponse).status, 200);
    const deleted = await deletionResponse;
    assert.equal(deleted.status, 204, await deleted.text());
    assert.equal(store.getProject(project.id), null);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed delete rolls back its cleanup journal and reopens same-process admission", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-payload-delete-retry-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  const seeded = await seededProject(store, dataDir);
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const releaseProject = runtimeSupervisor.releaseProject.bind(runtimeSupervisor);
  let failBeforeDatabaseDelete = true;
  runtimeSupervisor.releaseProject = async (projectId, options = {}) => {
    if (failBeforeDatabaseDelete) {
      failBeforeDatabaseDelete = false;
      await releaseProject(projectId, {
        ...options,
        async beforeDelete() {
          await options.beforeDelete?.();
          throw new Error("injected failure before Project DB cascade");
        },
      });
      return;
    }
    await releaseProject(projectId, options);
  };
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    sharinganBootstrap: seeded.sharinganBootstrap,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/api/projects/${seeded.project.id}`;
  try {
    const failed = await fetch(endpoint, { method: "DELETE" });
    assert.equal(failed.status, 500);
    assert.ok(store.getProject(seeded.project.id));
    assert.equal(existsSync(seeded.statePath), true);
    assert.equal(seeded.payloadDirectories.every(existsSync), true);
    assert.deepEqual(readdirSync(join(dataDir, "project-resource-cleanup")), []);
    assert.equal(
      (await seeded.sharinganBootstrap.ensure(seeded.project.id, NEVER)).status,
      "ready",
      "a pre-commit deletion failure must reopen bootstrap admission",
    );
    assert.equal(
      await runtimeSupervisor.trackOperation({ projectId: seeded.project.id }, () => "admitted"),
      "admitted",
      "a pre-commit deletion failure must reopen RuntimeSupervisor admission",
    );

    const retried = await fetch(endpoint, { method: "DELETE" });
    assert.equal(retried.status, 204, await retried.text());
    assert.equal(store.getProject(seeded.project.id), null);
    assert.equal(existsSync(seeded.statePath), false);
    assert.equal(seeded.payloadDirectories.some(existsSync), false);
    assert.deepEqual(readdirSync(join(dataDir, "project-resource-cleanup")), []);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("DELETE preflight preserves a Project when a Resource Revision directory contains unowned data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-payload-delete-preflight-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  const seeded = await seededProject(store, dataDir);
  const sentinelPath = join(seeded.payloadDirectories[0]!, "sentinel.txt");
  writeFileSync(sentinelPath, "not owned by Resource payload cleanup\n");
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    sharinganBootstrap: seeded.sharinganBootstrap,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/api/projects/${seeded.project.id}`;
  try {
    const refused = await fetch(endpoint, { method: "DELETE" });
    assert.equal(refused.status, 500);
    assert.ok(store.getProject(seeded.project.id), "preflight must run before the DB cascade");
    assert.equal(existsSync(sentinelPath), true);
    assert.equal(seeded.payloadDirectories.every(existsSync), true);
    assert.equal(existsSync(seeded.statePath), true);
    assert.deepEqual(readdirSync(join(dataDir, "project-resource-cleanup")), []);
    assert.equal(
      (await seeded.sharinganBootstrap.ensure(seeded.project.id, NEVER)).status,
      "ready",
      "a preflight refusal must reopen bootstrap admission",
    );
    assert.equal(
      await runtimeSupervisor.trackOperation({ projectId: seeded.project.id }, () => "admitted"),
      "admitted",
      "a preflight refusal must reopen RuntimeSupervisor admission",
    );
    const conversation = store.createConversation(seeded.project.id, "After refused deletion");
    store.createRun(seeded.project.id, conversation.id);

    rmSync(sentinelPath);
    const retried = await fetch(endpoint, { method: "DELETE" });
    assert.equal(retried.status, 204, await retried.text());
    assert.equal(store.getProject(seeded.project.id), null);
    assert.equal(seeded.payloadDirectories.some(existsSync), false);
    assert.equal(existsSync(seeded.statePath), false);
    assert.deepEqual(readdirSync(join(dataDir, "project-resource-cleanup")), []);
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery completes payload and Sharingan state cleanup after the DB cascade", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-payload-recovery-"));
  const databasePath = join(dataDir, "store.sqlite");
  try {
    const store = new Store(databasePath);
    const seeded = await seededProject(store, dataDir);
    beginProjectResourcePayloadCleanup({
      store,
      dataDir,
      projectId: seeded.project.id,
      createdAt: 20,
    });
    store.deleteProject(seeded.project.id);
    store.close();
    assert.equal(seeded.payloadDirectories.every(existsSync), true);
    assert.equal(existsSync(seeded.statePath), true);

    const reopened = new Store(databasePath);
    assert.deepEqual(recoverProjectResourcePayloadCleanups({ store: reopened, dataDir }), {
      recovered: 1,
      rolledBack: 0,
      completed: 1,
      retained: 0,
    });
    assert.equal(seeded.payloadDirectories.some(existsSync), false);
    assert.equal(existsSync(seeded.statePath), false);
    reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a crash immediately after the DB cascade completes source and payload deletion on restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-delete-commit-recovery-"));
  const databasePath = join(dataDir, "store.sqlite");
  const store = new Store(databasePath);
  const seeded = await seededProject(store, dataDir);
  const sourceDirectory = join(dataDir, "projects", seeded.project.id);
  const evidenceDirectory = join(dataDir, "generation-task-evidence", seeded.project.id);
  const renderAssemblyDirectory = join(dataDir, "render-assemblies", seeded.project.id);
  const sharinganProfileDirectory = join(
    dataDir,
    ".sharingan-profiles",
    createHash("sha256").update(seeded.project.id).digest("hex"),
  );
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(evidenceDirectory, { recursive: true });
  mkdirSync(renderAssemblyDirectory, { recursive: true });
  mkdirSync(sharinganProfileDirectory, { recursive: true });
  writeFileSync(join(sourceDirectory, "source.tsx"), "export default 'must be deleted';\n");
  writeFileSync(join(evidenceDirectory, "receipt.json"), "{}\n");
  writeFileSync(join(renderAssemblyDirectory, "assembly.json"), "{}\n");
  writeFileSync(join(sharinganProfileDirectory, "profile.lock"), "owned\n");
  const runtimeSupervisor = createRuntimeSupervisor({ store, dataDir });
  let storeClosed = false;
  try {
    await assert.rejects(
      runtimeSupervisor.releaseProject(seeded.project.id, {
        beforeDelete() {
          beginProjectResourcePayloadCleanup({
            store,
            dataDir,
            projectId: seeded.project.id,
            createdAt: 30,
          });
        },
        afterDelete() {
          throw new Error("injected process crash after Project DB cascade");
        },
      }),
      /injected process crash/,
    );
    assert.equal(store.getProject(seeded.project.id), null);
    assert.equal(existsSync(sourceDirectory), true, "the exact checkpoint is before directory removal");
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(renderAssemblyDirectory), true);
    assert.equal(existsSync(sharinganProfileDirectory), true);
    assert.equal(seeded.payloadDirectories.every(existsSync), true);
    store.close();
    storeClosed = true;

    const reopened = new Store(databasePath);
    assert.deepEqual(recoverProjectResourcePayloadCleanups({ store: reopened, dataDir }), {
      recovered: 1,
      rolledBack: 0,
      completed: 1,
      retained: 0,
    });
    assert.equal(existsSync(sourceDirectory), false);
    assert.equal(existsSync(evidenceDirectory), false);
    assert.equal(existsSync(renderAssemblyDirectory), false);
    assert.equal(existsSync(sharinganProfileDirectory), false);
    assert.equal(seeded.payloadDirectories.some(existsSync), false);
    assert.equal(existsSync(seeded.statePath), false);
    reopened.close();
  } finally {
    await runtimeSupervisor.shutdown();
    if (!storeClosed) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cleanup journal accepts and boundedly recovers the declared 100k Revision boundary", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-project-cleanup-boundary-"));
  const projectId = "project-cleanup-boundary";
  const workspaceId = "workspace-cleanup-boundary";
  const resourceId = "resource-cleanup-boundary";
  const revisions = Array.from({ length: 100_000 }, (_, index) => {
    const revisionId = `revision-${index.toString().padStart(6, "0")}`;
    return {
      id: revisionId,
      workspaceId,
      resourceId,
      manifestPath: resourceRevisionManifestRelativePath(workspaceId, revisionId),
    };
  });
  const project = { id: projectId, sharingan: false };
  const boundedStore = {
    getProject(id: string) {
      return id === projectId ? project : null;
    },
    listRuns() {
      return [];
    },
    workspace: {
      getWorkspace(id: string) {
        return id === projectId ? { id: workspaceId } : null;
      },
      listResources() {
        return [{ id: resourceId }];
      },
      listResourceRevisions() {
        return revisions;
      },
    },
  } as unknown as Store;
  try {
    const intent = beginProjectResourcePayloadCleanup({
      store: boundedStore,
      dataDir,
      projectId,
      createdAt: 40,
    });
    assert.equal(intent.revisions.length, 100_000);
    assert.deepEqual(recoverProjectResourcePayloadCleanups({
      store: boundedStore,
      dataDir,
    }), {
      recovered: 1,
      rolledBack: 1,
      completed: 0,
      retained: 0,
    });
    assert.deepEqual(readdirSync(join(dataDir, "project-resource-cleanup")), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
