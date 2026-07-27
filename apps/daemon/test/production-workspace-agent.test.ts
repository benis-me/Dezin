import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  NodeSpawnerOptions,
  ProcessSpawner,
  SpawnInput,
  SpawnOutput,
} from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import { composeWorkspaceAgentConversation } from "../../../packages/core/src/workspace-agent-conversation.ts";
import { sealResourceRevisionPayload } from "../src/context/adapters/file.ts";
import { BlockedContextError } from "../src/context/context-types.ts";
import { createWorkspaceContextPackRepository } from "../src/context/context-pack-store.ts";
import { createProductionScopedAgentTaskQueue } from "../src/orchestration/production-scoped-agent-task-queue.ts";
import { createProductionWorkspaceAgentOrchestrator } from "../src/orchestration/production-workspace-agent.ts";

const WORKSPACE_TURN_ID = "turn-00000000-0000-4000-8000-000000000010";
const TEST_CLAUDE_EXECUTABLE = "/trusted/claude/install/bin/claude";
const TEST_CODEBUDDY_EXECUTABLE = "/trusted/codebuddy/install/bin/codebuddy";
const TEST_CODEX_EXECUTABLE = "/trusted/codex/install/bin/codex";
const TEST_CURSOR_EXECUTABLE = "/trusted/cursor-agent/install/bin/cursor-agent";
const TEST_GEMINI_EXECUTABLE = "/trusted/gemini/install/bin/gemini";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAUDE_AGENT = Object.freeze({
  providerId: "claude",
  command: "claude",
  model: null,
} as const);

function seedArtifactSource(input: {
  root: string;
  projectId: string;
  sourceRoot: string;
  designNodeId: string;
  additionalSources?: Array<{ sourceRoot: string; designNodeId: string }>;
}): { commitHash: string; treeHash: string } {
  const repository = join(input.root, "projects", input.projectId);
  for (const source of [
    { sourceRoot: input.sourceRoot, designNodeId: input.designNodeId },
    ...(input.additionalSources ?? []),
  ]) {
    const sourceDirectory = source.sourceRoot === "." ? repository : join(repository, source.sourceRoot);
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(sourceDirectory, "index.tsx"),
      `export function Screen() { return <button data-dezin-id="${source.designNodeId}">Continue</button>; }\n`,
      "utf8",
    );
  }
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dezin-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: repository });
  execFileSync("git", ["add", "--all"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "seed immutable artifact selection"], {
    cwd: repository,
    stdio: "ignore",
  });
  return {
    commitHash: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    treeHash: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim(),
  };
}

class RecordingSpawner implements ProcessSpawner {
  readonly inputs: SpawnInput[] = [];
  readonly output: SpawnOutput | ((input: SpawnInput) => Promise<SpawnOutput>);

  constructor(output: SpawnOutput | ((input: SpawnInput) => Promise<SpawnOutput>)) {
    this.output = output;
  }

  async run(input: SpawnInput): Promise<SpawnOutput> {
    this.inputs.push(input);
    return typeof this.output === "function" ? this.output(input) : this.output;
  }
}

function plannerResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
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
    },
    rationale: "Keep the workspace coherent while adding the requested direction.",
    assumptions: ["The current design kernel remains authoritative."],
    ...overrides,
  });
}

function codexPlannerResponse(body: Record<string, unknown>): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-workspace-codex" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "message-workspace-codex",
        type: "agent_message",
        text: JSON.stringify(body),
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
    }),
  ].join("\n");
}

test("production Workspace Agent resolves immutable context in a scratch directory and persists only a draft Proposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent production", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const response = JSON.stringify({
    pages: [{
      existingNodeId: null,
      name: "Checkout",
      instructions: "Design the complete checkout journey with order review, payment, validation, success states, and production-ready responsive composition.",
    }],
    components: [],
    resources: [],
    relations: [],
    rationale: `Keep the workspace coherent while adding the requested direction. ${"x".repeat(3_000)}`,
    assumptions: ["The current design kernel remains authoritative."],
  });
  assert.ok(Buffer.byteLength(response, "utf8") > 2_000);
  const spawner = new RecordingSpawner({ stdout: response, stderr: "", exitCode: 0 });
  const spawnerOptions: NodeSpawnerOptions[] = [];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner(options) {
      spawnerOptions.push(options);
      return spawner;
    },
  });

  const turn = {
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: WORKSPACE_TURN_ID,
    message: "Create a restrained checkout flow.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  } as const;
  const result = await orchestrator.turn(turn, new AbortController().signal);
  const replay = await orchestrator.turn(turn, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.deepEqual(replay, result);
  assert.equal(result.proposal.status, "draft");
  assert.equal(result.proposal.workspaceId, workspace.id);
  assert.equal(result.proposal.review.kind, "none");
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.agent
      : undefined,
    CLAUDE_AGENT,
  );
  assert.deepEqual(store.workspace.listProposals(project.id), [result.proposal]);
  assert.equal(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM context_packs WHERE workspace_id = ?",
  ).get(workspace.id) as { count: number }).count), 1);
  const spawned = spawner.inputs[0];
  assert.ok(spawned);
  assert.equal(spawned.command, TEST_CLAUDE_EXECUTABLE);
  assert.notEqual(spawned.cwd, join(root, "projects", project.id));
  assert.equal(existsSync(spawned.cwd), false, "planner scratch directory is removed after the turn");
  assert.equal(spawned.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "DEZIN_DAEMON_TOKEN"), true);
  assert.match(
    spawned.args[spawned.args.indexOf("--system-prompt") + 1] ?? "",
    /compact semantic workspace intent/i,
  );
  assert.match(
    spawned.args[spawned.args.indexOf("--system-prompt") + 1] ?? "",
    /Research must always use `generate`.*cannot carry an exact immutable direction selection/is,
  );
  assert.match(spawned.stdin, /dezin\.workspace-agent-request\.v1/);
  assert.doesNotMatch(spawned.stdin, new RegExp(join(root, "projects", project.id)));
  assert.ok(spawned.args.includes("--safe-mode"));
  assert.equal(spawned.args[spawned.args.indexOf("--tools") + 1], "");
  assert.ok(spawned.args.includes("--strict-mcp-config"));
  assert.ok(spawned.args.includes("--disable-slash-commands"));
  assert.ok(spawned.args.includes("--no-session-persistence"));
  assert.ok(spawned.args.includes("--no-chrome"));
  assert.ok(!spawned.args.some((argument) => /bypass|danger|yolo/i.test(argument)));
  assert.deepEqual(spawnerOptions, [{
    timeoutMs: 3 * 60 * 1_000,
    stdoutLimitBytes: 2 * 1024 * 1024,
    stderrLimitBytes: 256 * 1024,
    killDelayMs: 500,
    inheritEnvironment: false,
  }]);
  assert.equal(spawner.inputs.length, 1, "an exact retry replays before Context and planner work");
});

