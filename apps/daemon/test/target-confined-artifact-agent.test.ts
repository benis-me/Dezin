import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRunner,
  AgentTurnInput,
} from "../../../packages/agent/src/index.ts";
import type { GenerationTaskAttemptClaim } from "../../../packages/core/src/index.ts";
import type { ContextPack } from "../src/context/context-types.ts";
import type { ArtifactRunInfrastructureInput } from "../src/orchestration/artifact-run-preparation.ts";

const CONTEXT_HASH = "c".repeat(64);
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);

function claim(): GenerationTaskAttemptClaim {
  const payload = {
    version: 2,
    artifactPlan: {
      operation: "create",
      nodeId: "node-page",
      artifactId: "artifact-page",
      kind: "page",
      name: "Checkout",
      trackId: "track-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: ["browser", "visual"],
      responsiveFrameIds: ["desktop"],
    },
    dependencyPlans: [],
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
    brief: {
      proposalRationale: "Create a precise checkout flow",
      assumptions: [],
      targetInstructions: { operation: "create", kind: "page", name: "Checkout" },
    },
    capabilityDescriptors: [
      { id: "browser", kind: "browser", required: true },
      { id: "visual", kind: "visual-qa", required: true },
    ],
  };
  return {
    task: {
      id: "task-page",
      planId: "plan-1",
      workspaceId: "workspace-1",
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-main",
      },
      payload,
      capabilities: ["browser", "visual"],
      qaProfile: {
        requiredFrameIds: ["desktop"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
      resourceLimits: {
        timeoutMs: 60_000,
        maxAgentTurns: 3,
        maxRepairRounds: 2,
        maxOutputBytes: 4 * 1024 * 1024,
        capacityClasses: ["agent", "render-qa"],
      },
    },
    attempt: {
      taskId: "task-page",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 2,
      inputHash: "d".repeat(64),
      createdAt: 1_700_000_000_000,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-main",
      },
      payload,
      contextPackId: `context-pack-${CONTEXT_HASH}`,
      sourceCommitHash: SOURCE_COMMIT,
      sourceTreeHash: SOURCE_TREE,
      resourcePins: [],
      componentPins: [],
    },
  } as unknown as GenerationTaskAttemptClaim;
}

function contextPack(): ContextPack {
  return {
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: "workspace-1",
    graphRevision: 7,
    target: { type: "artifact", id: "artifact-page" },
    intent: "generate",
    messageChecksum: "e".repeat(64),
    items: [],
    omissions: [],
    tokenEstimate: 0,
    manifestPath: `context-packs/workspace/${CONTEXT_HASH}.json`,
    hash: CONTEXT_HASH,
    createdAt: 1,
  };
}

function infrastructure(worktreeDir: string): ArtifactRunInfrastructureInput {
  return {
    projectId: "project-1",
    claim: claim(),
    contextPack: contextPack(),
    hasExactSharinganCapture: false,
    repositoryDir: join(worktreeDir, "repository"),
    worktreeDir,
  };
}

