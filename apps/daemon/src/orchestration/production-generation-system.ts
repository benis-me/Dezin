import type {
  GenerationTask,
  ResourceRevision,
  Store,
  WorkspaceSnapshotRecord,
} from "../../../../packages/core/src/index.ts";
import type { DesignRegistry } from "../../../../packages/design/src/index.ts";
import type { RuntimeSupervisor } from "../runtime-supervisor.ts";
import { GenerationPlanEventBroker } from "./generation-plan-events.ts";
import type { GenerationPlanRuntimeControl } from "./generation-plan-control.ts";
import {
  GenerationPlanService,
  type GenerationPlanMaterializationSummary,
  type GenerationTaskRebaseReconciler,
} from "./generation-plan-service.ts";
import { GenerationScheduler } from "./generation-scheduler.ts";
import {
  GenerationTaskExecutor,
  type ArtifactGenerationTaskLeafExecutor,
  type ResourceGenerationTaskLeafExecutor,
} from "./generation-task-executor.ts";
import {
  createProductionGenerationRuntime,
  type ProductionGenerationRuntimeOptions,
} from "./generation-runtime-composition.ts";
import type { GenerationRuntime } from "./generation-runtime.ts";
import { GitArtifactSourceBaseResolver } from "./git-source-base-resolver.ts";
import { createProductionGenerationTaskContextResolver } from "./production-generation-context.ts";
import { createProductionGenerationTaskPublication } from "./production-task-publication-adapter.ts";
import {
  PrototypeValidationExecutor,
  type PrototypeValidationStorePort,
} from "./prototype-validation-executor.ts";

export interface ProductionGenerationSystemOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly designRegistry: DesignRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly daemonOwnerId: string;
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly artifacts: ArtifactGenerationTaskLeafExecutor;
  readonly resources: ResourceGenerationTaskLeafExecutor;
  readonly events?: GenerationPlanEventBroker;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly onRecovery?: ProductionGenerationRuntimeOptions["onRecovery"];
}

export interface ProductionGenerationSystem {
  readonly runtime: GenerationRuntime;
  readonly scheduler: GenerationScheduler;
  readonly planService: GenerationPlanService;
  readonly events: GenerationPlanEventBroker;
  readonly control: GenerationPlanRuntimeControl;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Generation rebase reconciliation aborted", "AbortError");
  }
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ProductionGenerationOwnership {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  listProjectIds(): string[] {
    return this.#store.listProjects().map((project) => project.id).sort(compareBinary);
  }

  projectIdForWorkspace(workspaceId: string): string {
    const matches = this.#store.listProjects().filter(
      (project) => this.#store.workspace.getWorkspace(project.id)?.id === workspaceId,
    );
    if (matches.length !== 1) {
      throw new Error(`Generation Workspace has no unique Project owner: ${workspaceId}`);
    }
    return matches[0]!.id;
  }

  projectIdForPlan(planId: string): string {
    const matches = this.#store.listProjects().filter((project) =>
      this.#store.workspace.listGenerationPlans(project.id).some((plan) => plan.id === planId));
    if (matches.length !== 1) {
      throw new Error(`Generation Plan has no unique Project owner: ${planId}`);
    }
    return matches[0]!.id;
  }
}

class WorkspaceGenerationRebaseReconciler implements GenerationTaskRebaseReconciler {
  readonly #store: Store;
  readonly #ownership: ProductionGenerationOwnership;
  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(input: {
    store: Store;
    ownership: ProductionGenerationOwnership;
    onError?: (error: unknown) => void;
  }) {
    this.#store = input.store;
    this.#ownership = input.ownership;
    this.#onError = input.onError;
  }

  async reconcileNeedsRebaseTasks(signal: AbortSignal): Promise<GenerationPlanMaterializationSummary> {
    const touchedPlanIds = new Set<string>();
    for (const projectId of this.#ownership.listProjectIds()) {
      checkAbort(signal);
      let activePlanIds: string[];
      try {
        activePlanIds = this.#store.workspace.listActiveGenerationPlanIdsForProject(projectId);
      } catch (error) {
        this.#report(error);
        continue;
      }
      for (const planId of activePlanIds.sort(compareBinary)) {
        checkAbort(signal);
        let tasks: GenerationTask[];
        try {
          tasks = this.#store.workspace.getGenerationPlanDetailForProject(projectId, planId).tasks;
        } catch (error) {
          this.#report(error);
          continue;
        }
        for (const task of tasks.filter((candidate) => candidate.status === "needs-rebase")) {
          checkAbort(signal);
          try {
            this.#store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
              projectId,
              planId,
              task.id,
            );
            touchedPlanIds.add(planId);
          } catch (error) {
            this.#report(error);
          }
          await Promise.resolve();
        }
      }
    }
    return { planIds: [...touchedPlanIds].sort(compareBinary) };
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Per-Task reconciliation isolation is correctness-critical; reporting is not.
    }
  }
}

