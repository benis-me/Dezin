import type { Store } from "../../../packages/core/src/index.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export type RuntimeScope = { projectId: string; variantId?: string; runId?: string };

export type RegisteredRun = RuntimeScope & {
  runId: string;
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

function matchesScope(run: RegisteredRun, scope: RuntimeScope): boolean {
  return run.projectId === scope.projectId
    && (scope.variantId === undefined || run.variantId === scope.variantId)
    && (scope.runId === undefined || run.runId === scope.runId);
}

export class RuntimeSupervisor {
  private readonly runs = new Map<string, RegisteredRun>();
  private readonly blockedProjects = new Set<string>();
  private readonly blockedVariants = new Set<string>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<boolean>;
  private readonly options: RuntimeSupervisorOptions;

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
  }

  registerRun(run: RegisteredRun): () => void {
    if (
      this.shuttingDown
      || this.blockedProjects.has(run.projectId)
      || (run.variantId !== undefined && this.blockedVariants.has(this.variantKey(run.projectId, run.variantId)))
    ) {
      throw new RuntimeScopeUnavailableError(run);
    }
    this.runs.set(run.runId, run);
    const unregister = (): void => {
      if (this.runs.get(run.runId) === run) this.runs.delete(run.runId);
    };
    void run.settled.then(unregister, unregister);
    return unregister;
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

  async releaseVariant(projectId: string, variantId: string): Promise<void> {
    const scope = { projectId, variantId };
    this.blockedVariants.add(this.variantKey(projectId, variantId));
    const runIds = this.options.store
      .listRuns(projectId)
      .filter((run) => run.variantId === variantId)
      .map((run) => run.id);
    this.cancelRuns(scope);
    await this.waitForRuns(scope);
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
    await this.waitForRuns(scope);
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
  }

  shutdown(): Promise<boolean> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<boolean> {
    this.shuttingDown = true;
    this.cancelAll();
    const settled = await this.waitForSettlements(
      [...this.runs.values()].map((run) => run.settled),
      this.options.shutdownWaitMs ?? 5_000,
    );
    await this.options.shutdownResources?.();
    return settled;
  }

  private variantKey(projectId: string, variantId: string): string {
    return `${projectId}:${variantId}`;
  }

  private waitForSettlements(settlements: Promise<void>[], timeoutMs: number): Promise<boolean> {
    if (settlements.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve(false);
      }, Math.max(0, timeoutMs));
      void Promise.allSettled(settlements).then(() => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
