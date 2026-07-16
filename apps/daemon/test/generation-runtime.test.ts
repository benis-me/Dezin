import assert from "node:assert/strict";
import { test } from "node:test";

import type { GenerationTaskRecoverySummary } from "../../../packages/core/src/index.ts";
import {
  createGenerationRuntime,
  type GenerationRuntimeErrorEvent,
  type GenerationRuntimeTimerPort,
} from "../src/orchestration/generation-runtime.ts";
import type { GenerationPlanRecoveryDeps } from "../src/orchestration/recovery.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function emptyPlanRecoverySummary(): GenerationTaskRecoverySummary {
  return {
    planIds: [],
    retriedTaskIds: [],
    needsRebaseTaskIds: [],
    cancelledTaskIds: [],
    failedTaskIds: [],
  };
}

function planRecovery(order: string[], reconcile?: () => Promise<void>): GenerationPlanRecoveryDeps {
  return {
    store: {
      listApprovedGenerationPlanShells() {
        order.push("list-plans");
        return [{ id: "plan-1" }];
      },
      recoverExpiredGenerationTaskAttempts() {
        order.push("recover-expired");
        return emptyPlanRecoverySummary();
      },
    },
    planService: {
      compileAndEnqueueApprovedShell() {
        order.push("compile-plan");
      },
      async reconcileNeedsRebaseTasks() {
        order.push("reconcile-rebase");
        await reconcile?.();
        return { planIds: [] };
      },
    },
    clock: { now: () => 10_000 },
    logger: { warn: () => {} },
  };
}

class ManualTimers implements GenerationRuntimeTimerPort {
  readonly pending: Array<{ delayMs: number; cancelled: boolean; callback: () => void }> = [];

  schedule(delayMs: number, callback: () => void): { cancel(): void } {
    const scheduled = { delayMs, cancelled: false, callback };
    this.pending.push(scheduled);
    return {
      cancel() {
        scheduled.cancelled = true;
      },
    };
  }

  fireNext(): void {
    const scheduled = this.pending.shift();
    assert.ok(scheduled, "expected a scheduled recovery timer");
    if (!scheduled.cancelled) scheduled.callback();
  }
}

test("GenerationRuntime recovers durable plans and Artifact refs before scheduler admission, then stops scheduler before store", async () => {
  const order: string[] = [];
  const timers = new ManualTimers();
  const runtime = createGenerationRuntime({
    planRecovery: planRecovery(order),
    artifactRefRecovery: {
      async recover(signal) {
        assert.equal(signal.aborted, false);
        order.push("recover-artifact-refs");
        return {
          scanned: 0,
          eligible: 0,
          released: 0,
          alreadyReleased: 0,
          retained: 0,
          skipped: 0,
          failed: 0,
        };
      },
    },
    resourcePayloadRecovery: {
      async recover({ cursor, signal }) {
        assert.equal(signal.aborted, false);
        assert.equal(cursor, null);
        order.push("recover-resource-payloads");
        return {
          scanned: 0,
          removed: 0,
          retained: 0,
          invalid: 0,
          failed: 0,
          nextCursor: null,
        };
      },
    },
    scheduler: {
      start() {
        order.push("scheduler-start");
      },
      async stop() {
        order.push("scheduler-stop");
      },
    },
    async closeStore() {
      order.push("store-close");
    },
    timers,
    artifactRefRecoveryIntervalMs: 12_345,
  });

  await Promise.all([runtime.start(), runtime.start()]);

  assert.deepEqual(order, [
    "list-plans",
    "compile-plan",
    "recover-expired",
    "reconcile-rebase",
    "recover-artifact-refs",
    "recover-resource-payloads",
    "scheduler-start",
  ]);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0]?.delayMs, 12_345);

  await Promise.all([runtime.stop(), runtime.stop()]);

  assert.deepEqual(order.slice(-2), ["scheduler-stop", "store-close"]);
  assert.equal(timers.pending[0]?.cancelled, true);
});

test("GenerationRuntime advances the bounded Resource payload cursor across serialized maintenance passes", async () => {
  const order: string[] = [];
  const timers = new ManualTimers();
  const cursors: Array<{ afterSequence: number; throughSequence: number } | null> = [];
  let artifactPasses = 0;
  const runtime = createGenerationRuntime({
    planRecovery: planRecovery(order),
    artifactRefRecovery: {
      async recover() {
        artifactPasses += 1;
        return {
          scanned: 0,
          eligible: 0,
          released: 0,
          alreadyReleased: 0,
          retained: 0,
          skipped: 0,
          failed: 0,
        };
      },
    },
    resourcePayloadRecovery: {
      async recover({ cursor }) {
        cursors.push(cursor ?? null);
        return {
          scanned: 1,
          removed: 1,
          retained: 0,
          invalid: 0,
          failed: 0,
          nextCursor: cursor === null || cursor === undefined
            ? { afterSequence: 1, throughSequence: 3 }
            : null,
        };
      },
    },
    scheduler: { start: () => {}, stop: async () => {} },
    closeStore: () => {},
    timers,
    artifactRefRecoveryIntervalMs: 10,
  });

  await runtime.start();
  assert.deepEqual(cursors, [null]);

  timers.fireNext();
  await waitFor(() => cursors.length === 2, "periodic Resource payload recovery did not advance");
  assert.deepEqual(cursors, [null, { afterSequence: 1, throughSequence: 3 }]);

  timers.fireNext();
  await waitFor(() => cursors.length === 3, "completed Resource sweep did not restart from the beginning");
  assert.deepEqual(cursors, [
    null,
    { afterSequence: 1, throughSequence: 3 },
    null,
  ]);
  assert.equal(artifactPasses, 3, "Artifact and Resource maintenance must share one serialized cadence");
  await runtime.stop();
});