test("production Artifact Agent ports bind one target, Context, Source Base, environment, and capability set", async (t) => {
  const worktreeDir = mkdtempSync(join(tmpdir(), "dezin-confined-agent-"));
  t.after(() => rmSync(worktreeDir, { recursive: true, force: true }));
  const calls: AgentTurnInput[] = [];
  const underlying: AgentRunner = {
    id: "fixture-provider",
    async runTurn(input) {
      calls.push(input);
      return { text: "done", artifactHtml: "<main>done</main>", artifactPath: "index.html" };
    },
  };

  const module = await import("../src/orchestration/target-confined-artifact-agent.ts");
  const ports = module.createProductionArtifactAgentExecutionPorts({
    createRunner: () => underlying,
    extraEnvironment: { DEZIN_PROVIDER_PROFILE: "default" },
  });
  const exactInfrastructure = infrastructure(worktreeDir);
  const runner = await ports.createRunner(exactInfrastructure);
  const env = ports.environment(exactInfrastructure);
  const result = await runner.runTurn({
    systemPrompt: "You are Dezin's senior design Agent.",
    message: "Build the exact target.",
    projectDir: worktreeDir,
    history: [{ role: "user", content: "Use the approved direction." }],
    signal: new AbortController().signal,
    env,
  });

  assert.equal(result.artifactPath, "index.html");
  assert.equal(calls.length, 1);
  const [forwarded] = calls;
  assert.equal(forwarded?.projectDir, realpathSync(worktreeDir));
  assert.deepEqual(forwarded?.env, env);
  assert.deepEqual(Object.keys(env).sort(), [
    "DEZIN_AGENT_CAPABILITIES",
    "DEZIN_AGENT_SCOPE_PROTOCOL",
    "DEZIN_ARTIFACT_ID",
    "DEZIN_CONTEXT_PACK_HASH",
    "DEZIN_CONTEXT_PACK_ID",
    "DEZIN_PLAN_ID",
    "DEZIN_PROJECT_ID",
    "DEZIN_PROVIDER_PROFILE",
    "DEZIN_SOURCE_COMMIT_HASH",
    "DEZIN_SOURCE_TREE_HASH",
    "DEZIN_TASK_ATTEMPT",
    "DEZIN_TASK_ID",
    "DEZIN_TRACK_ID",
    "DEZIN_WORKSPACE_ID",
  ]);
  assert.equal(env.DEZIN_ARTIFACT_ID, "artifact-page");
  assert.equal(env.DEZIN_CONTEXT_PACK_ID, `context-pack-${CONTEXT_HASH}`);
  assert.equal(env.DEZIN_SOURCE_COMMIT_HASH, SOURCE_COMMIT);
  assert.equal(env.DEZIN_AGENT_CAPABILITIES, JSON.stringify([
    { id: "browser", kind: "browser", required: true },
    { id: "visual", kind: "visual-qa", required: true },
  ]));
  assert.match(forwarded?.systemPrompt ?? "", /You are Dezin's senior design Agent/);
  assert.match(forwarded?.systemPrompt ?? "", /artifact-page/);
  assert.match(forwarded?.systemPrompt ?? "", /context-pack-/);
  assert.match(forwarded?.systemPrompt ?? "", /read-only Context/i);
  assert.match(forwarded?.systemPrompt ?? "", /live HEAD/i);
});

test("production Artifact Agent ports preserve only the reserved daemon-token tombstone", async (t) => {
  const worktreeDir = mkdtempSync(join(tmpdir(), "dezin-confined-agent-token-tombstone-"));
  t.after(() => rmSync(worktreeDir, { recursive: true, force: true }));
  const module = await import("../src/orchestration/target-confined-artifact-agent.ts");
  const ports = module.createProductionArtifactAgentExecutionPorts({
    createRunner: () => ({
      id: "fixture-provider",
      async runTurn() {
        return { text: "done", artifactHtml: "<main />" };
      },
    }),
    extraEnvironment: {
      OPENAI_API_KEY: "provider-key",
      DEZIN_DAEMON_TOKEN: undefined,
    },
  });
  const env = ports.environment(infrastructure(worktreeDir));

  assert.equal(Object.hasOwn(env, "DEZIN_DAEMON_TOKEN"), true);
  assert.equal(env.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, "provider-key");
  assert.throws(
    () => module.createProductionArtifactAgentExecutionPorts({
      createRunner: () => ({
        id: "fixture-provider",
        async runTurn() {
          return { text: "done", artifactHtml: "<main />" };
        },
      }),
      extraEnvironment: { DEZIN_DAEMON_TOKEN: "must-not-cross-the-boundary" },
    }),
    /daemon token|environment.*reserved|DEZIN_DAEMON_TOKEN.*reserved/i,
  );
  assert.throws(
    () => module.createProductionArtifactAgentExecutionPorts({
      createRunner: () => ({
        id: "fixture-provider",
        async runTurn() {
          return { text: "done", artifactHtml: "<main />" };
        },
      }),
      extraEnvironment: { OPENAI_API_KEY: undefined },
    }),
    /OPENAI_API_KEY.*invalid/i,
  );
});

test("target-confined Artifact Agent rejects a foreign cwd or environment before provider invocation", async (t) => {
  const worktreeDir = mkdtempSync(join(tmpdir(), "dezin-confined-agent-reject-"));
  const foreignDir = mkdtempSync(join(tmpdir(), "dezin-confined-agent-foreign-"));
  t.after(() => {
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(foreignDir, { recursive: true, force: true });
  });
  let calls = 0;
  const module = await import("../src/orchestration/target-confined-artifact-agent.ts");
  const ports = module.createProductionArtifactAgentExecutionPorts({
    createRunner: () => ({
      id: "fixture-provider",
      async runTurn() {
        calls += 1;
        return { text: "done", artifactHtml: "<main />" };
      },
    }),
  });
  const exactInfrastructure = infrastructure(worktreeDir);
  const runner = await ports.createRunner(exactInfrastructure);
  const env = ports.environment(exactInfrastructure);

  await assert.rejects(
    runner.runTurn({
      systemPrompt: "base",
      message: "foreign cwd",
      projectDir: foreignDir,
      signal: new AbortController().signal,
      env,
    }),
    /worktree|project directory|target scope/i,
  );
  await assert.rejects(
    runner.runTurn({
      systemPrompt: "base",
      message: "foreign env",
      projectDir: worktreeDir,
      signal: new AbortController().signal,
      env: { ...env, DEZIN_ARTIFACT_ID: "foreign-artifact" },
    }),
    /environment.*exact|immutable environment/i,
  );
  assert.equal(calls, 0);
});

test("target-confined Artifact Agent rejects provider artifact paths outside its worktree", async (t) => {
  const worktreeDir = mkdtempSync(join(tmpdir(), "dezin-confined-agent-path-"));
  t.after(() => rmSync(worktreeDir, { recursive: true, force: true }));
  const module = await import("../src/orchestration/target-confined-artifact-agent.ts");
  const ports = module.createProductionArtifactAgentExecutionPorts({
    createRunner: () => ({
      id: "fixture-provider",
      async runTurn() {
        return { text: "done", artifactHtml: "<main />", artifactPath: "../outside.html" };
      },
    }),
  });
  const exactInfrastructure = infrastructure(worktreeDir);
  const runner = await ports.createRunner(exactInfrastructure);

  await assert.rejects(
    runner.runTurn({
      systemPrompt: "base",
      message: "escape",
      projectDir: worktreeDir,
      signal: new AbortController().signal,
      env: ports.environment(exactInfrastructure),
    }),
    /artifact path.*worktree|escapes/i,
  );
});
