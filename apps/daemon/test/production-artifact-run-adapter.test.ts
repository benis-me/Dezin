import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunner } from "../../../packages/agent/src/index.ts";
import type {
  GenerationTaskAttemptClaim,
  Settings,
} from "../../../packages/core/src/index.ts";
import type { ContextPack } from "../src/context/context-types.ts";
import type { ArtifactRunInfrastructureInput } from "../src/orchestration/artifact-run-preparation.ts";
import type { ArtifactRunExecutor } from "../src/orchestration/artifact-run-executor.ts";
import type { ProductionStandardArtifactQualityEvaluatorDependencies } from "../src/orchestration/standard-artifact-quality-evaluator.ts";

const CONTEXT_HASH = "c".repeat(64);
const FRAME = {
  id: "desktop",
  name: "Desktop",
  width: 1440,
  height: 900,
  background: "#ffffff",
  fixture: {},
};

interface ProductionArtifactRunAdapterModule {
  createProductionArtifactRunExecutor(options: {
    contextPacks: { get(workspaceId: string, contextPackId: string): ContextPack | null };
    projectIdForWorkspace(workspaceId: string): string | Promise<string>;
    repositoryDirForWorkspace(workspaceId: string): string | Promise<string>;
    agent: {
      createRunner(
        input: ArtifactRunInfrastructureInput,
        signal: AbortSignal,
      ): AgentRunner | Promise<AgentRunner>;
    };
    quality(input: ArtifactRunInfrastructureInput, signal: AbortSignal): {
      settings: Settings;
      dataDir: string;
      agentCommand: string;
      dependencies: ProductionStandardArtifactQualityEvaluatorDependencies;
    } | Promise<{
      settings: Settings;
      dataDir: string;
      agentCommand: string;
      dependencies: ProductionStandardArtifactQualityEvaluatorDependencies;
    }>;
    baseSystemPrompt(input: Omit<ArtifactRunInfrastructureInput, "repositoryDir" | "worktreeDir">): string;
  }): ArtifactRunExecutor;
  ProductionArtifactRunAdapterError: new (...args: never[]) => Error;
}

async function productionModule(): Promise<Partial<ProductionArtifactRunAdapterModule>> {
  return import("../src/orchestration/production-artifact-run-adapter.ts")
    .catch(() => ({})) as Promise<Partial<ProductionArtifactRunAdapterModule>>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): { root: string; commitHash: string; treeHash: string } {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-artifact-leaf-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  writeFileSync(join(root, "package.json"), "{}\n");
  git(root, "add", "package.json");
  git(root, "commit", "-q", "-m", "base");
  return {
    root,
    commitHash: git(root, "rev-parse", "HEAD"),
    treeHash: git(root, "rev-parse", "HEAD^{tree}"),
  };
}

function contextPack(): ContextPack {
  return {
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: "workspace-1",
    graphRevision: 1,
    target: { type: "artifact", id: "artifact-home" },
    intent: "generate",
    messageChecksum: "d".repeat(64),
    items: [],
    omissions: [],
    tokenEstimate: 0,
    manifestPath: `context-packs/workspace-1/${CONTEXT_HASH}.json`,
    hash: CONTEXT_HASH,
    createdAt: 10,
  };
}

function claim(source: { commitHash: string; treeHash: string }): GenerationTaskAttemptClaim {
  const payload = {
    version: 2,
    artifactPlan: {
      operation: "create",
      nodeId: "node-home",
      artifactId: "artifact-home",
      kind: "page",
      name: "Home",
      trackId: "track-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: [FRAME.id],
    },
    dependencyPlans: [],
    responsiveFrames: [FRAME],
    brief: {
      proposalRationale: "Design a precise product home page",
      assumptions: [],
      targetInstructions: { operation: "create", kind: "page", name: "Home" },
    },
    capabilityDescriptors: [],
  };
  const lease = {
    taskId: "task-home",
    workspaceId: "workspace-1",
    attempt: 1,
    ownerId: "daemon-owner",
    leaseToken: "lease-token",
  };
  return {
    task: {
      id: "task-home",
      ordinal: 0,
      planId: "plan-1",
      workspaceId: "workspace-1",
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-home",
        trackId: "track-main",
      },
      dependencyIds: [],
      payload,
      capabilities: [],
      qaProfile: {
        requiredFrameIds: [FRAME.id],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: false,
      },
      resourceLimits: {
        timeoutMs: 60_000,
        maxAgentTurns: 1,
        maxRepairRounds: 0,
        maxOutputBytes: 1024 * 1024,
        capacityClasses: ["agent", "render-qa"],
      },
      intentHash: "7".repeat(64),
      idempotencyKey: "8".repeat(64),
      status: "running",
      blockedReason: null,
      blockedByTaskId: null,
      pendingContextPolicy: null,
      currentAttempt: 1,
      materializationFailures: 0,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: null,
      createdAt: 10,
      finishedAt: null,
    },
    attempt: {
      taskId: "task-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 1,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-home",
        trackId: "track-main",
      },
      baseRevisionId: null,
      expectedSnapshotId: "snapshot-1",
      contextPackId: `context-pack-${CONTEXT_HASH}`,
      kernelRevisionId: "kernel-1",
      sourceCommitHash: source.commitHash,
      sourceTreeHash: source.treeHash,
      payload: structuredClone(payload),
      dependencyOutputs: [],
      resourcePins: [],
      componentPins: [],
      retryContextPolicy: "same-context",
      executionMode: "full",
      inputHash: "9".repeat(64),
      attemptOrigin: "materialized",
      predecessorAttempt: null,
      automaticRetryIndex: 0,
      status: "running",
      blockedReason: null,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
      lease,
      leaseExpiresAt: 100,
      heartbeatAt: 50,
      createdAt: 10,
      startedAt: 40,
      finishedAt: null,
    },
    lease,
    claims: [],
  } as unknown as GenerationTaskAttemptClaim;
}

