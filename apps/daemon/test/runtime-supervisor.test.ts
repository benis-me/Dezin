import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../packages/core/src/index.ts";
import { RuntimeScopeUnavailableError, RuntimeSupervisor } from "../src/runtime-supervisor.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("RuntimeSupervisor cancels and waits for only the matching variant Runs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstSettled = deferred();
  const secondSettled = deferred();

  supervisor.registerRun({
    projectId: "project-1",
    variantId: "variant-a",
    runId: "run-a",
    controller: firstController,
    settled: firstSettled.promise,
  });
  supervisor.registerRun({
    projectId: "project-1",
    variantId: "variant-b",
    runId: "run-b",
    controller: secondController,
    settled: secondSettled.promise,
  });

  supervisor.cancelRuns({ projectId: "project-1", variantId: "variant-a" });
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, false);

  let waitFinished = false;
  const waiting = supervisor.waitForRuns({ projectId: "project-1", variantId: "variant-a" }).then(() => {
    waitFinished = true;
  });
  await Promise.resolve();
  assert.equal(waitFinished, false);

  firstSettled.resolve();
  await waiting;
  assert.equal(waitFinished, true);

  secondSettled.resolve();
  await supervisor.shutdown();
  store.close();
});

test("releaseVariant rejects new matching Runs before waiting for active settlement", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Project" });
  const main = store.ensureMainVariant(project.id);
  const target = store.createVariant(project.id, "Target");
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id, target.id);
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  const controller = new AbortController();
  const settled = deferred();
  supervisor.registerRun({
    projectId: project.id,
    variantId: target.id,
    runId: run.id,
    controller,
    settled: settled.promise,
  });

  let released = false;
  const releasing = supervisor.releaseVariant(project.id, target.id).then(() => {
    released = true;
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(released, false);
  assert.ok(store.getVariant(target.id), "the database row remains until the active Run settles");
  assert.throws(
    () => supervisor.registerRun({
      projectId: project.id,
      variantId: target.id,
      runId: "late-target-run",
      controller: new AbortController(),
      settled: Promise.resolve(),
    }),
    RuntimeScopeUnavailableError,
  );
  assert.doesNotThrow(() => supervisor.registerRun({
    projectId: project.id,
    variantId: main.id,
    runId: "other-variant-run",
    controller: new AbortController(),
    settled: Promise.resolve(),
  }));

  settled.resolve();
  await releasing;
  assert.equal(released, true);
  await supervisor.shutdown();
  store.close();
});

test("releaseVariant recomputes owned Run ids after matching operations settle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Project" });
  store.ensureMainVariant(project.id);
  const target = store.createVariant(project.id, "Target");
  const conversation = store.createConversation(project.id);
  const entered = deferred();
  let lateRunId = "";
  const releasedRunIds: string[][] = [];
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    releaseVariantResources: ({ runIds }) => {
      releasedRunIds.push(runIds);
    },
  });

  const operation = supervisor.trackOperation(
    { projectId: project.id, variantId: target.id },
    async (signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      const lateRun = store.createRun(project.id, conversation.id, target.id);
      lateRunId = lateRun.id;
      const latePaths = [
        join(dataDir, ".runs", `${lateRun.id}.jsonl`),
        join(dataDir, ".runs", lateRun.id, "bundle.txt"),
      ];
      for (const path of latePaths) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "late");
      }
    },
  );
  await entered.promise;

  await Promise.all([supervisor.releaseVariant(project.id, target.id), operation]);

  assert.ok(lateRunId, "the matching operation creates a Run while settling after abort");
  assert.deepEqual(releasedRunIds, [[lateRunId]], "resource cleanup receives post-settlement ownership");
  assert.equal(existsSync(join(dataDir, ".runs", `${lateRunId}.jsonl`)), false);
  assert.equal(existsSync(join(dataDir, ".runs", lateRunId)), false);
  await supervisor.shutdown();
  store.close();
});

test("releaseVariant stops resources and removes only variant-owned paths before deleting rows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Project" });
  const main = store.ensureMainVariant(project.id);
  const target = store.createVariant(project.id, "Target");
  const conversation = store.createConversation(project.id);
  const targetRun = store.createRun(project.id, conversation.id, target.id);
  const mainRun = store.createRun(project.id, conversation.id, main.id);
  const targetPaths = [
    join(dataDir, ".runs", `${targetRun.id}.jsonl`),
    join(dataDir, ".runs", targetRun.id, "bundle.txt"),
    join(dataDir, "worktrees", project.id, target.id, "artifact.txt"),
    join(dataDir, "version-worktrees", project.id, targetRun.id, "artifact.txt"),
    join(dataDir, "projects", project.id, ".variants", target.id, "index.html"),
    join(dataDir, "projects", project.id, ".versions", `${targetRun.id.replace(/[^a-zA-Z0-9-]/g, "")}.html`),
  ];
  const retainedPaths = [
    join(dataDir, ".runs", `${mainRun.id}.jsonl`),
    join(dataDir, "version-worktrees", project.id, mainRun.id, "artifact.txt"),
    join(dataDir, "projects", project.id, "index.html"),
    join(dataDir, "projects", project.id, ".versions", `${mainRun.id.replace(/[^a-zA-Z0-9-]/g, "")}.html`),
  ];
  for (const path of [...targetPaths, ...retainedPaths]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, path);
  }

  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    releaseVariantResources: async (scope) => {
      assert.deepEqual(scope, { projectId: project.id, variantId: target.id, runIds: [targetRun.id] });
      assert.ok(store.getVariant(target.id), "runtime resources stop before database deletion");
      assert.ok(targetPaths.every(existsSync), "runtime resources stop before owned path deletion");
      resourcesReleased = true;
    },
  });

  await supervisor.releaseVariant(project.id, target.id);

  assert.equal(resourcesReleased, true);
  assert.equal(store.getVariant(target.id), null);
  assert.equal(store.getRun(targetRun.id), null);
  assert.ok(targetPaths.every((path) => !existsSync(path)), "all target variant paths are removed");
  assert.ok(retainedPaths.every(existsSync), "other variant and project paths remain");
  assert.ok(store.getVariant(main.id));
  assert.ok(store.getRun(mainRun.id));
  await supervisor.shutdown();
  store.close();
});

