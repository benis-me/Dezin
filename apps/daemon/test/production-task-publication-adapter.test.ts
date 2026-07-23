import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationTaskAttemptClaim } from "../../../packages/core/src/index.ts";
import type { ResourcePreparedCandidate } from "../src/orchestration/generation-task-executor.ts";
import type { GenerationTaskEvidenceLifecycleStorePort } from "../src/orchestration/generation-task-evidence-lifecycle.ts";
import {
  GenerationTaskPublication,
  type GenerationTaskPublicationStorePort,
} from "../src/orchestration/task-publication.ts";

interface ProductionTaskPublicationModule {
  createProductionGenerationTaskPublication(options: {
    store: GenerationTaskPublicationStorePort & GenerationTaskEvidenceLifecycleStorePort;
    repositoryDirForWorkspace(workspaceId: string): string | Promise<string>;
    dataDir: string;
    sourceAuthorityForRevision(
      input: { workspaceId: string; resourceId: string; revisionId: string },
      signal: AbortSignal,
    ): {
      resourceId: string;
      revisionId: string;
      revisionChecksum: string;
    } | null;
    projectIdForWorkspace(workspaceId: string): string;
    notifyPlan(planId: string): void;
  }): GenerationTaskPublication;
  ProductionTaskPublicationAdapterError: new (...args: never[]) => Error;
}

async function productionModule(): Promise<Partial<ProductionTaskPublicationModule>> {
  return import("../src/orchestration/production-task-publication-adapter.ts")
    .catch(() => ({})) as Promise<Partial<ProductionTaskPublicationModule>>;
}

function claim(): GenerationTaskAttemptClaim {
  return {
    task: {
      id: "task-resource",
      planId: "plan-1",
      workspaceId: "workspace-1",
      kind: "resource",
      target: { type: "resource", workspaceId: "workspace-1", id: "resource-1" },
    },
    attempt: { taskId: "task-resource", attempt: 1 },
    lease: {
      taskId: "task-resource",
      workspaceId: "workspace-1",
      attempt: 1,
      ownerId: "owner",
      leaseToken: "token",
    },
    claims: [],
  } as unknown as GenerationTaskAttemptClaim;
}

function result(): ResourcePreparedCandidate {
  return {
    kind: "resource-candidate",
    taskId: "task-resource",
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    revision: {
      revisionId: "revision-1",
      parentRevisionId: null,
      manifestPath: "resource-revisions/revision-1/manifest.json",
      summary: "Research",
      metadata: {},
      checksum: "a".repeat(64),
      provenance: {},
    },
    evidence: { protocol: "resource-evidence" },
  };
}

function store(
  calls: string[],
): GenerationTaskPublicationStorePort & GenerationTaskEvidenceLifecycleStorePort {
  return {
    getArtifactRevision() { return null; },
    stageGenerationTaskCandidateForProject(projectId, planId, input) {
      calls.push(`stage:${projectId}:${planId}:${input.candidate.kind}`);
      return { attempt: {} as never, artifactRevision: null, resourceRevision: {} as never };
    },
    publishGenerationTaskCandidateForProject(projectId, planId) {
      calls.push(`publish:${projectId}:${planId}`);
      return {} as never;
    },
    completeGenerationTaskValidationForProject() { return {} as never; },
    publishGenerationPlanCheckpointForProject() { return {} as never; },
    finishGenerationTaskAttemptForProject() { return {} as never; },
    getGenerationTaskAttemptForProject() { return null; },
  };
}