test("production Workspace Agent bounds a realistic multi-Artifact planning target without dropping exact Research or Moodboard Revisions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-context-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE multi-direction Workspace", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const directions = [
    { title: "Cinematic Black/Red", id: "cinematic-black-red" },
    { title: "Warm Paper/Ink", id: "warm-paper-ink" },
    { title: "Electric Cobalt Grid", id: "electric-cobalt-grid" },
  ] as const;
  const pageNames = ["Home", "Film", "Schedule", "Checkout"] as const;
  const artifacts = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `kite-page-${index + 1}`,
      nodeId: `kite-page-node-${index + 1}`,
      trackId: `kite-page-track-${index + 1}`,
      kind: "page" as const,
      name: `${directions[Math.floor(index / pageNames.length)]!.title} — ${pageNames[index % pageNames.length]}`,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `kite-component-${index + 1}`,
      nodeId: `kite-component-node-${index + 1}`,
      trackId: `kite-component-track-${index + 1}`,
      kind: "component" as const,
      name: `KITE Component ${index + 1}`,
    })),
  ];
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: artifacts.map((artifact, index) => ({
      id: `add-kite-artifact-${index + 1}`,
      type: "add-node" as const,
      node: {
        id: artifact.nodeId,
        kind: artifact.kind,
        name: artifact.name,
        artifactId: artifact.id,
        createIdentity: { initialTrackId: artifact.trackId },
      },
    })),
  });
  let expectedSnapshotId = graph.snapshot.id;
  for (const [index, artifact] of artifacts.slice(0, 8).entries()) {
    const revision = store.workspace.createArtifactRevision({
      artifactId: artifact.id,
      trackId: artifact.trackId,
      parentRevisionId: null,
      sourceCommitHash: "a".repeat(40),
      sourceTreeHash: "b".repeat(40),
      kernelRevisionId: foundation.activeKernelRevisionId,
      renderSpec: {
        protocol: "dezin.render-spec.v1",
        frames: [
          { id: "desktop-state", name: "Desktop", width: 1_440, height: 900, initialState: "default" },
          { id: "mobile-state", name: "Mobile", width: 390, height: 844, initialState: "menu-open" },
        ],
      },
      quality: {
        state: "passed",
        score: 96 - index,
        findings: [{
          severity: "info",
          code: "BULKY-QUALITY-MARKER",
          message: `BULKY-QUALITY-MARKER-${index}-${"q".repeat(2_400)}`,
        }],
      },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    expectedSnapshotId = store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId,
    }).id;
  }

  const createPinnedResource = async (input: {
    kind: "research" | "moodboard";
    title: string;
    revisionId: string;
    payload: Uint8Array;
  }) => {
    const current = store.workspace.ensureWorkspaceRecord(project.id);
    const created = store.workspace.createResourceForProject(project.id, {
      kind: input.kind,
      title: input.title,
      defaultPinPolicy: "pin-current",
      baseGraphRevision: current.graphRevision,
      expectedSnapshotId: current.activeSnapshotId,
    });
    const sealed = await sealResourceRevisionPayload({
      storageRoot: root,
      workspaceId: created.resource.workspaceId,
      resourceId: created.resource.id,
      revisionId: input.revisionId,
      mimeType: "application/json",
      bytes: input.payload,
    });
    const revision = store.workspace.createResourceRevisionCandidateForProject(
      project.id,
      created.resource.id,
      {
        revisionId: input.revisionId,
        parentRevisionId: null,
        manifestPath: sealed.manifestPath,
        summary: `${input.title} immutable evidence`,
        metadata: { mimeType: sealed.mimeType },
        checksum: sealed.manifestChecksum,
        provenance: { source: "context-budget-regression" },
      },
    );
    store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: `Seed exact immutable ${input.kind}`,
    });
    return { resource: created.resource, revision };
  };
  const research = await createPinnedResource({
    kind: "research",
    title: "KITE Research",
    revisionId: "kite-research-context-budget-revision",
    payload: Buffer.from(JSON.stringify({
      format: "dezin-research-resource",
      marker: "EXACT-RESEARCH-CONTEXT-MARKER",
      evidence: "r".repeat(24_000),
    }), "utf8"),
  });
  const moodboard = await createPinnedResource({
    kind: "moodboard",
    title: "KITE Moodboard",
    revisionId: "kite-moodboard-context-budget-revision",
    payload: Buffer.from(JSON.stringify({
      format: "dezin-moodboard-resource-bundle",
      version: 3,
      board: { id: "kite-board", name: "KITE Directions" },
      nodes: [{
        id: "kite-direction-node",
        type: "direction",
        marker: "EXACT-MOODBOARD-CONTEXT-MARKER",
        description: "m".repeat(34_000),
      }],
      messages: [],
      assets: [],
    }), "utf8"),
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const spawner = new RecordingSpawner({
    stdout: codexPlannerResponse({
      pages: artifacts.slice(0, 12).map((artifact, index) => {
        const directionIndex = Math.floor(index / pageNames.length);
        const direction = directions[directionIndex]!;
        return {
          existingNodeId: artifact.nodeId,
          operation: "generate" as const,
          requestSlotId: `direction-${directionIndex + 1}-page-${(index % pageNames.length) + 1}`,
          name: artifact.name,
          instructions: `Revise this exact KITE Page in place using Research direction id ${direction.id}.`,
          verificationStates: ["default"],
        };
      }),
      components: artifacts.slice(12).map((artifact) => ({
        existingNodeId: artifact.nodeId,
        operation: "generate" as const,
        name: artifact.name,
        instructions: "Keep this shared component coherent across Research directions cinematic-black-red, warm-paper-ink, and electric-cobalt-grid.",
        verificationStates: ["default", "hover", "focus"],
      })),
      resources: [],
      relations: [],
      rationale: "Preserve the exact current KITE Workspace.",
      assumptions: [],
    }),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000050",
    message: [
      "Revise only the current 19 active Artifact nodes in place using the pinned Research Revision and pinned Moodboard Revision.",
      "EXACT MATRIX: exactly 12 current Pages, four per direction: Cinematic Black/Red (cinematic-black-red), Warm Paper/Ink (warm-paper-ink), Electric Cobalt Grid (electric-cobalt-grid); each direction has Home, Film, Schedule, Checkout.",
      "Keep all 7 current shared Components coherent across all three exact Research directions.",
    ].join("\n"),
    explicitContext: [{
      kind: "resource",
      id: research.resource.id,
      resourceKind: "research",
      revisionId: research.revision.id,
    }, {
      kind: "resource",
      id: moodboard.resource.id,
      resourceKind: "moodboard",
      revisionId: moodboard.revision.id,
    }],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(spawner.inputs.length, 1);
  const plannerInput = spawner.inputs[0]!.stdin;
  assert.match(plannerInput, /EXACT-RESEARCH-CONTEXT-MARKER/);
  assert.match(plannerInput, /EXACT-MOODBOARD-CONTEXT-MARKER/);
  assert.doesNotMatch(plannerInput, /BULKY-QUALITY-MARKER/);
  assert.match(plannerInput, /"frameCount":2/);
  assert.match(plannerInput, /"findingCount":1/);
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  assert.equal(result.proposal.generation.artifactPlans.length, 19);
  assert.deepEqual(
    result.proposal.generation.resourceOperations.map((operation) => ({
      resourceId: operation.resourceId,
      kind: operation.kind,
      operation: operation.operation,
      revisionPolicy: operation.revisionPolicy,
    })),
    [{
      resourceId: research.resource.id,
      kind: "research",
      operation: "reuse",
      revisionPolicy: { kind: "exact", resourceRevisionId: research.revision.id },
    }, {
      resourceId: moodboard.resource.id,
      kind: "moodboard",
      operation: "reuse",
      revisionPolicy: { kind: "exact", resourceRevisionId: moodboard.revision.id },
    }],
  );
  const resourceDependencies = result.proposal.generation.dependencyPlans
    .filter((dependency) => dependency.kind === "resource");
  assert.equal(resourceDependencies.length, 19 * 2);
  for (const artifactPlan of result.proposal.generation.artifactPlans) {
    assert.deepEqual(
      resourceDependencies
        .filter((dependency) => dependency.ownerArtifactId === artifactPlan.artifactId)
        .map((dependency) => dependency.resourceId),
      [research.resource.id, moodboard.resource.id],
    );
  }
  for (const [index, pagePlan] of result.proposal.generation.artifactPlans.slice(0, 12).entries()) {
    const direction = directions[Math.floor(index / pageNames.length)]!;
    assert.deepEqual(pagePlan.researchDirectionSelection, {
      protocol: "dezin.research-direction-selection.v1",
      version: 1,
      resourceId: research.resource.id,
      revisionId: research.revision.id,
      directionId: direction.id,
    });
  }
  for (const componentPlan of result.proposal.generation.artifactPlans.slice(12)) {
    assert.deepEqual(componentPlan.researchDirectionSelection, {
      protocol: "dezin.research-direction-selection.v1",
      version: 1,
      resourceId: research.resource.id,
      revisionId: research.revision.id,
      directionId: directions[0].id,
      directionIds: directions.map(({ id }) => id),
    });
  }
});

test("production Workspace Agent keeps non-matrix exact Research directions scoped to each Artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-artifact-directions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Artifact-scoped Research directions", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Exact product directions",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const revisionId = "artifact-direction-scope-revision";
  const sealed = await sealResourceRevisionPayload({
    storageRoot: root,
    workspaceId: created.resource.workspaceId,
    resourceId: created.resource.id,
    revisionId,
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify({
      format: "dezin-research-resource",
      directions: [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ],
    }), "utf8"),
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId,
      parentRevisionId: null,
      manifestPath: sealed.manifestPath,
      summary: "Two exact immutable design directions",
      metadata: { mimeType: sealed.mimeType },
      checksum: sealed.manifestChecksum,
      provenance: { source: "artifact-direction-scope-regression" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "Seed exact Artifact-scoped Research directions",
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const plannerBodies: Record<string, unknown>[] = [{
    pages: [{
      existingNodeId: null,
      operation: "generate",
      name: "Alpha Home",
      instructions: "Generate Alpha Home using Research direction id alpha.",
      verificationStates: ["default"],
    }, {
      existingNodeId: null,
      operation: "generate",
      name: "Beta Home",
      instructions: "Generate Beta Home using Research direction id beta.",
      verificationStates: ["default"],
    }],
    components: [],
    resources: [],
    relations: [],
    rationale: "Keep each Page bound to its own exact immutable direction.",
    assumptions: [],
  }, {
    pages: [{
      existingNodeId: null,
      operation: "generate",
      name: "Global Alpha Home",
      instructions: "Generate the complete first Page without changing the turn-wide visual direction.",
      verificationStates: ["default"],
    }, {
      existingNodeId: null,
      operation: "generate",
      name: "Global Alpha Detail",
      instructions: "Generate the complete second Page without changing the turn-wide visual direction.",
      verificationStates: ["default"],
    }],
    components: [],
    resources: [],
    relations: [],
    rationale: "Apply the one unambiguous turn-wide Research direction.",
    assumptions: [],
  }, {
    pages: [{
      existingNodeId: null,
      operation: "generate",
      name: "Ambiguous Home",
      instructions: "Generate the complete first Page.",
      verificationStates: ["default"],
    }, {
      existingNodeId: null,
      operation: "generate",
      name: "Ambiguous Detail",
      instructions: "Generate the complete second Page.",
      verificationStates: ["default"],
    }],
    components: [],
    resources: [],
    relations: [],
    rationale: "The turn does not assign its two directions to individual Artifacts.",
    assumptions: [],
  }];
  const spawner = new RecordingSpawner(async () => {
    const body = plannerBodies.shift();
    assert.ok(body, "each Workspace turn must have one deterministic Planner response");
    return {
      stdout: codexPlannerResponse(body),
      stderr: "",
      exitCode: 0,
    };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000052",
    message: [
      "Create Alpha Home using Research direction id alpha.",
      "Create Beta Home using Research direction id beta.",
    ].join("\n"),
    explicitContext: [{
      kind: "resource",
      id: created.resource.id,
      resourceKind: "research",
      revisionId: revision.id,
    }],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  assert.deepEqual(
    result.proposal.generation.artifactPlans.map((plan) => ({
      name: plan.name,
      selection: plan.researchDirectionSelection,
    })),
    [{
      name: "Alpha Home",
      selection: {
        protocol: "dezin.research-direction-selection.v1",
        version: 1,
        resourceId: created.resource.id,
        revisionId: revision.id,
        directionId: "alpha",
      },
    }, {
      name: "Beta Home",
      selection: {
        protocol: "dezin.research-direction-selection.v1",
        version: 1,
        resourceId: created.resource.id,
        revisionId: revision.id,
        directionId: "beta",
      },
    }],
  );

  const singleFallback = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000054",
    message: "Create two Pages using the one turn-wide Research direction id alpha.",
    explicitContext: [{
      kind: "resource",
      id: created.resource.id,
      resourceKind: "research",
      revisionId: revision.id,
    }],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);
  assert.equal(singleFallback.kind, "proposal");
  assert.equal(singleFallback.proposal.generation.kind, "workspace-generation");
  if (singleFallback.proposal.generation.kind !== "workspace-generation") return;
  assert.deepEqual(
    singleFallback.proposal.generation.artifactPlans.map((plan) => (
      plan.researchDirectionSelection?.directionId
    )),
    ["alpha", "alpha"],
  );

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000055",
    message: [
      "Create Ambiguous Home using Research direction id alpha.",
      "Create Ambiguous Detail using Research direction id beta.",
    ].join("\n"),
    explicitContext: [{
      kind: "resource",
      id: created.resource.id,
      resourceKind: "research",
      revisionId: revision.id,
    }],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /must preserve an exact Research direction id/i);
});

test("production Workspace Agent uses the frozen CodeBuddy model despite mutable global Agent settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  store.updateSettings({
    agentCommand: "claude",
    model: "claude-global-must-not-win",
    apiKey: "live-setting-must-not-be-injected-into-codebuddy",
  });
  const project = store.createProject({ name: "Workspace Agent CodeBuddy", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const semanticIntent = {
    pages: [
      {
        existingNodeId: null,
        name: "Home",
        instructions: "Editorial landing with realistic lead story, varied story modules, saved states, and shared navigation.",
      },
      {
        existingNodeId: null,
        name: "City Guide",
        instructions: "Place-led guide with neighborhood sections, location metadata, itinerary saves, and mobile states.",
      },
    ],
    components: [
      {
        existingNodeId: null,
        name: "Global Navigation",
        instructions: "Shared masthead with desktop, compact, menu-open, focus, and active-route states.",
      },
      {
        existingNodeId: null,
        name: "Story Card",
        instructions: "Reusable editorial story preview with image, taxonomy, save, hover, and loading states.",
      },
    ],
    resources: [{
      existingNodeId: null,
      operation: "generate",
      kind: "research",
      title: "Atlas audience and Kyoto editorial research",
      instructions: "Find decision-grade audience evidence and Kyoto editorial references for the planned Home and City Guide.",
    }],
    relations: [
      { source: "Home", target: "City Guide", kind: "prototype" },
      { source: "Home", target: "Global Navigation", kind: "uses" },
      { source: "Home", target: "Story Card", kind: "uses" },
      { source: "City Guide", target: "Global Navigation", kind: "uses" },
    ],
    rationale: "Build a coherent editorial family around shared navigation and story language.",
    assumptions: ["The immutable Design Kernel remains authoritative."],
  };
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(semanticIntent),
  });
  const spawner = new RecordingSpawner({ stdout, stderr: "", exitCode: 0 });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => spawner,
  });
  const turn = {
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000012",
    message: "Plan with the Agent selected for this turn.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  } as const;

  const result = await orchestrator.turn(turn, new AbortController().signal);
  store.updateSettings({ agentCommand: "claude", model: "another-global-model" });
  const replay = await orchestrator.turn(turn, new AbortController().signal);

  assert.deepEqual(replay, result);
  assert.equal(spawner.inputs.length, 1);
  assert.equal(spawner.inputs[0]?.command, TEST_CODEBUDDY_EXECUTABLE);
  assert.equal(
    spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--model") + 1],
    "gpt-5.6-sol",
  );
  assert.equal(spawner.inputs[0]?.env?.ANTHROPIC_API_KEY, undefined);
  const systemPrompt = spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--system-prompt") + 1] ?? "";
  assert.match(systemPrompt, /compact semantic workspace intent/i);
  assert.match(systemPrompt, /do not generate ids|must not generate ids/i);
  assert.match(systemPrompt, /existingNodeId/i);
  assert.match(systemPrompt, /resources entries.*existingNodeId/i);
  assert.match(systemPrompt, /resource.*operation.*generate.*reuse/i);
  assert.match(systemPrompt, /revise.*operation.*generate/i);
  assert.deepEqual(
    result.kind === "proposal" && result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.agent
      : undefined,
    turn.agent,
  );
  assert.equal(result.kind, "proposal");
  assert.deepEqual(
    result.proposal.operations.filter((operation) => operation.type === "add-node").map((operation) => (
      operation.type === "add-node"
        ? { kind: operation.node.kind, name: operation.node.name }
        : null
    )),
    [
      { kind: "page", name: "Home" },
      { kind: "page", name: "City Guide" },
      { kind: "component", name: "Global Navigation" },
      { kind: "component", name: "Story Card" },
      { kind: "resource", name: "Atlas audience and Kyoto editorial research" },
    ],
  );
  assert.equal(
    result.proposal.operations.filter((operation) => operation.type === "add-edge").length,
    semanticIntent.relations.filter((relation) => relation.kind === "prototype").length,
  );
  assert.ok(
    result.proposal.layoutOperations.some((operation) => (
      operation.type === "add-group"
      && operation.groupId === "dezin-component-library"
      && operation.label === "Components"
      && operation.bounds.width === 668
      && operation.bounds.height === 300
    )),
  );
  const componentNodeIds = result.proposal.operations.flatMap((operation) => (
    operation.type === "add-node" && operation.node.kind === "component"
      ? [operation.node.id]
      : []
  ));
  assert.deepEqual(
    result.proposal.layoutOperations.flatMap((operation) => (
      operation.type === "move" && componentNodeIds.includes(operation.objectId)
        ? [{ objectId: operation.objectId, x: operation.x, y: operation.y }]
        : []
    )),
    [
      { objectId: componentNodeIds[0], x: 40, y: 64 },
      { objectId: componentNodeIds[1], x: 348, y: 64 },
    ],
  );
  assert.deepEqual(
    result.proposal.layoutOperations.flatMap((operation) => (
      operation.type === "set-parent" && componentNodeIds.includes(operation.objectId)
        ? [{ objectId: operation.objectId, parentGroupId: operation.parentGroupId }]
        : []
    )),
    componentNodeIds.map((objectId) => ({
      objectId,
      parentGroupId: "dezin-component-library",
    })),
  );
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.artifactPlans.map((plan) => ({
          kind: plan.kind,
          name: plan.name,
          instructions: plan.instructions,
          dependsOnArtifactIds: plan.dependsOnArtifactIds.length,
        }))
      : [],
    [
      {
        kind: "page",
        name: "Home",
        instructions: semanticIntent.pages[0]!.instructions,
        dependsOnArtifactIds: 2,
      },
      {
        kind: "page",
        name: "City Guide",
        instructions: semanticIntent.pages[1]!.instructions,
        dependsOnArtifactIds: 1,
      },
      {
        kind: "component",
        name: "Global Navigation",
        instructions: semanticIntent.components[0]!.instructions,
        dependsOnArtifactIds: 0,
      },
      {
        kind: "component",
        name: "Story Card",
        instructions: semanticIntent.components[1]!.instructions,
        dependsOnArtifactIds: 0,
      },
    ],
  );
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.resourceOperations.map((operation) => ({
          operation: operation.operation,
          kind: operation.kind,
          title: operation.title,
          instructions: operation.instructions,
          revisionPolicy: operation.revisionPolicy,
        }))
      : [],
    [{
      operation: "create",
      kind: "research",
      title: semanticIntent.resources[0]!.title,
      instructions: semanticIntent.resources[0]!.instructions,
      revisionPolicy: { kind: "generate" },
    }],
  );
  const codeBuddyGeneration = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation
    : null;
  const researchDependencies = codeBuddyGeneration?.dependencyPlans.filter(
    (dependency) => dependency.kind === "resource",
  ) ?? [];
  assert.equal(
    researchDependencies.length,
    codeBuddyGeneration?.artifactPlans.length,
    "every generated Artifact consumes the generated Research Revision before execution",
  );
  assert.equal(
    new Set(researchDependencies.map((dependency) => dependency.resourceId)).size,
    1,
    "the exact generated Research identity is frozen across every Artifact Task",
  );
  assert.deepEqual(
    new Set(researchDependencies.map((dependency) => dependency.ownerArtifactId)),
    new Set(codeBuddyGeneration?.artifactPlans.map((plan) => plan.artifactId)),
  );
  const componentDependencies = codeBuddyGeneration?.dependencyPlans.filter(
    (dependency) => dependency.kind === "component-instance",
  ) ?? [];
  assert.equal(componentDependencies.length, 3);
  assert.ok(componentDependencies.every((dependency) => (
    dependency.componentRevisionId === null
    && dependency.status === "linked"
    && Object.keys(dependency.overrides).length === 0
    && UUID_PATTERN.test(dependency.instanceId)
    && UUID_PATTERN.test(dependency.sourceLocator.designNodeId)
  )));

  const generatedPersistentIds = result.proposal.operations.flatMap((operation) => {
    if (operation.type === "add-edge") return [operation.id, operation.edge.id];
    if (operation.type !== "add-node") return [operation.id];
    if (operation.node.kind === "resource") {
      return [operation.id, operation.node.id, operation.node.resourceId];
    }
    return [
      operation.id,
      operation.node.id,
      operation.node.artifactId,
      operation.node.createIdentity?.initialTrackId,
    ].filter((id): id is string => id !== undefined);
  });
  assert.ok(generatedPersistentIds.length > 0);
  assert.ok(
    generatedPersistentIds.every((id) => UUID_PATTERN.test(id)),
    `all semantic compiler persistent ids must be UUIDs: ${generatedPersistentIds.join(", ")}`,
  );

  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.plan.constructionSealed, true);
  assert.equal(compiled.plan.status, "queued");
  assert.equal(
    compiled.tasks.filter((task) => task.kind === "component").length,
    semanticIntent.components.length,
  );
  assert.equal(
    compiled.tasks.filter((task) => task.kind === "page").length,
    semanticIntent.pages.length,
  );
});

test("production Workspace Agent claims the exact empty legacy Standard Page shell", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-legacy-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Legacy placeholder", mode: "standard" });
  store.ensureMainVariant(project.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const migrated = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    project: { ...facts.project, mode: "standard" },
    variants: facts.variants,
    successfulRuns: [],
  }, "compact");
  const legacyNode = migrated.graph.nodes[0]!;
  const legacyArtifact = migrated.artifacts[0]!;
  assert.equal(legacyNode.kind, "page");
  assert.equal(legacyArtifact.legacyWrapped, true);
  assert.equal(migrated.activeSnapshot.artifactRevisions[legacyArtifact.id], null);
  const withResearch = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Audience research",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: migrated.graph.revision,
    expectedSnapshotId: migrated.activeSnapshot.id,
  });
  const semanticIntent = {
    pages: [
      {
        existingNodeId: null,
        name: "Home",
        instructions: "A complete editorial Home page with realistic content, responsive composition, and key states.",
      },
      {
        existingNodeId: null,
        name: "Story",
        instructions: "A complete long-form Story page with reading rhythm, related content, and responsive states.",
      },
    ],
    components: [],
    resources: [],
    relations: [{ source: "Home", target: "Story", kind: "prototype" }],
    rationale: "Replace the empty migration shell and add the requested editorial flow.",
    assumptions: [],
  };
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(semanticIntent),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: migrated.workspace.id, workspaceId: migrated.workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000017",
    message: "Create the Home and Story pages.",
    explicitContext: [],
    graphRevision: withResearch.graph.revision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  const homePlan = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.artifactPlans.find((plan) => plan.name === "Home")
    : undefined;
  assert.deepEqual(homePlan && {
    operation: homePlan.operation,
    nodeId: homePlan.nodeId,
    artifactId: homePlan.artifactId,
    trackId: homePlan.trackId,
    baseRevisionId: homePlan.baseRevisionId,
  }, {
    operation: "create",
    nodeId: legacyNode.id,
    artifactId: legacyArtifact.id,
    trackId: legacyArtifact.activeTrackId,
    baseRevisionId: null,
  });
  assert.equal(
    result.proposal.operations.filter((operation) => (
      operation.type === "add-node" && operation.node.kind === "page"
    )).length,
    semanticIntent.pages.length - 1,
  );
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.deepEqual(
    approved.graph.nodes.filter((node) => node.kind === "page").map((node) => node.name).sort(),
    semanticIntent.pages.map((page) => page.name).sort(),
  );
  assert.ok(approved.plan);
  assert.equal(
    store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id).plan.status,
    "queued",
  );
});

