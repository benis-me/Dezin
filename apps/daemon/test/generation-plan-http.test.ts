import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../../../packages/core/src/index.ts";
import { createApp, createRuntimeSupervisor } from "../src/app.ts";
import {
  generationPlanHttpDetail,
  handleGenerationPlanEvents,
} from "../src/generation-plan-handler.ts";
import { GenerationPlanEventBroker } from "../src/orchestration/generation-plan-events.ts";

const FROZEN_CODEBUDDY_AGENT = Object.freeze({
  providerId: "codebuddy" as const,
  command: "codebuddy" as const,
  model: "gpt-5.6-sol",
});

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    agent: FROZEN_CODEBUDDY_AGENT,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createApprovedPlan(store: Store, name: string) {
  const project = store.createProject({ name, mode: "standard" });
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
    rationale: "Exercise durable Generation Plan HTTP",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  return { project, plan: approved.plan };
}

interface ServerContext {
  readonly base: string;
  readonly store: Store;
  readonly broker: GenerationPlanEventBroker;
  readonly runtime: {
    readonly ticks: string[];
    readonly cancellations: Array<{ projectId: string; planId: string }>;
  };
}

async function withServer(run: (context: ServerContext) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-generation-plan-http-"));
  const store = new Store(join(dataDir, "store.db"));
  const broker = new GenerationPlanEventBroker();
  const runtime = { ticks: [] as string[], cancellations: [] as Array<{ projectId: string; planId: string }> };
  const runtimeSupervisor = createRuntimeSupervisor({ dataDir, store });
  const server = createApp({
    store,
    dataDir,
    runtimeSupervisor,
    generationPlanEvents: broker,
    generationPlanRuntime: {
      requestTick() { runtime.ticks.push("tick"); },
      requestCancellation(projectId, planId) { runtime.cancellations.push({ projectId, planId }); },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, broker, runtime });
  } finally {
    await runtimeSupervisor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
  timeoutMs = 1_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (!output.includes(expected)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) assert.fail(`SSE stream did not include ${expected}: ${output}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`SSE read timed out for ${expected}`)), remaining);
        timer.unref?.();
      }),
    ]);
    if (result.done) assert.fail(`SSE stream ended before ${expected}: ${output}`);
    output += decoder.decode(result.value, { stream: true });
  }
  return output;
}

test("Generation Plan HTTP lists and returns authoritative durable detail with exact ownership", async () => {
  await withServer(async ({ base, store }) => {
    const { project, plan } = createApprovedPlan(store, "Plan reads");
    const foreign = createApprovedPlan(store, "Foreign Plan reads");
    const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);

    const listResponse = await fetch(`${base}/api/projects/${project.id}/workspace/plans`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      (await listResponse.json() as Array<{ id: string }>).map(({ id }) => id),
      [plan.id],
    );

    const detailResponse = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}`,
    );
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(await detailResponse.json(), { ...compiled, currentAttempts: [] });
    assert.equal(
      (await fetch(`${base}/api/projects/${foreign.project.id}/workspace/plans/${plan.id}`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/projects/missing/workspace/plans/${plan.id}`)).status,
      404,
    );
  });
});

test("Generation Plan HTTP exposes one narrow latest scoped Artifact Plan lookup", async () => {
  await withServer(async ({ base, store }) => {
    const project = store.createProject({ name: "Scoped Plan HTTP", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const reads: Array<[string, string]> = [];
    Object.defineProperty(store.workspace, "getLatestScopedArtifactGenerationPlanForProject", {
      configurable: true,
      value(projectId: string, artifactId: string) {
        reads.push([projectId, artifactId]);
        return artifactId === "artifact-1"
          ? {
              id: "plan-scoped",
              workspaceId: workspace.id,
              proposalId: "proposal-scoped",
              proposalRevision: 1,
              baseSnapshotId: workspace.activeSnapshotId,
              status: "running",
              constructionSealed: true,
              executionEpoch: 0,
              compileError: null,
              createdAt: 1,
              finishedAt: null,
            }
          : null;
      },
    });

    const exact = await fetch(
      `${base}/api/projects/${project.id}/artifacts/artifact-1/agent/latest-plan`,
    );
    const exactBody = await exact.json();
    assert.equal(exact.status, 200, JSON.stringify(exactBody));
    assert.deepEqual(exactBody, { planId: "plan-scoped" });

    const missing = await fetch(
      `${base}/api/projects/${project.id}/artifacts/missing/agent/latest-plan`,
    );
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { planId: null });
    assert.deepEqual(reads, [
      [project.id, "artifact-1"],
      [project.id, "missing"],
    ]);
  });
});

test("Generation Plan HTTP detail exposes only the exact current Attempt candidate identity and evidence", () => {
  const durable = {
    plan: { id: "plan-1", workspaceId: "workspace-1" },
    tasks: [{
      id: "task-1",
      planId: "plan-1",
      workspaceId: "workspace-1",
      currentAttempt: 2,
    }],
    dependencies: [],
  };
  const evidence = { protocol: "dezin.artifact-run.v1", selectedRound: 1 };
  const attempt = {
    taskId: "task-1",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 2,
    status: "candidate-ready",
    candidateRevisionId: "revision-candidate-2",
    candidateResourceRevisionId: null,
    candidateEvidence: evidence,
    candidateEvidenceHash: "a".repeat(64),
  };
  const reads: Array<[string, string, string, number]> = [];
  const detail = generationPlanHttpDetail(
    "project-1",
    durable as never,
    {
      getGenerationTaskAttemptForProject(projectId, planId, taskId, attemptNumber) {
        reads.push([projectId, planId, taskId, attemptNumber]);
        return attempt as never;
      },
    },
  );

  assert.deepEqual(reads, [["project-1", "plan-1", "task-1", 2]]);
  assert.deepEqual(detail.currentAttempts, [{
    taskId: "task-1",
    attempt: 2,
    status: "candidate-ready",
    candidateRevisionId: "revision-candidate-2",
    candidateResourceRevisionId: null,
    candidateEvidence: evidence,
    candidateEvidenceHash: "a".repeat(64),
  }]);
  assert.notEqual(detail.currentAttempts[0]?.candidateEvidence, evidence);
});

test("Generation Plan HTTP cancellation is exact, durable, owned, and wakes the runtime", async () => {
  await withServer(async ({ base, store, runtime }) => {
    const { project, plan } = createApprovedPlan(store, "Plan cancellation");
    const foreign = createApprovedPlan(store, "Foreign Plan cancellation");
    store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);

    const response = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    const detail = await response.json() as { plan: { status: string }; tasks: Array<{ status: string }> };
    assert.equal(detail.plan.status, "cancelled");
    assert.ok(detail.tasks.every((task) => task.status === "cancelled"));
    assert.deepEqual(runtime.cancellations, [{ projectId: project.id, planId: plan.id }]);
    assert.deepEqual(runtime.ticks, ["tick"]);
    assert.ok(store.workspace.listGenerationPlanEventsForProject(project.id, plan.id)
      .some((event) => event.type === "plan-cancelled"));

    const invalid = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(
      `${base}/api/projects/${foreign.project.id}/workspace/plans/${plan.id}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    )).status, 404);
  });
});

