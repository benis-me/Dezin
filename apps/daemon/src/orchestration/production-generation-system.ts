import { createHash } from "node:crypto";

import type {
  GenerationTask,
  GenerationTaskPrototypeMarkerProof,
  GenerationTaskSourceVisualEvidenceAuthority,
  Resource,
  ResourceRevision,
  Store,
  WorkspaceSnapshotRecord,
} from "../../../../packages/core/src/index.ts";
import type { DesignRegistry } from "../../../../packages/design/src/index.ts";
import type { RuntimeSupervisor } from "../runtime-supervisor.ts";
import { SharinganSession } from "../sharingan-browser.ts";
import {
  acquirePreviewTargetLease,
  resolvePreviewTarget,
} from "../preview-target.ts";
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
import { resolveArtifactElementSelectionProvenance } from "./artifact-element-selection-provenance.ts";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ProductionPrototypeRuntimeSession = Pick<
  SharinganSession,
  "applyRenderFrame" | "close" | "probePrototypeMarker" | "setViewport" | "settle"
>;

/**
 * Owns the exact preview browser + lease pair as one resource scope. Abort,
 * deadline, probe, and close failures all converge through the same cleanup.
 */
export async function withProductionPrototypeMarkerRuntimeSession<T>(input: {
  lease: { url: string; release(): Promise<void> };
  signal: AbortSignal;
  run(session: ProductionPrototypeRuntimeSession): Promise<T>;
  openSession?: (
    url: string,
    options: { headless: boolean; signal: AbortSignal },
  ) => Promise<ProductionPrototypeRuntimeSession>;
}): Promise<T> {
  checkAbort(input.signal);
  let session: ProductionPrototypeRuntimeSession | null = null;
  let result: T | undefined;
  let primaryFailure: unknown;
  let failed = false;
  try {
    session = await (input.openSession ?? SharinganSession.open)(
      input.lease.url,
      { headless: true, signal: input.signal },
    );
    result = await input.run(session);
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(async () => { if (session) await session.close(); }),
    Promise.resolve().then(() => input.lease.release()),
  ]);
  const cleanupFailures = cleanup.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []);
  if (failed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "Prototype marker runtime failed and its browser or preview lease cleanup also failed",
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      "Prototype marker browser and preview lease cleanup failed",
    );
  }
  return result as T;
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