test("production Workspace Agent refuses to infer a non-bootstrap Artifact identity from its name", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-legacy-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Existing named Page", mode: "standard" });
  store.ensureMainVariant(project.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const migrated = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    project: { ...facts.project, mode: "standard" },
    variants: facts.variants,
    successfulRuns: [],
  }, "compact");
  const existingNode = migrated.graph.nodes[0]!;
  const nonBootstrap = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: migrated.graph.revision,
    expectedSnapshotId: migrated.activeSnapshot.id,
    commands: [{
      id: "add-existing-sibling-page",
      type: "add-node",
      node: {
        id: "existing-sibling-page-node",
        kind: "page",
        name: "Existing sibling",
        artifactId: "existing-sibling-page",
        createIdentity: { initialTrackId: "existing-sibling-page-track" },
      },
    }],
  });
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: existingNode.name,
        instructions: "Attempt to recreate an existing non-bootstrap Page from its display name alone.",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Attempt an ambiguous identity substitution.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: migrated.workspace.id, workspaceId: migrated.workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000020",
    message: "Regenerate the existing Page.",
    explicitContext: [],
    graphRevision: nonBootstrap.graph.revision,
  }, new AbortController().signal), /exact existingNodeId/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent adds new Components to unoccupied canonical shelf slots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-component-shelf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy Component shelf", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const firstIntent = {
    pages: [{
      existingNodeId: null,
      name: "Overview",
      instructions: "A complete overview Page with realistic content, responsive composition, and interaction states.",
    }],
    components: [
      {
        existingNodeId: null,
        name: "Navigation",
        instructions: "A reusable navigation Component with desktop, mobile, active, and focus states.",
      },
      {
        existingNodeId: null,
        name: "Story Card",
        instructions: "A reusable story card Component with media, metadata, save, hover, and loading states.",
      },
    ],
    resources: [],
    relations: [
      { source: "Overview", target: "Navigation", kind: "uses" },
      { source: "Overview", target: "Story Card", kind: "uses" },
    ],
    rationale: "Seed the canonical Component shelf.",
    assumptions: [],
  };
  const firstOrchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(firstIntent),
      }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const first = await firstOrchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000018",
    message: "Create the initial Page and Component shelf.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);
  assert.equal(first.kind, "proposal");
  const seeded = store.workspace.approveProposalForProject(project.id, first.proposal.id, "structure-only");
  assert.equal(seeded.plan, null);
  const overviewNode = seeded.graph.nodes.find((node) => node.name === "Overview")!;
  const existingComponentNodeIds = seeded.graph.nodes
    .filter((node) => node.kind === "component")
    .map((node) => node.id);
  const seededPositions = new Map(seeded.layout.objects.map((object) => [object.id, object]));
  const secondIntent = {
    pages: [{
      existingNodeId: overviewNode.id,
      name: "Overview",
      instructions: "Refine the complete overview while preserving its realistic content and responsive states.",
    }],
    components: [{
      existingNodeId: null,
      name: "Feature Rail",
      instructions: "A reusable horizontal feature rail with overflow, focus, loading, and mobile states.",
    }],
    resources: [],
    relations: [{ source: "Overview", target: "Feature Rail", kind: "uses" }],
    rationale: "Extend the existing canonical Component shelf without moving established work.",
    assumptions: [],
  };
  const secondOrchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(secondIntent),
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  const second = await secondOrchestrator.turn({
    scope: { type: "workspace", id: seeded.graph.workspaceId, workspaceId: seeded.graph.workspaceId },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000019",
    message: "Add a Feature Rail Component without disturbing the existing canvas.",
    explicitContext: [],
    graphRevision: seeded.graph.revision,
  }, new AbortController().signal);
  assert.equal(second.kind, "proposal");
  const newComponentNode = second.proposal.operations.flatMap((operation) => (
    operation.type === "add-node" && operation.node.kind === "component" ? [operation.node] : []
  ))[0]!;
  const movedIds = second.proposal.layoutOperations.flatMap((operation) => (
    operation.type === "move" ? [operation.objectId] : []
  ));
  assert.ok(!movedIds.includes(overviewNode.id));
  assert.ok(existingComponentNodeIds.every((nodeId) => !movedIds.includes(nodeId)));
  assert.deepEqual(
    second.proposal.layoutOperations.find((operation) => (
      operation.type === "move" && operation.objectId === newComponentNode.id
    )),
    { type: "move", objectId: newComponentNode.id, x: 656, y: 64 },
  );
  assert.deepEqual(
    second.proposal.layoutOperations.find((operation) => operation.type === "resize-group"),
    {
      type: "resize-group",
      groupId: "dezin-component-library",
      width: 976,
      height: 300,
    },
  );
  assert.ok(existingComponentNodeIds.every((nodeId) => (
    seededPositions.get(nodeId)?.parentGroupId === "dezin-component-library"
  )));
  const approved = store.workspace.approveProposalForProject(project.id, second.proposal.id, "generate");
  assert.ok(approved.plan);
  assert.equal(
    store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id).plan.status,
    "queued",
  );
});

test("production Workspace Agent keeps new root placements clear of occupied canvas bounds", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-root-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy root layout", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-layout-blocker-page",
      type: "add-node",
      node: {
        id: "layout-blocker-page",
        kind: "page",
        name: "Existing Page",
        artifactId: "layout-blocker-page-artifact",
        createIdentity: { initialTrackId: "layout-blocker-page-track" },
      },
    }, {
      id: "add-layout-blocker-resource",
      type: "add-node",
      node: {
        id: "layout-blocker-resource",
        kind: "resource",
        name: "Existing Resource",
        resourceId: "layout-blocker-resource-record",
        createIdentity: {
          resourceKind: "moodboard",
          defaultPinPolicy: "follow-head",
        },
      },
    }],
  });
  const baseLayout = store.workspace.getLayout(project.id);
  store.workspace.saveLayout(project.id, {
    layoutId: baseLayout.layoutId,
    graphRevision: mutation.graph.revision,
    baseLayoutChecksum: baseLayout.checksum,
    commands: [
      { type: "move", objectId: "layout-blocker-page", x: 80, y: 80 },
      { type: "move", objectId: "layout-blocker-resource", x: 80, y: 680 },
      {
        type: "add-group",
        groupId: "layout-blocker-group",
        label: "Existing group",
        bounds: { x: 1_240, y: 80, width: 600, height: 400 },
      },
    ],
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "New Page",
        instructions: "A complete new Page with realistic content, responsive hierarchy, and interaction states.",
      }],
      components: [{
        existingNodeId: null,
        name: "New Action",
        instructions: "A reusable action Component with default, hover, focus, loading, and disabled states.",
      }],
      resources: [{
        existingNodeId: null,
        operation: "generate",
        kind: "moodboard",
        title: "New visual direction",
        instructions: "Generate a coherent visual reference set for the new Page and shared Action Component.",
      }],
      relations: [{ source: "New Page", target: "New Action", kind: "uses" }],
      rationale: "Add a coherent Page, shared Component, and visual direction without covering existing work.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000023",
    message: "Add a Page, Component, and Moodboard without overlapping existing canvas work.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  const added = result.proposal.operations.flatMap((operation) => (
    operation.type === "add-node" ? [operation.node] : []
  ));
  const newPage = added.find((node) => node.kind === "page");
  const newResource = added.find((node) => node.kind === "resource");
  assert.ok(newPage && newResource);
  const pageMove = result.proposal.layoutOperations.find((operation) => (
    operation.type === "move" && operation.objectId === newPage.id
  ));
  const resourceMove = result.proposal.layoutOperations.find((operation) => (
    operation.type === "move" && operation.objectId === newResource.id
  ));
  const componentGroup = result.proposal.layoutOperations.find((operation) => (
    operation.type === "add-group" && operation.groupId === "dezin-component-library"
  ));
  assert.ok(pageMove?.type === "move");
  assert.ok(resourceMove?.type === "move");
  assert.ok(componentGroup?.type === "add-group");
  const occupied = [
    { x: 80, y: 80, width: 280, height: 222 },
    { x: 80, y: 680, width: 240, height: 112 },
    { x: 1_240, y: 80, width: 600, height: 400 },
  ];
  const overlaps = (
    left: { x: number; y: number; width: number; height: number },
    right: { x: number; y: number; width: number; height: number },
  ): boolean => (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
  assert.ok(occupied.every((bounds) => !overlaps(
    { x: pageMove.x, y: pageMove.y, width: 280, height: 222 },
    bounds,
  )));
  assert.ok(occupied.every((bounds) => !overlaps(
    { x: resourceMove.x, y: resourceMove.y, width: 240, height: 112 },
    bounds,
  )));
  assert.ok(occupied.every((bounds) => !overlaps(componentGroup.bounds, bounds)));
});

test("production Workspace Agent pins an exact existing Component without regenerating it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-component-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy Component reuse", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-existing-navigation-component",
      type: "add-node",
      node: {
        id: "existing-navigation-component-node",
        kind: "component",
        name: "Existing Navigation",
        artifactId: "existing-navigation-component",
        createIdentity: { initialTrackId: "existing-navigation-component-track" },
      },
    }],
  });
  const component = store.workspace.getArtifact("existing-navigation-component");
  assert.ok(component);
  const source = seedArtifactSource({
    root,
    projectId: project.id,
    sourceRoot: component.sourceRoot,
    designNodeId: "existing-navigation-root",
  });
  const componentRevision = store.workspace.createArtifactRevision({
    artifactId: component.id,
    trackId: "existing-navigation-component-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: mutation.snapshot.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Checkout",
        instructions: "A complete checkout Page with realistic order content, responsive states, and shared navigation.",
      }],
      components: [{
        existingNodeId: "existing-navigation-component-node",
        operation: "reuse",
        name: "Existing Navigation",
        instructions: "Reuse the exact published navigation Component without regenerating or changing its states.",
      }],
      resources: [],
      relations: [{ source: "Checkout", target: "Existing Navigation", kind: "uses" }],
      rationale: "Compose the new Page from the exact published shared Component.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000021",
    message: "Create Checkout using the exact existing Navigation Component.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.artifactPlans.map((plan) => ({ kind: plan.kind, name: plan.name }))
      : [],
    [{ kind: "page", name: "Checkout" }],
  );
  const dependency = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.dependencyPlans.find((candidate) => (
        candidate.kind === "component-instance"
        && candidate.componentArtifactId === component.id
      ))
    : undefined;
  assert.ok(dependency?.kind === "component-instance");
  assert.equal(dependency.componentRevisionId, componentRevision.id);
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.tasks.filter((task) => task.kind === "page").length, 1);
  assert.equal(compiled.tasks.filter((task) => task.kind === "component").length, 0);
});

test("production Workspace Agent attaches a reused Moodboard only to generated Artifacts so mixed reuse compiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-mixed-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent mixed reuse", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const componentMutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [{
      id: "add-mixed-reuse-component",
      type: "add-node",
      node: {
        id: "mixed-reuse-component-node",
        kind: "component",
        name: "Existing Navigation",
        artifactId: "mixed-reuse-component",
        createIdentity: { initialTrackId: "mixed-reuse-component-track" },
      },
    }],
  });
  const component = store.workspace.getArtifact("mixed-reuse-component");
  assert.ok(component);
  const source = seedArtifactSource({
    root,
    projectId: project.id,
    sourceRoot: component.sourceRoot,
    designNodeId: "mixed-reuse-component-root",
  });
  const componentRevision = store.workspace.createArtifactRevision({
    artifactId: component.id,
    trackId: "mixed-reuse-component-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: foundation.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentMutation.snapshot.id,
  });
  const afterComponent = store.workspace.ensureWorkspaceRecord(project.id);
  const moodboard = store.workspace.createResourceForProject(project.id, {
    kind: "moodboard",
    title: "Existing Visual Direction",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: afterComponent.graphRevision,
    expectedSnapshotId: afterComponent.activeSnapshotId,
  });
  const moodboardRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    moodboard.resource.id,
    {
      revisionId: "mixed-reuse-moodboard-revision",
      parentRevisionId: null,
      manifestPath: "resource-revisions/mixed-reuse-moodboard-revision/manifest.json",
      summary: "Published visual direction",
      metadata: { mimeType: "application/json" },
      checksum: "b".repeat(64),
      provenance: { source: "test" },
    },
  );
  store.workspace.publishResourceRevisionForProject(
    project.id,
    moodboard.resource.id,
    moodboardRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: moodboard.snapshot.id,
      reason: "Seed exact immutable Moodboard",
    },
  );
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const moodboardNode = store.workspace.getCompactBundleByProjectId(project.id)?.graph.nodes.find(
    (node) => node.kind === "resource" && node.resourceId === moodboard.resource.id,
  );
  assert.ok(moodboardNode);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        operation: "generate",
        name: "Checkout",
        instructions: "A complete checkout Page using the existing navigation and visual direction.",
      }],
      components: [{
        existingNodeId: "mixed-reuse-component-node",
        operation: "reuse",
        name: "Existing Navigation",
        instructions: "Reuse the exact published navigation Component.",
      }],
      resources: [{
        existingNodeId: moodboardNode.id,
        operation: "reuse",
        kind: "moodboard",
        title: moodboard.resource.title,
        instructions: "Reuse this exact immutable visual direction without generating or altering its assets.",
      }],
      relations: [{ source: "Checkout", target: "Existing Navigation", kind: "uses" }],
      rationale: "Generate one Page from exact existing Component and Moodboard context.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000022",
    message: "Create Checkout using the exact existing Navigation and Moodboard.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  const generatedArtifactId = result.proposal.generation.artifactPlans[0]?.artifactId;
  assert.ok(generatedArtifactId);
  assert.deepEqual(
    result.proposal.generation.dependencyPlans
      .filter((dependency) => dependency.kind === "resource")
      .map((dependency) => dependency.ownerArtifactId),
    [generatedArtifactId],
  );
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.tasks.filter((task) => task.kind === "page").length, 1);
  assert.equal(compiled.tasks.filter((task) => task.kind === "component").length, 0);
});

test("production Workspace Agent preserves omitted base Component dependencies when revising an Artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-dependency-union-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy dependency union", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-existing-checkout-page",
      type: "add-node",
      node: {
        id: "existing-checkout-page-node",
        kind: "page",
        name: "Existing Checkout",
        artifactId: "existing-checkout-page",
        createIdentity: { initialTrackId: "existing-checkout-page-track" },
      },
    }, {
      id: "add-existing-payment-component",
      type: "add-node",
      node: {
        id: "existing-payment-component-node",
        kind: "component",
        name: "Existing Payment",
        artifactId: "existing-payment-component",
        createIdentity: { initialTrackId: "existing-payment-component-track" },
      },
    }],
  });
  const page = store.workspace.getArtifact("existing-checkout-page");
  const component = store.workspace.getArtifact("existing-payment-component");
  assert.ok(page && component);
  const source = seedArtifactSource({
    root,
    projectId: project.id,
    sourceRoot: page.sourceRoot,
    designNodeId: "existing-checkout-root",
    additionalSources: [{ sourceRoot: component.sourceRoot, designNodeId: "existing-payment-root" }],
  });
  const componentRevision = store.workspace.createArtifactRevision({
    artifactId: component.id,
    trackId: "existing-payment-component-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: mutation.snapshot.id,
  });
  const pageRevision = store.workspace.createArtifactRevision({
    artifactId: page.id,
    trackId: "existing-checkout-page-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [{
      instanceId: "existing-payment-instance",
      componentArtifactId: component.id,
      componentRevisionId: componentRevision.id,
      createInstanceIdentity: true,
      variantKey: "compact",
      stateKey: "ready",
      sourceLocator: {
        designNodeId: "existing-payment-slot",
        sourcePath: `${page.sourceRoot}/index.tsx`,
      },
      overrides: { emphasis: "high" },
      status: "linked",
    }],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(pageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: "existing-checkout-page-node",
        name: "Existing Checkout",
        instructions: "Refine the complete checkout hierarchy and responsive states without changing shared Component usage.",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Revise only the Page while preserving its exact shared Component assembly.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000022",
    message: "Refine Checkout without changing its shared Component dependencies.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  const generation = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation
    : null;
  assert.ok(generation);
  assert.deepEqual(generation.artifactPlans[0]?.dependsOnArtifactIds, [component.id]);
  assert.deepEqual(generation.dependencyPlans, [{
    kind: "component-instance",
    ownerArtifactId: page.id,
    instanceId: "existing-payment-instance",
    componentArtifactId: component.id,
    componentRevisionId: componentRevision.id,
    variantKey: "compact",
    stateKey: "ready",
    sourceLocator: {
      designNodeId: "existing-payment-slot",
      sourcePath: `${page.sourceRoot}/index.tsx`,
    },
    overrides: { emphasis: "high" },
    status: "linked",
  }]);
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.tasks.filter((task) => task.kind === "page").length, 1);
  assert.equal(compiled.tasks.filter((task) => task.kind === "component").length, 0);
});

test("production Workspace Agent rejects a CodeBuddy semantic intent that forges an existing node identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-forged-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy forged node", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: "forged-page-node",
        name: "Forged page",
        instructions: "Attempt to substitute a node outside the immutable Workspace Context.",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Try a forged identity.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000014",
    message: "Plan against this exact Workspace.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /existingNodeId.*current Workspace Artifact node/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent never resolves a CodeBuddy Resource by kind and title", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-resource-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy Resource identity", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const existing = store.workspace.createResourceForProject(project.id, {
    kind: "moodboard",
    title: "Exact visual direction",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Campaign",
        instructions: "A complete campaign landing page with realistic content and responsive states.",
      }],
      components: [],
      resources: [{
        existingNodeId: null,
        operation: "reuse",
        kind: existing.resource.kind,
        title: existing.resource.title,
        instructions: "Reuse only the exact current Moodboard identity; never substitute by matching title or kind.",
      }],
      relations: [],
      rationale: "Attempt to infer a Resource identity from its title.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000015",
    message: "Reuse the exact current moodboard.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /reuse.*existingNodeId/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent generates the first Revision into an exact empty Resource shell with planned prototype history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-empty-resource-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent empty Resource shell", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const graphWithPrototype = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      {
        id: "add-empty-shell-source-page",
        type: "add-node",
        node: {
          id: "empty-shell-source-page-node",
          kind: "page",
          name: "Source Page",
          artifactId: "empty-shell-source-page-artifact",
          createIdentity: { initialTrackId: "empty-shell-source-page-track" },
        },
      },
      {
        id: "add-empty-shell-target-page",
        type: "add-node",
        node: {
          id: "empty-shell-target-page-node",
          kind: "page",
          name: "Target Page",
          artifactId: "empty-shell-target-page-artifact",
          createIdentity: { initialTrackId: "empty-shell-target-page-track" },
        },
      },
      {
        id: "add-empty-shell-planned-prototype",
        type: "add-edge",
        edge: {
          id: "empty-shell-planned-prototype-edge",
          workspaceId: foundation.id,
          kind: "prototype",
          sourceNodeId: "empty-shell-source-page-node",
          targetNodeId: "empty-shell-target-page-node",
        },
      },
    ],
  });
  const existing = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "KITE Film Festival Research",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: graphWithPrototype.graph.revision,
    expectedSnapshotId: graphWithPrototype.snapshot.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse({
        pages: [],
        components: [],
        resources: [{
          existingNodeId: existing.node.id,
          operation: "generate",
          kind: "research",
          title: existing.resource.title,
          instructions: "Complete decision-grade film-festival evidence in this exact empty Research shell.",
        }],
        relations: [],
        rationale: "Complete the exact empty Research shell left by the prior interrupted generation.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000047",
    message: "Retry the failed Research generation in place.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  if (result.kind !== "proposal") return;
  assert.deepEqual(result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.resourceOperations.map((operation) => ({
        operation: operation.operation,
        nodeId: operation.nodeId,
        resourceId: operation.resourceId,
      }))
    : [], [{
    operation: "create",
    nodeId: existing.node.id,
    resourceId: existing.resource.id,
  }]);
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.tasks.filter((task) => task.target.type === "resource").length, 1);
});