function prototypeValidationStore(
  store: Store,
  ownership: ProductionGenerationOwnership,
): PrototypeValidationStorePort {
  return {
    readSnapshot(workspaceId, snapshotId, signal): WorkspaceSnapshotRecord | null {
      checkAbort(signal);
      const projectId = ownership.projectIdForWorkspace(workspaceId);
      return store.workspace.getSnapshotForProject(projectId, snapshotId);
    },
    readArtifactRevision(workspaceId, revisionId, signal) {
      checkAbort(signal);
      const revision = store.workspace.getArtifactRevision(revisionId);
      return revision?.workspaceId === workspaceId ? revision : null;
    },
    readResourceRevision(workspaceId, revisionId, signal): ResourceRevision | null {
      checkAbort(signal);
      ownership.projectIdForWorkspace(workspaceId);
      return store.workspace.getResourceRevisionForWorkspace(workspaceId, revisionId);
    },
  };
}

/**
 * Complete production Task 12 composition: one Store, one broker, one Plan
 * service, one bounded scheduler, and the real publication/recovery lifecycle.
 */
export function createProductionGenerationSystem(
  options: ProductionGenerationSystemOptions,
): ProductionGenerationSystem {
  const ownership = new ProductionGenerationOwnership(options.store);
  const events = options.events ?? new GenerationPlanEventBroker({ onError: options.onError });
  const contextResolver = createProductionGenerationTaskContextResolver({
    store: options.store,
    dataDir: options.dataDir,
    designRegistry: options.designRegistry,
    repositoryDirForWorkspace: options.repositoryDirForWorkspace,
  });
  const sourceBaseResolver = new GitArtifactSourceBaseResolver({
    workspace: options.store.workspace,
    repositoryDirForWorkspace: options.repositoryDirForWorkspace,
  });
  const planService = new GenerationPlanService({
    store: options.store.workspace,
    projectLookup: {
      listProjectIds: () => ownership.listProjectIds(),
      projectIdForPlan: (planId) => ownership.projectIdForPlan(planId),
    },
    contextResolver,
    sourceBaseResolver,
    rebaseReconciler: new WorkspaceGenerationRebaseReconciler({
      store: options.store,
      ownership,
      onError: options.onError,
    }),
    onError: options.onError,
  });
  const publication = createProductionGenerationTaskPublication({
    store: options.store.workspace,
    repositoryDirForWorkspace: options.repositoryDirForWorkspace,
    projectIdForWorkspace: (workspaceId) => ownership.projectIdForWorkspace(workspaceId),
    notifyPlan: (planId) => events.notify(planId),
  });
  const executor = new GenerationTaskExecutor({
    artifacts: options.artifacts,
    resources: options.resources,
    prototypeValidation: new PrototypeValidationExecutor({
      store: prototypeValidationStore(options.store, ownership),
    }),
    publication,
    reportError: options.onError,
  });
  const clock = { now: options.now ?? (() => Date.now()) };
  const scheduler = new GenerationScheduler({
    store: options.store.workspace,
    planService,
    runtimeSupervisor: options.runtimeSupervisor,
    executor,
    events,
    projectIdForWorkspace: (workspaceId) => ownership.projectIdForWorkspace(workspaceId),
    ownerId: options.daemonOwnerId,
    clock,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    pollMs: options.pollMs,
    onError: options.onError,
  });
  const runtime = createProductionGenerationRuntime({
    projectCatalog: options.store,
    workspaceStore: options.store.workspace,
    dataDir: options.dataDir,
    planRecovery: {
      planService,
      clock,
      logger: {
        warn(context) {
          options.onError?.(context.error);
        },
      },
    },
    scheduler,
    repositoryDirForWorkspace: options.repositoryDirForWorkspace,
    onRecovery: options.onRecovery,
    onError: (event) => options.onError?.(event.error),
  });
  const control: GenerationPlanRuntimeControl = {
    requestTick: () => scheduler.requestTick(),
    requestCancellation: (projectId, planId) => scheduler.requestCancellation(projectId, planId),
  };
  return Object.freeze({ runtime, scheduler, planService, events, control });
}
