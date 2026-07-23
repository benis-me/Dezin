import {
  createGenerationRecoveryBarrier,
  type GenerationRecoveryBarrier,
} from "./generation-recovery-barrier.ts";
import {
  createArtifactCandidateRefRecovery,
  type ArtifactCandidateRefRecoveryAdapterOptions,
} from "./artifact-candidate-ref-recovery-adapter.ts";
import {
  createGenerationRuntime,
  type GenerationRuntime,
  type GenerationRuntimeErrorEvent,
  type GenerationRuntimeRecoveryEvent,
  type GenerationRuntimeScheduler,
  type GenerationRuntimeTimerPort,
} from "./generation-runtime.ts";
import {
  OwnedResourceTaskPayloadRecovery,
  type ResourcePayloadCleanupStorePort,
  WorkspaceStoreResourceTaskPayloadReferenceGuard,
} from "./resource-task-payload-recovery.ts";
import { OwnedResourceTaskPayloadStaging } from "./resource-task-payload-staging.ts";
import {
  GenerationTaskEvidenceLifecycle,
  type GenerationTaskEvidenceLifecycleStorePort,
} from "./generation-task-evidence-lifecycle.ts";
import type { GenerationPlanRecoveryDeps } from "./recovery.ts";

export type ProductionGenerationWorkspaceStore =
  ArtifactCandidateRefRecoveryAdapterOptions["store"]
  & ResourcePayloadCleanupStorePort
  & GenerationTaskEvidenceLifecycleStorePort
  & Pick<GenerationPlanRecoveryDeps["store"], "recoverExpiredGenerationTaskAttempts">
  & {
    listGenerationPlans(projectId: string): readonly {
      readonly id: string;
      readonly status: string;
      readonly constructionSealed: boolean;
    }[];
  };

export interface ProductionGenerationProjectCatalog {
  listProjects(): readonly { readonly id: string }[];
}

export interface ProductionGenerationRecoveryCompositionOptions {
  readonly workspaceStore: ProductionGenerationWorkspaceStore;
  readonly dataDir: string;
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly timers?: GenerationRuntimeTimerPort;
  readonly artifactRefRecoveryIntervalMs?: number;
  readonly artifactRefRecoveryLimit?: number;
  readonly resourcePayloadRecoveryLimit?: number;
  readonly observeArtifactRefRecovery?: ArtifactCandidateRefRecoveryAdapterOptions["observe"];
  readonly onRecovery?: (event: GenerationRuntimeRecoveryEvent) => void;
  readonly onError?: (event: GenerationRuntimeErrorEvent) => void;
}

export interface ProductionGenerationRuntimeOptions {
  readonly projectCatalog: ProductionGenerationProjectCatalog;
  readonly workspaceStore: ProductionGenerationWorkspaceStore;
  readonly dataDir: string;
  readonly planRecovery: Omit<GenerationPlanRecoveryDeps, "store">;
  readonly scheduler: GenerationRuntimeScheduler;
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly timers?: GenerationRuntimeTimerPort;
  readonly artifactRefRecoveryIntervalMs?: number;
  readonly artifactRefRecoveryLimit?: number;
  readonly resourcePayloadRecoveryLimit?: number;
  readonly observeArtifactRefRecovery?: ArtifactCandidateRefRecoveryAdapterOptions["observe"];
  readonly onRecovery?: (event: GenerationRuntimeRecoveryEvent) => void;
  readonly onError?: (event: GenerationRuntimeErrorEvent) => void;
}

function recoveryAdapters(options: ProductionGenerationRecoveryCompositionOptions): {
  artifactRefRecovery: ReturnType<typeof createArtifactCandidateRefRecovery>;
  resourcePayloadRecovery: OwnedResourceTaskPayloadRecovery;
  evidenceRecovery: GenerationTaskEvidenceLifecycle;
} {
  const references = new WorkspaceStoreResourceTaskPayloadReferenceGuard({
    store: options.workspaceStore,
  });
  const staging = new OwnedResourceTaskPayloadStaging({
    storageRoot: options.dataDir,
    references,
    journal: references,
  });
  const evidenceRecovery = new GenerationTaskEvidenceLifecycle({
    dataDir: options.dataDir,
    store: options.workspaceStore,
  });
  return {
    artifactRefRecovery: createArtifactCandidateRefRecovery({
      store: options.workspaceStore,
      repositoryDirForWorkspace: options.repositoryDirForWorkspace,
      limit: options.artifactRefRecoveryLimit,
      observe: options.observeArtifactRefRecovery,
      evidenceLifecycle: evidenceRecovery,
      reportEvidenceCleanupError(error, identity) {
        console.warn(
          "[dezin:generation-task-evidence] startup publication cache cleanup failed",
          identity,
          error,
        );
      },
    }),
    resourcePayloadRecovery: new OwnedResourceTaskPayloadRecovery({
      staging,
      store: options.workspaceStore,
    }),
    evidenceRecovery,
  };
}

export function createProductionGenerationPlanRecoveryStore(options: {
  readonly projectCatalog: ProductionGenerationProjectCatalog;
  readonly workspaceStore: ProductionGenerationWorkspaceStore;
}): GenerationPlanRecoveryDeps["store"] {
  return {
    listApprovedGenerationPlanShells() {
      const shells = options.projectCatalog.listProjects().flatMap((project) =>
        options.workspaceStore.listGenerationPlans(project.id)
          .filter((plan) => plan.status === "approved" && !plan.constructionSealed)
          .map((plan) => ({ id: plan.id })),
      );
      return shells.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    },
    recoverExpiredGenerationTaskAttempts(now) {
      return options.workspaceStore.recoverExpiredGenerationTaskAttempts(now);
    },
  };
}

/**
 * The currently deployable startup slice: durable Artifact/Resource cleanup
 * only. It never admits Generation tasks and therefore cannot conceal missing
 * scheduler leaf adapters behind a no-op implementation.
 */
export function createProductionGenerationRecoveryBarrier(
  options: ProductionGenerationRecoveryCompositionOptions,
): GenerationRecoveryBarrier {
  const adapters = recoveryAdapters(options);
  return createGenerationRecoveryBarrier({
    ...adapters,
    timers: options.timers,
    intervalMs: options.artifactRefRecoveryIntervalMs,
    resourcePayloadRecoveryLimit: options.resourcePayloadRecoveryLimit,
    onRecovery: options.onRecovery,
    onError: options.onError,
  });
}

/**
 * Binds restart recovery to the daemon's durable Store and owned data root.
 *
 * Store closure is intentionally absent: the Store is shared with HTTP and
 * RuntimeSupervisor, so daemon shutdown remains its sole lifecycle owner.
 */
export function createProductionGenerationRuntime(
  options: ProductionGenerationRuntimeOptions,
): GenerationRuntime {
  if (options.scheduler === null || typeof options.scheduler !== "object"
    || typeof options.scheduler.start !== "function"
    || typeof options.scheduler.stop !== "function") {
    throw new Error("Production Generation scheduler leaf dependencies are unavailable");
  }
  const adapters = recoveryAdapters(options);

  return createGenerationRuntime({
    planRecovery: {
      ...options.planRecovery,
      store: createProductionGenerationPlanRecoveryStore(options),
    },
    ...adapters,
    scheduler: options.scheduler,
    timers: options.timers,
    artifactRefRecoveryIntervalMs: options.artifactRefRecoveryIntervalMs,
    resourcePayloadRecoveryLimit: options.resourcePayloadRecoveryLimit,
    onRecovery: options.onRecovery,
    onError: options.onError,
  });
}