test("Codex semantic planning compiles explicit visual states into Artifact-scoped desktop and mobile QA Frames", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-state-frames-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent state Frames", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  let observedSchema: Record<string, unknown> | null = null;
  let observedSystemPrompt = "";
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchema = JSON.parse(
        readFileSync(input.args[schemaIndex + 1]!, "utf8"),
      ) as Record<string, unknown>;
      observedSystemPrompt = input.stdin;
      return {
        stdout: codexPlannerResponse({
          pages: [{
            existingNodeId: null,
            operation: "generate",
            name: "KITE Checkout",
            instructions: "Design a complete ticket checkout with populated, validation, processing, and error behavior.",
            verificationStates: ["validation-error", "payment-processing"],
          }],
          components: [{
            existingNodeId: null,
            operation: "generate",
            name: "KITE Direction Switcher",
            instructions: "Switch visibly between the exact cinematic, paper, and cobalt visual directions.",
            verificationStates: [
              "cinematic-black-red",
              "warm-paper-ink",
              "electric-cobalt-grid",
            ],
          }],
          resources: [],
          relations: [],
          rationale: "Prove every explicitly required non-default visual state.",
          assumptions: [],
        }),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000048",
    message: "Generate Checkout and its shared direction switcher with all named visual states verified.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  const generation = result.proposal.generation;
  const checkout = generation.artifactPlans.find((plan) => plan.name === "KITE Checkout");
  const switcher = generation.artifactPlans.find((plan) => plan.name === "KITE Direction Switcher");
  assert.ok(checkout);
  assert.ok(switcher);
  const framesById = new Map(generation.responsiveFrames.map((frame) => [frame.id, frame]));
  const statesFor = (frameIds: readonly string[]) => frameIds.flatMap((id) => {
    const state = framesById.get(id)?.initialState;
    return state === undefined ? [] : [state];
  });
  assert.deepEqual(
    new Set(statesFor(checkout.responsiveFrameIds)),
    new Set(["validation-error", "payment-processing"]),
  );
  assert.deepEqual(
    new Set(statesFor(switcher.responsiveFrameIds)),
    new Set(["cinematic-black-red", "warm-paper-ink", "electric-cobalt-grid"]),
  );
  for (const state of [
    "validation-error",
    "payment-processing",
    "cinematic-black-red",
    "warm-paper-ink",
    "electric-cobalt-grid",
  ]) {
    const stateFrames = generation.responsiveFrames.filter((frame) => frame.initialState === state);
    assert.equal(stateFrames.some((frame) => frame.width >= 1_280 && frame.height >= 720), true);
    assert.equal(
      stateFrames.some((frame) => frame.width >= 320 && frame.width <= 480 && frame.height >= 640),
      true,
    );
  }

  assert.ok(observedSchema);
  const exactObservedSchema = observedSchema as unknown as Record<string, unknown>;
  const schemaProperties = exactObservedSchema.properties as Record<string, unknown>;
  const pageItem = ((schemaProperties.pages as Record<string, unknown>).items) as Record<string, unknown>;
  const pageProperties = pageItem.properties as Record<string, Record<string, unknown>>;
  assert.ok((pageItem.required as string[]).includes("verificationStates"));
  assert.equal(pageProperties.verificationStates!.maxItems, 6);
  assert.equal(Object.hasOwn(pageProperties.verificationStates!, "uniqueItems"), false);
  assert.match(observedSystemPrompt, /verificationStates.*non-default.*visibl/i);
  assert.match(observedSystemPrompt, /server.*desktop.*mobile.*QA Frames/i);
  assert.match(observedSystemPrompt, /every generated Component.*uses.*Do not leave.*orphaned/is);
});

test("Codex semantic planning makes generated Research and Moodboard outputs hard dependencies of generated Artifacts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-resource-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent Resource dependencies", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse({
        pages: [{
          existingNodeId: null,
          operation: "generate",
          name: "KITE Home",
          instructions: "Use the exact generated film-festival evidence and direction imagery in the final Home design.",
        }],
        components: [],
        resources: [
          {
            existingNodeId: null,
            operation: "generate",
            kind: "research",
            title: "KITE Research",
            instructions: "Produce decision-grade film-festival evidence for the planned visual direction.",
          },
          {
            existingNodeId: null,
            operation: "generate",
            kind: "moodboard",
            title: "KITE Moodboard",
            instructions: "Produce the exact imagery, palette, texture, and composition reference for KITE Home.",
          },
        ],
        relations: [],
        rationale: "Generate source truth before the Artifact consumes it.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000049",
    message: "Generate the Research and Moodboard first, then use their immutable outputs in KITE Home.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  const generation = result.proposal.generation;
  const page = generation.artifactPlans.find((plan) => plan.name === "KITE Home");
  assert.ok(page);
  const resourceIds = new Set(generation.resourceOperations.map((operation) => operation.resourceId));
  assert.deepEqual(
    new Set(generation.dependencyPlans.flatMap((dependency) => (
      dependency.kind === "resource" && dependency.ownerArtifactId === page.artifactId
        ? [dependency.resourceId]
        : []
    ))),
    resourceIds,
  );

  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const pageTask = compiled.tasks.find((task) => task.kind === "page");
  assert.ok(pageTask);
  const resourceTaskIds = new Set(
    compiled.tasks.filter((task) => task.kind === "resource").map((task) => task.id),
  );
  assert.deepEqual(new Set(pageTask.dependencyIds.filter((id) => resourceTaskIds.has(id))), resourceTaskIds);
});

test("production Workspace Agent rejects existing Research reuse without an exact direction selection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-research-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy Research reuse", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const research = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Exact published research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    research.resource.id,
    {
      revisionId: "research-revision-codebuddy-reuse",
      parentRevisionId: null,
      manifestPath: "resource-revisions/research-revision-codebuddy-reuse/manifest.json",
      summary: "Grounded direction set",
      metadata: {
        mimeType: "application/json",
        qualityState: "grounded",
        evidenceDirectionCount: 1,
        hypothesisDirectionCount: 0,
      },
      checksum: "a".repeat(64),
      provenance: { source: "test" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, research.resource.id, revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: research.snapshot.id,
    reason: "Seed exact immutable Research",
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const resourceNode = store.workspace.getCompactBundleByProjectId(project.id)?.graph.nodes.find(
    (node) => node.kind === "resource" && node.resourceId === research.resource.id,
  );
  assert.ok(resourceNode);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Campaign",
        instructions: "A complete campaign page with realistic content, responsive states, and evidence-led direction.",
      }],
      components: [],
      resources: [{
        existingNodeId: resourceNode.id,
        operation: "reuse",
        kind: "research",
        title: research.resource.title,
        instructions: "Attempt to reuse this Research only if an exact immutable direction selection is present.",
      }],
      relations: [],
      rationale: "Attempt to reuse Research without selecting one immutable direction.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000016",
    message: "Reuse the exact published Research.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /Research reuse.*not supported.*direction selection/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent leaves the reserved Component group untouched for a Page-only intent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-codebuddy-page-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent CodeBuddy Page only", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Overview",
        instructions: "A complete overview page with realistic content, responsive composition, and interaction states.",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Add the requested Page without inventing a Component library.",
      assumptions: [],
    }),
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveCodeBuddyExecutable: () => TEST_CODEBUDDY_EXECUTABLE,
    createSpawner: () => new RecordingSpawner({ stdout, stderr: "", exitCode: 0 }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
    turnId: "turn-00000000-0000-4000-8000-000000000016",
    message: "Add one standalone overview Page.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.ok(result.proposal.layoutOperations.every((operation) => (
    operation.type !== "rename-group" || operation.groupId !== "dezin-component-library"
  )));
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  assert.equal(
    store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id).plan.status,
    "queued",
  );
});

test("production Workspace Agent preserves Kernel QA and raises weak Artifact plans to the production quality floor", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-quality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent quality", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const kernel = store.workspace.createKernelRevision({
    workspaceId: foundation.id,
    parentRevisionId: foundation.activeKernelRevisionId,
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Review the complete responsive experience.",
    terminology: {},
    exclusions: [],
    responsiveFrames: [{ id: "wide", name: "Wide", width: 1600, height: 1000 }],
    qualityProfile: {
      requiredFrameIds: ["wide"],
      blockingSeverities: ["P2"],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
  });
  store.workspace.publishKernelRevision(kernel.id, {
    expectedKernelRevisionId: foundation.activeKernelRevisionId,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const spawner = new RecordingSpawner({
    stdout: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Checkout",
        instructions: "Design the complete checkout journey with order review, payment, validation, and success states.",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Add a production-ready checkout journey.",
      assumptions: [],
    }),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: "turn-00000000-0000-4000-8000-000000000011",
    message: "Create a checkout page.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  assert.deepEqual(result.proposal.generation.responsiveFrames.find((frame) => frame.id === "wide"), {
    id: "wide",
    name: "Wide",
    width: 1600,
    height: 1000,
  });
  assert.deepEqual(result.proposal.generation.qualityProfile, {
    requiredFrameIds: ["wide", "mobile"],
    blockingSeverities: ["P0", "P1", "P2"],
    requireRuntimeChecks: true,
    requireVisualReview: true,
  });
  assert.deepEqual(
    result.proposal.generation.artifactPlans[0]?.responsiveFrameIds,
    result.proposal.generation.qualityProfile.requiredFrameIds,
  );
  assert.equal(
    result.proposal.generation.artifactPlans[0]?.instructions,
    "Design the complete checkout journey with order review, payment, validation, and success states.",
  );
  assert.match(
    spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--system-prompt") + 1] ?? "",
    /server deterministically compiles.*responsive QA/i,
  );
  assert.match(
    spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--system-prompt") + 1] ?? "",
    /Every Page and Component.*instructions.*purpose.*content.*states.*composition/i,
  );
});

