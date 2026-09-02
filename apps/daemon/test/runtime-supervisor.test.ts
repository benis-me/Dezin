import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@dezin/core";
import { RuntimeScopeUnavailableError, RuntimeSupervisor } from "../src/runtime-supervisor.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createSharinganProject(store: Store, name: string) {
  return store.createProject({
    name,
    sharingan: true,
    sourceUrl: `https://${name.toLowerCase()}.example/`,
  });
}

test("RuntimeSupervisor cancels and waits for only the matching Project operations", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstSettled = deferred();
  const secondSettled = deferred();
  let firstSignal: AbortSignal | undefined;
  let secondSignal: AbortSignal | undefined;

  const first = supervisor.trackOperation({ projectId: "project-1" }, async (signal) => {
    firstSignal = signal;
    firstEntered.resolve();
    await firstSettled.promise;
  });
  const second = supervisor.trackOperation({ projectId: "project-2" }, async (signal) => {
    secondSignal = signal;
    secondEntered.resolve();
    await secondSettled.promise;
  });
  await Promise.all([firstEntered.promise, secondEntered.promise]);

  supervisor.cancelOperations({ projectId: "project-1" });
  assert.equal(firstSignal?.aborted, true);
  assert.equal(secondSignal?.aborted, false);

  let waitFinished = false;
  const waiting = supervisor.waitForOperations({ projectId: "project-1" }).then(() => {
    waitFinished = true;
  });
  await Promise.resolve();
  assert.equal(waitFinished, false);
  firstSettled.resolve();
  await Promise.all([first, waiting]);
  assert.equal(waitFinished, true);

  secondSettled.resolve();
  await second;
  await supervisor.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("releaseProject waits for Project work and removes only current Project storage", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = createSharinganProject(store, "Project");
  const otherProject = createSharinganProject(store, "Other");
  const projectFile = join(dataDir, "projects", project.id, "design", "canvas.json");
  const otherFile = join(dataDir, "projects", otherProject.id, "design", "canvas.json");
  for (const path of [projectFile, otherFile]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{}");
  }

  const entered = deferred();
  const settled = deferred();
  let operationSignal: AbortSignal | undefined;
  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    releaseProjectResources: ({ projectId }) => {
      assert.equal(projectId, project.id);
      assert.ok(store.getProject(project.id), "live resources stop before the database commit");
      resourcesReleased = true;
    },
  });
  const operation = supervisor.trackOperation({ projectId: project.id }, async (signal) => {
    operationSignal = signal;
    entered.resolve();
    await settled.promise;
  });
  await entered.promise;

  let released = false;
  const releasing = supervisor.releaseProject(project.id).then(() => { released = true; });
  assert.equal(operationSignal?.aborted, true);
  assert.equal(released, false);
  assert.throws(() => supervisor.assertAdmission({ projectId: project.id }), RuntimeScopeUnavailableError);
  assert.doesNotThrow(() => supervisor.assertAdmission({ projectId: otherProject.id }));

  settled.resolve();
  await Promise.all([operation, releasing]);
  assert.equal(resourcesReleased, true);
  assert.equal(store.getProject(project.id), null);
  assert.equal(existsSync(projectFile), false);
  assert.equal(existsSync(otherFile), true);

  await supervisor.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("releaseProject has one deletion owner and reopens admission after pre-commit failure", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = createSharinganProject(store, "Project");
  const blocked = deferred();
  const continueFailure = deferred();
  let rollbackCalls = 0;
  const supervisor = new RuntimeSupervisor({ dataDir, store });

  const first = supervisor.releaseProject(project.id, {
    async afterBlock() {
      blocked.resolve();
      await continueFailure.promise;
      throw new Error("pre-commit failure");
    },
    onPrecommitFailure() {
      rollbackCalls += 1;
    },
  });
  await blocked.promise;
  await assert.rejects(supervisor.releaseProject(project.id), RuntimeScopeUnavailableError);
  continueFailure.resolve();
  await assert.rejects(first, /pre-commit failure/);

  assert.equal(rollbackCalls, 1);
  assert.ok(store.getProject(project.id));
  assert.equal(await supervisor.trackOperation({ projectId: project.id }, () => "admitted"), "admitted");
  await supervisor.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("releaseProject rejects unsafe Project ids before touching storage", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const sentinel = join(dataDir, "outside", "must-survive.txt");
  mkdirSync(join(sentinel, ".."), { recursive: true });
  writeFileSync(sentinel, "outside");
  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    releaseProjectResources: () => { resourcesReleased = true; },
  });

  for (const projectId of ["../outside", "other/nested", "other\\nested", "unsafe\0id"]) {
    await assert.rejects(supervisor.releaseProject(projectId), /one project id segment/i);
  }
  assert.equal(existsSync(sentinel), true);
  assert.equal(resourcesReleased, false);

  await supervisor.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("shutdown cancels Project operations before stopping child resources", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const entered = deferred();
  const settled = deferred();
  const order: string[] = [];
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    shutdownResources: () => { order.push("resources"); },
  });
  const operation = supervisor.trackOperation({ projectId: "project" }, async (signal) => {
    signal.addEventListener("abort", () => order.push("abort"), { once: true });
    entered.resolve();
    await settled.promise;
    order.push("settled");
  });
  await entered.promise;

  let shutdownFinished = false;
  const shuttingDown = supervisor.shutdown().then((result) => {
    shutdownFinished = true;
    return result;
  });
  assert.deepEqual(order, ["abort"]);
  await Promise.resolve();
  assert.equal(shutdownFinished, false);

  settled.resolve();
  assert.equal(await shuttingDown, true);
  await operation;
  assert.deepEqual(order, ["abort", "settled", "resources"]);
  assert.throws(() => supervisor.assertAdmission({ projectId: "late" }), RuntimeScopeUnavailableError);

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("shutdown bounds stuck Project settlement before forcing resource cleanup", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    shutdownWaitMs: 20,
    shutdownResources: () => { resourcesReleased = true; },
  });
  const entered = deferred();
  void supervisor.trackOperation({ projectId: "project" }, () => {
    entered.resolve();
    return new Promise<void>(() => {});
  });
  await entered.promise;

  const result = await Promise.race([
    supervisor.shutdown(),
    new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 500)),
  ]);
  assert.notEqual(result, "test-timeout");
  assert.equal(result, false);
  assert.equal(resourcesReleased, true);

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
