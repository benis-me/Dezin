import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NodeSpawnerOptions,
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import {
  BUNDLED_DESIGN_SYSTEMS,
  DesignRegistry,
} from "../../../packages/design/src/index.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import { createProductionGenerationBootstrap } from "../src/orchestration/production-generation-bootstrap.ts";
import { createProductionResourceRuntimePorts } from "../src/orchestration/production-resource-runtime.ts";
import type { SafeBoundedExternalFetcher } from "../src/resource-revision-source.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";
import {
  frozenGeneratorFixture,
  frozenReviewerFixture,
} from "./support/generation-execution-authority-fixture.ts";

const TEST_CODEX_EXECUTABLE = "/trusted/codex/install/bin/codex";
const CLOCK_ACCELERATION = 100;
const RAW_PROVIDER_DIAGNOSTIC = "private-provider-diagnostic";
const RAW_STDERR_DIAGNOSTIC = "private transport stderr";

type JsonRecord = Record<string, unknown>;

function acceleratedClock() {
  const realEpoch = Date.now();
  let id = 0;
  const now = () => realEpoch + ((Date.now() - realEpoch) * CLOCK_ACCELERATION);
  return {
    now,
    storeClock: {
      now,
      id: () => `retry-ownership-${++id}`,
    },
  };
}

class HttpFailureSpawner implements ProcessSpawner {
  readonly inputs: SpawnInput[] = [];
  readonly httpStatus: number;

  constructor(httpStatus: number) {
    this.httpStatus = httpStatus;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.inputs.push(input);
    return {
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: `thread-retry-ownership-${this.inputs.length}`,
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.failed",
          error: {
            message: `HTTP ${this.httpStatus} provider failure ${RAW_PROVIDER_DIAGNOSTIC}`,
          },
        }),
      ].join("\n"),
      stderr: RAW_STDERR_DIAGNOSTIC,
      exitCode: 1,
    };
  }
}

interface TransportFailureScenario {
  readonly httpStatus: number;
  readonly reasonCode: "request-rejected" | "upstream-unavailable";
  readonly retryable: boolean;
  readonly attemptStatuses: readonly ("retryable-failed" | "failed")[];
  readonly retryDelays: readonly (number | null)[];
}

