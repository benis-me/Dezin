import type { Store } from "../../../packages/core/src/index.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export type RuntimeScope = {
  projectId: string;
};

type RegisteredOperation = RuntimeScope & {
  id: number;
  controller: AbortController;
  settled: Promise<void>;
};

export type RuntimeReleaseScope = Required<Pick<RuntimeScope, "projectId">>;

export interface RuntimeSupervisorOptions {
  dataDir: string;
  store: Store;
  releaseProjectResources?: (scope: RuntimeReleaseScope) => void | Promise<void>;
  shutdownResources?: () => void | Promise<void>;
  shutdownWaitMs?: number;
}

export class RuntimeScopeUnavailableError extends Error {
  constructor(scope: RuntimeScope) {
    super(`Runtime scope is unavailable: ${scope.projectId}`);
    this.name = "RuntimeScopeUnavailableError";
  }
}

function matchesOperationScope(operation: RuntimeScope, scope: RuntimeScope): boolean {
  return operation.projectId === scope.projectId;
}

function assertProjectIdSegment(projectId: string): void {
  if (
    projectId.length === 0
    || projectId === "."
    || projectId === ".."
    || projectId.includes("/")
    || projectId.includes("\\")
    || projectId.includes("\0")
  ) {
    throw new Error(`Project deletion requires one project id segment: ${projectId}`);
  }
}

export class RuntimeSupervisor {
  private readonly operations = new Map<number, RegisteredOperation>();
  private readonly blockedProjects = new Set<string>();
  private readonly projectReleaseOwners = new Map<string, symbol>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<boolean>;
  private readonly options: RuntimeSupervisorOptions;
  private nextOperationId = 1;

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
  }

  assertAdmission(scope: RuntimeScope): void {
    if (
      this.shuttingDown
      || this.blockedProjects.has(scope.projectId)
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

  /**
   * Transfer an already-started operation from an admitted request (or one of
   * its supervised descendants) into daemon ownership. This deliberately does
   * not re-run admission: Project deletion may close admission while an
   * admitted Main Agent is in the middle of creating a child Node Agent. Such
   * a late child is registered and immediately cancelled instead of escaping
   * supervision.
   *
   * Both the operation rejection and the asynchronous cancellation hook are
   * observed here, so callers may safely return HTTP 202 without retaining the
   * completion Promise.
   */
  superviseDetachedOperation<T>(
    scope: RuntimeScope,
    completion: Promise<T>,
    cancel: () => void | Promise<unknown>,
  ): void {
    const id = this.nextOperationId++;
    const controller = new AbortController();
    let cancelTask = Promise.resolve();
    let cancellationRequested = false;
    const requestCancellation = (): void => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      try {
        cancelTask = Promise.resolve(cancel()).then(() => {}, () => {});
      } catch {
        cancelTask = Promise.resolve();
      }
    };
    controller.signal.addEventListener("abort", requestCancellation, { once: true });

    const completionSettled = Promise.resolve(completion).then(() => {}, () => {});
    const settled = completionSettled.then(() => cancelTask);
    const entry: RegisteredOperation = { ...scope, id, controller, settled };
    this.operations.set(id, entry);
    void settled.finally(() => {
      controller.signal.removeEventListener("abort", requestCancellation);
      if (this.operations.get(id) === entry) this.operations.delete(id);
    });

    // A descendant may be adopted after deletion/shutdown closed admission but
    // before its parent settles. It remains part of the drain and is cancelled
    // immediately rather than becoming an unowned background task.
    if (this.shuttingDown || this.blockedProjects.has(scope.projectId)) {
      controller.abort(new RuntimeScopeUnavailableError(scope));
    }
  }

  acquireOperationLease(scope: RuntimeScope): { release: () => void } {
    this.assertAdmission(scope);
    const id = this.nextOperationId++;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: RegisteredOperation = { ...scope, id, controller, settled };
    this.operations.set(id, entry);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      resolveSettled();
    };
    void settled.finally(() => {
      if (this.operations.get(id) === entry) this.operations.delete(id);
    });
    return { release };
  }

  cancelOperations(scope: RuntimeScope): void {
    for (const operation of this.operations.values()) {
      if (matchesOperationScope(operation, scope)) operation.controller.abort();
    }
  }

  async waitForOperations(scope: RuntimeScope): Promise<void> {
    // An admitted operation (notably Main Agent) can create a supervised child
    // while cancellation is propagating. Drain until no matching owner remains
    // instead of waiting only for the first snapshot.
    while (true) {
      const matching = [...this.operations.values()].filter((operation) => matchesOperationScope(operation, scope));
      if (matching.length === 0) return;
      await Promise.allSettled(matching.map((operation) => operation.settled));
    }
  }

  async releaseProject(
    projectId: string,
    options: {
      /** Sharingan owns a SQLite identity; ordinary Design Projects do not. */
      deleteProjectRecord?: boolean;
      /** Runs after this deletion owns admission, before any live work is cancelled. */
      afterBlock?: () => void | Promise<void>;
      /**
       * Restore caller-owned pre-commit state before admission is reopened.
       * If this rollback fails, admission remains closed.
       */
      onPrecommitFailure?: (error: unknown) => void | Promise<void>;
      /** Deterministic crash checkpoint after the atomic DB cascade. */
      afterDelete?: () => void | Promise<void>;
    } = {},
  ): Promise<void> {
    assertProjectIdSegment(projectId);
    if (this.projectReleaseOwners.has(projectId)) {
      throw new RuntimeScopeUnavailableError({ projectId });
    }
    const releaseOwner = Symbol(projectId);
    this.projectReleaseOwners.set(projectId, releaseOwner);
    const scope = { projectId };
    this.blockedProjects.add(projectId);
    let databaseDeleted = false;
    let preserveAdmissionBlock = false;
    try {
      if (options.afterBlock) await options.afterBlock();
      this.cancelOperations(scope);
      await this.waitForOperations(scope);
      await this.options.releaseProjectResources?.({ projectId });
      if (options.deleteProjectRecord !== false) {
        this.options.store.deleteProject(projectId);
        databaseDeleted = true;
      }
      await options.afterDelete?.();
      await rm(join(this.options.dataDir, "projects", projectId), { recursive: true, force: true });
    } catch (error) {
      if (databaseDeleted) {
        preserveAdmissionBlock = true;
      } else {
        try {
          await options.onPrecommitFailure?.(error);
        } catch (rollbackError) {
          preserveAdmissionBlock = true;
          throw new AggregateError(
            [error, rollbackError],
            "Project deletion failed and its pre-commit rollback could not restore admission",
          );
        }
      }
      throw error;
    } finally {
      if (this.projectReleaseOwners.get(projectId) === releaseOwner) {
        this.projectReleaseOwners.delete(projectId);
        if (!preserveAdmissionBlock) this.blockedProjects.delete(projectId);
      }
    }
  }

  cancelAll(): void {
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
    const settled = await this.waitForOperationDrain(deadlineAt);
    const resourcesSettled = await this.waitForSettlements(
      [
        Promise.resolve().then(() => this.options.shutdownResources?.()).then(() => {}),
      ],
      deadlineAt,
    );
    return settled && resourcesSettled;
  }

  private async waitForOperationDrain(deadlineAt: number): Promise<boolean> {
    while (true) {
      const settlements = [...this.operations.values()].map((operation) => operation.settled);
      if (settlements.length === 0) return true;
      if (!(await this.waitForSettlements(settlements, deadlineAt))) return false;
    }
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
