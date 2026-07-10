import type { Store } from "../../../packages/core/src/index.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export type RuntimeScope = { projectId: string; variantId?: string; runId?: string };

export type RegisteredRun = RuntimeScope & {
  runId: string;
  controller: AbortController;
  settled: Promise<void>;
};

type RegisteredOperation = RuntimeScope & {
  id: number;
  controller: AbortController;
  settled: Promise<void>;
};

export type RuntimeReleaseScope = Required<Pick<RuntimeScope, "projectId">> & {
  variantId?: string;
  runIds: string[];
};

export interface RuntimeSupervisorOptions {
  dataDir: string;
  store: Store;
  releaseProjectResources?: (scope: RuntimeReleaseScope) => void | Promise<void>;
  releaseVariantResources?: (scope: RuntimeReleaseScope & { variantId: string }) => void | Promise<void>;
  shutdownResources?: () => void | Promise<void>;
  shutdownWaitMs?: number;
}

export class RuntimeScopeUnavailableError extends Error {
  constructor(scope: RuntimeScope) {
    super(`Runtime scope is unavailable: ${scope.projectId}${scope.variantId ? `:${scope.variantId}` : ""}`);
    this.name = "RuntimeScopeUnavailableError";
  }
}

function matchesScope(run: RuntimeScope, scope: RuntimeScope): boolean {
  return run.projectId === scope.projectId
    && (scope.variantId === undefined || run.variantId === scope.variantId)
    && (scope.runId === undefined || run.runId === scope.runId);
}

function matchesOperationScope(operation: RuntimeScope, scope: RuntimeScope): boolean {
  return operation.projectId === scope.projectId
    && (scope.variantId === undefined || operation.variantId === undefined || operation.variantId === scope.variantId)
    && (scope.runId === undefined || operation.runId === undefined || operation.runId === scope.runId);
}

