import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Store } from "../../../packages/core/src/index.ts";
import { createRun, finishRun, pushEvent, readRunLog, subscribe } from "../src/run-manager.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";

test("run-manager registers scoped ownership and settles only after its JSONL queue flushes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  const store = new Store(":memory:");
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  const controller = createRun({
    runId: "r-owned",
    conversationId: "c-owned",
    projectId: "p-owned",
    variantId: "v-owned",
    dataDir,
    runtimeSupervisor: supervisor,
  });
  pushEvent("r-owned", { type: "owned-event", runId: "r-owned" });

  supervisor.cancelRuns({ projectId: "p-owned", variantId: "v-owned" });
  assert.equal(controller.signal.aborted, true);
  finishRun("r-owned");
  await supervisor.waitForRuns({ projectId: "p-owned", variantId: "v-owned" });

  assert.deepEqual(
    readRunLog(join(dataDir, ".runs", "r-owned.jsonl")).map((event) => (event as { type?: string }).type),
    ["owned-event"],
  );
  await supervisor.shutdown();
  store.close();
});

test("finishRun rejects late broker events before reporting supervisor settlement", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  const store = new Store(":memory:");
  const supervisor = new RuntimeSupervisor({ dataDir, store });
  createRun({
    runId: "r-finish-boundary",
    conversationId: "c-finish-boundary",
    projectId: "p-finish-boundary",
    variantId: "v-finish-boundary",
    dataDir,
    runtimeSupervisor: supervisor,
  });
  pushEvent("r-finish-boundary", { type: "before-finish" });

  finishRun("r-finish-boundary");
  pushEvent("r-finish-boundary", { type: "after-finish" });
  await supervisor.waitForRuns({ projectId: "p-finish-boundary" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    readRunLog(join(dataDir, ".runs", "r-finish-boundary.jsonl")).map((event) => (event as { type?: string }).type),
    ["before-finish"],
  );
  await supervisor.shutdown();
  store.close();
});

test("subscribe attaches live listener before replay so reattach cannot miss events", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-race", conversationId: "c1", dataDir });
  pushEvent("r-race", { type: "first", runId: "r-race" });

  const seen: unknown[] = [];
  const unsubscribe = subscribe(
    "r-race",
    dataDir,
    (event) => {
      seen.push(event);
      if (seen.length === 1) pushEvent("r-race", { type: "second", runId: "r-race" });
    },
    () => {},
  );
  unsubscribe();

  assert.deepEqual(
    seen.map((event) => (event as { type?: string }).type),
    ["first", "second"],
  );
});

test("subscribe can replay only events after a cursor", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-cursor", conversationId: "c1", dataDir });
  pushEvent("r-cursor", { type: "first", runId: "r-cursor" });
  pushEvent("r-cursor", { type: "second", runId: "r-cursor" });

  const seen: unknown[] = [];
  const unsubscribe = subscribe("r-cursor", dataDir, (event) => seen.push(event), () => {}, { afterSeq: 1 });
  unsubscribe();

  assert.deepEqual(
    seen.map((event) => ({ type: (event as { type?: string }).type, seq: (event as { seq?: number }).seq })),
    [{ type: "second", seq: 2 }],
  );
});

test("finished run logs persist sequence numbers for restart reattach cursors", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-log", conversationId: "c1", dataDir });
  pushEvent("r-log", { type: "first", runId: "r-log" });
  pushEvent("r-log", { type: "second", runId: "r-log" });
  finishRun("r-log");
  // Poll for the async log flush rather than a fixed 20ms sleep — under load the sleep lost the
  // race and this test flaked intermittently (#108).
  const logPath = join(dataDir, ".runs", "r-log.jsonl");
  const started = Date.now();
  let log = "";
  while (Date.now() - started < 3000) {
    try {
      log = readFileSync(logPath, "utf8");
    } catch {
      log = "";
    }
    if (/"seq":1/.test(log) && /"seq":2/.test(log)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(log, /"seq":1/);
  assert.match(log, /"seq":2/);

  const seen: unknown[] = [];
  subscribe("r-log", dataDir, (event) => seen.push(event), () => {}, { afterSeq: 1 });
  assert.deepEqual(readRunLog(join(dataDir, ".runs", "r-log.jsonl")).map((event) => (event as { seq?: number }).seq), [1, 2]);
  assert.deepEqual(seen.map((event) => (event as { type?: string }).type), ["second"]);
});

test("subscribe removes a partially attached listener when broker subscription throws", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-run-manager-"));
  createRun({ runId: "r-subscribe-fail", conversationId: "c1", dataDir });
  const originalOnce = EventEmitter.prototype.once;
  EventEmitter.prototype.once = function (eventName: string | symbol, listener: (...args: unknown[]) => void) {
    if (this.constructor === EventEmitter && eventName === "done") throw new Error("subscribe exploded");
    return originalOnce.call(this, eventName, listener);
  };
  const seen: unknown[] = [];
  try {
    assert.throws(
      () => subscribe("r-subscribe-fail", dataDir, (event) => seen.push(event), () => {}),
      /subscribe exploded/,
    );
  } finally {
    EventEmitter.prototype.once = originalOnce;
  }

  pushEvent("r-subscribe-fail", { type: "after-failure" });
  finishRun("r-subscribe-fail");
  assert.deepEqual(seen, []);
});