test("releaseProject waits, releases resources, and removes all project-owned state before its rows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Project" });
  const main = store.ensureMainVariant(project.id);
  const branch = store.createVariant(project.id, "Branch");
  const conversation = store.createConversation(project.id);
  const mainRun = store.createRun(project.id, conversation.id, main.id);
  const branchRun = store.createRun(project.id, conversation.id, branch.id);
  const otherProject = store.createProject({ name: "Other" });
  const otherVariant = store.ensureMainVariant(otherProject.id);
  const otherConversation = store.createConversation(otherProject.id);
  const otherRun = store.createRun(otherProject.id, otherConversation.id, otherVariant.id);
  const targetPaths = [
    join(dataDir, ".runs", `${mainRun.id}.jsonl`),
    join(dataDir, ".runs", branchRun.id, "bundle.txt"),
    join(dataDir, "worktrees", project.id, branch.id, "artifact.txt"),
    join(dataDir, "version-worktrees", project.id, branchRun.id, "artifact.txt"),
    join(dataDir, "projects", project.id, "index.html"),
  ];
  const retainedPaths = [
    join(dataDir, ".runs", `${otherRun.id}.jsonl`),
    join(dataDir, "projects", otherProject.id, "index.html"),
  ];
  for (const path of [...targetPaths, ...retainedPaths]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, path);
  }

  const controller = new AbortController();
  const settled = deferred();
  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    releaseProjectResources: async (scope) => {
      assert.equal(scope.projectId, project.id);
      assert.deepEqual(scope.runIds.toSorted(), [mainRun.id, branchRun.id].toSorted());
      assert.ok(store.getProject(project.id), "resources stop before database deletion");
      assert.ok(targetPaths.every(existsSync), "resources stop before path deletion");
      resourcesReleased = true;
    },
  });
  supervisor.registerRun({
    projectId: project.id,
    variantId: branch.id,
    runId: branchRun.id,
    controller,
    settled: settled.promise,
  });

  let released = false;
  const releasing = supervisor.releaseProject(project.id).then(() => {
    released = true;
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(released, false);
  assert.ok(store.getProject(project.id));
  assert.throws(
    () => supervisor.registerRun({
      projectId: project.id,
      variantId: main.id,
      runId: "late-project-run",
      controller: new AbortController(),
      settled: Promise.resolve(),
    }),
    RuntimeScopeUnavailableError,
  );

  settled.resolve();
  await releasing;

  assert.equal(resourcesReleased, true);
  assert.equal(released, true);
  assert.equal(store.getProject(project.id), null);
  assert.equal(store.getRun(mainRun.id), null);
  assert.equal(store.getRun(branchRun.id), null);
  assert.ok(targetPaths.every((path) => !existsSync(path)));
  assert.ok(retainedPaths.every(existsSync));
  assert.ok(store.getProject(otherProject.id));
  assert.ok(store.getRun(otherRun.id));
  await supervisor.shutdown();
  store.close();
});

test("shutdown cancels all Runs and waits for settlement before stopping child resources", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  const settled = deferred();
  const controller = new AbortController();
  const order: string[] = [];
  controller.signal.addEventListener("abort", () => order.push("abort"), { once: true });
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    shutdownResources: async () => {
      order.push("resources");
    },
  });
  supervisor.registerRun({
    projectId: "project",
    variantId: "variant",
    runId: "run",
    controller,
    settled: settled.promise.then(() => {
      order.push("settled");
    }),
  });

  let shutdownFinished = false;
  const shuttingDown = supervisor.shutdown().then(() => {
    shutdownFinished = true;
  });
  assert.equal(controller.signal.aborted, true);
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  assert.deepEqual(order, ["abort"]);

  settled.resolve();
  await shuttingDown;
  assert.equal(shutdownFinished, true);
  assert.deepEqual(order, ["abort", "settled", "resources"]);
  assert.throws(
    () => supervisor.registerRun({
      projectId: "other",
      runId: "late",
      controller: new AbortController(),
      settled: Promise.resolve(),
    }),
    RuntimeScopeUnavailableError,
  );
  store.close();
});

test("shutdown bounds settlement waiting before forcing resource cleanup", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-runtime-supervisor-"));
  const store = new Store(":memory:");
  let resourcesReleased = false;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    store,
    shutdownWaitMs: 20,
    shutdownResources: () => {
      resourcesReleased = true;
    },
  });
  supervisor.registerRun({
    projectId: "project",
    runId: "stuck-run",
    controller: new AbortController(),
    settled: new Promise<void>(() => {}),
  });

  const result = await Promise.race([
    supervisor.shutdown(),
    new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 500)),
  ]);

  assert.notEqual(result, "test-timeout", "shutdown wait must be bounded");
  assert.equal(result, false, "shutdown reports that settlement timed out");
  assert.equal(resourcesReleased, true, "resource cleanup still runs after the bound");
  store.close();
});