export class RuntimeSupervisor {
  private readonly runs = new Map<string, RegisteredRun>();
  private readonly operations = new Map<number, RegisteredOperation>();
  private readonly blockedProjects = new Set<string>();
  private readonly blockedVariants = new Set<string>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<boolean>;
  private readonly options: RuntimeSupervisorOptions;
  private nextOperationId = 1;

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
  }

  registerRun(run: RegisteredRun): () => void {
    this.assertAdmission(run);
    this.runs.set(run.runId, run);
    const unregister = (): void => {
      if (this.runs.get(run.runId) === run) this.runs.delete(run.runId);
    };
    void run.settled.then(unregister, unregister);
    return unregister;
  }

  assertAdmission(scope: RuntimeScope): void {
    if (
      this.shuttingDown
      || this.blockedProjects.has(scope.projectId)
      || (scope.variantId !== undefined && this.blockedVariants.has(this.variantKey(scope.projectId, scope.variantId)))
    ) {
      throw new RuntimeScopeUnavailableError(scope);
    }
  }

  trackOperation<T>(scope: RuntimeScope, start: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    this.assertAdmission(scope);
    const id = this.nextOperationId++;
    const controller = new AbortController();
    let operation!: Promise<T>;
    const settled = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return start(controller.signal);
      })
      .then((value) => value);
    operation = settled;
    const entry: RegisteredOperation = {
      ...scope,
      id,
      controller,
      settled: operation.then(() => {}, () => {}),
    };
    this.operations.set(id, entry);
    void entry.settled.finally(() => {
      if (this.operations.get(id) === entry) this.operations.delete(id);
    });
    return operation;
  }

  cancelRuns(scope: RuntimeScope): void {
    for (const run of this.runs.values()) {
      if (matchesScope(run, scope)) run.controller.abort();
    }
  }

  async waitForRuns(scope: RuntimeScope): Promise<void> {
    const matching = [...this.runs.values()].filter((run) => matchesScope(run, scope));
    await Promise.allSettled(matching.map((run) => run.settled));
  }

  cancelOperations(scope: RuntimeScope): void {
    for (const operation of this.operations.values()) {
      if (matchesOperationScope(operation, scope)) operation.controller.abort();
    }
  }

  async waitForOperations(scope: RuntimeScope): Promise<void> {
    const matching = [...this.operations.values()].filter((operation) => matchesOperationScope(operation, scope));
    await Promise.allSettled(matching.map((operation) => operation.settled));
  }

  async releaseVariant(projectId: string, variantId: string): Promise<void> {
    const scope = { projectId, variantId };
    this.blockedVariants.add(this.variantKey(projectId, variantId));
    const runIds = this.options.store
      .listRuns(projectId)
      .filter((run) => run.variantId === variantId)
      .map((run) => run.id);
    this.cancelRuns(scope);
    this.cancelOperations(scope);
    await Promise.all([this.waitForRuns(scope), this.waitForOperations(scope)]);
    await this.options.releaseVariantResources?.({ projectId, variantId, runIds });
    await Promise.all([
      rm(join(this.options.dataDir, "worktrees", projectId, variantId), { recursive: true, force: true }),
      rm(join(this.options.dataDir, "projects", projectId, ".variants", variantId), { recursive: true, force: true }),
      ...runIds.flatMap((runId) => [
        rm(join(this.options.dataDir, ".runs", `${runId}.jsonl`), { recursive: true, force: true }),
        rm(join(this.options.dataDir, ".runs", runId), { recursive: true, force: true }),
        rm(join(this.options.dataDir, "version-worktrees", projectId, runId), { recursive: true, force: true }),
      ]),
    ]);
    this.options.store.deleteVariant(variantId);
  }

  async releaseProject(projectId: string): Promise<void> {
    const scope = { projectId };
    this.blockedProjects.add(projectId);
    const runIds = this.options.store.listRuns(projectId).map((run) => run.id);
    this.cancelRuns(scope);
    this.cancelOperations(scope);
    await Promise.all([this.waitForRuns(scope), this.waitForOperations(scope)]);
    await this.options.releaseProjectResources?.({ projectId, runIds });
    await Promise.all([
      rm(join(this.options.dataDir, "worktrees", projectId), { recursive: true, force: true }),
      rm(join(this.options.dataDir, "version-worktrees", projectId), { recursive: true, force: true }),
      rm(join(this.options.dataDir, "projects", projectId), { recursive: true, force: true }),
      ...runIds.flatMap((runId) => [
        rm(join(this.options.dataDir, ".runs", `${runId}.jsonl`), { recursive: true, force: true }),
        rm(join(this.options.dataDir, ".runs", runId), { recursive: true, force: true }),
      ]),
    ]);
    this.options.store.deleteProject(projectId);
  }

  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  shutdown(deadlineAt?: number): Promise<boolean> {
    this.shutdownPromise ??= this.performShutdown(
      deadlineAt ?? Date.now() + (this.options.shutdownWaitMs ?? 5_000),
    );
    return this.shutdownPromise;
  }

  private async performShutdown(deadlineAt: number): Promise<boolean> {
    this.shuttingDown = true;
    this.cancelAll();
    const settled = await this.waitForSettlements(
      [
        ...[...this.runs.values()].map((run) => run.settled),
        ...[...this.operations.values()].map((operation) => operation.settled),
      ],
      deadlineAt,
    );
    const resourcesSettled = await this.waitForSettlements(
      [Promise.resolve().then(() => this.options.shutdownResources?.()).then(() => {})],
      deadlineAt,
    );
    return settled && resourcesSettled;
  }

  private variantKey(projectId: string, variantId: string): string {
    return `${projectId}:${variantId}`;
  }

  private waitForSettlements(settlements: Promise<void>[], deadlineAt: number): Promise<boolean> {
    if (settlements.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve(false);
      }, Math.max(0, deadlineAt - Date.now()));
      void Promise.allSettled(settlements).then(() => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
