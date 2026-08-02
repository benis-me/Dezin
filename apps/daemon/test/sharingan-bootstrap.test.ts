import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import {
  SharinganBootstrapError,
  createSharinganBootstrapService,
  type SharinganBootstrapCapturePort,
} from "../src/sharingan-bootstrap.ts";
import { semanticSharinganCaptureFiles } from "./support/sharingan-capture-fixture.ts";

const TURN_ID = "turn-11111111-1111-4111-8111-111111111111";
const SOURCE_URL = "https://example.com/";
const NEVER = new AbortController().signal;

function capturePort(
  run: (attempt: number) => void | Promise<void> = () => {},
): SharinganBootstrapCapturePort & { calls: number } {
  return {
    calls: 0,
    async capture(request) {
      this.calls += 1;
      await run(this.calls);
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
  };
}

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "dezin-sharingan-bootstrap-"));
  const store = new Store(join(dataDir, "store.sqlite"));
  const project = store.createProject({
    name: "Captured source",
    mode: "standard",
    sharingan: true,
    sourceUrl: SOURCE_URL,
  });
  const initial = store.workspace.ensureSharinganWorkspaceFoundation(project.id);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, project, initial };
}

test("Sharingan bootstrap publishes one immutable exact capture and reload reuses it", async (t) => {
  const f = await fixture(t);
  const capture = capturePort();
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
    now: () => 100,
  });
  await service.register(f.project.id, TURN_ID);

  const ready = await service.ensure(f.project.id, NEVER);
  assert.equal(capture.calls, 1);
  assert.equal(ready.initialTurn?.turnId, TURN_ID);
  assert.equal(ready.initialTurn?.graphRevision, ready.readyGraphRevision - 1);
  assert.notEqual(ready.initialTurn?.snapshotId, ready.readySnapshotId);
  assert.equal(f.store.workspace.listResources(f.project.id).length, 1);
  assert.equal(
    f.store.workspace.getWorkspace(f.project.id)!.activeSnapshotId,
    ready.readySnapshotId,
  );
  assert.equal(
    f.store.workspace.getWorkspace(f.project.id)!.graphRevision,
    ready.readyGraphRevision,
  );
  assert.equal(
    f.store.workspace.getWorkspace(f.project.id)
      && f.store.workspace.listSnapshots(f.project.id)
        .find((snapshot) => snapshot.id === ready.readySnapshotId)!
        .resourceRevisions[ready.resourceId],
    ready.revisionId,
  );
  const tables = new Set((f.store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const retired of ["workspace_artifacts", "artifact_tracks", "variants", "runs"]) {
    assert.equal(tables.has(retired), false, `${retired} must be physically absent`);
  }

  const noRecapture = capturePort(() => {
    throw new Error("reload must not recapture");
  });
  const reloaded = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: noRecapture,
    now: () => 200,
  });
  assert.deepEqual(await reloaded.ensure(f.project.id, NEVER), ready);
  assert.equal(noRecapture.calls, 0);
  assert.equal((await reloaded.getState(f.project.id))?.status, "ready");
});

test("Sharingan bootstrap fails closed when the ready hint disagrees with its immutable publication anchor", async (t) => {
  const f = await fixture(t);
  const capture = capturePort();
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
  });
  await service.register(f.project.id, TURN_ID);
  const ready = await service.ensure(f.project.id, NEVER);

  const statePath = join(f.dataDir, "sharingan-bootstrap", `${f.project.id}.json`);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  await writeFile(statePath, JSON.stringify({
    ...persisted,
    readyGraphRevision: ready.readyGraphRevision + 1,
  }));

  const noRecapture = capturePort(() => {
    throw new Error("an invalid state anchor must fail before recapture");
  });
  const reloaded = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: noRecapture,
  });
  await assert.rejects(
    reloaded.ensure(f.project.id, NEVER),
    (error: unknown) => error instanceof SharinganBootstrapError
      && error.code === "SHARINGAN_BOOTSTRAP_STATE_ANCHOR_INVALID"
      && error.retryable === false,
  );
  assert.equal(noRecapture.calls, 0);
});

test("a failed post-publication ready hint write recovers from the authoritative Snapshot", async (t) => {
  const f = await fixture(t);
  const capture = capturePort();
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
    beforeStateWrite(state) {
      if (state.status === "ready") throw new Error("injected ready hint write failure");
    },
  });
  await service.register(f.project.id, TURN_ID);
  const committed = await service.ensure(f.project.id, NEVER);
  assert.equal(committed.status, "ready");
  assert.equal((await service.getState(f.project.id))?.status, "capturing");

  const recovered = await service.ensure(f.project.id, NEVER);
  assert.deepEqual(recovered, committed);
  assert.equal(capture.calls, 1);
  assert.equal((await service.getState(f.project.id))?.status, "capturing");
});