test("Generation Plan HTTP retry validates its exact typed body before ownership mutation", async () => {
  await withServer(async ({ base, store }) => {
    const { project, plan } = createApprovedPlan(store, "Plan retry validation");
    const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
    const taskId = compiled.tasks[0]!.id;
    const endpoint = `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/tasks/${taskId}/retry`;

    for (const body of [
      {},
      { mode: "freshest-context" },
      { mode: "same-context", force: true },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(
      store.workspace.getGenerationPlanDetailForProject(project.id, plan.id).tasks[0]!.status,
      compiled.tasks[0]!.status,
    );
  });
});

test("Generation Plan SSE replays commit-before-notify rows and advances only by durable cursor", async () => {
  await withServer(async ({ base, store, broker }) => {
    const { project, plan } = createApprovedPlan(store, "Plan SSE replay");
    store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);

    const response = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events?after=0`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reader = response.body!.getReader();
    const replay = await readUntil(reader, '"type":"plan-queued"');
    assert.match(replay, /id: 1\nevent: generation-plan/);

    const postNotifyRead = reader.read();
    broker.notify(plan.id);
    broker.notify(plan.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const cancellation = reader.cancel();
    const postNotify = await postNotifyRead;
    await cancellation;
    assert.equal((replay.match(/"type":"plan-queued"/g) ?? []).length, 1);
    assert.equal(postNotify.done, true, "notify without a newer durable cursor must not replay an old event");
  });
});

test("Generation Plan SSE observes a live durable transition and validates cursors before headers", async () => {
  await withServer(async ({ base, store, broker }) => {
    const { project, plan } = createApprovedPlan(store, "Plan SSE live");
    const response = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events`,
    );
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
    broker.notify(plan.id);
    const live = await readUntil(reader, '"type":"plan-queued"');
    assert.match(live, /id: 1/);
    await reader.cancel();

    assert.equal((await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events?after=-1`,
    )).status, 400);
    assert.equal((await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events?after=0&after=1`,
    )).status, 400);
    assert.equal((await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events?cursor=0`,
    )).status, 400);
  });
});

test("Generation Plan SSE remains subscribed while a failed Plan can be retried by another viewer", async () => {
  await withServer(async ({ base, store }) => {
    const { project, plan } = createApprovedPlan(store, "Plan SSE retry");
    const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
    const task = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
    assert.ok(task);
    store.workspace.recordGenerationTaskMaterializationFailureForProject(
      project.id,
      plan.id,
      {
        taskId: task.id,
        expectedFailureCount: 0,
        failureClass: "qa",
        error: { code: "VISUAL_QA_FAILED", message: "Visual QA failed" },
        nextEligibleAt: null,
      },
    );
    const failed = store.workspace.getGenerationPlanDetailForProject(project.id, plan.id);
    assert.equal(failed.plan.status, "failed");
    const after = store.workspace.listGenerationPlanEventsForProject(
      project.id,
      plan.id,
      { after: 0, limit: 1_000 },
    ).at(-1)?.sequence ?? 0;

    const response = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/events?after=${after}`,
    );
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    const retry = await fetch(
      `${base}/api/projects/${project.id}/workspace/plans/${plan.id}/tasks/${task.id}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "latest-context" }),
      },
    );
    assert.equal(retry.status, 200);
    const live = await readUntil(reader, '"type":"task-retry-requested"');
    assert.match(live, new RegExp(`id: ${after + 1}`));
    await reader.cancel();
  });
});

test("Generation Plan SSE contains response errors while writing its terminal error frame", async () => {
  const broker = new GenerationPlanEventBroker();
  let eventReads = 0;
  const request = Object.assign(new EventEmitter(), {
    url: "/events",
    headers: {},
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    endCalls: 0,
    writeHead() {},
    write(chunk: string) {
      return !chunk.startsWith("event: error");
    },
    end() {
      this.endCalls += 1;
      this.writableEnded = true;
    },
  });
  const deps = {
    store: {
      getProject() {
        return { id: "project-1", mode: "standard" };
      },
      workspace: {
        getGenerationPlanForProject() {
          return { id: "plan-1", workspaceId: "workspace-1" };
        },
        listGenerationPlanEventsForProject() {
          eventReads += 1;
          if (eventReads === 1) return [];
          throw new Error("durable replay unavailable");
        },
        getGenerationPlanDetailForProject() {
          return { plan: { status: "running" } };
        },
      },
    },
    generationPlanEvents: broker,
  };

  await handleGenerationPlanEvents(
    request as never,
    response as never,
    { id: "project-1", planId: "plan-1" },
    deps as never,
  );
  broker.notify("plan-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  response.emit("error", new Error("socket reset during error frame"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(response.endCalls, 1);
  assert.equal(response.writableEnded, true);
});
