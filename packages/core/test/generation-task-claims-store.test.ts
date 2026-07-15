import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  Store,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptLease,
  type GenerationTaskClaim,
  type StoreClock,
} from "../src/index.ts";

interface GenerationTaskAttemptClaim {
  attempt: GenerationTaskAttempt;
  lease: GenerationTaskAttemptLease;
  claims: GenerationTaskClaim[];
}

interface GenerationTaskClaimStoreContract {
  listReadyGenerationTaskAttempts(limit?: number): GenerationTaskAttempt[];
  tryClaimGenerationTaskAttempt(input: {
    taskId: string;
    attempt: number;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): GenerationTaskAttemptClaim | null;
  heartbeatGenerationTaskAttempt(
    lease: GenerationTaskAttemptLease,
    now: number,
    leaseMs: number,
  ): unknown;
  releaseGenerationTaskAttemptClaims(lease: GenerationTaskAttemptLease): boolean;
}

function claimApi(store: Store): GenerationTaskClaimStoreContract {
  return store.workspace as unknown as GenerationTaskClaimStoreContract;
}

function fakeClock(prefix: string, initialNow = 50_000): StoreClock {
  let now = initialNow;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `${prefix}-${++id}`,
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createQueuedValidationAttempt(store: Store, label: string) {
  const project = store.createProject({ name: `Claim validation ${label}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: emptyGeneration(),
    rationale: `Queue render-QA validation ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  assert.ok(task);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  return { project, workspace, plan: compiled.plan, task, attempt };
}

interface ResourceTargetFixture {
  nodeId: string;
  resourceId: string;
  kind: "research";
  title: string;
  baseRevisionId: string;
  baseRevisionChecksum: string;
}

function createResourceTargets(store: Store, count: number, label: string) {
  const project = store.createProject({ name: `Claim resources ${label}`, mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const resources: ResourceTargetFixture[] = [];
  for (let index = 0; index < count; index += 1) {
    const current = store.workspace.getWorkspace(project.id)!;
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "research",
      title: `${label} research ${index + 1}`,
      defaultPinPolicy: "follow-head",
      baseGraphRevision: current.graphRevision,
      expectedSnapshotId: current.activeSnapshotId,
    });
    const baseRevision = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
      revisionId: `${label}-base-revision-${index + 1}`,
      parentRevisionId: null,
      manifestPath: `resource-revisions/${label}-${index + 1}/manifest.json`,
      summary: `${label} base ${index + 1}`,
      metadata: { fixture: label, index },
      checksum: `${index + 1}`.repeat(64).slice(0, 64),
      provenance: { source: "generation-task-claims-store-test" },
    });
    store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, baseRevision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: `Publish ${label} base ${index + 1}`,
    });
    resources.push({
      nodeId: created.node.id,
      resourceId: created.resource.id,
      kind: "research",
      title: created.resource.title,
      baseRevisionId: baseRevision.id,
      baseRevisionChecksum: baseRevision.checksum,
    });
  }
  return { project, resources };
}

