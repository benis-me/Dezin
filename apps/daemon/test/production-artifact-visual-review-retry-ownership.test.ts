import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRunner,
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
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { createProductionGenerationBootstrap } from "../src/orchestration/production-generation-bootstrap.ts";
import {
  inspectStandardArtifactCandidate,
  type ProductionStandardArtifactQualityEvaluatorDependencies,
} from "../src/orchestration/standard-artifact-quality-evaluator.ts";
import { runSafeStructuredAgent } from "../src/orchestration/safe-structured-agent.ts";
import {
  reviewScreenshotWithAgent,
  visualQaFrameAttemptId,
} from "../src/visual-qa.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";
import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";

const FRAME = {
  id: "desktop",
  name: "Desktop",
  width: 320,
  height: 240,
} as const;
const TEST_CODEX_EXECUTABLE = "/trusted/codex/install/bin/codex";
const CLOCK_ACCELERATION = 100;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializeRepository(repositoryDir: string): Promise<void> {
  await mkdir(repositoryDir, { recursive: true });
  git(repositoryDir, "init", "-q");
  git(repositoryDir, "config", "user.name", "Dezin retry ownership");
  git(repositoryDir, "config", "user.email", "retry-ownership@dezin.local");
  await writeFile(join(repositoryDir, "README.md"), "# Artifact retry ownership\n", "utf8");
  git(repositoryDir, "add", "README.md");
  git(repositoryDir, "commit", "-q", "-m", "base");
}

function acceleratedClock() {
  const realEpoch = Date.now();
  let id = 0;
  const now = () => realEpoch + ((Date.now() - realEpoch) * CLOCK_ACCELERATION);
  return {
    now,
    storeClock: {
      now,
      id: () => `artifact-review-retry-ownership-${++id}`,
    },
  };
}

class TransientVisualReviewSpawner implements ProcessSpawner {
  readonly inputs: SpawnInput[] = [];

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.inputs.push(input);
    return {
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: `artifact-review-${this.inputs.length}`,
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.failed",
          error: { message: "HTTP 503 temporarily unavailable" },
        }),
      ].join("\n"),
      stderr: "bounded visual-review transport failure",
      exitCode: 1,
    };
  }
}

