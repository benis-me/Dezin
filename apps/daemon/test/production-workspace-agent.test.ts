import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { BlockedContextError } from "../src/context/context-types.ts";
import { createWorkspaceContextPackRepository } from "../src/context/context-pack-store.ts";
import { createProductionScopedAgentTaskQueue } from "../src/orchestration/production-scoped-agent-task-queue.ts";
import { createProductionWorkspaceAgentOrchestrator } from "../src/orchestration/production-workspace-agent.ts";

const WORKSPACE_TURN_ID = "turn-00000000-0000-4000-8000-000000000010";
const TEST_CLAUDE_EXECUTABLE = "/trusted/claude/install/bin/claude";
const TEST_CODEBUDDY_EXECUTABLE = "/trusted/codebuddy/install/bin/codebuddy";
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

test("production Workspace Agent resolves immutable context in a scratch directory and persists only a draft Proposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Workspace Agent production", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const response = plannerResponse({ rationale: `Detailed proposal ${"x".repeat(3_000)}` });
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
  assert.match(spawned.args[spawned.args.indexOf("--system-prompt") + 1] ?? "", /proposal-only/i);
  assert.match(
    spawned.args[spawned.args.indexOf("--system-prompt") + 1] ?? "",
    /researchDirectionSelection.*explicitly selected.*existing immutable Research Revision/i,
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
          revisionPolicy: operation.revisionPolicy,
        }))
      : [],
    [{
      operation: "create",
      kind: "research",
      title: semanticIntent.resources[0]!.title,
      revisionPolicy: { kind: "generate" },
    }],
  );
  const codeBuddyGeneration = result.proposal.generation.kind === "workspace-generation"
    ? result.proposal.generation
    : null;
  assert.deepEqual(
    codeBuddyGeneration?.dependencyPlans.filter((dependency) => dependency.kind === "resource"),
    [],
    "Research generated in this Plan is not consumed by Artifact Tasks",
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
    stdout: plannerResponse({
      operations: [{
        id: "add-checkout-page",
        type: "add-node",
        node: {
          id: "checkout-page-node",
          kind: "page",
          name: "Checkout",
          artifactId: "checkout-page",
          createIdentity: { initialTrackId: "checkout-track" },
        },
      }],
      generation: {
        kind: "workspace-generation",
        resourceOperations: [],
        artifactPlans: [{
          operation: "create",
          nodeId: "checkout-page-node",
          artifactId: "checkout-page",
          kind: "page",
          name: "Checkout",
          instructions: "Design the complete checkout journey with order review, payment, validation, and success states.",
          trackId: "checkout-track",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["thumbnail"],
        }],
        dependencyPlans: [],
        prototypeIntents: [],
        capabilities: [],
        responsiveFrames: [{ id: "thumbnail", name: "Thumbnail", width: 100, height: 100 }],
        qualityProfile: {
          requiredFrameIds: [],
          blockingSeverities: [],
          requireRuntimeChecks: false,
          requireVisualReview: false,
        },
      },
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
    requiredFrameIds: ["wide", "thumbnail", "desktop", "mobile"],
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
    /production desktop\/mobile QA floor.*Design Kernel/i,
  );
  assert.match(
    spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--system-prompt") + 1] ?? "",
    /every Artifact plan.*instructions.*purpose.*content.*states.*composition/i,
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
    stdout: plannerResponse({
      operations: [{
        id: "add-home-page",
        type: "add-node",
        node: {
          id: "home-page-node",
          kind: "page",
          name: "Home",
          artifactId: "home-page",
          createIdentity: { initialTrackId: "home-track" },
        },
      }],
      generation: {
        kind: "workspace-generation",
        resourceOperations: [],
        artifactPlans: [{
          operation: "create",
          nodeId: "home-page-node",
          artifactId: "home-page",
          kind: "page",
          name: "Home",
          trackId: "home-track",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        }],
        dependencyPlans: [],
        prototypeIntents: [],
        capabilities: [],
        responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
        qualityProfile: {
          requiredFrameIds: ["desktop"],
          blockingSeverities: ["P0", "P1"],
          requireRuntimeChecks: true,
          requireVisualReview: true,
        },
      },
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
  }, new AbortController().signal), /Artifact .*instructions.*purpose.*content.*states.*composition/i);
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
  }, new AbortController().signal), /archive|forbidden|proposal-only/i);
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

test("production Workspace Agent rejects a noncanonical selected provider before spawn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-production-workspace-agent-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  store.updateSettings({ agentCommand: "codex" });
  const project = store.createProject({ name: "Workspace Agent provider boundary", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  let spawnCount = 0;
  const orchestrator = createProductionWorkspaceAgentOrchestrator({
    store,
    dataDir: root,
    createSpawner() {
      spawnCount += 1;
      return new RecordingSpawner({ stdout: plannerResponse(), stderr: "", exitCode: 0 });
    },
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
    agent: { providerId: "codex", command: "codex", model: null },
    turnId: WORKSPACE_TURN_ID,
    message: "Plan a checkout flow.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /canonical supported structured provider command/i);
  assert.equal(spawnCount, 0);
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