test("Sharingan bootstrap persists failure and retries the same empty Resource after reload", async (t) => {
  const f = await fixture(t);
  const failedCapture = capturePort(() => {
    throw new Error("browser login is temporarily unavailable");
  });
  const failed = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: failedCapture,
    now: () => 100,
  });
  await failed.register(f.project.id, TURN_ID);
  await assert.rejects(
    failed.ensure(f.project.id, NEVER),
    (error: unknown) => error instanceof SharinganBootstrapError
      && error.code === "SHARINGAN_BOOTSTRAP_CAPTURE_FAILED"
      && error.state?.status === "failed"
      && error.state.attempt === 1,
  );
  const [emptyCapture] = f.store.workspace.listResources(f.project.id);
  assert.equal(emptyCapture?.kind, "sharingan-capture");
  assert.equal(emptyCapture?.headRevisionId, null);

  const recoveredCapture = capturePort();
  const recovered = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: recoveredCapture,
    now: () => 200,
  });
  const ready = await recovered.ensure(f.project.id, NEVER);
  assert.equal(recoveredCapture.calls, 1);
  assert.equal(ready.resourceId, emptyCapture!.id);
  const state = await recovered.getState(f.project.id);
  assert.equal(state?.status, "ready");
  assert.equal(state?.attempt, 2);
});

test("Sharingan bootstrap recovers a committed candidate without recapturing", async (t) => {
  const f = await fixture(t);
  const capture = capturePort();
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
  });
  await service.register(f.project.id, TURN_ID);

  const workspaceStore = f.store.workspace as typeof f.store.workspace & {
    publishResourceRevisionForProject: typeof f.store.workspace.publishResourceRevisionForProject;
  };
  const publish = workspaceStore.publishResourceRevisionForProject.bind(workspaceStore);
  let interrupted = true;
  workspaceStore.publishResourceRevisionForProject = ((...args: Parameters<typeof publish>) => {
    if (interrupted) {
      interrupted = false;
      throw new Error("process stopped after immutable candidate commit");
    }
    return publish(...args);
  }) as typeof workspaceStore.publishResourceRevisionForProject;
  await assert.rejects(service.ensure(f.project.id, NEVER), SharinganBootstrapError);
  workspaceStore.publishResourceRevisionForProject = publish;
  assert.equal(capture.calls, 1);
  const [resource] = f.store.workspace.listResources(f.project.id);
  const [candidate] = f.store.workspace.listResourceRevisions(f.project.id, resource!.id);
  assert.equal(resource!.headRevisionId, null);
  assert.ok(candidate);
  assert.equal(existsSync(join(f.dataDir, candidate!.manifestPath)), true);

  const noRecapture = capturePort(() => {
    throw new Error("candidate recovery must not reopen the browser");
  });
  const recovered = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: noRecapture,
  });
  const ready = await recovered.ensure(f.project.id, NEVER);
  assert.equal(ready.revisionId, candidate!.id);
  assert.equal(noRecapture.calls, 0);
});

test("an aborted HTTP waiter does not cancel the shared daemon capture", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = capturePort(() => gate);
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
  });
  await service.register(f.project.id, TURN_ID);

  const first = new AbortController();
  const abandoned = service.ensure(f.project.id, first.signal);
  const shared = service.ensure(f.project.id, NEVER);
  first.abort(new Error("request disconnected"));
  await assert.rejects(abandoned, /request disconnected/);
  release();
  assert.equal((await shared).status, "ready");
  assert.equal(capture.calls, 1);
});

test("remove waits for a registration state write and cannot leave state for a deleted Project", async (t) => {
  const f = await fixture(t);
  let stateWriteEntered!: () => void;
  let releaseStateWrite!: () => void;
  const entered = new Promise<void>((resolve) => {
    stateWriteEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseStateWrite = resolve;
  });
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture: capturePort(),
    async beforeStateWrite(state) {
      if (state.status !== "pending" || state.attempt !== 0) return;
      stateWriteEntered();
      await gate;
    },
  });

  const registering = service.register(f.project.id, TURN_ID);
  await entered;
  let removalSettled = false;
  const removing = service.remove(f.project.id).then(() => {
    removalSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(removalSettled, false);

  releaseStateWrite();
  await registering;
  await removing;
  assert.equal(await service.getState(f.project.id), null);
  assert.equal(
    existsSync(join(f.dataDir, "sharingan-bootstrap", `${f.project.id}.json`)),
    false,
  );
});

test("deletion cancellation blocks a replacement capture until deletion is rolled back", async (t) => {
  const f = await fixture(t);
  let captureEntered!: () => void;
  let releaseCapture!: () => void;
  const entered = new Promise<void>((resolve) => {
    captureEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const capture = capturePort(async (attempt) => {
    if (attempt !== 1) return;
    captureEntered();
    await gate;
  });
  const service = createSharinganBootstrapService({
    store: f.store,
    dataDir: f.dataDir,
    capture,
  });
  await service.register(f.project.id, TURN_ID);

  const active = service.ensure(f.project.id, NEVER);
  await entered;
  const cancelling = service.cancel(f.project.id);
  releaseCapture();
  await cancelling;
  await assert.rejects(active);

  await assert.rejects(
    service.ensure(f.project.id, NEVER),
    (error: unknown) => error instanceof SharinganBootstrapError
      && error.code === "SHARINGAN_BOOTSTRAP_PROJECT_DELETING"
      && error.retryable === false,
  );
  assert.equal(capture.calls, 1);

  service.resume(f.project.id);
  assert.equal((await service.ensure(f.project.id, NEVER)).status, "ready");
  assert.equal(capture.calls, 2);
});