test("production Workspace Agent rejects name-only Artifact plans that cannot preserve per-page intent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-missing-brief-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent missing brief", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const spawner = new RecordingSpawner({
    stdout: JSON.stringify({
      pages: [{
        existingNodeId: null,
        name: "Home",
      }],
      components: [],
      resources: [],
      relations: [],
      rationale: "Add a complete editorial home page.",
      assumptions: [],
    }),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: "turn-00000000-0000-4000-8000-000000000013",
    message: "Create a complete editorial home page.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /instructions/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent rejects forbidden direct mutations without persisting a Proposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-forbidden-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent restrictions", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const spawner = new RecordingSpawner({
    stdout: plannerResponse({
      operations: [{ id: "archive-1", type: "archive-node", nodeId: "node-1" }],
    }),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: WORKSPACE_TURN_ID,
    message: "Archive this node without review.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /archive|forbidden|proposal-only|unsupported field operations/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent never rebases a plan onto canvas state that changed during the turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent drift", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const initialLayout = store.workspace.getLayout(project.id);
  const spawner = new RecordingSpawner(async () => {
      store.workspace.saveLayout(project.id, {
        layoutId: initialLayout.layoutId,
        graphRevision: workspace.graphRevision,
        baseLayoutChecksum: initialLayout.checksum,
        commands: [{ type: "set-viewport", viewport: { x: 120, y: -40, zoom: 0.75 } }],
      });
      return { stdout: plannerResponse(), stderr: "", exitCode: 0 };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: WORKSPACE_TURN_ID,
    message: "Plan against this exact canvas.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BlockedContextError);
    assert.match(error.message, /changed while.*planning|current canvas/i);
    return true;
  });
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production scoped Artifact Agent persists exact target and element Context before compiling one durable Task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-scoped-agent-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Scoped Artifact Agent production", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-checkout-page",
      type: "add-node",
      node: {
        id: "checkout-page-node",
        kind: "page",
        name: "Checkout",
        artifactId: "checkout-page",
        createIdentity: { initialTrackId: "checkout-page-track" },
      },
    }, {
      id: "add-payment-component",
      type: "add-node",
      node: {
        id: "payment-component-node",
        kind: "component",
        name: "Payment action",
        artifactId: "payment-component",
        createIdentity: { initialTrackId: "payment-component-track" },
      },
    }],
  });
  const artifact = store.workspace.getArtifact("checkout-page");
  const component = store.workspace.getArtifact("payment-component");
  assert.ok(artifact && component);
  const source = seedArtifactSource({
    root,
    projectId: project.id,
    sourceRoot: artifact.sourceRoot,
    designNodeId: "checkout-root",
    additionalSources: [{ sourceRoot: component.sourceRoot, designNodeId: "payment-submit" }],
  });
  const componentRevision = store.workspace.createArtifactRevision({
    artifactId: component.id,
    trackId: "payment-component-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: mutation.snapshot.id,
  });
  const baseRevision = store.workspace.createArtifactRevision({
    artifactId: "checkout-page",
    trackId: "checkout-page-track",
    parentRevisionId: null,
    sourceCommitHash: source.commitHash,
    sourceTreeHash: source.treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [{
      instanceId: "payment-component-instance",
      componentArtifactId: component.id,
      componentRevisionId: componentRevision.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "payment-component-slot", sourcePath: `${artifact.sourceRoot}/index.tsx` },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(baseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const wakes: string[] = [];
  const scopedTasks = createProductionScopedAgentTaskQueue({
    store,
    planService: {
      compileAndEnqueueApprovedShell(planId) {
        return store.workspace.compileApprovedGenerationPlanForProject(project.id, planId).plan;
      },
    },
    wakePlan(planId) {
      wakes.push(planId);
    },
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    scopedTasks,
    createSpawner() {
      throw new Error("scoped dispatch must not invoke the Workspace Planner");
    },
  });

  const result = await orchestrator.turn({
    turnId: "turn-00000000-0000-4000-8000-000000000001",
    scope: { type: "artifact", id: "checkout-page", workspaceId: workspace.id },
    intent: "edit",
    agent: CLAUDE_AGENT,
    message: "Refine the payment call to action without changing the shared checkout structure.",
    selection: [{ kind: "element", id: "payment-submit", revisionId: baseRevision.id }],
    explicitContext: [],
    graphRevision: workspace.graphRevision,
    baseRevisionId: baseRevision.id,
  }, new AbortController().signal);

  assert.equal(result.kind, "task");
  assert.deepEqual(result.task.target, {
    type: "artifact",
    workspaceId: workspace.id,
    id: "checkout-page",
    trackId: "checkout-page-track",
  });
  assert.deepEqual(wakes, [result.task.planId]);
  const repository = createWorkspaceContextPackRepository(store.workspace, { manifestRoot: root });
  const contextPack = repository.get(workspace.id, result.contextPackId);
  assert.ok(contextPack);
  const target = contextPack.items.find((item) => item.contextClass === "target");
  assert.deepEqual(target?.ref, {
    kind: "artifact",
    id: "checkout-page",
    revisionId: baseRevision.id,
  });
  assert.equal(target?.provenance.artifactRevisionId, baseRevision.id);
  assert.equal(target?.provenance.snapshotId, workspace.activeSnapshotId);
  const selection = contextPack.items.find((item) => item.contextClass === "selection");
  assert.deepEqual(selection?.ref, { kind: "inline", id: "payment-submit" });
  assert.equal(selection?.provenance.artifactRevisionId, baseRevision.id);
  assert.equal(selection?.provenance.designNodeId, "payment-submit");
  assert.equal(selection?.provenance.sourceArtifactId, component.id);
  assert.equal(selection?.provenance.sourceArtifactRevisionId, componentRevision.id);
  assert.equal(selection?.provenance.sourceTreeHash, source.treeHash);
  assert.equal(typeof selection?.provenance.assemblyHash, "string");
  assert.match(selection?.provenance.assemblyHash as string, /^[0-9a-f]{64}$/);
  const selectionManifest = JSON.parse(selection?.content ?? "null") as Record<string, unknown> | null;
  assert.equal(selectionManifest?.protocol, "dezin.artifact-element-selection-manifest.v1");
  assert.equal(selectionManifest?.sourceArtifactId, component.id);
  assert.equal(selectionManifest?.sourceArtifactRevisionId, componentRevision.id);
  assert.equal(selectionManifest?.selectionManifestHash, selection?.provenance.selectionManifestHash);
  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, result.task.planId);
  assert.equal(detail.plan.status, "queued");
  assert.deepEqual(detail.tasks.map((task) => task.kind), ["page", "prototype-validation", "checkpoint"]);

  await assert.rejects(orchestrator.turn({
    turnId: "turn-00000000-0000-4000-8000-000000000002",
    scope: { type: "artifact", id: "checkout-page", workspaceId: workspace.id },
    intent: "edit",
    agent: CLAUDE_AGENT,
    message: "Refine a forged selection.",
    selection: [{ kind: "element", id: "forged-payment-submit", revisionId: baseRevision.id }],
    explicitContext: [],
    graphRevision: workspace.graphRevision,
    baseRevisionId: baseRevision.id,
  }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BlockedContextError);
    assert.deepEqual(error.missing, ["forged-payment-submit"]);
    assert.match(error.message, /cannot be proven|not present|immutable Artifact Revision/i);
    return true;
  });
  assert.deepEqual(wakes, [result.task.planId], "a forged node never reaches the durable Task queue");
});

test("production scoped Artifact Agent bounds selection indexing across the complete Component Revision assembly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-scoped-agent-selection-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Scoped Artifact selection budget", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-budget-page",
      type: "add-node",
      node: {
        id: "budget-page-node",
        kind: "page",
        name: "Budget page",
        artifactId: "budget-page",
        createIdentity: { initialTrackId: "budget-page-track" },
      },
    }, {
      id: "add-budget-component",
      type: "add-node",
      node: {
        id: "budget-component-node",
        kind: "component",
        name: "Budget component",
        artifactId: "budget-component",
        createIdentity: { initialTrackId: "budget-component-track" },
      },
    }],
  });
  const page = store.workspace.getArtifact("budget-page");
  const component = store.workspace.getArtifact("budget-component");
  assert.ok(page && component);
  const repository = join(root, "projects", project.id);
  for (const artifact of [page, component]) {
    const sourceRoot = join(repository, artifact.sourceRoot);
    mkdirSync(sourceRoot, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(sourceRoot, `large-${index}.ts`), "x".repeat(3_000_000), "utf8");
    }
  }
  writeFileSync(
    join(repository, component.sourceRoot, "index.tsx"),
    "export const Card = () => <button data-dezin-id=\"component-action\">Continue</button>;\n",
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dezin-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Dezin Test"], { cwd: repository });
  execFileSync("git", ["add", "--all"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "seed oversized immutable assembly"], {
    cwd: repository,
    stdio: "ignore",
  });
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const treeHash = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim();
  const componentRevision = store.workspace.createArtifactRevision({
    artifactId: component.id,
    trackId: "budget-component-track",
    parentRevisionId: null,
    sourceCommitHash: commitHash,
    sourceTreeHash: treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const pageRevision = store.workspace.createArtifactRevision({
    artifactId: page.id,
    trackId: "budget-page-track",
    parentRevisionId: null,
    sourceCommitHash: commitHash,
    sourceTreeHash: treeHash,
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [{
      instanceId: "budget-component-instance",
      componentArtifactId: component.id,
      componentRevisionId: componentRevision.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "budget-component-slot", sourcePath: `${page.sourceRoot}/index.tsx` },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(pageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  let queued = 0;
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    scopedTasks: {
      async enqueue() {
        queued += 1;
        throw new Error("assembly-wide selection budget must fail before queueing");
      },
    },
  });

  await assert.rejects(orchestrator.turn({
    turnId: "turn-00000000-0000-4000-8000-000000000003",
    scope: { type: "artifact", id: page.id, workspaceId: workspace.id },
    intent: "edit",
    agent: CLAUDE_AGENT,
    message: "Refine the linked Component action.",
    selection: [{ kind: "element", id: "component-action", revisionId: pageRevision.id }],
    explicitContext: [],
    graphRevision: workspace.graphRevision,
    baseRevisionId: pageRevision.id,
  }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BlockedContextError);
    assert.match(error.message, /assembly.*selection-index.*budget|selection-index.*assembly.*budget/i);
    return true;
  });
  assert.equal(queued, 0);
});

test("production Workspace Agent constrains Codex semantic identity to current graph node ids", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  store.updateSettings({
    agentCommand: "codex",
    apiKey: "selected-openai-key",
    apiBaseUrl: "https://provider.example.test",
  });
  const project = store.createProject({ name: "Workspace Agent provider boundary", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [{
      id: "add-existing-page",
      type: "add-node",
      node: {
        id: "existing-page-node",
        kind: "page",
        name: "Existing Page",
        artifactId: "existing-page-artifact",
        createIdentity: { initialTrackId: "existing-page-track" },
      },
    }],
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const semanticIntent = {
    pages: [{
      existingNodeId: null,
      operation: "generate",
      name: "Checkout",
      instructions: "Focused checkout with realistic cart, address, payment, validation, loading, failure, and success states.",
    }],
    components: [],
    resources: [],
    relations: [],
    rationale: "Create one coherent checkout Page while preserving the immutable Design Kernel.",
    assumptions: ["The current product catalog remains available."],
  };
  let scratchContainedOnlySchema = false;
  let observedPlannerSchema: Record<string, unknown> | undefined;
  const spawner = new RecordingSpawner(async (input) => {
    const schemaArgumentIndex = input.args.indexOf("--output-schema");
    assert.notEqual(schemaArgumentIndex, -1, "Codex Workspace Planner must receive a final-output schema");
    const schemaPath = input.args[schemaArgumentIndex + 1];
    assert.equal(typeof schemaPath, "string");
    scratchContainedOnlySchema = existsSync(input.cwd)
      && readdirSync(input.cwd).length === 1
      && readdirSync(input.cwd)[0] === "dezin-final-output.schema.json";
    observedPlannerSchema = JSON.parse(readFileSync(schemaPath!, "utf8")) as Record<string, unknown>;
    return {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-workspace-codex" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "message-workspace-codex",
            type: "agent_message",
            text: JSON.stringify(semanticIntent),
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable(command) {
      assert.equal(command, "codex");
      return TEST_CODEX_EXECUTABLE;
    },
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner() {
      return spawner;
    },
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.6-codex" },
    turnId: WORKSPACE_TURN_ID,
    message: "Plan a checkout flow.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(spawner.inputs.length, 1);
  const spawned = spawner.inputs[0]!;
  assert.equal(spawned.command, "/usr/bin/sandbox-exec");
  assert.match(spawned.cwd, /workspace-agent-tmp\/turn-/);
  assert.equal(scratchContainedOnlySchema, true);
  assert.ok(spawned.args.includes("--ephemeral"));
  assert.equal(spawned.args[0], "-p");
  assert.match(spawned.args[1] ?? "", /\(deny file-read-data \(subpath "\/Users"\)\)/);
  assert.equal(spawned.args[2], TEST_CODEX_EXECUTABLE);
  assert.equal(spawned.args[spawned.args.indexOf("--sandbox") + 1], "danger-full-access");
  assert.ok(spawned.args.includes("--ignore-user-config"));
  assert.ok(spawned.args.includes("--ignore-rules"));
  assert.ok(spawned.args.includes("--json"));
  assert.match(spawned.stdin, /compact semantic Workspace intent/i);
  assert.match(spawned.stdin, /Plan a checkout flow/);
  assert.match(spawned.stdin, /"currentWorkspaceNodes":\[/);
  assert.match(
    spawned.stdin,
    /"id":"existing-page-node","kind":"page","name":"Existing Page"/,
  );
  assert.equal(spawned.env?.OPENAI_API_KEY, undefined);
  assert.equal(spawned.env?.OPENAI_BASE_URL, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "OPENAI_BASE_URL"), false);
  assert.equal(spawned.env?.DEZIN_DAEMON_TOKEN, undefined);
  assert.equal(Object.hasOwn(spawned.env ?? {}, "DEZIN_DAEMON_TOKEN"), true);
  const schemaProperties = observedPlannerSchema?.properties as Record<string, unknown> | undefined;
  const pagesSchema = schemaProperties?.pages as Record<string, unknown> | undefined;
  const pageItemSchema = pagesSchema?.items as Record<string, unknown> | undefined;
  const pageItemProperties = pageItemSchema?.properties as Record<string, unknown> | undefined;
  const resourcesSchema = schemaProperties?.resources as Record<string, unknown> | undefined;
  const resourceItemSchema = resourcesSchema?.items as Record<string, unknown> | undefined;
  const resourceItemProperties = resourceItemSchema?.properties as Record<string, unknown> | undefined;
  assert.equal(Object.hasOwn(pagesSchema ?? {}, "minItems"), false);
  assert.equal(Object.hasOwn(pageItemProperties ?? {}, "requestSlotId"), false);
  assert.deepEqual(
    (pageItemProperties?.existingNodeId as Record<string, unknown> | undefined)?.enum,
    [null, "existing-page-node"],
  );
  assert.deepEqual(
    (pageItemProperties?.existingNodeId as Record<string, unknown> | undefined)?.type,
    ["string", "null"],
  );
  assert.equal(
    ((pageItemProperties?.existingNodeId as Record<string, unknown> | undefined)?.enum as unknown[])
      .includes("existing-page-artifact"),
    false,
  );
  assert.ok(
    (resourceItemSchema?.required as unknown[] | undefined)?.includes("instructions"),
    "Codex Resource intent schema requires an implementation-grade leaf brief",
  );
  assert.deepEqual(resourceItemProperties?.instructions, {
    type: "string",
    minLength: 1,
    maxLength: 2_000,
  });
  assert.equal(observedPlannerSchema?.additionalProperties, false);
  assert.equal(existsSync(spawned.cwd), false, "the per-turn planner scratch is removed after terminalization");
  assert.deepEqual(
    result.kind === "proposal"
      ? result.proposal.operations.flatMap((operation) => (
          operation.type === "add-node" ? [{ kind: operation.node.kind, name: operation.node.name }] : []
        ))
      : [],
    [{ kind: "page", name: "Checkout" }],
  );
  assert.equal(store.workspace.listProposals(project.id).length, 1);
});

test("production Workspace Agent bounds a 44-Component target while preserving every semantic node identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-large-identity-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Large component library", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const components = Array.from({ length: 44 }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(12, "0");
    return {
      nodeId: `10000000-0000-4000-8000-${suffix}`,
      artifactId: `20000000-0000-4000-8000-${suffix}`,
      trackId: `30000000-0000-4000-8000-${suffix}`,
      name: `Component ${String(index + 1).padStart(2, "0")} — shared product pattern`,
    };
  });
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: components.map((component, index) => ({
      id: `add-large-component-${index + 1}`,
      type: "add-node" as const,
      node: {
        id: component.nodeId,
        kind: "component" as const,
        name: component.name,
        artifactId: component.artifactId,
        createIdentity: { initialTrackId: component.trackId },
      },
    })),
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const selected = components.at(-1)!;
  let targetContent = "";
  let requestNodeIdentities: unknown;
  let componentIdentityEnum: unknown;
  const spawner = new RecordingSpawner(async (input) => {
    const targetMatch = /<dezin-context[^>]*class="target"[^>]*>\n([^\n]+)\n<\/dezin-context>/.exec(
      input.stdin,
    );
    assert.ok(targetMatch, "the immutable target Context must reach the Planner");
    targetContent = targetMatch[1]!;
    const requestLine = input.stdin.split("\n").find((line) => (
      line.includes('"protocol":"dezin.workspace-agent-request.v1"')
    ));
    assert.ok(requestLine, "the Planner request identity map must reach the Planner");
    requestNodeIdentities = (JSON.parse(requestLine) as {
      currentWorkspaceNodes?: unknown;
    }).currentWorkspaceNodes;
    const schemaArgumentIndex = input.args.indexOf("--output-schema");
    assert.notEqual(schemaArgumentIndex, -1);
    const schema = JSON.parse(
      readFileSync(input.args[schemaArgumentIndex + 1]!, "utf8"),
    ) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const componentItems = (properties.components as Record<string, unknown>).items as Record<string, unknown>;
    const componentProperties = componentItems.properties as Record<string, unknown>;
    componentIdentityEnum = (componentProperties.existingNodeId as Record<string, unknown>).enum;
    return {
      stdout: codexPlannerResponse({
        pages: [],
        components: [{
          existingNodeId: selected.nodeId,
          operation: "generate",
          name: selected.name,
          instructions: "Refine this exact shared Component with complete interaction, focus, loading, empty, and error states.",
          verificationStates: ["focus", "loading", "error"],
        }],
        resources: [],
        relations: [],
        rationale: "Revise the exact selected Component without creating a duplicate identity.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000051",
    message: `Refine ${selected.name} in place.`,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(spawner.inputs.length, 1, "a valid large Workspace must reach the Planner");
  assert.ok(Buffer.byteLength(targetContent, "utf8") <= 24 * 1024);
  const target = JSON.parse(targetContent) as {
    detailLevel?: string;
    currentWorkspaceNodes?: unknown;
    identityIndex?: {
      source?: string;
      nodeCount?: number;
    };
  };
  assert.equal(target.detailLevel, "semantic-index-reference");
  assert.equal(target.currentWorkspaceNodes, undefined);
  assert.deepEqual(target.identityIndex, {
    source: "dezin.workspace-agent-request.v1.currentWorkspaceNodes",
    nodeCount: components.length,
  });
  assert.deepEqual(
    requestNodeIdentities,
    components.map((component) => ({
      id: component.nodeId,
      kind: "component",
      name: component.name,
      activeRevisionId: null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.deepEqual(componentIdentityEnum, [
    null,
    ...components.map((component) => component.nodeId).sort(),
  ]);
  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  assert.equal(result.proposal.generation.artifactPlans[0]?.artifactId, selected.artifactId);
});

test("production Workspace Agent indexes all 150 Component identities without blocking exact in-place revision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-large-node-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Large exact Component index", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const components = Array.from({ length: 150 }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(12, "0");
    return {
      nodeId: `10000000-0000-4000-8000-${suffix}`,
      artifactId: `20000000-0000-4000-8000-${suffix}`,
      trackId: `30000000-0000-4000-8000-${suffix}`,
      name: `Component ${String(index + 1).padStart(3, "0")} — shared responsive product pattern with exact identity`,
    };
  });
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: components.map((component, index) => ({
      id: `add-indexed-component-${index + 1}`,
      type: "add-node" as const,
      node: {
        id: component.nodeId,
        kind: "component" as const,
        name: component.name,
        artifactId: component.artifactId,
        createIdentity: { initialTrackId: component.trackId },
      },
    })),
  });
  const selected = components.at(-1)!;
  const selectedBaseRevision = store.workspace.createArtifactRevision({
    artifactId: selected.artifactId,
    trackId: selected.trackId,
    parentRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    kernelRevisionId: initial.activeKernelRevisionId,
    renderSpec: {},
    quality: {},
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(selectedBaseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  let targetContent = "";
  let requestNodeIdentities: unknown;
  let componentIdentityEnum: unknown;
  const spawner = new RecordingSpawner(async (input) => {
    const targetMatch = /<dezin-context[^>]*class="target"[^>]*>\n([^\n]+)\n<\/dezin-context>/.exec(
      input.stdin,
    );
    assert.ok(targetMatch, "the bounded target anchor must reach the Planner");
    targetContent = targetMatch[1]!;
    const requestLine = input.stdin.split("\n").find((line) => (
      line.includes('"protocol":"dezin.workspace-agent-request.v1"')
    ));
    assert.ok(requestLine, "the Planner request identity map must reach the Planner");
    const requestPayload = JSON.parse(requestLine) as {
      currentWorkspaceNodes?: unknown;
    };
    requestNodeIdentities = requestPayload.currentWorkspaceNodes;
    const schemaArgumentIndex = input.args.indexOf("--output-schema");
    assert.notEqual(schemaArgumentIndex, -1);
    const schema = JSON.parse(
      readFileSync(input.args[schemaArgumentIndex + 1]!, "utf8"),
    ) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const componentItems = (properties.components as Record<string, unknown>).items as Record<string, unknown>;
    const componentProperties = componentItems.properties as Record<string, unknown>;
    componentIdentityEnum = (componentProperties.existingNodeId as Record<string, unknown>).enum;
    return {
      stdout: codexPlannerResponse({
        pages: [],
        components: [{
          existingNodeId: selected.nodeId,
          operation: "generate",
          name: selected.name,
          instructions: "Revise this exact shared Component in place with responsive, focus, loading, empty, and error states.",
          verificationStates: ["focus", "loading", "error"],
        }],
        resources: [],
        relations: [],
        rationale: "Revise only the exact selected Component without duplicating its identity.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000053",
    message: `Revise ${selected.name} in place.`,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(spawner.inputs.length, 1, "a valid 150-node Workspace must reach the Planner");
  assert.ok(Buffer.byteLength(targetContent, "utf8") <= 24 * 1024);
  const target = JSON.parse(targetContent) as {
    detailLevel?: string;
    currentWorkspaceNodes?: unknown;
    identityIndex?: {
      source?: string;
      nodeCount?: number;
    };
  };
  assert.equal(target.detailLevel, "semantic-index-reference");
  assert.equal(target.currentWorkspaceNodes, undefined);
  assert.deepEqual(target.identityIndex, {
    source: "dezin.workspace-agent-request.v1.currentWorkspaceNodes",
    nodeCount: components.length,
  });
  assert.deepEqual(
    requestNodeIdentities,
    components.map((component) => ({
      id: component.nodeId,
      kind: "component",
      name: component.name,
      activeRevisionId: component.nodeId === selected.nodeId ? selectedBaseRevision.id : null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.deepEqual(componentIdentityEnum, [
    null,
    ...components.map((component) => component.nodeId).sort(),
  ]);
  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  assert.deepEqual(
    result.proposal.generation.artifactPlans.map((plan) => ({
      artifactId: plan.artifactId,
      operation: plan.operation,
      baseRevisionId: plan.baseRevisionId,
    })),
    [{
      artifactId: selected.artifactId,
      operation: "revise",
      baseRevisionId: selectedBaseRevision.id,
    }],
  );
});

test("production Workspace Agent rejects a compressed Codex response for an explicit Page matrix", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-matrix-underfill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE explicit matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const original = "3 directions: cinematic black/red, warm paper/ink, electric cobalt grid. Each has Home, Film, Schedule, Checkout.";
  const message = composeWorkspaceAgentConversation(
    "Retry all requested Pages as new items and preserve every direction.",
    original,
  );
  const compressedIntent = {
    pages: [
      {
        existingNodeId: null,
        operation: "generate",
        requestSlotId: "direction-1-page-1",
        name: "KITE Overview",
        instructions: "One overview that summarizes all requested routes.",
      },
      {
        existingNodeId: null,
        operation: "generate",
        requestSlotId: "direction-1-page-2",
        name: "KITE Direction A",
        instructions: "One page that compresses the complete cinematic direction.",
      },
      {
        existingNodeId: null,
        operation: "generate",
        requestSlotId: "direction-1-page-3",
        name: "KITE Direction B",
        instructions: "One page that compresses the complete paper direction.",
      },
      {
        existingNodeId: null,
        operation: "generate",
        requestSlotId: "direction-1-page-4",
        name: "KITE Direction C",
        instructions: "One page that compresses the complete cobalt direction.",
      },
    ],
    components: [],
    resources: [],
    relations: [],
    rationale: "Compress the request into four Pages.",
    assumptions: [],
  };
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse(compressedIntent),
      stderr: "",
      exitCode: 0,
    }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000044",
    message,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /explicit Page matrix requires exactly 12 Page intents/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent freezes a numbered direction matrix used by acceptance briefs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-numbered-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE numbered matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const cells = [
    ["direction-1-page-1", "Cinematic Black/Red", "Home"],
    ["direction-1-page-2", "Cinematic Black/Red", "Film"],
    ["direction-1-page-3", "Cinematic Black/Red", "Schedule"],
    ["direction-1-page-4", "Cinematic Black/Red", "Checkout"],
    ["direction-2-page-1", "Warm Paper/Ink", "Home"],
    ["direction-2-page-2", "Warm Paper/Ink", "Film"],
    ["direction-2-page-3", "Warm Paper/Ink", "Schedule"],
    ["direction-2-page-4", "Warm Paper/Ink", "Checkout"],
    ["direction-3-page-1", "Electric Cobalt Grid", "Home"],
    ["direction-3-page-2", "Electric Cobalt Grid", "Film"],
    ["direction-3-page-3", "Electric Cobalt Grid", "Schedule"],
    ["direction-3-page-4", "Electric Cobalt Grid", "Checkout"],
  ] as const;
  const observedTimeouts: number[] = [];
  const observedSchemas: Record<string, unknown>[] = [];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      observedTimeouts.push(input.timeoutMs ?? 0);
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchemas.push(
        JSON.parse(readFileSync(input.args[schemaIndex + 1]!, "utf8")) as Record<string, unknown>,
      );
      return {
        stdout: codexPlannerResponse({
          pages: cells.map(([requestSlotId, direction, page]) => ({
            existingNodeId: null,
            operation: "generate",
            requestSlotId,
            name: `${direction} — ${page}`,
            instructions: `Design the complete ${direction} ${page} festival experience.`,
            verificationStates: [],
          })),
          components: [],
          resources: [],
          relations: [],
          rationale: "Preserve the exact numbered acceptance matrix.",
          assumptions: [],
        }),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000050",
    message: [
      "Keep exactly 12 Pages and revise every current Page in place.",
      "",
      "EXACT DIRECTIONS AND PAGE MATRIX",
      "1. Cinematic Black/Red — id cinematic-black-red — Pages Home, Film, Schedule, Checkout.",
      "2. Warm Paper/Ink — id warm-paper-ink — Pages Home, Film, Schedule, Checkout.",
      "3. Electric Cobalt Grid — id electric-cobalt-grid — Pages Home, Film, Schedule, Checkout.",
      "The three directions must be unmistakably different while sharing the same information architecture.",
    ].join("\n"),
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  assert.equal(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.artifactPlans.length
      : 0,
    12,
  );
  assert.deepEqual(observedTimeouts, [12 * 60 * 1_000]);
  const schemaProperties = observedSchemas[0]!.properties as Record<string, unknown>;
  const pagesSchema = schemaProperties.pages as Record<string, unknown>;
  assert.equal(pagesSchema.minItems, 12);
  assert.equal(pagesSchema.maxItems, 12);
});

test("production Workspace Agent freezes a total-plus-per-direction matrix used by in-place acceptance briefs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-inline-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE inline matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const cells = [
    ["direction-1-page-1", "Cinematic Black/Red", "Home"],
    ["direction-1-page-2", "Cinematic Black/Red", "Film"],
    ["direction-1-page-3", "Cinematic Black/Red", "Schedule"],
    ["direction-1-page-4", "Cinematic Black/Red", "Checkout"],
    ["direction-2-page-1", "Warm Paper/Ink", "Home"],
    ["direction-2-page-2", "Warm Paper/Ink", "Film"],
    ["direction-2-page-3", "Warm Paper/Ink", "Schedule"],
    ["direction-2-page-4", "Warm Paper/Ink", "Checkout"],
    ["direction-3-page-1", "Electric Cobalt Grid", "Home"],
    ["direction-3-page-2", "Electric Cobalt Grid", "Film"],
    ["direction-3-page-3", "Electric Cobalt Grid", "Schedule"],
    ["direction-3-page-4", "Electric Cobalt Grid", "Checkout"],
  ] as const;
  const observedTimeouts: number[] = [];
  const observedSchemas: Record<string, unknown>[] = [];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      observedTimeouts.push(input.timeoutMs ?? 0);
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchemas.push(
        JSON.parse(readFileSync(input.args[schemaIndex + 1]!, "utf8")) as Record<string, unknown>,
      );
      return {
        stdout: codexPlannerResponse({
          pages: cells.map(([requestSlotId, direction, page]) => ({
            existingNodeId: null,
            operation: "generate",
            requestSlotId,
            name: `${direction} — ${page}`,
            instructions: `Design the complete ${direction} ${page} festival experience.`,
            verificationStates: [],
          })),
          components: [],
          resources: [],
          relations: [],
          rationale: "Preserve the exact inline acceptance matrix.",
          assumptions: [],
        }),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000063",
    message: [
      "Revise only the current 19 active Artifact nodes in place.",
      "EXACT MATRIX: exactly 12 current Pages, four per direction: Cinematic Black/Red (cinematic-black-red), Warm Paper/Ink (warm-paper-ink), Electric Cobalt Grid (electric-cobalt-grid); each direction has Home, Film, Schedule, Checkout.",
    ].join("\n"),
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  assert.equal(
    result.proposal.generation.kind === "workspace-generation"
      ? result.proposal.generation.artifactPlans.length
      : 0,
    12,
  );
  assert.deepEqual(observedTimeouts, [12 * 60 * 1_000]);
  const schemaProperties = observedSchemas[0]!.properties as Record<string, unknown>;
  const pagesSchema = schemaProperties.pages as Record<string, unknown>;
  assert.equal(pagesSchema.minItems, 12);
  assert.equal(pagesSchema.maxItems, 12);
});

test("production Workspace Agent freezes exact uses relations instead of keeping stale base extras", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-exact-uses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE exact uses", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const mutation = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [{
      id: "add-warm-home",
      type: "add-node",
      node: {
        id: "warm-home-node",
        kind: "page",
        name: "Warm Paper/Ink Home",
        artifactId: "warm-home-artifact",
        createIdentity: { initialTrackId: "warm-home-track" },
      },
    }, {
      id: "add-ticket-selector",
      type: "add-node",
      node: {
        id: "ticket-selector-node",
        kind: "component",
        name: "KITE Ticket Selector",
        artifactId: "ticket-selector-artifact",
        createIdentity: { initialTrackId: "ticket-selector-track" },
      },
    }],
  });
  const home = store.workspace.getArtifact("warm-home-artifact");
  const ticket = store.workspace.getArtifact("ticket-selector-artifact");
  assert.ok(home && ticket);
  const ticketRevision = store.workspace.createArtifactRevision({
    artifactId: ticket.id,
    trackId: "ticket-selector-track",
    parentRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    kernelRevisionId: foundation.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const componentSnapshot = store.workspace.publishArtifactRevision(ticketRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: mutation.snapshot.id,
  });
  const homeRevision = store.workspace.createArtifactRevision({
    artifactId: home.id,
    trackId: "warm-home-track",
    parentRevisionId: null,
    sourceCommitHash: "c".repeat(40),
    sourceTreeHash: "d".repeat(40),
    kernelRevisionId: foundation.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [{
      instanceId: "stale-home-ticket-instance",
      componentArtifactId: ticket.id,
      componentRevisionId: ticketRevision.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "stale-home-ticket-slot" },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [],
  });
  store.workspace.publishArtifactRevision(homeRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const pageNames = ["Home", "Film", "Schedule", "Checkout"] as const;
  const componentNames = [
    "KITE Shared Shell",
    "KITE Hero Banner",
    "KITE Program Card",
    "KITE Ticket Selector",
  ] as const;
  const relations = [
    ...pageNames.map((page) => ({
      source: `Warm Paper/Ink ${page}`,
      target: "KITE Shared Shell",
      kind: "uses" as const,
    })),
    {
      source: "Warm Paper/Ink Home",
      target: "KITE Hero Banner",
      kind: "uses" as const,
    },
    ...pageNames.map((page) => ({
      source: `Warm Paper/Ink ${page}`,
      target: "KITE Program Card",
      kind: "uses" as const,
    })),
  ];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse({
        pages: pageNames.map((page, index) => ({
          existingNodeId: page === "Home" ? "warm-home-node" : null,
          operation: "generate",
          requestSlotId: `direction-1-page-${index + 1}`,
          name: `Warm Paper/Ink ${page}`,
          instructions: `Design the complete Warm Paper/Ink ${page} festival experience.`,
          verificationStates: [],
        })),
        components: componentNames.map((name) => ({
          existingNodeId: name === "KITE Ticket Selector" ? "ticket-selector-node" : null,
          operation: "generate",
          name,
          instructions: `Design the complete reusable ${name} product UI.`,
          verificationStates: [],
        })),
        resources: [],
        relations,
        rationale: "Preserve the exact requested uses contract.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000051",
    message: [
      "EXACT DIRECTIONS AND PAGE MATRIX",
      "1. Warm Paper/Ink — id warm-paper-ink — Pages Home, Film, Schedule, Checkout.",
      "Create exact uses relations: every Page uses Shared Shell; each Home uses Hero Banner and Program Card; each Film uses Program Card; each Schedule uses Program Card; each Checkout uses Program Card. Do not invent component substitutes.",
    ].join("\n"),
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  const names = new Map(result.proposal.generation.artifactPlans.map((plan) => [plan.artifactId, plan.name]));
  const dependencies = result.proposal.generation.dependencyPlans
    .filter((dependency) => dependency.kind === "component-instance")
    .map((dependency) => ({
      owner: names.get(dependency.ownerArtifactId),
      component: names.get(dependency.componentArtifactId),
    }));
  assert.equal(dependencies.length, 9);
  assert.equal(
    dependencies.some((dependency) => (
      dependency.owner === "Warm Paper/Ink Home"
      && dependency.component === "KITE Ticket Selector"
    )),
    false,
  );
});

test("production Workspace Agent does not inherit a prior Page matrix for an independent current request", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-independent-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Independent settings request", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const message = composeWorkspaceAgentConversation(
    "Create a settings page.",
    "3 directions: cinematic, paper, cobalt. Each has Home, Film, Schedule, Checkout.",
  );
  const observedSchemas: Record<string, unknown>[] = [];
  let observedPlannerInput = "";
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      observedPlannerInput = input.stdin;
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchemas.push(
        JSON.parse(readFileSync(input.args[schemaIndex + 1]!, "utf8")) as Record<string, unknown>,
      );
      return {
        stdout: codexPlannerResponse({
          pages: [{
            existingNodeId: null,
            operation: "generate",
            name: "Settings",
            instructions: "A complete settings Page with profile, notification, privacy, billing, and account states.",
          }],
          components: [],
          resources: [],
          relations: [],
          rationale: "Create only the newly requested Settings Page.",
          assumptions: [],
        }),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000048",
    message,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  const plans = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.artifactPlans
    : [];
  assert.deepEqual(plans.map((plan) => plan.name), ["Settings"]);
  assert.doesNotMatch(observedPlannerInput, /3 directions: cinematic/);
  assert.match(observedPlannerInput, /"priorUncommittedRequests":\[\]/);
  assert.match(observedPlannerInput, /"request":"Create a settings page\."/);
  const schemaProperties = observedSchemas[0]!.properties as Record<string, unknown>;
  const pagesSchema = schemaProperties.pages as Record<string, unknown>;
  const pageItem = pagesSchema.items as Record<string, unknown>;
  const pageProperties = pageItem.properties as Record<string, unknown>;
  assert.equal(Object.hasOwn(pagesSchema, "minItems"), false);
  assert.equal(Object.hasOwn(pageProperties, "requestSlotId"), false);
});

test("production Workspace Agent rejects duplicate coverage inside a full-size explicit Page matrix", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-matrix-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE duplicate matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const message = composeWorkspaceAgentConversation(
    "Retry all requested Pages as new items.",
    "3 directions: cinematic black/red, warm paper/ink, electric cobalt grid. Each has Home, Film, Schedule, Checkout.",
  );
  const slotIds = [
    "direction-1-page-1",
    "direction-1-page-2",
    "direction-1-page-3",
    "direction-1-page-4",
    "direction-2-page-1",
    "direction-2-page-2",
    "direction-2-page-3",
    "direction-2-page-4",
    "direction-3-page-1",
    "direction-3-page-2",
    "direction-3-page-3",
    "direction-1-page-1",
  ];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse({
        pages: slotIds.map((requestSlotId, index) => ({
          existingNodeId: null,
          operation: "generate",
          requestSlotId,
          name: `KITE Page ${index + 1}`,
          instructions: `Independent festival Page ${index + 1} with realistic content and complete states.`,
        })),
        components: [],
        resources: [],
        relations: [],
        rationale: "Incorrectly repeat one matrix slot.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000046",
    message,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /explicit Page matrix requestSlotId direction-1-page-1 is duplicated/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent deterministically binds explicit matrix cells to exact current Pages", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-matrix-existing-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE existing matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const cells = [
    ["direction-1-page-1", "Cinematic Black/Red", "Home"],
    ["direction-1-page-2", "Cinematic Black/Red", "Film"],
    ["direction-1-page-3", "Cinematic Black/Red", "Schedule"],
    ["direction-1-page-4", "Cinematic Black/Red", "Checkout"],
    ["direction-2-page-1", "Warm Paper/Ink", "Home"],
    ["direction-2-page-2", "Warm Paper/Ink", "Film"],
    ["direction-2-page-3", "Warm Paper/Ink", "Schedule"],
    ["direction-2-page-4", "Warm Paper/Ink", "Checkout"],
    ["direction-3-page-1", "Electric Cobalt Grid", "Home"],
    ["direction-3-page-2", "Electric Cobalt Grid", "Film"],
    ["direction-3-page-3", "Electric Cobalt Grid", "Schedule"],
    ["direction-3-page-4", "Electric Cobalt Grid", "Checkout"],
  ] as const;
  const nodeIdByName = new Map<string, string>();
  const current = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: cells.map(([, direction, page], index) => {
      const name = `${direction} ${page}`;
      const nodeId = `existing-kite-matrix-page-node-${index + 1}`;
      nodeIdByName.set(name, nodeId);
      return {
        id: `add-existing-kite-matrix-page-${index + 1}`,
        type: "add-node" as const,
        node: {
          id: nodeId,
          kind: "page" as const,
          name,
          artifactId: `existing-kite-matrix-page-artifact-${index + 1}`,
          createIdentity: { initialTrackId: `existing-kite-matrix-page-track-${index + 1}` },
        },
      };
    }),
  });
  const duplicatedModelNodeId = nodeIdByName.get("Warm Paper/Ink Schedule")!;
  const response = {
    pages: cells.map(([requestSlotId, direction, page]) => ({
      existingNodeId: duplicatedModelNodeId,
      operation: "generate",
      requestSlotId,
      name: `${direction} ${page}`,
      instructions: `Design the complete ${direction} ${page} festival experience.`,
      verificationStates: [],
    })),
    components: [],
    resources: [],
    relations: [],
    rationale: "Revise the exact current KITE Page matrix in place.",
    assumptions: [],
  };
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse(response),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000049",
    message: [
      "Revise the current KITE workspace in place.",
      "Keep exactly 3 distinct visual directions: Cinematic Black/Red, Warm Paper/Ink, and Electric Cobalt Grid.",
      "Each direction must contain exactly 4 independent Pages named Home, Film, Schedule, and Checkout, for exactly 12 Pages total.",
    ].join(" "),
    explicitContext: [],
    graphRevision: current.graph.revision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  if (result.proposal.generation.kind !== "workspace-generation") return;
  assert.equal(
    result.proposal.operations.some((operation) => operation.type === "add-node"),
    false,
  );
  assert.deepEqual(
    new Map(result.proposal.generation.artifactPlans.map((plan) => [plan.name, plan.nodeId])),
    nodeIdByName,
  );
});

test("production Workspace Agent preserves every explicit Page matrix cell as an independent Codex plan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-matrix-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "KITE complete matrix", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const stalePageNodeIds = [
    "stale-kite-overview-hub-node",
    "stale-kite-direction-a-node",
    "stale-kite-direction-b-node",
    "stale-kite-direction-c-node",
  ];
  const stalePages = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: stalePageNodeIds.map((nodeId, index) => ({
      id: `add-${nodeId}`,
      type: "add-node" as const,
      node: {
        id: nodeId,
        kind: "page" as const,
        name: ["KITE Overview Hub", "KITE Direction A", "KITE Direction B", "KITE Direction C"][index]!,
        artifactId: `stale-kite-page-artifact-${index}`,
        createIdentity: { initialTrackId: `stale-kite-page-track-${index}` },
      },
    })),
  });
  const original = [
    "Rebuild the KITE film festival design workspace as exactly three distinct visual directions: Cinematic Black/Red, Warm Paper/Ink, and Electric Cobalt Grid.",
    "Each direction must contain exactly four independent Page artifacts named Home, Film, Schedule, and Checkout, for exactly 12 Pages total.",
    "Archive KITE Overview Hub and KITE Direction A/B/C; do not create or retain any Overview or Hub Page.",
    "Regenerate every unpublished shared Component for navigation/direction switching, hero, film cards, schedule rows, checkout controls, revision navigation, and the shared shell.",
    "Revise the existing Research into decision-grade evidence tied to these three directions.",
    "Revise the existing Moodboard with exactly three high-quality generated image assets, one actionable visual reference per direction.",
    "Keep the shared Component group, explicit Home → Film → Schedule → Checkout prototype links within each direction, high-fidelity desktop and mobile previews, immutable revisions, Versions, Viewer, and Present readiness.",
  ].join(" ");
  const message = composeWorkspaceAgentConversation(
    "Retry all requested Pages as new items and preserve every direction.",
    original,
  );
  const cells = [
    ["direction-1-page-1", "Cinematic Black/Red", "Home"],
    ["direction-1-page-2", "Cinematic Black/Red", "Film"],
    ["direction-1-page-3", "Cinematic Black/Red", "Schedule"],
    ["direction-1-page-4", "Cinematic Black/Red", "Checkout"],
    ["direction-2-page-1", "Warm Paper/Ink", "Home"],
    ["direction-2-page-2", "Warm Paper/Ink", "Film"],
    ["direction-2-page-3", "Warm Paper/Ink", "Schedule"],
    ["direction-2-page-4", "Warm Paper/Ink", "Checkout"],
    ["direction-3-page-1", "Electric Cobalt Grid", "Home"],
    ["direction-3-page-2", "Electric Cobalt Grid", "Film"],
    ["direction-3-page-3", "Electric Cobalt Grid", "Schedule"],
    ["direction-3-page-4", "Electric Cobalt Grid", "Checkout"],
  ] as const;
  const completeIntent = {
    pages: cells.map(([requestSlotId, direction, page]) => ({
      existingNodeId: null,
      operation: "generate",
      requestSlotId,
      name: `${direction} — ${page}`,
      instructions: `Design the ${page} experience with realistic content and complete states.`,
    })),
    components: [],
    resources: [],
    relations: [],
    rationale: "Preserve all twelve explicitly requested Page cells.",
    assumptions: [],
  };
  const observedSchemas: Record<string, unknown>[] = [];
  const observedTimeouts: number[] = [];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      observedTimeouts.push(input.timeoutMs ?? 0);
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchemas.push(
        JSON.parse(readFileSync(input.args[schemaIndex + 1]!, "utf8")) as Record<string, unknown>,
      );
      return {
        stdout: codexPlannerResponse(completeIntent),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000045",
    message,
    explicitContext: [],
    graphRevision: stalePages.graph.revision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  const plans = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.artifactPlans
    : [];
  assert.equal(plans.length, 12);
  for (const [, direction, page] of cells) {
    const plan = plans.find((candidate) => candidate.name === `${direction} — ${page}`);
    assert.ok(plan, `missing independent Page plan for ${direction} / ${page}`);
    assert.match(plan.instructions ?? "", new RegExp(`Direction: ${direction.replace("/", "\\/")}`));
    assert.match(plan.instructions ?? "", new RegExp(`Page: ${page}`));
  }
  assert.equal(observedSchemas.length, 1);
  assert.deepEqual(observedTimeouts, [12 * 60 * 1_000]);
  assert.deepEqual(
    result.proposal.operations
      .filter((operation) => operation.type === "archive-node")
      .map((operation) => operation.nodeId)
      .sort(),
    [...stalePageNodeIds].sort(),
    "an exact replacement matrix removes unrelated unpublished Page shells",
  );
  const schemaProperties = observedSchemas[0]!.properties as Record<string, unknown>;
  const pagesSchema = schemaProperties.pages as Record<string, unknown>;
  assert.equal(pagesSchema.minItems, 12);
  assert.equal(pagesSchema.maxItems, 12);
  const pageItem = pagesSchema.items as Record<string, unknown>;
  const pageProperties = pageItem.properties as Record<string, Record<string, unknown>>;
  assert.ok(
    (pageItem.required as unknown[] | undefined)?.includes("requestSlotId"),
    "the exact matrix schema requires every Page to claim one requestSlotId",
  );
  assert.deepEqual(pageProperties.requestSlotId!.enum, cells.map(([slotId]) => slotId));
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.equal(
    approved.graph.nodes.some((node) => stalePageNodeIds.includes(node.id)),
    false,
  );
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.tasks.filter((task) => task.kind === "page").length, 12);
});

test("production Workspace Agent freezes a Chinese direction-by-Page request as an exact matrix", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-chinese-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "中文页面矩阵", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const message = [
    "请生成三个方向，分别为：柔和极简、暖纸墨色、电光钴蓝网格。",
    "每个方向包含4个独立页面，分别是：首页、影片、日程、结账页，共12个页面。",
  ].join("\n");
  const cells = [
    ["direction-1-page-1", "柔和极简", "首页"],
    ["direction-1-page-2", "柔和极简", "影片"],
    ["direction-1-page-3", "柔和极简", "日程"],
    ["direction-1-page-4", "柔和极简", "结账页"],
    ["direction-2-page-1", "暖纸墨色", "首页"],
    ["direction-2-page-2", "暖纸墨色", "影片"],
    ["direction-2-page-3", "暖纸墨色", "日程"],
    ["direction-2-page-4", "暖纸墨色", "结账页"],
    ["direction-3-page-1", "电光钴蓝网格", "首页"],
    ["direction-3-page-2", "电光钴蓝网格", "影片"],
    ["direction-3-page-3", "电光钴蓝网格", "日程"],
    ["direction-3-page-4", "电光钴蓝网格", "结账页"],
  ] as const;
  const observedSchemas: Record<string, unknown>[] = [];
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner(async (input) => {
      const schemaIndex = input.args.indexOf("--output-schema");
      observedSchemas.push(
        JSON.parse(readFileSync(input.args[schemaIndex + 1]!, "utf8")) as Record<string, unknown>,
      );
      return {
        stdout: codexPlannerResponse({
          pages: cells.map(([requestSlotId, direction, page]) => ({
            existingNodeId: null,
            operation: "generate",
            requestSlotId,
            name: `${direction} — ${page}`,
            instructions: `为${page}设计完整内容、状态与响应式层级。`,
          })),
          components: [],
          resources: [],
          relations: [],
          rationale: "完整保留三个方向各四个页面。",
          assumptions: [],
        }),
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000047",
    message,
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  assert.equal(result.proposal.generation.kind, "workspace-generation");
  const plans = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation.artifactPlans
    : [];
  assert.equal(plans.length, 12);
  for (const [, direction, page] of cells) {
    const plan = plans.find((candidate) => candidate.name === `${direction} — ${page}`);
    assert.ok(plan, `缺少独立页面计划 ${direction} / ${page}`);
    assert.match(plan.instructions ?? "", new RegExp(`Direction: ${direction}`));
    assert.match(plan.instructions ?? "", new RegExp(`Page: ${page}`));
  }
  const schemaProperties = observedSchemas[0]!.properties as Record<string, unknown>;
  const pagesSchema = schemaProperties.pages as Record<string, unknown>;
  assert.equal(pagesSchema.minItems, 12);
  assert.equal(pagesSchema.maxItems, 12);
});

test("production Workspace Agent compiles a Cursor component-only intent into a legal Component shelf plan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-cursor-component-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Cursor component-only planner", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const semanticIntent = {
    pages: [],
    components: [{
      existingNodeId: null,
      name: "Filter Chip",
      instructions: "Reusable filter chip with selected, unselected, hover, focus, disabled, and compact responsive states.",
    }],
    resources: [],
    relations: [],
    rationale: "Add the requested reusable primitive without manufacturing an unrelated Page.",
    assumptions: [],
  };
  const spawner = new RecordingSpawner({
    stdout: JSON.stringify(semanticIntent),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable(command) {
      assert.equal(command, "cursor-agent");
      return TEST_CURSOR_EXECUTABLE;
    },
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "cursor-agent", command: "cursor-agent", model: "gpt-5" },
    turnId: "turn-00000000-0000-4000-8000-000000000041",
    message: "Create only a reusable Filter Chip component.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  const spawned = spawner.inputs[0]!;
  assert.deepEqual(spawned.args.slice(3, 8), [
    "--output-format",
    "text",
    "--model",
    "gpt-5",
    "-p",
  ]);
  assert.equal(spawned.stdin, "");
  const componentNode = result.proposal.operations.flatMap((operation) => (
    operation.type === "add-node" && operation.node.kind === "component" ? [operation.node] : []
  ))[0]!;
  assert.equal(componentNode.name, "Filter Chip");
  assert.deepEqual(
    result.proposal.operations.flatMap((operation) => (
      operation.type === "add-node" ? [operation.node.kind] : []
    )),
    ["component"],
  );
  assert.ok(result.proposal.layoutOperations.some((operation) => (
    operation.type === "add-group"
    && operation.groupId === "dezin-component-library"
    && operation.label === "Components"
  )));
  assert.ok(result.proposal.layoutOperations.some((operation) => (
    operation.type === "set-parent"
    && operation.objectId === componentNode.id
    && operation.parentGroupId === "dezin-component-library"
  )));
  assert.ok(result.proposal.layoutOperations.some((operation) => (
    operation.type === "move" && operation.objectId === componentNode.id
  )));
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? {
          artifactPlans: result.proposal.generation.artifactPlans.map((plan) => ({
            kind: plan.kind,
            name: plan.name,
            instructions: plan.instructions,
          })),
          resourceOperations: result.proposal.generation.resourceOperations,
        }
      : null,
    {
      artifactPlans: [{
        kind: "component",
        name: "Filter Chip",
        instructions: semanticIntent.components[0]!.instructions,
      }],
      resourceOperations: [],
    },
  );
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.plan.status, "queued");
  assert.equal(compiled.tasks.filter((task) => task.kind === "component").length, 1);
  assert.equal(compiled.tasks.filter((task) => task.kind === "page").length, 0);
});

test("production Workspace Agent compiles a generic resource-only intent into a legal root Resource plan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-gemini-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Gemini resource-only planner", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const semanticIntent = {
    pages: [],
    components: [],
    resources: [{
      existingNodeId: null,
      operation: "generate",
      kind: "research",
      title: "Mobile commerce checkout research",
      instructions: [
        "Compare three checkout directions: guided single-page, progressive steps, and express wallet.",
        "Return evidence-backed tradeoffs, mobile failure/recovery patterns, and one explicit recommendation.",
      ].join(" "),
    }],
    relations: [],
    rationale: "Research the requested problem before introducing any Page or Component.",
    assumptions: [],
  };
  const spawner = new RecordingSpawner({
    stdout: JSON.stringify(semanticIntent),
    stderr: "",
    exitCode: 0,
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable(command) {
      assert.equal(command, "gemini");
      return TEST_GEMINI_EXECUTABLE;
    },
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "gemini", command: "gemini", model: "gemini-2.5-pro" },
    turnId: "turn-00000000-0000-4000-8000-000000000042",
    message: "Create only Research for the mobile checkout problem.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  const missingInstructions = {
    ...semanticIntent,
    resources: semanticIntent.resources.map(({ instructions: _instructions, ...resource }) => resource),
  };
  const invalidOrchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_GEMINI_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: JSON.stringify(missingInstructions),
      stderr: "",
      exitCode: 0,
    }),
  });
  await assert.rejects(
    invalidOrchestrator.turn({
      scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
      intent: "plan",
      agent: { providerId: "gemini", command: "gemini", model: "gemini-2.5-pro" },
      turnId: "turn-00000000-0000-4000-8000-000000000048",
      message: "Retry Research without dropping its concrete evidence brief.",
      explicitContext: [],
      graphRevision: workspace.graphRevision,
    }, new AbortController().signal),
    /Resource.*missing required field instructions/i,
  );
  const resourceNode = result.proposal.operations.flatMap((operation) => (
    operation.type === "add-node" && operation.node.kind === "resource" ? [operation.node] : []
  ))[0]!;
  assert.equal(resourceNode.name, semanticIntent.resources[0]!.title);
  assert.deepEqual(
    result.proposal.operations.flatMap((operation) => (
      operation.type === "add-node" ? [operation.node.kind] : []
    )),
    ["resource"],
  );
  assert.ok(!result.proposal.layoutOperations.some((operation) => operation.type === "add-group"));
  assert.ok(result.proposal.layoutOperations.some((operation) => (
    operation.type === "move"
    && operation.objectId === resourceNode.id
    && Number.isFinite(operation.x)
    && Number.isFinite(operation.y)
  )));
  assert.deepEqual(
    result.proposal.generation.kind === "workspace-generation"
      ? {
          artifactPlans: result.proposal.generation.artifactPlans,
          resourceOperations: result.proposal.generation.resourceOperations.map((operation) => ({
            operation: operation.operation,
            kind: operation.kind,
            title: operation.title,
            instructions: operation.instructions,
            revisionPolicy: operation.revisionPolicy,
          })),
        }
      : null,
    {
      artifactPlans: [],
      resourceOperations: [{
        operation: "create",
        kind: "research",
        title: semanticIntent.resources[0]!.title,
        instructions: semanticIntent.resources[0]!.instructions,
        revisionPolicy: { kind: "generate" },
      }],
    },
  );
  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  assert.equal(compiled.plan.status, "queued");
  assert.equal(compiled.tasks.filter((task) => task.kind === "resource").length, 1);
  const resourceTask = compiled.tasks.find((task) => task.kind === "resource");
  assert.ok(resourceTask);
  assert.equal(
    ((resourceTask.payload.brief as Record<string, unknown>).targetInstructions as Record<string, unknown>)
      .instructions,
    semanticIntent.resources[0]!.instructions,
  );
  assert.deepEqual(
    compiled.tasks.map((task) => task.kind),
    ["resource", "prototype-validation", "checkpoint"],
  );
});

test("production Workspace Agent rejects a completely empty semantic intent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-empty-semantic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Empty semantic planner", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_GEMINI_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: JSON.stringify({
        pages: [],
        components: [],
        resources: [],
        relations: [],
        rationale: "No requested work.",
        assumptions: [],
      }),
      stderr: "",
      exitCode: 0,
    }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "gemini", command: "gemini", model: null },
    turnId: "turn-00000000-0000-4000-8000-000000000043",
    message: "Return no changes.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /at least one Page, Component, or Resource/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("production Workspace Agent cancellation leaves no Proposal or planner scratch directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent cancellation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const controller = new AbortController();
  const reason = new Error("cancel immutable workspace planning");
  const spawner = new RecordingSpawner(async () => {
    controller.abort(reason);
    return { stdout: plannerResponse(), stderr: "", exitCode: 0 };
  });
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: WORKSPACE_TURN_ID,
    message: "Plan against this exact canvas.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, controller.signal), (error: unknown) => error === reason);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
  const scratch = spawner.inputs[0]?.cwd;
  assert.ok(scratch);
  for (let attempt = 0; attempt < 50 && existsSync(scratch); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(existsSync(scratch), false);
});

test("semantic prototype relations retain planned edge ids and compile server-owned v2 marker requirements", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-prototype-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent prototype v2", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const existing = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      {
        id: "add-home-node",
        type: "add-node",
        node: {
          id: "home-node",
          kind: "page",
          name: "Home",
          artifactId: "home-artifact",
          createIdentity: { initialTrackId: "home-track" },
        },
      },
      {
        id: "add-checkout-node",
        type: "add-node",
        node: {
          id: "checkout-node",
          kind: "page",
          name: "Checkout",
          artifactId: "checkout-artifact",
          createIdentity: { initialTrackId: "checkout-track" },
        },
      },
      {
        id: "add-receipt-node",
        type: "add-node",
        node: {
          id: "receipt-node",
          kind: "page",
          name: "Receipt",
          artifactId: "receipt-artifact",
          createIdentity: { initialTrackId: "receipt-track" },
        },
      },
      {
        id: "add-gallery-node",
        type: "add-node",
        node: {
          id: "gallery-node",
          kind: "page",
          name: "Gallery",
          artifactId: "gallery-artifact",
          createIdentity: { initialTrackId: "gallery-track" },
        },
      },
      {
        id: "add-home-checkout-edge",
        type: "add-edge",
        edge: {
          id: "home-checkout-edge",
          workspaceId: foundation.id,
          kind: "prototype",
          sourceNodeId: "home-node",
          targetNodeId: "checkout-node",
        },
      },
      {
        id: "add-checkout-receipt-edge",
        type: "add-edge",
        edge: {
          id: "checkout-receipt-edge",
          workspaceId: foundation.id,
          kind: "prototype",
          sourceNodeId: "checkout-node",
          targetNodeId: "receipt-node",
        },
      },
    ],
  });
  const semanticIntent = {
    pages: [
      {
        existingNodeId: "home-node",
        operation: "generate",
        name: "Home",
        instructions: "A complete festival Home page with a real primary ticket action and responsive hierarchy.",
        verificationStates: [],
      },
      {
        existingNodeId: "checkout-node",
        operation: "generate",
        name: "Checkout",
        instructions: "A complete Checkout page with order review, a real form, validation, and payment states.",
        verificationStates: ["review"],
      },
      {
        existingNodeId: "receipt-node",
        operation: "generate",
        name: "Receipt",
        instructions: "A complete Receipt page with confirmed order details, next steps, and a success state.",
        verificationStates: ["success"],
      },
      {
        existingNodeId: "gallery-node",
        operation: "generate",
        name: "Gallery",
        instructions: "A standalone festival Gallery page with editorial media and no prototype relationship.",
        verificationStates: [],
      },
    ],
    components: [],
    resources: [],
    relations: [
      {
        source: "Checkout",
        target: "Receipt",
        kind: "prototype",
        trigger: "submit",
        targetState: "success",
        transition: { type: "fade", durationMs: 180 },
      },
      {
        source: "Home",
        target: "Checkout",
        kind: "prototype",
        trigger: "click",
        targetState: "review",
      },
    ],
    rationale: "Retain the reviewed page flow while regenerating every page with provable interaction anchors.",
    assumptions: [],
  };
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse(semanticIntent),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: foundation.id, workspaceId: foundation.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000091",
    message: "Regenerate the four Pages and preserve the exact Home to Checkout to Receipt prototype flow.",
    explicitContext: [],
    graphRevision: existing.graph.revision,
  }, new AbortController().signal);

  assert.equal(result.kind, "proposal");
  if (result.kind !== "proposal" || result.proposal.generation.kind !== "workspace-generation") return;
  const generation = result.proposal.generation as typeof result.proposal.generation & {
    version?: number;
    prototypeIntents: Array<Record<string, unknown>>;
    artifactPlans: Array<typeof result.proposal.generation.artifactPlans[number] & {
      prototypeRequirements?: {
        outgoing: Array<Record<string, unknown>>;
        incoming: Array<Record<string, unknown>>;
      };
    }>;
  };
  assert.equal(generation.version, 2);
  assert.equal(
    result.proposal.operations.filter((operation) => operation.type === "add-edge").length,
    0,
    "retained planned edges must keep their exact durable identities",
  );
  assert.deepEqual(
    generation.prototypeIntents.map((intent) => intent.edgeId),
    ["checkout-receipt-edge", "home-checkout-edge"],
    "v2 intents are canonicalized by retained edge id instead of Agent response order",
  );
  assert.ok(generation.prototypeIntents.every((intent) => (
    Object.keys(intent).every((key) => [
      "edgeId",
      "sourceArtifactId",
      "targetArtifactId",
      "trigger",
      "sourceMarkerId",
      "targetState",
      "transition",
    ].includes(key))
    && UUID_PATTERN.test(String(intent.sourceMarkerId))
  )));
  assert.equal(
    new Set(generation.prototypeIntents.map((intent) => intent.sourceMarkerId)).size,
    generation.prototypeIntents.length,
  );
  assert.doesNotMatch(
    JSON.stringify(generation.prototypeIntents),
    /sourceLocator|sourceRevisionId|revisionId|commit|treeHash|selector|xpath/i,
  );
  const requirementsByArtifact = new Map(generation.artifactPlans.map((plan) => [
    plan.artifactId,
    plan.prototypeRequirements,
  ]));
  assert.deepEqual(
    requirementsByArtifact.get("home-artifact")?.outgoing.map((entry) => entry.edgeId),
    ["home-checkout-edge"],
  );
  assert.deepEqual(
    requirementsByArtifact.get("checkout-artifact"),
    {
      outgoing: [{
        edgeId: "checkout-receipt-edge",
        sourceMarkerId: generation.prototypeIntents[0]!.sourceMarkerId,
        trigger: "submit",
      }],
      incoming: [{
        edgeId: "home-checkout-edge",
        sourceArtifactId: "home-artifact",
        sourceMarkerId: generation.prototypeIntents[1]!.sourceMarkerId,
        targetState: "review",
      }],
    },
  );
  assert.deepEqual(
    requirementsByArtifact.get("receipt-artifact")?.incoming.map((entry) => ({
      edgeId: entry.edgeId,
      targetState: entry.targetState,
    })),
    [{ edgeId: "checkout-receipt-edge", targetState: "success" }],
  );
  assert.equal(requirementsByArtifact.get("gallery-artifact"), undefined);

  const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const validation = compiled.tasks.find((task) => task.kind === "prototype-validation");
  assert.ok(validation);
  assert.equal(validation.payload.version, 2);
  assert.deepEqual(validation.payload.prototypeIntents, generation.prototypeIntents);
  const artifactTaskIds = new Set(
    compiled.tasks
      .filter((task) => task.kind === "page")
      .map((task) => task.id),
  );
  assert.equal(
    validation.dependencyIds.filter((taskId) => artifactTaskIds.has(taskId)).length,
    generation.artifactPlans.length,
    "v2 finalization receives the exact generated Revision output for every source and target Page",
  );
});