export async function resolveProductionPrototypeMarkers(input: {
  store: Store;
  dataDir: string;
  projectId: string;
  markers: Array<{
    workspaceId: string;
    artifactId: string;
    revisionId: string;
    sourceMarkerId: string;
    trigger: "click" | "submit";
    receiptNonce: string;
  }>;
  signal: AbortSignal;
}): Promise<GenerationTaskPrototypeMarkerProof[]> {
  checkAbort(input.signal);
  if (input.markers.some((marker) => !/^[0-9a-f]{64}$/.test(marker.receiptNonce))) {
    throw new Error("Prototype marker runtime receipt nonce is invalid");
  }
  const selections = new Array<Awaited<ReturnType<typeof resolveArtifactElementSelectionProvenance>>>(
    input.markers.length,
  );
  for (const [index, marker] of input.markers.entries()) {
    selections[index] = await resolveArtifactElementSelectionProvenance({
      store: input.store,
      dataDir: input.dataDir,
      projectId: input.projectId,
      workspaceId: marker.workspaceId,
      artifactId: marker.artifactId,
      revisionId: marker.revisionId,
      designNodeId: marker.sourceMarkerId,
      signal: input.signal,
    });
  }
  const groups = new Map<string, number[]>();
  input.markers.forEach((marker, index) => {
    const key = `${marker.workspaceId}\0${marker.artifactId}\0${marker.revisionId}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const results = new Array<GenerationTaskPrototypeMarkerProof>(input.markers.length);
  for (const indexes of groups.values()) {
    checkAbort(input.signal);
    const firstIndex = indexes[0]!;
    const first = input.markers[firstIndex]!;
    const resolved = await resolvePreviewTarget({
      store: input.store,
      dataDir: input.dataDir,
    }, {
      kind: "artifact-revision",
      projectId: input.projectId,
      revisionId: first.revisionId,
    });
    if (resolved.workspaceId !== first.workspaceId
      || resolved.artifactId !== first.artifactId
      || resolved.revisionId !== first.revisionId
      || indexes.some((index) => selections[index]!.assemblyHash !== resolved.assemblyHash
        || selections[index]!.sourceTreeHash !== resolved.sourceTreeHash)) {
      throw new Error("Prototype marker immutable preview identity diverges from its source proof");
    }
    const rawFrames = resolved.renderSpec.frames;
    if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
      throw new Error("Prototype marker immutable preview has no exact responsive Frames");
    }
    const frames = rawFrames.map((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Prototype marker immutable preview Frame ${index} is invalid`);
      }
      const frame = value as Record<string, unknown>;
      if (typeof frame.id !== "string" || frame.id.length === 0
        || !Number.isSafeInteger(frame.width) || Number(frame.width) <= 0
        || !Number.isSafeInteger(frame.height) || Number(frame.height) <= 0
        || (Object.hasOwn(frame, "initialState")
          && (typeof frame.initialState !== "string" || frame.initialState.length === 0))
        || (Object.hasOwn(frame, "background")
          && (typeof frame.background !== "string" || frame.background.length === 0))) {
        throw new Error(`Prototype marker immutable preview Frame ${index} is invalid`);
      }
      return {
        frameId: frame.id,
        width: Number(frame.width),
        height: Number(frame.height),
        ...(typeof frame.initialState === "string" ? { initialState: frame.initialState } : {}),
        ...(Object.hasOwn(frame, "fixture") ? { fixture: structuredClone(frame.fixture) } : {}),
        ...(typeof frame.background === "string" ? { background: frame.background } : {}),
      };
    }).sort((left, right) => compareBinary(left.frameId, right.frameId));
    if (new Set(frames.map((frame) => frame.frameId)).size !== frames.length) {
      throw new Error("Prototype marker immutable preview Frames are ambiguous");
    }
    const observations = new Map<number, GenerationTaskPrototypeMarkerProof["runtimeProof"]["frames"]>(
      indexes.map((index) => [index, []]),
    );
    const lease = await acquirePreviewTargetLease({
      store: input.store,
      dataDir: input.dataDir,
    }, resolved, input.signal);
    await withProductionPrototypeMarkerRuntimeSession({
      lease,
      signal: input.signal,
      run: async (session) => {
        for (const frame of frames) {
          checkAbort(input.signal);
          await session.setViewport({ width: frame.width, height: frame.height, label: frame.frameId });
          const frameAttemptId = sha256(JSON.stringify([
            "dezin-prototype-runtime-frame-attempt-v1",
            frame.frameId,
            ...indexes.map((index) => input.markers[index]!.receiptNonce).sort(compareBinary),
          ]));
          await session.applyRenderFrame(lease.url, {
            frameId: frame.frameId,
            frameAttemptId,
            ...(frame.initialState === undefined ? {} : { initialState: frame.initialState }),
            ...(Object.hasOwn(frame, "fixture") ? { fixture: frame.fixture } : {}),
            ...(frame.background === undefined ? {} : { background: frame.background }),
          }, input.signal);
          await session.settle();
          for (const index of indexes) {
            const marker = input.markers[index]!;
            const observation = await session.probePrototypeMarker(
              marker.sourceMarkerId,
              marker.trigger,
              marker.receiptNonce,
              input.signal,
            );
            observations.get(index)!.push({
              frameId: frame.frameId,
              width: frame.width,
              height: frame.height,
              ...observation,
            });
          }
        }
      },
    });
    for (const index of indexes) {
      const marker = input.markers[index]!;
      const selection = selections[index]!;
      const dependencyLockHash = resolved.dependencyLockHash;
      const runtimeIdentityHash = sha256(JSON.stringify({
        protocol: "dezin.artifact-preview-runtime-identity.v1",
        workspaceId: marker.workspaceId,
        artifactId: marker.artifactId,
        artifactRevisionId: marker.revisionId,
        assemblyHash: selection.assemblyHash,
        sourceTreeHash: selection.sourceTreeHash,
        dependencyLockHash,
      }));
      const runtimeProof = {
        protocol: "dezin.artifact-prototype-runtime-proof.v1" as const,
        runtimeIdentityHash,
        workspaceId: marker.workspaceId,
        artifactId: marker.artifactId,
        artifactRevisionId: marker.revisionId,
        assemblyHash: selection.assemblyHash,
        designNodeId: marker.sourceMarkerId,
        trigger: marker.trigger,
        sourceTreeHash: selection.sourceTreeHash,
        dependencyLockHash,
        receiptNonce: marker.receiptNonce,
        frames: observations.get(index)!,
      };
      results[index] = {
        ...selection,
        runtimeProof: {
          ...runtimeProof,
          receiptHash: sha256(JSON.stringify(runtimeProof)),
        },
      };
    }
  }
  return results;
}

