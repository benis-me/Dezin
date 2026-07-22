import type { Store } from "../../../../packages/core/src/index.ts";
import type { DesignRegistry } from "../../../../packages/design/src/index.ts";
import { createWorkspaceContextPackRepository } from "../context/context-pack-store.ts";
import type { RuntimeSupervisor } from "../runtime-supervisor.ts";
import type { SafeBoundedExternalFetcher } from "../resource-revision-source.ts";
import {
  createProductionArtifactGenerationExecutor,
  type ProductionArtifactGenerationOptions,
} from "./production-artifact-generation.ts";
import { GenerationPlanEventBroker } from "./generation-plan-events.ts";
import {
  createProductionGenerationSystem,
  type ProductionGenerationSystem,
  type ProductionGenerationSystemOptions,
} from "./production-generation-system.ts";
import { createProductionResourceGenerationImplementations } from "./production-resource-generators.ts";
import {
  createProductionResourceRuntimePorts,
  type ProductionResourceRuntimeOptions,
} from "./production-resource-runtime.ts";
import { createProductionResourceTaskExecutor } from "./production-resource-task-adapter.ts";
import { createProductionSharinganCaptureRevisionBundleSource } from "./production-sharingan-capture-revision-source.ts";
import { ProductionSharinganCaptureRevisionMaterializer } from "./sharingan-capture-revision-materializer.ts";
import {
  createProductionWorkspaceAgentOrchestrator,
} from "./production-workspace-agent.ts";
import type { ProductionAgentOrchestrator } from "./production-agent-orchestrator.ts";
import { createProductionScopedAgentTaskQueue } from "./production-scoped-agent-task-queue.ts";

export interface ProductionGenerationBootstrapOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly designRegistry: DesignRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly daemonOwnerId: string;
  readonly repositoryDirForWorkspace: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => string | Promise<string>;
  /** Shared daemon-owned SSRF-safe fetch boundary used by generated Research. */
  readonly resourceExternalFetch: SafeBoundedExternalFetcher;
  readonly events?: GenerationPlanEventBroker;
  readonly now?: ProductionGenerationSystemOptions["now"];
  readonly leaseMs?: ProductionGenerationSystemOptions["leaseMs"];
  readonly heartbeatMs?: ProductionGenerationSystemOptions["heartbeatMs"];
  readonly pollMs?: ProductionGenerationSystemOptions["pollMs"];
  readonly onError?: ProductionGenerationSystemOptions["onError"];
  readonly onRecovery?: ProductionGenerationSystemOptions["onRecovery"];
  /** Test seam; production always uses the configured BYOK Artifact provider factory. */
  readonly createArtifactRunner?: ProductionArtifactGenerationOptions["createRunner"];
  /** Test seam for external Artifact preview/render services; production leaves this unset. */
  readonly artifactQualityDependencies?: ProductionArtifactGenerationOptions["qualityDependencies"];
  /** Test seam; production always creates the Store-backed ports. */
  readonly createResourceRuntimePorts?: (
    options: ProductionResourceRuntimeOptions,
  ) => ReturnType<typeof createProductionResourceRuntimePorts>;
}

export interface ProductionGenerationBootstrap extends ProductionGenerationSystem {
  readonly workspaceAgent: ProductionAgentOrchestrator;
}

/**
 * Creates the one production Generation graph used by startup and HTTP.
 *
 * All leaves share the same Store, Context Pack repository, data root, event
 * broker, and runtime supervisor. This prevents a Plan request from observing a
 * different wake-up or Resource identity domain from the worker that executes
 * it.
 */
export function createProductionGenerationBootstrap(
  options: ProductionGenerationBootstrapOptions,
): ProductionGenerationBootstrap {
  const events = options.events ?? new GenerationPlanEventBroker({ onError: options.onError });
  const contextPacks = createWorkspaceContextPackRepository(options.store.workspace, {
    manifestRoot: options.dataDir,
  });
  const resourceRuntime = (options.createResourceRuntimePorts ?? createProductionResourceRuntimePorts)({
    store: options.store,
    dataDir: options.dataDir,
    researchExternalFetch: options.resourceExternalFetch,
  });
  const resourceImplementations = createProductionResourceGenerationImplementations({
    contextPacks,
    agent: resourceRuntime.agent,
    researchEvidence: resourceRuntime.researchEvidence,
    researchGroundedness: resourceRuntime.researchGroundedness,
    moodboardImages: resourceRuntime.moodboardImages,
    moodboardQuality: resourceRuntime.moodboardQuality,
    sharinganCaptures: resourceRuntime.sharinganCaptures,
  });
  const resources = createProductionResourceTaskExecutor({
    storageRoot: options.dataDir,
    store: options.store.workspace,
    implementations: resourceImplementations,
  });
  const sharinganCaptures = new ProductionSharinganCaptureRevisionMaterializer({
    source: createProductionSharinganCaptureRevisionBundleSource({
      store: options.store,
      dataDir: options.dataDir,
    }),
  });
  const artifacts = createProductionArtifactGenerationExecutor({
    store: options.store,
    dataDir: options.dataDir,
    designRegistry: options.designRegistry,
    repositoryDirForWorkspace: (workspaceId, signal) => (
      options.repositoryDirForWorkspace(workspaceId, signal)
    ),
    sharinganCaptures,
    reportError: options.onError,
    ...(options.createArtifactRunner === undefined
      ? {}
      : { createRunner: options.createArtifactRunner }),
    ...(options.artifactQualityDependencies === undefined
      ? {}
      : { qualityDependencies: options.artifactQualityDependencies }),
  });

  const system = createProductionGenerationSystem({
    store: options.store,
    dataDir: options.dataDir,
    designRegistry: options.designRegistry,
    runtimeSupervisor: options.runtimeSupervisor,
    daemonOwnerId: options.daemonOwnerId,
    repositoryDirForWorkspace: (workspaceId) => options.repositoryDirForWorkspace(workspaceId),
    artifacts,
    resources,
    events,
    now: options.now,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    pollMs: options.pollMs,
    onError: options.onError,
    onRecovery: options.onRecovery,
  });
  return Object.freeze({
    ...system,
    workspaceAgent: createProductionWorkspaceAgentOrchestrator({
      store: options.store,
      dataDir: options.dataDir,
      scopedTasks: createProductionScopedAgentTaskQueue({
        store: options.store,
        planService: system.planService,
        wakePlan(planId) {
          system.events.notify(planId);
          system.scheduler.requestTick();
        },
      }),
    }),
  });
}