type PrototypeStatusFixture =
  | { status: "planned" }
  | {
      status: "interactive";
      binding: {
        sourceArtifactId: string;
        sourceRevisionId: string;
        sourceLocator: { designNodeId: string };
        trigger: "click";
        targetArtifactId: string;
      };
    }
  | {
      status: "broken";
      brokenReason: string;
      binding?: {
        sourceArtifactId: string;
        sourceRevisionId: string;
        sourceLocator: { designNodeId: string };
        trigger: "click";
        targetArtifactId: string;
      };
    };

function seedRetainedPrototypePair(
  store: Store,
  projectId: string,
  workspace: ReturnType<Store["workspace"]["ensureWorkspaceRecord"]>,
) {
  return store.workspace.applyGraphCommands(projectId, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "add-source-node",
        type: "add-node",
        node: {
          id: "source-node",
          kind: "page",
          name: "Source",
          artifactId: "source-artifact",
          createIdentity: { initialTrackId: "source-track" },
        },
      },
      {
        id: "add-target-node",
        type: "add-node",
        node: {
          id: "target-node",
          kind: "page",
          name: "Target",
          artifactId: "target-artifact",
          createIdentity: { initialTrackId: "target-track" },
        },
      },
      {
        id: "add-retained-edge",
        type: "add-edge",
        edge: {
          id: "retained-prototype-edge",
          workspaceId: workspace.id,
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          kind: "prototype",
        },
      },
    ],
  });
}