test("production TaskPublication factory binds durable publication and requires explicit Git retention ownership", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionGenerationTaskPublication, "function");
  if (typeof module.createProductionGenerationTaskPublication !== "function") return;
  const calls: string[] = [];
  let authorityReads = 0;
  const publication = module.createProductionGenerationTaskPublication({
    store: store(calls),
    repositoryDirForWorkspace: (workspaceId) => `/projects/${workspaceId}`,
    dataDir: "/data",
    sourceAuthorityForRevision() {
      authorityReads += 1;
      return null;
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan: (planId) => calls.push(`notify:${planId}`),
  });
  assert.ok(publication instanceof GenerationTaskPublication);

  await publication.publishPreparedResult(claim(), result(), new AbortController().signal);

  assert.deepEqual(calls, [
    "stage:project-1:plan-1:resource",
    "notify:plan-1",
    "publish:project-1:plan-1",
    "notify:plan-1",
  ]);
  assert.equal(authorityReads, 0, "Resource publication must not read Artifact source authority");
});

test("production TaskPublication factory fails closed when the retention repository adapter is missing", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionGenerationTaskPublication, "function");
  assert.equal(typeof module.ProductionTaskPublicationAdapterError, "function");
  const createPublication = module.createProductionGenerationTaskPublication;
  const ErrorType = module.ProductionTaskPublicationAdapterError;
  if (typeof createPublication !== "function" || typeof ErrorType !== "function") return;
  assert.throws(
    () => createPublication({
      store: store([]),
      repositoryDirForWorkspace: undefined as never,
      dataDir: "/data",
      sourceAuthorityForRevision: () => null,
      projectIdForWorkspace: () => "project-1",
      notifyPlan() {},
    }),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code === "PRODUCTION_TASK_RETENTION_UNAVAILABLE"
      && (error as Error & { failureClass?: string }).failureClass === "build-infrastructure",
  );
});

test("production TaskPublication factory rejects accessor-backed Store ports without invoking them", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionGenerationTaskPublication, "function");
  assert.equal(typeof module.ProductionTaskPublicationAdapterError, "function");
  const createPublication = module.createProductionGenerationTaskPublication;
  const ErrorType = module.ProductionTaskPublicationAdapterError;
  if (typeof createPublication !== "function" || typeof ErrorType !== "function") return;
  let invoked = false;
  const hostileStore = Object.defineProperty({}, "getArtifactRevision", {
    enumerable: true,
    get() {
      invoked = true;
      return () => null;
    },
  });

  assert.throws(
    () => createPublication({
      store: hostileStore as never,
      repositoryDirForWorkspace: () => "/projects/workspace-1",
      dataDir: "/data",
      sourceAuthorityForRevision: () => null,
      projectIdForWorkspace: () => "project-1",
      notifyPlan() {},
    }),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code
        === "PRODUCTION_TASK_PUBLICATION_CONFIGURATION_INVALID",
  );
  assert.equal(invoked, false);
});

test("production TaskPublication factory fails closed without durable evidence ownership", async (t) => {
  const module = await productionModule();
  const createPublication = module.createProductionGenerationTaskPublication;
  const ErrorType = module.ProductionTaskPublicationAdapterError;
  if (typeof createPublication !== "function" || typeof ErrorType !== "function") return;
  const base = {
    store: store([]),
    repositoryDirForWorkspace: () => "/projects/workspace-1",
    dataDir: "/data",
    sourceAuthorityForRevision: () => null,
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  };
  for (const testCase of [
    { name: "missing data directory", options: { ...base, dataDir: undefined as never } },
    { name: "missing authority resolver", options: { ...base, sourceAuthorityForRevision: undefined as never } },
  ]) {
    await t.test(testCase.name, () => {
      assert.throws(
        () => createPublication(testCase.options),
        (error: unknown) => error instanceof ErrorType
          && (error as Error & { code?: string }).code === "PRODUCTION_TASK_RETENTION_UNAVAILABLE",
      );
    });
  }

  let invoked = false;
  const accessorBacked = Object.defineProperty({ ...base }, "sourceAuthorityForRevision", {
    enumerable: true,
    get() {
      invoked = true;
      return () => null;
    },
  });
  assert.throws(
    () => createPublication(accessorBacked),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code
        === "PRODUCTION_TASK_PUBLICATION_CONFIGURATION_INVALID",
  );
  assert.equal(invoked, false);
});