test("GenerationRuntime serializes periodic Artifact ref recovery, observes a failed pass, and keeps scheduling", async () => {
  const order: string[] = [];
  const timers = new ManualTimers();
  const periodicEntered = deferred();
  const allowPeriodicFailure = deferred();
  const errors: GenerationRuntimeErrorEvent[] = [];
  let recoveries = 0;
  const runtime = createGenerationRuntime({
    planRecovery: planRecovery(order),
    artifactRefRecovery: {
      async recover() {
        recoveries += 1;
        order.push(`artifact-recovery:${recoveries}`);
        if (recoveries === 2) {
          periodicEntered.resolve();
          await allowPeriodicFailure.promise;
          throw new Error("candidate ref scan unavailable");
        }
        return {
          scanned: 0,
          eligible: 0,
          released: 0,
          alreadyReleased: 0,
          retained: 0,
          skipped: 0,
          failed: 0,
        };
      },
    },
    scheduler: { start: () => {}, stop: async () => {} },
    closeStore: () => {},
    timers,
    artifactRefRecoveryIntervalMs: 10,
    onError: (event) => errors.push(event),
  });
  await runtime.start();

  timers.fireNext();
  await periodicEntered.promise;
  assert.equal(timers.pending.length, 0, "an in-flight recovery must not overlap another timer");
  allowPeriodicFailure.resolve();
  await waitFor(() => timers.pending.length === 1, "failed periodic recovery did not schedule its next pass");
  assert.deepEqual(errors.map(({ operation }) => operation), ["periodic-artifact-ref-recovery"]);

  timers.fireNext();
  await waitFor(() => recoveries === 3, "next periodic recovery did not run");
  await runtime.stop();
});

test("GenerationRuntime aborts startup admission when stop races an in-flight startup recovery", async () => {
  const order: string[] = [];
  const reconcileEntered = deferred();
  const allowReconcile = deferred();
  const runtime = createGenerationRuntime({
    planRecovery: planRecovery(order, async () => {
      reconcileEntered.resolve();
      await allowReconcile.promise;
    }),
    artifactRefRecovery: {
      async recover() {
        order.push("recover-artifact-refs");
        return {
          scanned: 0,
          eligible: 0,
          released: 0,
          alreadyReleased: 0,
          retained: 0,
          skipped: 0,
          failed: 0,
        };
      },
    },
    scheduler: {
      start() {
        order.push("scheduler-start");
      },
      async stop() {
        order.push("scheduler-stop");
      },
    },
    closeStore() {
      order.push("store-close");
    },
    timers: new ManualTimers(),
  });

  const starting = runtime.start();
  await reconcileEntered.promise;
  const stopping = runtime.stop();
  allowReconcile.resolve();
  await Promise.all([starting, stopping]);

  assert.equal(order.includes("recover-artifact-refs"), false);
  assert.equal(order.includes("scheduler-start"), false);
  assert.deepEqual(order.slice(-2), ["scheduler-stop", "store-close"]);
});

test("a new GenerationRuntime instance replays startup recovery before admission after response loss and restart", async () => {
  const order: string[] = [];
  let recoveryPass = 0;
  const artifactRefRecovery = {
    async recover() {
      recoveryPass += 1;
      order.push(`restart-recovery:${recoveryPass}`);
      return {
        scanned: 1,
        eligible: 1,
        released: 0,
        alreadyReleased: recoveryPass === 1 ? 0 : 1,
        retained: 0,
        skipped: 0,
        failed: recoveryPass === 1 ? 1 : 0,
      };
    },
  };
  const makeRuntime = (id: number) => createGenerationRuntime({
    planRecovery: planRecovery(order),
    artifactRefRecovery,
    scheduler: {
      start: () => order.push(`scheduler-start:${id}`),
      stop: async () => {},
    },
    closeStore: () => {},
    timers: new ManualTimers(),
  });

  const beforeRestart = makeRuntime(1);
  await beforeRestart.start();
  await beforeRestart.stop();
  const afterRestart = makeRuntime(2);
  await afterRestart.start();
  await afterRestart.stop();

  assert.ok(order.indexOf("restart-recovery:1") < order.indexOf("scheduler-start:1"));
  assert.ok(order.indexOf("restart-recovery:2") < order.indexOf("scheduler-start:2"));
  assert.equal(recoveryPass, 2);
});