async function runTransportFailureScenario(scenario: TransportFailureScenario): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `dezin-resource-retry-ownership-${scenario.httpStatus}-`));
  const clock = acceleratedClock();
  const store = new Store(join(root, "store.db"), clock.storeClock);
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const errors: unknown[] = [];
  let system: ReturnType<typeof createProductionGenerationBootstrap> | null = null;
  try {
    const project = store.createProject({
      name: "Resource retry ownership",
      mode: "standard",
    });
    const initialWorkspace = store.workspace.ensureWorkspaceRecord(project.id);
    store.updateSettings({
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      apiBaseUrl: "https://project-provider-must-not-bind.example/v1",
      apiKey: "project-provider-secret-must-not-bind",
      aiProviderId: "azure-openai",
      aiProviderEnabled: true,
      aiProviderOrganization: "project-provider-org-must-not-bind",
      aiProviderProfiles: JSON.stringify({
        "azure-openai": {
          enabled: true,
          baseUrl: "https://project-provider-must-not-bind.example/v1",
          apiKey: "project-provider-secret-must-not-bind",
          models: "gpt-5.4-mini",
          organization: "project-provider-org-must-not-bind",
        },
      }),
      researchEnabled: true,
    });
    const settings = store.getSettings();
    const generationAgent = frozenGeneratorFixture(settings, {
      providerId: "codex",
      command: "codex",
      model: "gpt-5.4-mini",
    });
    const reviewerAgent = frozenReviewerFixture(settings, {
      providerId: "claude",
      command: "claude",
      model: null,
    }, generationAgent);
    const researchAgent = frozenGeneratorFixture(settings, {
      providerId: "codex",
      command: "codex",
      model: "gpt-5.4-mini",
    });

    const resourceId = "decision-research";
    const nodeId = "decision-research-node";
    const priorRevisionId = "decision-research-prior-revision";
    const sealedPrior = await sealResourceRevisionPayload({
      storageRoot: root,
      workspaceId: initialWorkspace.id,
      resourceId,
      revisionId: priorRevisionId,
      mimeType: "application/json",
      bytes: Buffer.from(JSON.stringify({
        format: "dezin-research-resource-bundle",
        version: 3,
        executiveSummary: "Immutable prior Research.",
        directions: [{
          id: "prior-direction",
          title: "Prior Direction",
          thesis: "Prior art remains immutable context only.",
        }],
      }), "utf8"),
    });
    store.workspace.createPublishedResourceForProject(project.id, {
      resourceId,
      nodeId,
      commandId: "add-decision-research",
      kind: "research",
      title: "Decision Research",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: initialWorkspace.graphRevision,
      expectedSnapshotId: initialWorkspace.activeSnapshotId,
      revision: {
        revisionId: priorRevisionId,
        parentRevisionId: null,
        manifestPath: sealedPrior.manifestPath,
        summary: "Immutable prior Research",
        metadata: {
          format: "dezin-research-resource-bundle",
          version: 3,
          mimeType: sealedPrior.mimeType,
        },
        checksum: sealedPrior.manifestChecksum,
        provenance: {
          protocol: "dezin.resource-retry-ownership-fixture.v1",
          payloadChecksum: sealedPrior.payloadChecksum,
        },
      },
      reason: "Seed immutable Research prior art",
    });

    const workspace = store.workspace.getWorkspace(project.id);
    assert.ok(workspace);
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
        kind: "workspace-generation",
        agent: generationAgent,
        reviewerAgent,
        researchAgent,
        resourceOperations: [{
          operation: "revise",
          nodeId,
          resourceId,
          kind: "research",
          title: "Decision Research",
          instructions: "Refresh the evidence-backed design directions.",
          revisionPolicy: { kind: "generate" },
        }],
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
      },
      rationale: "Exercise the complete durable transient retry chain.",
      assumptions: [],
    });
    const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
    assert.ok(approved.plan);

    const repositoryDir = join(root, "projects", project.id);
    await mkdir(repositoryDir, { recursive: true });
    const spawner = new HttpFailureSpawner(scenario.httpStatus);
    const spawnerOptions: NodeSpawnerOptions[] = [];
    let externalFetchCalls = 0;
    const unreachableFetch: SafeBoundedExternalFetcher = async () => {
      externalFetchCalls += 1;
      throw new Error("Research retrieval must not run after primary transport failure");
    };

    system = createProductionGenerationBootstrap({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-resource-retry-ownership",
      repositoryDirForWorkspace: () => repositoryDir,
      resourceExternalFetch: unreachableFetch,
      createResourceRuntimePorts(options) {
        return createProductionResourceRuntimePorts({
          ...options,
          createSpawner(spawnOptions) {
            spawnerOptions.push(spawnOptions);
            return spawner;
          },
          resolveRegisteredExecutable(command) {
            assert.equal(command, "codex");
            return TEST_CODEX_EXECUTABLE;
          },
          structuredAgentPlatform: "darwin",
          resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
        });
      },
      now: clock.now,
      // Virtual time is accelerated 100x. Keep the lease inside Core's bounded
      // contract while compressing the 1s/4s/16s Core backoff.
      leaseMs: 300_000,
      heartbeatMs: 100_000,
      pollMs: 1,
      onError: (error) => errors.push(error),
    });

    await system.runtime.start();
    await waitForDurableProgress({
      description: `terminal Resource HTTP ${scenario.httpStatus} transport chain`,
      read: () => store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan!.id),
      isSettled: ({ plan }) => (
        plan.status === "succeeded"
        || plan.status === "failed"
        || plan.status === "cancelled"
        || plan.status === "compile-failed"
      ),
      fingerprint: ({ plan, tasks }) => JSON.stringify({
        plan: [plan.status, plan.executionEpoch],
        tasks: tasks.map((task) => [
          task.status,
          task.currentAttempt,
          task.failureClass,
          task.nextEligibleAt,
        ]),
      }),
      idleTimeoutMs: 2_000,
      hardTimeoutMs: 8_000,
    });

    const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    const resourceTask = detail.tasks.find((task) => task.kind === "resource");
    assert.ok(resourceTask);
    const attempts = store.db.prepare(
      `SELECT attempt, status, failure_class, error_json, finished_at, next_eligible_at
         FROM generation_task_attempts
        WHERE task_id = ?
        ORDER BY attempt`,
    ).all(resourceTask.id) as Array<{
      attempt: number;
      status: string;
      failure_class: string | null;
      error_json: string | null;
      finished_at: number | null;
      next_eligible_at: number | null;
    }>;

    assert.equal(detail.plan.status, "failed");
    assert.equal(resourceTask.status, "failed");
    assert.equal(resourceTask.currentAttempt, scenario.attemptStatuses.length);
    assert.equal(resourceTask.failureClass, "agent-transport");
    assert.deepEqual(
      attempts.map((attempt) => attempt.attempt),
      scenario.attemptStatuses.map((_, index) => index + 1),
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      scenario.attemptStatuses,
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.failure_class),
      scenario.attemptStatuses.map(() => "agent-transport"),
    );
    assert.deepEqual(
      attempts.map((attempt) => (
        attempt.next_eligible_at === null || attempt.finished_at === null
          ? null
          : attempt.next_eligible_at - attempt.finished_at
      )),
      scenario.retryDelays,
    );

    const expectedBoundedError = {
      name: "ProductionResourceRuntimeError",
      message: "Resource Agent process failed",
      code: "RESOURCE_AGENT_PROCESS_FAILED",
      details: {
        reasonCode: scenario.reasonCode,
        httpStatus: scenario.httpStatus,
        retryable: scenario.retryable,
      },
    };
    assert.deepEqual(resourceTask.error, expectedBoundedError);
    assert.deepEqual(
      attempts.map((attempt) => JSON.parse(attempt.error_json ?? "null")),
      scenario.attemptStatuses.map(() => expectedBoundedError),
    );

    const events = store.workspace.listGenerationPlanEventsForProject(
      project.id,
      approved.plan.id,
    );
    const retryEvents = events.filter((event) => event.type === "task-retry-wait");
    assert.equal(retryEvents.length, scenario.attemptStatuses.length - 1);
    assert.deepEqual(
      retryEvents.map((event) => ({
        sourceAttempt: event.payload.sourceAttempt,
        successorAttempt: event.payload.successorAttempt,
        retryOrdinal: event.payload.retryOrdinal,
        failureClass: event.payload.failureClass,
        reason: event.payload.reason,
      })),
      scenario.attemptStatuses.slice(1).map((_, index) => ({
        sourceAttempt: index + 1,
        successorAttempt: index + 2,
        retryOrdinal: index + 1,
        failureClass: "agent-transport",
        reason: "execution-failed",
      })),
    );
    assert.equal(events.filter((event) => event.type === "task-failed").length, 1);

    assert.equal(spawner.inputs.length, scenario.attemptStatuses.length);
    assert.equal(spawnerOptions.length, scenario.attemptStatuses.length);
    assert.deepEqual(
      spawnerOptions.map((options) => options.inheritEnvironment),
      scenario.attemptStatuses.map(() => false),
    );
    assert.equal(externalFetchCalls, 0);
    for (const input of spawner.inputs) {
      for (const key of [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG_ID",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
      ]) {
        assert.equal(input.env?.[key], undefined, `${key} must not bind to the Codex child`);
      }
    }

    const durableFailureText = JSON.stringify({
      taskError: resourceTask.error,
      attempts: attempts.map((attempt) => attempt.error_json),
      events: events.map((event) => event.payload),
    });
    assert.doesNotMatch(
      durableFailureText,
      new RegExp(`${RAW_PROVIDER_DIAGNOSTIC}|${RAW_STDERR_DIAGNOSTIC}`),
    );
    assert.equal(errors.length, 0);
  } finally {
    await system?.runtime.stop().catch(() => undefined);
    await runtimeSupervisor.shutdown().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Core persists exactly four transient Resource attempts with one Codex process each", async () => {
  await runTransportFailureScenario({
    httpStatus: 503,
    reasonCode: "upstream-unavailable",
    retryable: true,
    attemptStatuses: ["retryable-failed", "retryable-failed", "retryable-failed", "failed"],
    retryDelays: [1_000, 4_000, 16_000, null],
  });
});

for (const httpStatus of [400, 401, 403, 404] as const) {
  test(`Core terminalizes Resource HTTP ${httpStatus} after one Codex process and one durable Attempt`, async () => {
    await runTransportFailureScenario({
      httpStatus,
      reasonCode: "request-rejected",
      retryable: false,
      attemptStatuses: ["failed"],
      retryDelays: [null],
    });
  });
}