function retainedPrototypeSemanticIntent(includeRelation = true) {
  return {
    pages: [
      {
        existingNodeId: "source-node",
        operation: "generate",
        name: "Source",
        instructions: "A complete source Page with a real primary action, responsive hierarchy, and all interaction states.",
      },
      {
        existingNodeId: "target-node",
        operation: "generate",
        name: "Target",
        instructions: "A complete target Page with realistic content, responsive hierarchy, and destination states.",
      },
    ],
    components: [],
    resources: [],
    relations: includeRelation
      ? [{ source: "Source", target: "Target", kind: "prototype", trigger: "click" }]
      : [],
    rationale: "Regenerate the retained two-page flow without losing its reviewed graph identity.",
    assumptions: [],
  };
}

function overrideRetainedPrototypeStatus(store: Store, prototype: PrototypeStatusFixture): void {
  const original = store.workspace.getCompactBundleByProjectId.bind(store.workspace);
  Object.defineProperty(store.workspace, "getCompactBundleByProjectId", {
    configurable: true,
    value(projectId: string) {
      const bundle = original(projectId);
      if (bundle === null) return null;
      const cloned = structuredClone(bundle);
      for (const graph of [cloned.graph, cloned.activeSnapshot.graph]) {
        const edge = graph.edges.find((candidate) => candidate.id === "retained-prototype-edge");
        assert.ok(edge && edge.kind === "prototype");
        edge.prototype = structuredClone(prototype);
      }
      return cloned;
    },
  });
}