const settings = {
  visualQaEnabled: false,
  agentCommand: "codex",
  model: "fixture-model",
  visualQaAgentCommand: "",
  visualQaModel: "",
} as Settings;

function qualityDependencies(calls: string[]): ProductionStandardArtifactQualityEvaluatorDependencies {
  return {
    async inspectCandidate(input) {
      calls.push("inspect-candidate");
      return { ...input.candidate, status: "" };
    },
    async acquireRuntime(input) {
      calls.push(`runtime:${input.projectDir}`);
      return {
        leaseId: "lease-1",
        url: `http://127.0.0.1:4173/#dezin-bridge=${"n".repeat(43)}`,
        bridgeNonce: "n".repeat(43),
        expiresAt: Date.now() + 60_000,
        async release() { calls.push("runtime-release"); },
      };
    },
    async collectLintSurface() {
      calls.push("lint-surface");
      return "export const page = true;";
    },
    lint() { return []; },
    async visualQa(input) {
      calls.push("visual-runtime");
      assert.equal(input.runtimeOnly, true);
      return {
        findings: [],
        frames: input.renderFrames.map((frame, index) => ({
          frameId: frame.id,
          frameAttemptId: `${input.frameAttemptIdPrefix}-${index}-${frame.id}`,
          width: frame.width,
          height: frame.height,
          status: "passed" as const,
          reviewed: false,
        })),
      };
    },
    async persistEvidence() {
      throw new Error("runtime-only evaluation must not persist review evidence");
    },
    sharinganReference() { return undefined; },
  };
}

test("production Artifact factory runs the exact isolated Standard leaf through an injected Agent and disposes it", async (t) => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionArtifactRunExecutor, "function");
  if (typeof module.createProductionArtifactRunExecutor !== "function") return;
  const repo = repository();
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-production-artifact-data-"));
  t.after(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  let isolatedDir = "";
  const executor = module.createProductionArtifactRunExecutor({
    contextPacks: { get: () => contextPack() },
    projectIdForWorkspace: () => "project-1",
    repositoryDirForWorkspace: () => repo.root,
    agent: {
      createRunner(input) {
        isolatedDir = input.worktreeDir;
        assert.notEqual(input.worktreeDir, repo.root);
        return {
          id: "production-agent-adapter",
          async runTurn(turn) {
            calls.push(`agent:${turn.projectDir}`);
            assert.equal(turn.projectDir, input.worktreeDir);
            writeFileSync(join(turn.projectDir, "index.html"), "<main data-design-node-id=\"hero\">Home</main>\n");
            return { text: "implemented", artifactHtml: "" };
          },
        };
      },
    },
    quality(input) {
      assert.equal(input.worktreeDir, isolatedDir);
      return {
        settings,
        dataDir,
        agentCommand: "codex",
        dependencies: qualityDependencies(calls),
      };
    },
    baseSystemPrompt: () => "You are Dezin's production design Agent.",
  });

  const result = await executor.execute(claim(repo), new AbortController().signal);

  assert.equal(result.kind, "artifact-candidate");
  assert.equal(readFileSync(repo.root + "/package.json", "utf8"), "{}\n");
  assert.equal(existsSync(isolatedDir), false, "Attempt worktree must be disposed after leaf execution");
  assert.ok(calls.some((call) => call.startsWith("agent:")));
  assert.ok(calls.includes("visual-runtime"));
  assert.ok(calls.includes("runtime-release"));
  const evidence = result.evidence as { candidateRetentionRef?: unknown; versions?: unknown[] };
  assert.equal(typeof evidence.candidateRetentionRef, "string");
  assert.equal(evidence.versions?.length, 1);
  assert.equal(
    git(repo.root, "show-ref", "--verify", evidence.candidateRetentionRef as string).length > 0,
    true,
    "Attempt ref must retain the exact candidate after disposable worktree cleanup",
  );
});

