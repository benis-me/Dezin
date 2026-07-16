import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../../../packages/core/src/index.ts";
import type {
  GenerationRuntime,
  GenerationRuntimeRecoveryEvent,
  GenerationRuntimeScheduler,
} from "../src/orchestration/generation-runtime.ts";
import type { GenerationPlanRecoveryDeps } from "../src/orchestration/recovery.ts";

interface CompositionModule {
  createProductionGenerationRecoveryBarrier(options: {
    workspaceStore: Store["workspace"];
    dataDir: string;
    repositoryDirForWorkspace(workspaceId: string): string | Promise<string>;
    onRecovery?(event: GenerationRuntimeRecoveryEvent): void;
  }): GenerationRuntime;
  createProductionGenerationRuntime(options: {
    projectCatalog: Pick<Store, "listProjects">;
    workspaceStore: Store["workspace"];
    dataDir: string;
    planRecovery: Omit<GenerationPlanRecoveryDeps, "store">;
    scheduler: GenerationRuntimeScheduler;
    repositoryDirForWorkspace(workspaceId: string): string | Promise<string>;
    onRecovery?(event: GenerationRuntimeRecoveryEvent): void;
  }): GenerationRuntime;
}

async function compositionModule(): Promise<Partial<CompositionModule>> {
  return import("../src/orchestration/generation-runtime-composition.ts")
    .catch(() => ({})) as Promise<Partial<CompositionModule>>;
}

test("production Generation composition binds durable ref/payload recovery and leaves Store closure to daemon shutdown", async (t) => {
  const module = await compositionModule();
  assert.equal(
    typeof module.createProductionGenerationRuntime,
    "function",
    "production Generation runtime composition must be exported",
  );
  const root = await mkdtemp(join(tmpdir(), "dezin-generation-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(":memory:");
  t.after(() => {
    try { store.close(); } catch { /* already closed by a failed assertion cleanup */ }
  });
  const order: string[] = [];
  const recoveryPhases: string[] = [];
  const planRecovery: Omit<GenerationPlanRecoveryDeps, "store"> = {
    planService: {
      compileAndEnqueueApprovedShell() {
        order.push("compile-approved-shell");
      },
      async reconcileNeedsRebaseTasks() {
        order.push("reconcile-rebase");
        return { planIds: [] };
      },
    },
    clock: { now: () => 1_700_000_000_000 },
    logger: { warn: () => {} },
  };
  const runtime = module.createProductionGenerationRuntime!({
    projectCatalog: store,
    workspaceStore: store.workspace,
    dataDir: root,
    planRecovery,
    scheduler: {
      start() { order.push("scheduler-start"); },
      async stop() { order.push("scheduler-stop"); },
    },
    repositoryDirForWorkspace(workspaceId) {
      return join(root, "projects", workspaceId);
    },
    onRecovery: (event) => recoveryPhases.push(event.phase),
  });

  await runtime.start();
  assert.deepEqual(order, ["reconcile-rebase", "scheduler-start"]);
  assert.deepEqual(recoveryPhases, [
    "startup-plan-recovery",
    "startup-artifact-ref-recovery",
    "startup-resource-payload-recovery",
  ]);

  await runtime.stop();
  assert.deepEqual(order, ["reconcile-rebase", "scheduler-start", "scheduler-stop"]);
  assert.deepEqual(store.listProjects(), [], "GenerationRuntime.stop must not close the shared Store");
});

test("production Generation composition rejects missing scheduler leaf dependencies at construction", async () => {
  const module = await compositionModule();
  assert.equal(typeof module.createProductionGenerationRuntime, "function");
  assert.throws(
    () => module.createProductionGenerationRuntime!({
      projectCatalog: { listProjects: () => [] },
      workspaceStore: {} as Store["workspace"],
      dataDir: "/tmp/dezin-missing-scheduler",
      planRecovery: {} as Omit<GenerationPlanRecoveryDeps, "store">,
      scheduler: undefined as unknown as GenerationRuntimeScheduler,
      repositoryDirForWorkspace: () => "/tmp/dezin-missing-scheduler/project",
    }),
    /scheduler/i,
  );
});

test("production startup recovery barrier binds real durable cleanup without admitting scheduler work", async (t) => {
  const module = await compositionModule();
  assert.equal(
    typeof module.createProductionGenerationRecoveryBarrier,
    "function",
    "production startup recovery barrier must be exported",
  );
  const root = await mkdtemp(join(tmpdir(), "dezin-generation-recovery-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(":memory:");
  t.after(() => {
    try { store.close(); } catch { /* already closed by a failed assertion cleanup */ }
  });
  const phases: string[] = [];
  const barrier = module.createProductionGenerationRecoveryBarrier!({
    workspaceStore: store.workspace,
    dataDir: root,
    repositoryDirForWorkspace: (workspaceId) => join(root, "projects", workspaceId),
    onRecovery: (event) => phases.push(event.phase),
  });

  await barrier.start();
  assert.deepEqual(phases, [
    "startup-artifact-ref-recovery",
    "startup-resource-payload-recovery",
  ]);
  await barrier.stop();
  assert.deepEqual(store.listProjects(), [], "recovery barrier must leave Store closure to daemon shutdown");
});