function prototypeValidationStore(
  store: Store,
  ownership: ProductionGenerationOwnership,
  dataDir: string,
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
    resolveArtifactMarkers(inputs, signal) {
      checkAbort(signal);
      if (inputs.length === 0) return [];
      const projectId = ownership.projectIdForWorkspace(inputs[0]!.workspaceId);
      if (inputs.some((input) => ownership.projectIdForWorkspace(input.workspaceId) !== projectId)) {
        throw new Error("Prototype marker batch spans multiple Projects");
      }
      return resolveProductionPrototypeMarkers({
        store,
        dataDir,
        projectId,
        markers: inputs,
        signal,
      });
    },
  };
}

export interface ProductionSharinganSourceAuthorityStore {
  getResourceForProject(projectId: string, resourceId: string): Resource | null;
  getResourceRevisionForWorkspace(workspaceId: string, revisionId: string): ResourceRevision | null;
}

/**
 * Resolves source evidence only through the owning immutable Sharingan Resource
 * and its exact Revision. Descriptor-supplied checksums never become authority.
 */
export function productionSharinganSourceAuthority(input: {
  store: ProductionSharinganSourceAuthorityStore;
  projectId: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
}): GenerationTaskSourceVisualEvidenceAuthority | null {
  const resource = input.store.getResourceForProject(input.projectId, input.resourceId);
  if (resource === null
    || resource.id !== input.resourceId
    || resource.workspaceId !== input.workspaceId
    || resource.kind !== "sharingan-capture") return null;
  const revision = input.store.getResourceRevisionForWorkspace(
    input.workspaceId,
    input.revisionId,
  );
  if (revision === null
    || revision.id !== input.revisionId
    || revision.workspaceId !== input.workspaceId
    || revision.resourceId !== resource.id) return null;
  return {
    resourceId: resource.id,
    revisionId: revision.id,
    revisionChecksum: revision.checksum,
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
    dataDir: options.dataDir,
    sourceAuthorityForRevision({ workspaceId, resourceId, revisionId }, signal) {
      checkAbort(signal);
      const authority = productionSharinganSourceAuthority({
        store: options.store.workspace,
        projectId: ownership.projectIdForWorkspace(workspaceId),
        workspaceId,
        resourceId,
        revisionId,
      });
      checkAbort(signal);
      return authority;
    },
    projectIdForWorkspace: (workspaceId) => ownership.projectIdForWorkspace(workspaceId),
    notifyPlan: (planId) => events.notify(planId),
  });
  const executor = new GenerationTaskExecutor({
    artifacts: options.artifacts,
    resources: options.resources,
    prototypeValidation: new PrototypeValidationExecutor({
      store: prototypeValidationStore(options.store, ownership, options.dataDir),
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