test("caller-owned Artifact review still gets one semantic retry for malformed reviewer output", async () => {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-review-malformed-boundary-"));
  try {
    const htmlPath = join(root, "index.html");
    const screenshotPath = join(root, "screenshot.png");
    await writeFile(htmlPath, "<h1>Review boundary</h1>", "utf8");
    await writeFile(screenshotPath, sharinganFixturePng(1, 1));
    const requests: Array<"transport-owned" | "caller-owned" | undefined> = [];

    const findings = await reviewScreenshotWithAgent({
      htmlPath,
      projectRoot: root,
      settings: {
        visualQaEnabled: true,
        agentCommand: "codex",
        model: "gpt-5.4-mini",
      } as never,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      remoteRetryMode: "caller-owned",
    }, screenshotPath, async (request) => {
      requests.push(request.remoteRetryMode);
      return {
        providerId: "codex",
        text: requests.length === 1 ? "{}" : '{"findings":[]}',
      };
    });

    assert.deepEqual(requests, ["caller-owned", "caller-owned"]);
    assert.ok(findings.some((finding) => finding.id === "visual-reviewed"));
    assert.ok(!findings.some((finding) => finding.id === "visual-review-unassessed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Core owns transient Artifact visual-review retries with one Codex process per Attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dezin-artifact-review-retry-ownership-"));
  const clock = acceleratedClock();
  const store = new Store(join(root, "store.db"), clock.storeClock);
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  let system: ReturnType<typeof createProductionGenerationBootstrap> | null = null;
  try {
    const project = store.createProject({
      name: "Artifact visual-review retry ownership",
      mode: "standard",
    });
    const initialWorkspace = store.workspace.ensureWorkspaceRecord(project.id);
    const repositoryDir = join(root, "projects", project.id);
    await initializeRepository(repositoryDir);
    store.updateSettings({
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      visualQaEnabled: true,
      autoImproveEnabled: false,
    });

    store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: initialWorkspace.graphRevision,
      expectedSnapshotId: initialWorkspace.activeSnapshotId,
      commands: [{
        id: "add-review-page",
        type: "add-node",
        node: {
          id: "review-page-node",
          kind: "page",
          name: "Review Page",
          artifactId: "review-page",
          createIdentity: { initialTrackId: "review-page-main" },
        },
      }],
    });
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
        kind: "workspace-generation",
        agent: {
          providerId: "codex",
          command: "codex",
          model: "gpt-5.4-mini",
        },
        resourceOperations: [],
        artifactPlans: [{
          operation: "create",
          nodeId: "review-page-node",
          artifactId: "review-page",
          kind: "page",
          name: "Review Page",
          trackId: "review-page-main",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: [FRAME.id],
        }],
        dependencyPlans: [],
        prototypeIntents: [],
        capabilities: [],
        responsiveFrames: [FRAME],
        qualityProfile: {
          requiredFrameIds: [FRAME.id],
          blockingSeverities: ["P0", "P1"],
          requireRuntimeChecks: true,
          requireVisualReview: true,
        },
      },
      rationale: "Prove durable Core is the sole transient visual-review retry owner.",
      assumptions: [],
    });
    const approved = store.workspace.approveProposalForProject(
      project.id,
      proposal.id,
      "generate",
    );
    assert.ok(approved.plan);

    let artifactRunnerCalls = 0;
    const artifactRunner: AgentRunner = {
      id: "artifact-review-retry-ownership-fixture",
      async runTurn(input) {
        artifactRunnerCalls += 1;
        const html = [
          "<!doctype html>",
          '<html><body><main data-design-node-id="review-root">',
          `<h1>Review attempt ${artifactRunnerCalls}</h1>`,
          "</main></body></html>",
        ].join("");
        await writeFile(join(input.projectDir, "index.html"), html, "utf8");
        return {
          text: "Generated one exact review candidate.",
          artifactHtml: html,
          artifactPath: "index.html",
        };
      },
    };

    const spawner = new TransientVisualReviewSpawner();
    const spawnerOptions: NodeSpawnerOptions[] = [];
    const reviewRetryModes: Array<"transport-owned" | "caller-owned" | undefined> = [];
    let visualQaCalls = 0;
    const qualityDependencies: ProductionStandardArtifactQualityEvaluatorDependencies = {
      inspectCandidate: inspectStandardArtifactCandidate,
      async acquireRuntime() {
        const bridgeNonce = "v".repeat(43);
        return {
          leaseId: "artifact-review-retry-lease",
          url: `http://127.0.0.1:9/#dezin-bridge=${bridgeNonce}`,
          bridgeNonce,
          expiresAt: Date.now() + 60_000,
          async release() {},
        };
      },
      async collectLintSurface() {
        return "";
      },
      lint() {
        return [];
      },
      async visualQa(input) {
        visualQaCalls += 1;
        const frame = input.renderFrames[0]!;
        const frameAttemptId = visualQaFrameAttemptId(
          input.frameAttemptIdPrefix,
          frame,
          0,
        );
        const screenshotPath = join(
          input.screenshotEvidenceRoot!,
          `review-${visualQaCalls}.png`,
        );
        const bytes = sharinganFixturePng(frame.width, frame.height);
        await writeFile(screenshotPath, bytes);
        const captureIdentity = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          width: frame.width,
          height: frame.height,
        };
        const findings = await reviewScreenshotWithAgent({
          ...input,
          reviewFrame: { ...frame, frameAttemptId },
          reviewScreenshotIdentity: captureIdentity,
        }, screenshotPath, async (request) => {
          reviewRetryModes.push(request.remoteRetryMode);
          return runSafeStructuredAgent(request, {
            createSpawner(options) {
              spawnerOptions.push(options);
              return spawner;
            },
            resolveCodexExecutable: () => TEST_CODEX_EXECUTABLE,
            platform: "darwin",
            resolveSandboxExecutable: () => "/usr/bin/sandbox-exec",
          });
        });
        return {
          findings,
          frames: [{
            frameId: frame.id,
            frameAttemptId,
            width: frame.width,
            height: frame.height,
            status: "failed",
            screenshotPath,
            captureIdentity,
            reviewed: false,
          }],
        };
      },
      async persistEvidence() {
        throw new Error("failed visual review must never persist evidence");
      },
      sharinganReference() {
        return undefined;
      },
    };

    const errors: unknown[] = [];
    system = createProductionGenerationBootstrap({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-artifact-review-retry-ownership",
      repositoryDirForWorkspace: () => repositoryDir,
      resourceExternalFetch: async () => {
        throw new Error("this Plan has no Resource Task");
      },
      createResourceRuntimePorts: () => ({
        agent: { async generateStructured() { throw new Error("no Resource Task"); } },
        researchEvidence: { async retrieveWebEvidence() { throw new Error("no Research Task"); } },
        sharinganCaptures: { async exportExactCapture() { throw new Error("no Sharingan Task"); } },
      }) as never,
      createArtifactRunner: () => artifactRunner,
      artifactQualityDependencies: qualityDependencies,
      now: clock.now,
      leaseMs: 300_000,
      // The accelerated clock makes this a 3s real-time lease. Renew it every
      // second so a coverage-loaded Attempt remains durably owned.
      heartbeatMs: 1_000,
      pollMs: 1,
      onError: (error) => errors.push(error),
    });

    await system.runtime.start();
    const readProgress = () => ({
      detail: store.workspace.getGenerationPlanDetailForProject(
        project.id,
        approved.plan!.id,
      ),
      attempts: store.db.prepare(
        `SELECT attempt, status, heartbeat_at
           FROM generation_task_attempts
          WHERE plan_id = ?
          ORDER BY attempt`,
      ).all(approved.plan!.id) as Array<{
        attempt: number;
        status: string;
        heartbeat_at: number | null;
      }>,
    });
    await waitForDurableProgress({
      description: "terminal four-attempt Artifact visual-review transport chain",
      read: readProgress,
      isSettled: ({ detail: { plan } }) => (
        plan.status === "succeeded"
        || plan.status === "failed"
        || plan.status === "cancelled"
        || plan.status === "compile-failed"
      ),
      fingerprint: ({ detail: { plan, tasks }, attempts }) => JSON.stringify({
        plan: [plan.status, plan.executionEpoch],
        tasks: tasks.map((task) => [
          task.kind,
          task.status,
          task.currentAttempt,
          task.failureClass,
          task.nextEligibleAt,
        ]),
        attempts: attempts.map((attempt) => [
          attempt.attempt,
          attempt.status,
          attempt.heartbeat_at,
        ]),
      }),
      idleTimeoutMs: 3_000,
      // The idle watchdog is the stall detector. Keep a separate generous
      // total bound for four real Git/evidence Attempts under coverage load.
      hardTimeoutMs: 30_000,
    });

    const detail = store.workspace.getGenerationPlanDetailForProject(
      project.id,
      approved.plan.id,
    );
    const artifactTask = detail.tasks.find((task) => task.kind === "page");
    assert.ok(artifactTask);
    const attempts = store.db.prepare(
      `SELECT attempt, status, failure_class
         FROM generation_task_attempts
        WHERE task_id = ?
        ORDER BY attempt`,
    ).all(artifactTask.id) as Array<{
      attempt: number;
      status: string;
      failure_class: string | null;
    }>;

    assert.equal(detail.plan.status, "failed");
    assert.equal(artifactTask.status, "failed");
    assert.equal(artifactTask.currentAttempt, 4);
    assert.deepEqual(attempts.map((attempt) => attempt.attempt), [1, 2, 3, 4]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      ["retryable-failed", "retryable-failed", "retryable-failed", "failed"],
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.failure_class),
      ["provider", "provider", "provider", "provider"],
    );
    assert.equal(artifactRunnerCalls, 4);
    assert.equal(visualQaCalls, 4);
    assert.equal(spawner.inputs.length, 4);
    assert.equal(spawnerOptions.length, 4);
    assert.deepEqual(
      reviewRetryModes,
      ["caller-owned", "caller-owned", "caller-owned", "caller-owned"],
    );
    assert.equal(errors.length, 0);
  } finally {
    await system?.runtime.stop().catch(() => undefined);
    await runtimeSupervisor.shutdown().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