test("production Artifact factory fails closed when the Agent adapter is unavailable", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionArtifactRunExecutor, "function");
  assert.equal(typeof module.ProductionArtifactRunAdapterError, "function");
  const createExecutor = module.createProductionArtifactRunExecutor;
  const ErrorType = module.ProductionArtifactRunAdapterError;
  if (typeof createExecutor !== "function" || typeof ErrorType !== "function") return;
  assert.throws(
    () => createExecutor({
      contextPacks: { get: () => null },
      projectIdForWorkspace: () => "project-1",
      repositoryDirForWorkspace: () => "/tmp/project",
      agent: {} as never,
      quality: () => ({} as never),
      baseSystemPrompt: () => "base",
    }),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code === "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE"
      && (error as Error & { failureClass?: string }).failureClass === "adapter",
  );
});

test("production Artifact setup aborts a stalled Agent factory and disposes the isolated transaction", async (t) => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionArtifactRunExecutor, "function");
  const createExecutor = module.createProductionArtifactRunExecutor;
  if (typeof createExecutor !== "function") return;
  const repo = repository();
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-production-artifact-abort-data-"));
  t.after(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  let isolatedDir = "";
  let signalRunnerStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { signalRunnerStarted = resolve; });
  const executor = createExecutor({
    contextPacks: { get: () => contextPack() },
    projectIdForWorkspace: () => "project-1",
    repositoryDirForWorkspace: () => repo.root,
    agent: {
      createRunner(input, signal) {
        isolatedDir = input.worktreeDir;
        assert.equal(signal, controller.signal);
        signalRunnerStarted();
        return new Promise<AgentRunner>(() => {});
      },
    },
    quality: () => ({
      settings,
      dataDir,
      agentCommand: "codex",
      dependencies: qualityDependencies([]),
    }),
    baseSystemPrompt: () => "You are Dezin's production design Agent.",
  });
  const controller = new AbortController();
  const execution = executor.execute(claim(repo), controller.signal);
  await runnerStarted;

  const reason = new Error("stop stalled production Agent setup");
  controller.abort(reason);
  let timer: NodeJS.Timeout | undefined;
  const settled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Artifact setup did not observe cancellation")),
      250,
    );
  });
  await assert.rejects(Promise.race([execution, settled]), (error: unknown) => error === reason);
  if (timer !== undefined) clearTimeout(timer);

  assert.notEqual(isolatedDir, "");
  assert.equal(existsSync(isolatedDir), false, "aborted setup must remove its isolated worktree");
});

test("production Artifact factory rejects accessor-backed configuration without invoking it", async () => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionArtifactRunExecutor, "function");
  assert.equal(typeof module.ProductionArtifactRunAdapterError, "function");
  const createExecutor = module.createProductionArtifactRunExecutor;
  const ErrorType = module.ProductionArtifactRunAdapterError;
  if (typeof createExecutor !== "function" || typeof ErrorType !== "function") return;
  let invoked = false;
  const hostileOptions = Object.defineProperty({
    projectIdForWorkspace: () => "project-1",
    repositoryDirForWorkspace: () => "/projects/workspace-1",
    agent: { createRunner() { throw new Error("not used"); } },
    quality: () => { throw new Error("not used"); },
    baseSystemPrompt: () => "base",
  }, "contextPacks", {
    enumerable: true,
    get() {
      invoked = true;
      return { get: () => null };
    },
  });

  assert.throws(
    () => createExecutor(hostileOptions as never),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code === "PRODUCTION_ARTIFACT_CONFIGURATION_INVALID",
  );
  assert.equal(invoked, false);
});

test("production Artifact factory rejects accessor-backed Agent runners without invoking them", async (t) => {
  const module = await productionModule();
  assert.equal(typeof module.createProductionArtifactRunExecutor, "function");
  assert.equal(typeof module.ProductionArtifactRunAdapterError, "function");
  const createExecutor = module.createProductionArtifactRunExecutor;
  const ErrorType = module.ProductionArtifactRunAdapterError;
  if (typeof createExecutor !== "function" || typeof ErrorType !== "function") return;
  const repo = repository();
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-production-artifact-hostile-runner-"));
  t.after(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  let invoked = false;
  let isolatedDir = "";
  const executor = createExecutor({
    contextPacks: { get: () => contextPack() },
    projectIdForWorkspace: () => "project-1",
    repositoryDirForWorkspace: () => repo.root,
    agent: {
      createRunner(input) {
        isolatedDir = input.worktreeDir;
        return Object.defineProperty({
          async runTurn() { return { text: "not used", artifactHtml: "" }; },
        }, "id", {
          enumerable: true,
          get() {
            invoked = true;
            return "hostile-runner";
          },
        }) as unknown as AgentRunner;
      },
    },
    quality: () => ({
      settings,
      dataDir,
      agentCommand: "codex",
      dependencies: qualityDependencies([]),
    }),
    baseSystemPrompt: () => "base",
  });

  await assert.rejects(
    executor.execute(claim(repo), new AbortController().signal),
    (error: unknown) => error instanceof ErrorType
      && (error as Error & { code?: string }).code === "PRODUCTION_ARTIFACT_AGENT_UNAVAILABLE"
      && (error as Error & { failureClass?: string }).failureClass === "adapter",
  );
  assert.equal(invoked, false);
  assert.equal(existsSync(isolatedDir), false);
});
