import assert from "node:assert/strict";
import { test } from "node:test";

interface StartupModule {
  startDaemonAfterGenerationRecovery(options: {
    generationRecovery: { start(): Promise<void>; stop(): Promise<void> };
    listen(): void;
    rollback(): void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<void>;
}

async function startupModule(): Promise<Partial<StartupModule>> {
  return import("../src/daemon-startup.ts").catch(() => ({})) as Promise<Partial<StartupModule>>;
}

test("daemon begins listening only after Generation startup recovery completes", async () => {
  const module = await startupModule();
  assert.equal(typeof module.startDaemonAfterGenerationRecovery, "function");
  const order: string[] = [];
  await module.startDaemonAfterGenerationRecovery!({
    generationRecovery: {
      async start() { order.push("recovery"); },
      async stop() { order.push("stop"); },
    },
    listen() { order.push("listen"); },
    rollback() { order.push("rollback"); },
  });
  assert.deepEqual(order, ["recovery", "listen"]);
});

test("daemon never listens and stops recovery before startup rollback on recovery failure", async () => {
  const module = await startupModule();
  assert.equal(typeof module.startDaemonAfterGenerationRecovery, "function");
  const order: string[] = [];
  const startupError = new Error("recovery failed");
  await assert.rejects(
    module.startDaemonAfterGenerationRecovery!({
      generationRecovery: {
        async start() {
          order.push("recovery");
          throw startupError;
        },
        async stop() { order.push("stop"); },
      },
      listen() { order.push("listen"); },
      rollback() { order.push("rollback"); },
    }),
    (error) => error === startupError,
  );
  assert.deepEqual(order, ["recovery", "stop", "rollback"]);
});

test("shutdown racing startup recovery aborts the barrier and never opens admission", async () => {
  const module = await startupModule();
  assert.equal(typeof module.startDaemonAfterGenerationRecovery, "function");
  const order: string[] = [];
  let finishRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
  const controller = new AbortController();
  const startup = module.startDaemonAfterGenerationRecovery!({
    generationRecovery: {
      async start() {
        order.push("recovery");
        await recovery;
      },
      async stop() {
        order.push("stop");
        finishRecovery();
      },
    },
    listen() { order.push("listen"); },
    rollback() { order.push("rollback"); },
    signal: controller.signal,
  });

  controller.abort(new Error("shutdown"));
  await assert.rejects(startup, /shutdown/);
  assert.deepEqual(order, ["recovery", "stop", "rollback"]);
});
