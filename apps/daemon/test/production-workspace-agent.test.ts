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
    createSpawner(options) {
      spawnerOptions.push(options);
      return spawner;
    },
  });

  const turn = {
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
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
  assert.deepEqual(store.workspace.listProposals(project.id), [result.proposal]);
  assert.equal(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM context_packs WHERE workspace_id = ?",
  ).get(workspace.id) as { count: number }).count), 1);
  const spawned = spawner.inputs[0];
  assert.ok(spawned);
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
    createSpawner: () => spawner,
  });

  const result = await orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
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
  assert.match(
    spawner.inputs[0]?.args[spawner.inputs[0]!.args.indexOf("--system-prompt") + 1] ?? "",
    /production desktop\/mobile QA floor.*Design Kernel/i,
  );
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
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
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
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
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

test("production Workspace Agent fails closed before spawn when the selected provider has no hard no-tools transport", async (t) => {
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
    turnId: WORKSPACE_TURN_ID,
    message: "Plan a checkout flow.",
    explicitContext: [],
    graphRevision: workspace.graphRevision,
  }, new AbortController().signal), /hard no-tools structured-output transport/i);
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
    createSpawner: () => spawner,
  });

  await assert.rejects(orchestrator.turn({
    scope: { type: "workspace", id: workspace.id, workspaceId: workspace.id },
    intent: "plan",
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