function createQueuedResourceAttempts(
  store: Store,
  project: ReturnType<Store["createProject"]>,
  resources: readonly ResourceTargetFixture[],
  label: string,
  requiredImage: boolean,
) {
  const workspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      resourceOperations: resources.map((resource) => ({
        operation: "revise" as const,
        nodeId: resource.nodeId,
        resourceId: resource.resourceId,
        kind: resource.kind,
        title: resource.title,
        revisionPolicy: { kind: "generate" as const },
      })),
      capabilities: requiredImage
        ? [{ id: `${label}-image`, kind: "image" as const, required: true }]
        : [],
    },
    rationale: `Queue Resource attempts ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const tasks = compiled.tasks.filter((candidate) => candidate.kind === "resource");
  assert.equal(tasks.length, resources.length);
  const attempts = tasks.map((task, index) => {
    const observation = store.workspace.observeGenerationTaskMaterializationForProject(
      project.id,
      compiled.plan.id,
      task.id,
    );
    const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
    assert.ok(kernel);
    const resource = resources.find((candidate) => candidate.resourceId === task.target.id);
    assert.ok(resource);
    assert.equal(observation.baseRevisionId, resource.baseRevisionId);
    const pack = store.workspace.persistContextPack({
      id: `${label}-context-${index + 1}-${compiled.plan.id}`,
      workspaceId: workspace.id,
      graphRevision: workspace.graphRevision,
      target: { type: "resource", id: task.target.id },
      intent: "generate",
      messageChecksum: checksum(`${label}:${compiled.plan.id}:${index + 1}:message`),
      items: [
        {
          ref: { kind: "kernel", id: kernel.id, revisionId: kernel.id },
          resolvedKind: "kernel-revision",
          kernelRevisionId: kernel.id,
          checksum: kernel.checksum,
          reason: "design-kernel",
          trustLevel: "system",
          boundary: {},
          tokenEstimate: 1,
          provenance: {},
          provided: true,
        },
        {
          ref: {
            kind: "resource",
            id: resource.resourceId,
            resourceKind: resource.kind,
            revisionId: resource.baseRevisionId,
          },
          resolvedKind: "resource-revision",
          resourceRevisionId: resource.baseRevisionId,
          checksum: resource.baseRevisionChecksum,
          reason: "target-base",
          trustLevel: "trusted",
          boundary: {},
          tokenEstimate: 1,
          provenance: {},
          provided: true,
        },
      ],
      omissions: [],
      tokenEstimate: 2,
      manifestPath: `context-packs/${label}-${index + 1}.json`,
      hash: checksum(`${label}:${compiled.plan.id}:${index + 1}:pack`),
    });
    return store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
      ...observation,
      contextPackId: pack.id,
      retryContextPolicy: "same-context",
      executionMode: "full",
    });
  });
  return { project, workspace, plan: compiled.plan, tasks, attempts };
}

function claim(api: GenerationTaskClaimStoreContract, attempt: GenerationTaskAttempt, ownerId: string) {
  return api.tryClaimGenerationTaskAttempt({
    taskId: attempt.taskId,
    attempt: attempt.attempt,
    ownerId,
    now: 100_000,
    leaseMs: 30_000,
  });
}

function capacityKeys(store: Store, capacityClass: "agent" | "render-qa" | "image") {
  return (store.db.prepare(
    `SELECT claim_key FROM generation_task_claims
     WHERE claim_kind = 'capacity' AND claim_key LIKE ?
     ORDER BY claim_key`,
  ).all(`capacity:${capacityClass}:%`) as Array<{ claim_key: string }>).map((row) => row.claim_key);
}

function waitForWorkerMessage(worker: Worker): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for claim worker ${worker.threadId}`));
    }, 10_000);
    const onMessage = (message: Record<string, unknown>) => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function createClaimWorker(file: string, prefix: string) {
  return new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(({ Store }) => {
      let id = 0;
      const store = new Store(workerData.file, {
        now: () => 80_000 + ++id,
        id: () => workerData.prefix + "-" + ++id,
      });
      parentPort.postMessage({ kind: "ready" });
      parentPort.once("message", (message) => {
        try {
          const result = store.workspace.tryClaimGenerationTaskAttempt(message.input);
          parentPort.postMessage({ kind: "result", ok: true, result });
        } catch (error) {
          parentPort.postMessage({
            kind: "result",
            ok: false,
            name: error?.name,
            message: error?.message ?? String(error),
          });
        }
        setImmediate(() => store.close());
      });
    }).catch((error) => parentPort.postMessage({
      kind: "boot-error",
      message: error?.stack ?? String(error),
    }));
  `, {
    eval: true,
    workerData: {
      file,
      prefix,
      moduleUrl: new URL("../src/index.ts", import.meta.url).href,
    },
  });
}

test("two Store connections racing one queued Attempt produce exactly one durable claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-generation-claim-race-"));
  const file = join(dir, "race.db");
  const bootstrap = new Store(file, fakeClock("claim-race-bootstrap"));
  const fixture = createQueuedValidationAttempt(bootstrap, "race");
  bootstrap.close();

  const first = createClaimWorker(file, "claim-race-a");
  const second = createClaimWorker(file, "claim-race-b");
  try {
    assert.deepEqual((await waitForWorkerMessage(first)).kind, "ready");
    assert.deepEqual((await waitForWorkerMessage(second)).kind, "ready");
    const input = {
      taskId: fixture.attempt.taskId,
      attempt: fixture.attempt.attempt,
      ownerId: "racing-worker",
      now: 100_000,
      leaseMs: 30_000,
    };
    const firstResult = waitForWorkerMessage(first);
    const secondResult = waitForWorkerMessage(second);
    first.postMessage({ input: { ...input, ownerId: "racing-worker-a" } });
    second.postMessage({ input: { ...input, ownerId: "racing-worker-b" } });
    const results = await Promise.all([firstResult, secondResult]);
    const winners = results.filter((result) => result.ok === true && result.result !== null);
    assert.equal(winners.length, 1, JSON.stringify(results));

    const verifier = new Store(file, fakeClock("claim-race-verifier"));
    try {
      assert.equal(
        Number((verifier.db.prepare(
          "SELECT COUNT(DISTINCT lease_token) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
        ).get(fixture.attempt.taskId, fixture.attempt.attempt) as { count: number }).count),
        1,
      );
      assert.equal(
        (verifier.db.prepare(
          "SELECT status FROM generation_task_attempts WHERE task_id = ? AND attempt = ?",
        ).get(fixture.attempt.taskId, fixture.attempt.attempt) as { status: string }).status,
        "running",
      );
    } finally {
      verifier.close();
    }
  } finally {
    await Promise.allSettled([first.terminate(), second.terminate()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed capacity slots enforce exact agent 3, render-qa 2, and image 2 bounds", async (t) => {
  await t.test("agent slots admit three Resource attempts and retain the fourth queued", () => {
    const store = new Store(":memory:", fakeClock("agent-capacity"));
    try {
      const targets = createResourceTargets(store, 4, "agent-capacity");
      const fixture = createQueuedResourceAttempts(
        store,
        targets.project,
        targets.resources,
        "agent-capacity",
        false,
      );
      const api = claimApi(store);
      assert.equal(api.listReadyGenerationTaskAttempts().length, 4);
      assert.deepEqual(fixture.attempts.map((attempt, index) => Boolean(claim(api, attempt, `agent-${index + 1}`))), [
        true,
        true,
        true,
        false,
      ]);
      assert.deepEqual(capacityKeys(store, "agent"), [
        "capacity:agent:1",
        "capacity:agent:2",
        "capacity:agent:3",
      ]);
      assert.equal(api.listReadyGenerationTaskAttempts().length, 1);
    } finally {
      store.close();
    }
  });

  await t.test("render-qa slots admit two validation attempts and retain the third queued", () => {
    const store = new Store(":memory:", fakeClock("render-capacity"));
    try {
      const fixtures = [1, 2, 3].map((index) => createQueuedValidationAttempt(store, `render-${index}`));
      const api = claimApi(store);
      assert.deepEqual(fixtures.map((fixture, index) => Boolean(claim(api, fixture.attempt, `render-${index + 1}`))), [
        true,
        true,
        false,
      ]);
      assert.deepEqual(capacityKeys(store, "render-qa"), [
        "capacity:render-qa:1",
        "capacity:render-qa:2",
      ]);
    } finally {
      store.close();
    }
  });

  await t.test("image slots bind independently and stop a third image task before agent capacity is full", () => {
    const store = new Store(":memory:", fakeClock("image-capacity"));
    try {
      const targets = createResourceTargets(store, 3, "image-capacity");
      const fixture = createQueuedResourceAttempts(
        store,
        targets.project,
        targets.resources,
        "image-capacity",
        true,
      );
      const api = claimApi(store);
      assert.deepEqual(fixture.attempts.map((attempt, index) => Boolean(claim(api, attempt, `image-${index + 1}`))), [
        true,
        true,
        false,
      ]);
      assert.deepEqual(capacityKeys(store, "image"), [
        "capacity:image:1",
        "capacity:image:2",
      ]);
      assert.deepEqual(capacityKeys(store, "agent"), [
        "capacity:agent:1",
        "capacity:agent:2",
      ]);
    } finally {
      store.close();
    }
  });
});

test("two queued attempts for the same target cannot hold overlapping writer claims", () => {
  const store = new Store(":memory:", fakeClock("writer-exclusion"));
  try {
    const targets = createResourceTargets(store, 1, "writer-exclusion");
    const first = createQueuedResourceAttempts(
      store,
      targets.project,
      targets.resources,
      "writer-exclusion-a",
      false,
    );
    const second = createQueuedResourceAttempts(
      store,
      targets.project,
      targets.resources,
      "writer-exclusion-b",
      false,
    );
    const api = claimApi(store);
    const firstClaim = claim(api, first.attempts[0]!, "writer-owner-a");
    assert.ok(firstClaim);
    assert.equal(claim(api, second.attempts[0]!, "writer-owner-b"), null);
    const writerRows = store.db.prepare(
      `SELECT claim_key, task_id FROM generation_task_claims
       WHERE claim_kind = 'writer'
       ORDER BY claim_key`,
    ).all() as Array<{ claim_key: string; task_id: string }>;
    assert.equal(writerRows.length, 1);
    assert.equal(writerRows[0]?.task_id, first.attempts[0]!.taskId);
    assert.equal(
      writerRows[0]!.claim_key,
      `writer:resource:${Buffer.from(first.workspace.id, "utf8").toString("hex")}`
        + `:${Buffer.from(targets.resources[0]!.resourceId, "utf8").toString("hex")}`,
    );
  } finally {
    store.close();
  }
});

test("claiming atomically commits Attempt running, Task running, Plan running, claims, and one durable event", () => {
  const store = new Store(":memory:", fakeClock("claim-atomic-success"));
  try {
    const fixture = createQueuedValidationAttempt(store, "atomic-success");
    const result = claim(claimApi(store), fixture.attempt, "atomic-owner");
    assert.ok(result);
    assert.equal(result.attempt.status, "running");
    assert.equal(result.lease.ownerId, "atomic-owner");
    assert.ok(result.claims.length > 0);

    assert.deepEqual({ ...(store.db.prepare(
      `SELECT
         (SELECT status FROM generation_task_attempts WHERE task_id = ? AND attempt = ?) AS attempt_status,
         (SELECT status FROM generation_tasks WHERE id = ?) AS task_status,
         (SELECT status FROM generation_plans WHERE id = ?) AS plan_status,
         (SELECT COUNT(*) FROM generation_task_claims WHERE task_id = ? AND attempt = ?) AS claim_count,
         (SELECT COUNT(*) FROM generation_plan_events
          WHERE plan_id = ? AND task_id = ? AND type = 'task-running') AS event_count`,
    ).get(
      fixture.task.id,
      fixture.attempt.attempt,
      fixture.task.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
      fixture.plan.id,
      fixture.task.id,
    ) as Record<string, unknown>) }, {
      attempt_status: "running",
      task_status: "running",
      plan_status: "running",
      claim_count: result.claims.length,
      event_count: 1,
    });
  } finally {
    store.close();
  }
});

test("a durable task-running event failure rolls the entire claim transition back", () => {
  const store = new Store(":memory:", fakeClock("claim-atomic-rollback"));
  try {
    const fixture = createQueuedValidationAttempt(store, "atomic-rollback");
    store.db.exec(`
      CREATE TRIGGER reject_task_running_event
      BEFORE INSERT ON generation_plan_events
      WHEN NEW.type = 'task-running'
      BEGIN SELECT RAISE(ABORT, 'reject task-running event'); END;
    `);
    assert.throws(
      () => claim(claimApi(store), fixture.attempt, "rollback-owner"),
      /task-running|event|reject/i,
    );
    assert.deepEqual({ ...(store.db.prepare(
      `SELECT
         (SELECT status FROM generation_task_attempts WHERE task_id = ? AND attempt = ?) AS attempt_status,
         (SELECT owner_id FROM generation_task_attempts WHERE task_id = ? AND attempt = ?) AS owner_id,
         (SELECT status FROM generation_tasks WHERE id = ?) AS task_status,
         (SELECT status FROM generation_plans WHERE id = ?) AS plan_status,
         (SELECT COUNT(*) FROM generation_task_claims WHERE task_id = ? AND attempt = ?) AS claim_count,
         (SELECT COUNT(*) FROM generation_plan_events
          WHERE plan_id = ? AND task_id = ? AND type = 'task-running') AS event_count`,
    ).get(
      fixture.task.id,
      fixture.attempt.attempt,
      fixture.task.id,
      fixture.attempt.attempt,
      fixture.task.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
      fixture.plan.id,
      fixture.task.id,
    ) as Record<string, unknown>) }, {
      attempt_status: "queued",
      owner_id: null,
      task_status: "queued",
      plan_status: "queued",
      claim_count: 0,
      event_count: 0,
    });
  } finally {
    store.close();
  }
});

test("stale lease tokens cannot heartbeat or release the current worker's claims", () => {
  const store = new Store(":memory:", fakeClock("claim-fence"));
  try {
    const fixture = createQueuedValidationAttempt(store, "lease-fence");
    const api = claimApi(store);
    const first = claim(api, fixture.attempt, "lease-owner-a");
    assert.ok(first);
    api.heartbeatGenerationTaskAttempt(first.lease, 105_000, 30_000);
    const heartbeatExpiry = (store.db.prepare(
      "SELECT lease_expires_at FROM generation_task_attempts WHERE task_id = ? AND attempt = ?",
    ).get(first.lease.taskId, first.lease.attempt) as { lease_expires_at: number }).lease_expires_at;
    assert.equal(heartbeatExpiry, 135_000);

    const stale = {
      ...first.lease,
      ownerId: "stale-lease-owner",
      leaseToken: "stale-lease-token",
    };
    assert.throws(
      () => api.heartbeatGenerationTaskAttempt(stale, 106_000, 30_000),
      /lease|token|stale|fence/i,
    );
    assert.equal(api.releaseGenerationTaskAttemptClaims(stale), false);
    assert.deepEqual((store.db.prepare(
      `SELECT DISTINCT owner_id, lease_token, lease_expires_at
       FROM generation_task_claims
       WHERE task_id = ? AND attempt = ?`,
    ).all(first.lease.taskId, first.lease.attempt) as Array<Record<string, unknown>>).map((row) => ({ ...row })), [{
      owner_id: first.lease.ownerId,
      lease_token: first.lease.leaseToken,
      lease_expires_at: 135_000,
    }]);
  } finally {
    store.close();
  }
});