test("RunExecution cancellation racing success emits only the winning terminal event", async () => {
  const { RunExecution } = await import("../src/run-execution.ts");
  const store = new Store(":memory:");
  const project = store.createProject({ name: "P" });
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id);
  store.updateRun(run.id, { status: "running" });
  const events: unknown[] = [];
  const execution = new RunExecution({
    store,
    runId: run.id,
    emit: (event) => events.push(event),
    fallbackEmit: () => {},
    finish: () => {},
    unsubscribe: () => {},
    closeStream: () => {},
  });

  const [cancelled, succeeded] = await Promise.all([
    Promise.resolve().then(() =>
      execution.settle("cancelled", {
        finishedAt: 2_000,
        event: { type: "run-cancelled", runId: run.id },
      }),
    ),
    Promise.resolve().then(() =>
      execution.settle("succeeded", {
        lintPassed: true,
        score: 100,
        finishedAt: 3_000,
        event: { type: "run-done", runId: run.id },
      }),
    ),
  ]);

  assert.equal(cancelled.changed, true);
  assert.equal(succeeded.changed, false);
  assert.equal(store.getRun(run.id)?.status, "cancelled");
  assert.deepEqual(events, [{ type: "run-cancelled", runId: run.id }]);
  store.close();
});

test("RunExecution uses fallbackEmit when primary terminal emission throws", async () => {
  const { RunExecution } = await import("../src/run-execution.ts");
  const store = new Store(":memory:");
  const project = store.createProject({ name: "P" });
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id);
  store.updateRun(run.id, { status: "running" });
  const terminalEvent = { type: "run-error", runId: run.id, message: "failed" };
  const fallbackEvents: unknown[] = [];
  const execution = new RunExecution({
    store,
    runId: run.id,
    emit: () => {
      throw new Error("primary emit failed");
    },
    fallbackEmit: (event) => fallbackEvents.push(event),
    finish: () => {},
    unsubscribe: () => {},
    closeStream: () => {},
  });

  const result = execution.settle("failed", { finishedAt: 2_000, event: terminalEvent });

  assert.equal(result.changed, true);
  assert.equal(result.run.status, "failed");
  assert.deepEqual(fallbackEvents, [terminalEvent]);
  store.close();
});

test("RunExecution surfaces AggregateError when primary and fallback terminal emission both throw", async () => {
  const { RunExecution } = await import("../src/run-execution.ts");
  const store = new Store(":memory:");
  const project = store.createProject({ name: "P" });
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id);
  store.updateRun(run.id, { status: "running" });
  const primaryError = new Error("primary emit failed");
  const fallbackError = new Error("fallback emit failed");
  const execution = new RunExecution({
    store,
    runId: run.id,
    emit: () => {
      throw primaryError;
    },
    fallbackEmit: () => {
      throw fallbackError;
    },
    finish: () => {},
    unsubscribe: () => {},
    closeStream: () => {},
  });

  assert.throws(
    () => execution.settle("failed", { finishedAt: 2_000, event: { type: "run-error", runId: run.id } }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === primaryError &&
      error.errors[1] === fallbackError,
  );
  assert.equal(store.getRun(run.id)?.status, "failed", "the winning DB transition remains durable");
  store.close();
});

test("RunExecution retries a one-shot terminal event failure without duplicating the durable success", async () => {
  const { RunExecution } = await import("../src/run-execution.ts");
  const store = new Store(":memory:");
  const project = store.createProject({ name: "P" });
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id);
  store.updateRun(run.id, { status: "running" });
  const terminalEvent = { type: "run-done", runId: run.id };
  const delivered: unknown[] = [];
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  const execution = new RunExecution({
    store,
    runId: run.id,
    emit: (event) => {
      primaryAttempts += 1;
      if (primaryAttempts === 1) throw new Error("one-shot primary event failure");
      delivered.push(event);
    },
    fallbackEmit: (event) => {
      fallbackAttempts += 1;
      if (fallbackAttempts === 1) throw new Error("one-shot fallback event failure");
      delivered.push(event);
    },
    finish: () => {},
    unsubscribe: () => {},
    closeStream: () => {},
  });

  assert.throws(
    () => execution.settle("succeeded", { commitHash: "abc1234", finishedAt: 2_000, event: terminalEvent }),
    AggregateError,
  );
  const retried = execution.settle("succeeded", { commitHash: "abc1234", finishedAt: 2_000, event: terminalEvent });

  assert.equal(retried.changed, false, "the succeeded DB transition remains exactly once");
  assert.equal(store.getRun(run.id)?.status, "succeeded");
  assert.deepEqual(delivered, [terminalEvent]);
  assert.equal(primaryAttempts, 2);
  assert.equal(fallbackAttempts, 1);
  store.close();
});

test("RunExecution dispose releases broker, subscription, and stream exactly once", async () => {
  const { RunExecution } = await import("../src/run-execution.ts");
  const store = new Store(":memory:");
  const project = store.createProject({ name: "P" });
  const conversation = store.createConversation(project.id);
  const run = store.createRun(project.id, conversation.id);
  const calls: string[] = [];
  const execution = new RunExecution({
    store,
    runId: run.id,
    emit: () => {},
    fallbackEmit: () => {},
    finish: () => {
      calls.push("finish");
      throw new Error("finish cleanup failed");
    },
    unsubscribe: () => calls.push("unsubscribe"),
    closeStream: () => calls.push("close"),
  });

  execution.dispose();
  execution.dispose();

  assert.deepEqual(calls, ["finish", "unsubscribe", "close"]);
  store.close();
});