test("semantic prototype compilation resets retained interactive and broken edges to planned with the same id", async (t) => {
  const statuses: PrototypeStatusFixture[] = [
    {
      status: "interactive",
      binding: {
        sourceArtifactId: "source-artifact",
        sourceRevisionId: "source-revision",
        sourceLocator: { designNodeId: "source.action" },
        trigger: "click",
        targetArtifactId: "target-artifact",
      },
    },
    {
      status: "broken",
      brokenReason: "The source locator no longer resolves.",
    },
  ];
  for (const prototype of statuses) {
    await t.test(prototype.status, async (subtest) => {
      const root = mkdtempSync(join(tmpdir(), `dezin-production-workspace-agent-reset-${prototype.status}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const store = new Store(join(root, "store.db"));
      subtest.after(() => store.close());
      const project = store.createProject({ name: `Reset ${prototype.status} prototype`, mode: "standard" });
      const workspace = store.workspace.ensureWorkspaceRecord(project.id);
      const existing = seedRetainedPrototypePair(store, project.id, workspace);
      overrideRetainedPrototypeStatus(store, prototype);
      const orchestrator = createProductionWorkspaceAgentOrchestrator({
        store,
        dataDir: root,
        resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
        structuredAgentPlatform: "darwin",
        resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
        createSpawner: () => new RecordingSpawner({
          stdout: codexPlannerResponse(retainedPrototypeSemanticIntent()),
          stderr: "",
          exitCode: 0,
        }),
      });

      const result = await orchestrator.turn({
        scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
        intent: "plan",
        agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
        turnId: prototype.status === "interactive"
          ? "turn-00000000-0000-4000-8000-000000000092"
          : "turn-00000000-0000-4000-8000-000000000093",
        message: "Regenerate both Pages while preserving the reviewed prototype relation.",
        explicitContext: [],
        graphRevision: existing.graph.revision,
      }, new AbortController().signal);

      assert.equal(result.kind, "proposal");
      if (result.kind !== "proposal") return;
      assert.deepEqual(
        result.proposal.operations.flatMap((operation): Array<
          | { type: "remove-edge"; edgeId: string }
          | {
              type: "add-edge";
              edgeId: string;
              sourceNodeId: string;
              targetNodeId: string;
            }
        > => {
          if (operation.type === "remove-edge" && operation.edgeId === "retained-prototype-edge") {
            return [{ type: operation.type, edgeId: operation.edgeId }];
          }
          if (operation.type === "add-edge" && operation.edge.id === "retained-prototype-edge") {
            return [{
              type: operation.type,
              edgeId: operation.edge.id,
              sourceNodeId: operation.edge.sourceNodeId,
              targetNodeId: operation.edge.targetNodeId,
            }];
          }
          return [];
        }),
        [
          { type: "remove-edge", edgeId: "retained-prototype-edge" },
          {
            type: "add-edge",
            edgeId: "retained-prototype-edge",
            sourceNodeId: "source-node",
            targetNodeId: "target-node",
          },
        ],
      );
      const approved = store.workspace.approveProposalForProject(project.id, result.proposal.id, "generate");
      assert.ok(approved.plan);
      assert.equal(
        store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id).plan.status,
        "queued",
      );
    });
  }
});

test("semantic prototype compilation fails closed when a retained generated Page relation is omitted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-missing-retained-prototype-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Missing retained prototype relation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const existing = seedRetainedPrototypePair(store, project.id, workspace);
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => new RecordingSpawner({
      stdout: codexPlannerResponse(retainedPrototypeSemanticIntent(false)),
      stderr: "",
      exitCode: 0,
    }),
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000094",
    message: "Regenerate both Pages and retain the reviewed prototype flow.",
    explicitContext: [],
    graphRevision: existing.graph.revision,
  }, new AbortController().signal), /retained prototype relation.*missing|missing semantic prototype relation/i);
  assert.deepEqual(store.workspace.listProposals(project.id), []);
});

test("Claude and Codex compile the same semantic prototype contract through the server compiler", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-provider-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const semanticIntent = {
    pages: [
      {
        existingNodeId: null,
        name: "Home",
        instructions: "A complete Home Page with a real primary action, responsive hierarchy, and production states.",
      },
      {
        existingNodeId: null,
        name: "Checkout",
        instructions: "A complete Checkout Page with order review, a real form, validation, and success states.",
      },
    ],
    components: [],
    resources: [],
    relations: [{
      source: "Home",
      target: "Checkout",
      kind: "prototype",
      trigger: "submit",
      targetState: "review",
    }],
    rationale: "Create one coherent two-page checkout flow.",
    assumptions: [],
  };
  const spawner = new RecordingSpawner(async (input) => ({
    stdout: input.command === TEST_CLAUDE_EXECUTABLE
      ? JSON.stringify(semanticIntent)
      : codexPlannerResponse(semanticIntent),
    stderr: "",
    exitCode: 0,
  }));
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    resolveClaudeExecutable: () => TEST_CLAUDE_EXECUTABLE,
    resolveRegisteredExecutable: () => TEST_CODEX_EXECUTABLE,
    structuredAgentPlatform: "darwin",
    resolveStructuredAgentSandboxExecutable: () => "/usr/bin/sandbox-exec",
    createSpawner: () => spawner,
  });
  const claudeProject = store.createProject({ name: "Claude semantic compiler", mode: "standard" });
  const claudeWorkspace = store.workspace.ensureWorkspaceRecord(claudeProject.id);
  const codexProject = store.createProject({ name: "Codex semantic compiler", mode: "standard" });
  const codexWorkspace = store.workspace.ensureWorkspaceRecord(codexProject.id);
  const claudeResult = await orchestrator.turn({
    scope: { type: "workspace", id: claudeWorkspace.id, workspaceId: claudeWorkspace.id },
    intent: "plan",
    agent: CLAUDE_AGENT,
    turnId: "turn-00000000-0000-4000-8000-000000000095",
    message: "Create a complete Home to Checkout flow.",
    explicitContext: [],
    graphRevision: claudeWorkspace.graphRevision,
  }, new AbortController().signal);
  const codexResult = await orchestrator.turn({
    scope: { type: "workspace", id: codexWorkspace.id, workspaceId: codexWorkspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: "gpt-5.4-mini" },
    turnId: "turn-00000000-0000-4000-8000-000000000096",
    message: "Create a complete Home to Checkout flow.",
    explicitContext: [],
    graphRevision: codexWorkspace.graphRevision,
  }, new AbortController().signal);

  const summarize = (result: typeof claudeResult) => {
    assert.equal(result.kind, "proposal");
    if (result.kind !== "proposal" || result.proposal.generation.kind !== "workspace-generation") {
      throw new Error("Expected a Workspace generation Proposal");
    }
    const generation = result.proposal.generation;
    const plans = new Map(generation.artifactPlans.map((plan) => [plan.artifactId, plan] as const));
    return {
      version: generation.version,
      nodes: result.proposal.operations.flatMap((operation) => (
        operation.type === "add-node" && operation.node.kind === "page"
          ? [{ kind: operation.node.kind, name: operation.node.name }]
          : []
      )),
      plans: generation.artifactPlans.map((plan) => ({
        kind: plan.kind,
        name: plan.name,
        instructions: plan.instructions,
        outgoing: plan.prototypeRequirements?.outgoing.map((requirement) => requirement.trigger) ?? [],
        incoming: plan.prototypeRequirements?.incoming.map((requirement) => requirement.targetState) ?? [],
      })),
      intents: generation.prototypeIntents.map((intent) => ({
        sourceName: plans.get(intent.sourceArtifactId)?.name,
        targetName: plans.get(intent.targetArtifactId)?.name,
        trigger: intent.trigger,
        targetState: intent.targetState,
        hasServerMarker: typeof intent.sourceMarkerId === "string" && UUID_PATTERN.test(intent.sourceMarkerId),
        hasLegacyLocator: intent.sourceLocator !== undefined,
      })),
    };
  };
  assert.deepEqual(summarize(claudeResult), summarize(codexResult));
  assert.equal(spawner.inputs.length, 2);
  for (const input of spawner.inputs) {
    const systemPromptIndex = input.args.indexOf("--system-prompt");
    const prompt = systemPromptIndex === -1 ? input.stdin : input.args[systemPromptIndex + 1] ?? "";
    assert.match(prompt, /compact semantic workspace intent/i);
  }
});
