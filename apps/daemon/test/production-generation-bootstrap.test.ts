import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentSpawnEnv, type AgentRunner } from "../../../packages/agent/src/index.ts";
import { Store } from "../../../packages/core/src/index.ts";
import { BUNDLED_DESIGN_SYSTEMS, DesignRegistry } from "../../../packages/design/src/index.ts";
import { resourceAdapters } from "../src/context/adapters/index.ts";
import { stableStringify } from "../src/context/context-types.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { createProductionGenerationBootstrap } from "../src/orchestration/production-generation-bootstrap.ts";
import { persistGenerationTaskVisualEvidence } from "../src/orchestration/generation-task-visual-evidence.ts";
import type {
  ProductionResearchGroundednessRequest,
  ProductionResearchWebEvidenceRequest,
  ProductionResourceAgentRequest,
} from "../src/orchestration/production-resource-generators.ts";
import {
  inspectStandardArtifactCandidate,
  type ProductionStandardArtifactQualityEvaluatorDependencies,
} from "../src/orchestration/standard-artifact-quality-evaluator.ts";
import { visualQaFrameAttemptId } from "../src/visual-qa.ts";
import { resolveResourceRevisionPayloadDescriptor } from "../src/resource-revision-payload.ts";
import type { SafeBoundedExternalFetcher } from "../src/resource-revision-source.ts";
import {
  createResearchRevisionFixture,
  persistResearchRevisionFixtureContextPack,
} from "./support/research-resource-fixture.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";
import { waitForDurableProgress } from "./support/wait-for-durable-progress.ts";

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

const DESKTOP_FRAME = { id: "desktop", name: "Desktop", width: 1_440, height: 900 } as const;
const PRODUCTION_GENERATION_IDLE_TIMEOUT_MS = 30_000;
const PRODUCTION_GENERATION_HARD_TIMEOUT_MS = 60_000;

function researchBackedPageGeneration() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [{
      operation: "create" as const,
      nodeId: "research-node",
      resourceId: "checkout-research",
      kind: "research" as const,
      title: "Checkout evidence",
      revisionPolicy: { kind: "generate" as const },
    }],
    artifactPlans: [{
      operation: "create" as const,
      nodeId: "checkout-node",
      artifactId: "checkout-page",
      kind: "page" as const,
      name: "Checkout",
      trackId: "checkout-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: [DESKTOP_FRAME.id],
    }],
    dependencyPlans: [{
      kind: "resource" as const,
      ownerArtifactId: "checkout-page",
      resourceId: "checkout-research",
    }],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [DESKTOP_FRAME],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function exactResearchBackedPageGeneration(input: {
  resourceNodeId: string;
  resourceId: string;
  resourceTitle: string;
  resourceRevisionId: string;
  directionId: string;
}) {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [{
      operation: "reuse" as const,
      nodeId: input.resourceNodeId,
      resourceId: input.resourceId,
      kind: "research" as const,
      title: input.resourceTitle,
      revisionPolicy: {
        kind: "exact" as const,
        resourceRevisionId: input.resourceRevisionId,
      },
    }],
    artifactPlans: [{
      operation: "create" as const,
      nodeId: "checkout-node",
      artifactId: "checkout-page",
      kind: "page" as const,
      name: "Checkout",
      trackId: "checkout-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: [DESKTOP_FRAME.id],
      researchDirectionSelection: {
        protocol: "dezin.research-direction-selection.v1" as const,
        version: 1 as const,
        resourceId: input.resourceId,
        revisionId: input.resourceRevisionId,
        directionId: input.directionId,
      },
    }],
    dependencyPlans: [{
      kind: "resource" as const,
      ownerArtifactId: "checkout-page",
      resourceId: input.resourceId,
    }],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [DESKTOP_FRAME],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializeRepository(repositoryDir: string): Promise<void> {
  await mkdir(repositoryDir, { recursive: true });
  git(repositoryDir, "init", "-q");
  git(repositoryDir, "config", "user.name", "Dezin acceptance");
  git(repositoryDir, "config", "user.email", "acceptance@dezin.local");
  await writeFile(join(repositoryDir, "README.md"), "# Production bootstrap Artifact leaf\n", "utf8");
  git(repositoryDir, "add", "README.md");
  git(repositoryDir, "commit", "-q", "-m", "base");
}

function researchDraft() {
  return {
    protocol: "dezin.research-generation.v3",
    executiveSummary: "Verified checkout evidence favors a quiet, confidence-led purchase flow.",
    sources: [
      {
        id: "source-checkout-evidence",
        kind: "web",
        title: "Checkout evidence",
        locator: "https://evidence.dezin-design.dev/checkout",
        excerpt: "Expose delivery cost and timing before commitment.",
        binding: null,
        notes: "Decision transparency reduces uncertainty.",
      },
      {
        id: "source-accessibility-evidence",
        kind: "web",
        title: "Accessible forms evidence",
        locator: "https://evidence.dezin-design.dev/forms",
        excerpt: "Labels, errors, and progress must remain explicit.",
        binding: null,
        notes: "Form state needs redundant, local feedback.",
      },
    ],
    findings: [
      {
        id: "finding-cost",
        statement: "Late delivery-cost disclosure creates avoidable uncertainty.",
        implication: "Keep price, delivery, and totals adjacent throughout checkout.",
        confidence: "high",
        supports: [{
          sourceId: "source-checkout-evidence",
          quote: "Expose delivery cost and timing before commitment.",
        }],
      },
      {
        id: "finding-state",
        statement: "Every field state needs a persistent textual explanation.",
        implication: "Pair visual state with labels and local recovery guidance.",
        confidence: "high",
        supports: [{
          sourceId: "source-accessibility-evidence",
          quote: "Labels, errors, and progress must remain explicit.",
        }],
      },
      {
        id: "finding-sequence",
        statement: "A stable reading sequence helps customers verify commitment details.",
        implication: "Use one dominant action and a persistent order summary.",
        confidence: "medium",
        supports: [{
          sourceId: "source-checkout-evidence",
          quote: "Expose delivery cost and timing before commitment.",
        }, {
          sourceId: "source-accessibility-evidence",
          quote: "Labels, errors, and progress must remain explicit.",
        }],
      },
    ],
    designPrinciples: [
      {
        id: "principle-visible-cost",
        title: "Visible commitment",
        rationale: "Cost and delivery remain inspectable before the final action.",
        findingIds: ["finding-cost"],
      },
      {
        id: "principle-local-state",
        title: "Local recovery",
        rationale: "Every invalid state explains the correction beside its control.",
        findingIds: ["finding-state"],
      },
      {
        id: "principle-stable-sequence",
        title: "Stable sequence",
        rationale: "Hierarchy does not jump while the customer verifies details.",
        findingIds: ["finding-sequence"],
      },
    ],
    directions: [
      {
        id: "direction-primary",
        title: "Quiet confidence",
        thesis: "A calm editorial checkout with an always-visible commitment rail.",
        visualLanguage: ["warm neutral canvas", "precise rule-led hierarchy"],
        interactionPrinciples: ["progressive disclosure with stable totals"],
        risks: ["Restraint can obscure urgency without clear state contrast."],
        findingIds: ["finding-cost", "finding-state", "finding-sequence"],
      },
      {
        id: "direction-secondary",
        title: "Guided ledger",
        thesis: "A compact transaction ledger that foregrounds validation and progress.",
        visualLanguage: ["cool paper surface", "tabular numeric rhythm"],
        interactionPrinciples: ["stepwise verification with explicit recovery"],
        risks: ["Dense ledger treatment can feel operational rather than reassuring."],
        findingIds: ["finding-cost", "finding-state"],
      },
    ],
    openQuestions: ["Which delivery promises vary by region?"],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("production Generation bootstrap did not settle");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("production Generation bootstrap shares the complete real leaf graph with recovery and scheduling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Production bootstrap", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const repositoryDir = join(root, "projects", project.id);
  await mkdir(repositoryDir, { recursive: true });
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
    rationale: "Prove production startup has no placeholder leaves",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);

  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  let researchEvidenceReads = 0;
  let observedExternalFetch: SafeBoundedExternalFetcher | undefined;
  const resourceExternalFetch: SafeBoundedExternalFetcher = async () => ({
    finalUrl: "https://evidence.dezin-design.dev/canonical",
    status: 200,
    mimeType: "text/plain",
    bytes: Buffer.from("verified evidence", "utf8"),
  });
  const resourceRuntime = {
    agent: { async generateStructured() { throw new Error("Resource Agent is not used by this empty Plan"); } },
    researchGroundedness: { async verifyClaims() { throw new Error("Research review is not used by this empty Plan"); } },
    moodboardImages: { async generateImage() { throw new Error("Moodboard images are not used by this empty Plan"); } },
    moodboardQuality: { async reviewImage() { throw new Error("Moodboard review is not used by this empty Plan"); } },
    sharinganCaptures: { async exportExactCapture() { throw new Error("Sharingan export is not used by this empty Plan"); } },
  } as Record<string, unknown>;
  Object.defineProperty(resourceRuntime, "researchEvidence", {
    enumerable: true,
    get() {
      researchEvidenceReads += 1;
      return {
        async retrieveWebEvidence() {
          throw new Error("Research evidence is not used by this empty Plan");
        },
      };
    },
  });
  const system = createProductionGenerationBootstrap({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-production-bootstrap-test",
    repositoryDirForWorkspace: () => repositoryDir,
    resourceExternalFetch,
    createResourceRuntimePorts: (options) => {
      observedExternalFetch = options.researchExternalFetch;
      return resourceRuntime as any;
    },
    leaseMs: 2_000,
    heartbeatMs: 500,
    pollMs: 10,
  });
  t.after(async () => {
    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
  });

  await system.runtime.start();
  await waitFor(() => (
    store.workspace.getGenerationPlanForProject(project.id, approved.plan!.id).status === "succeeded"
  ));

  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
  assert.equal(detail.plan.status, "succeeded");
  assert.deepEqual(detail.tasks.map((task) => task.kind), ["prototype-validation", "checkpoint"]);
  assert.ok(detail.tasks.every((task) => task.status === "succeeded"));
  assert.equal(typeof system.control.requestTick, "function");
  assert.equal(typeof system.control.requestCancellation, "function");
  assert.equal(typeof system.events.notify, "function");
  assert.ok(researchEvidenceReads >= 1, "bootstrap forwards the production Research evidence port into Resource generation");
  assert.equal(observedExternalFetch, resourceExternalFetch,
    "bootstrap forwards the daemon's shared safe external fetch boundary to Research");
});

test("same-Plan generated Research cannot become an Artifact input before human direction selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-research-selection-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Research selection gate", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [{
      id: "add-checkout-research",
      type: "add-node",
      node: {
        id: "research-node",
        kind: "resource",
        name: "Checkout evidence",
        resourceId: "checkout-research",
        createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
      },
    }, {
      id: "add-checkout-page",
      type: "add-node",
      node: {
        id: "checkout-node",
        kind: "page",
        name: "Checkout",
        artifactId: "checkout-page",
        createIdentity: { initialTrackId: "checkout-main" },
      },
    }],
    layoutOperations: [],
    generation: researchBackedPageGeneration(),
    rationale: "Attempt to consume generated Research before a human selects one immutable direction",
    assumptions: [],
  });
  const before = {
    workspace: store.workspace.getWorkspace(project.id),
    graph: store.workspace.getGraph(project.id),
    snapshots: store.workspace.listSnapshots(project.id),
    artifacts: store.workspace.listArtifacts(project.id),
    resources: store.workspace.listResources(project.id),
  };

  assert.throws(
    () => store.workspace.approveProposalForProject(project.id, proposal.id, "generate"),
    /cannot consume Research generated in the same Plan; publish the Research Revision, choose one exact direction, then approve a successor Artifact Plan/,
  );

  assert.equal(store.workspace.getProposalForProject(project.id, proposal.id).status, "draft");
  assert.deepEqual(store.workspace.getWorkspace(project.id), before.workspace);
  assert.deepEqual(store.workspace.getGraph(project.id), before.graph);
  assert.deepEqual(store.workspace.listSnapshots(project.id), before.snapshots);
  assert.deepEqual(store.workspace.listArtifacts(project.id), before.artifacts);
  assert.deepEqual(store.workspace.listResources(project.id), before.resources);
  assert.deepEqual(store.workspace.listGenerationPlans(project.id), []);
  assert.equal(Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks")
    .get() as { count: number }).count), 0);
});

test("production bootstrap lets a new selected Plan claim an empty Page shell from one exact existing Research Revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-selected-research-bootstrap-"));
  const store = new Store(join(root, "store.db"));
  let teardownRuntime: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await teardownRuntime?.();
    } finally {
      try {
        store.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const project = store.createProject({ name: "Selected Research Artifact", mode: "standard" });
  const initialWorkspace = store.workspace.ensureWorkspaceRecord(project.id);
  const repositoryDir = join(root, "projects", project.id);
  await initializeRepository(repositoryDir);
  store.updateSettings({
    agentCommand: "codex",
    model: "gpt-5.4",
    apiKey: "artifact-provider-key",
    visualQaEnabled: false,
    autoImproveEnabled: false,
  });

  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Checkout evidence",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: initialWorkspace.graphRevision,
    expectedSnapshotId: initialWorkspace.activeSnapshotId,
  });
  const researchContextPack = persistResearchRevisionFixtureContextPack({
    store,
    manifestRoot: root,
    workspaceId: initialWorkspace.id,
    resourceId: created.resource.id,
    graphRevision: store.workspace.getWorkspace(project.id)!.graphRevision,
  });
  const researchFixture = createResearchRevisionFixture({
    workspaceId: initialWorkspace.id,
    resourceId: created.resource.id,
    contextPack: researchContextPack,
  });
  const selectedDirection = {
    ...researchFixture.bundle.directions[0]!,
    id: "direction-primary",
    title: "Quiet confidence",
    thesis: "A calm editorial checkout with an always-visible commitment rail.",
    visualLanguage: ["warm neutral canvas", "precise rule-led hierarchy"],
    interactionPrinciples: ["progressive disclosure with stable totals"],
    risks: ["Restraint can obscure urgency without clear state contrast."],
  };
  researchFixture.bundle.directions[0] = selectedDirection;
  const sourcePath = "selected-research.json";
  await writeFile(
    join(repositoryDir, sourcePath),
    `${stableStringify(researchFixture.bundle)}\n`,
    "utf8",
  );
  const payload = await resourceAdapters.require("research").snapshot({
    workspaceId: initialWorkspace.id,
    resourceId: created.resource.id,
    revisionId: "research-revision-selected",
    kind: "research",
    workspaceRoot: repositoryDir,
    snapshotRoot: root,
    source: { type: "owned-file", path: sourcePath, mimeType: "application/json" },
    provenance: researchFixture.provenance,
    createdAt: 1,
  });
  const researchRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId: "research-revision-selected",
      parentRevisionId: null,
      manifestPath: payload.manifestPath,
      summary: "Exact selected checkout Research",
      metadata: {
        ...researchFixture.metadata,
        mimeType: payload.mimeType,
        byteLength: payload.byteSize,
        payloadChecksum: payload.payloadChecksum,
      },
      checksum: payload.checksum,
      provenance: researchFixture.provenance,
    },
  );
  store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    researchRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: "Seed exact selected Research Revision",
    },
  );
  const beforePageShell = store.workspace.getWorkspace(project.id)!;
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: beforePageShell.graphRevision,
    expectedSnapshotId: beforePageShell.activeSnapshotId,
    commands: [{
      id: "add-blocked-page-shell",
      type: "add-node",
      node: {
        id: "checkout-node",
        kind: "page",
        name: "Checkout",
        artifactId: "checkout-page",
        createIdentity: { initialTrackId: "checkout-main" },
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
    generation: exactResearchBackedPageGeneration({
      resourceNodeId: created.node.id,
      resourceId: created.resource.id,
      resourceTitle: created.resource.title,
      resourceRevisionId: researchRevision.id,
      directionId: selectedDirection.id,
    }),
    rationale: "Generate from the exact immutable Research direction the user selected",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);

  const previousDaemonToken = process.env.DEZIN_DAEMON_TOKEN;
  process.env.DEZIN_DAEMON_TOKEN = "parent-daemon-token-must-not-leak";
  t.after(() => {
    if (previousDaemonToken === undefined) delete process.env.DEZIN_DAEMON_TOKEN;
    else process.env.DEZIN_DAEMON_TOKEN = previousDaemonToken;
  });
  let childEnvironment = "";
  let observedInputEnvironment: NodeJS.ProcessEnv | undefined;
  let artifactRunnerCalls = 0;
  let observedDirectionSpec: string | undefined;
  const artifactRunner: AgentRunner = {
    id: "bootstrap-selected-research-fixture",
    async runTurn(input) {
      artifactRunnerCalls += 1;
      observedInputEnvironment = input.env;
      const child = spawnSync("/usr/bin/env", [], {
        encoding: "utf8",
        env: agentSpawnEnv(input.env),
      });
      assert.equal(child.status, 0, child.stderr);
      childEnvironment = child.stdout;
      assert.match(input.systemPrompt, /direction-primary/);
      assert.match(input.systemPrompt, /evidenceFindingIds/);
      const html = [
        "<!doctype html>",
        '<html><body><main data-design-node-id="checkout-root">',
        "<h1>Quiet confidence checkout</h1>",
        "<p>Delivery, total, and recovery guidance remain visible.</p>",
        "</main></body></html>",
      ].join("");
      await writeFile(join(input.projectDir, "index.html"), html, "utf8");
      return { text: "Generated from one exact selected Research direction.", artifactHtml: html, artifactPath: "index.html" };
    },
  };
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const qualityDependencies: ProductionStandardArtifactQualityEvaluatorDependencies = {
    inspectCandidate: inspectStandardArtifactCandidate,
    async acquireRuntime() {
      const bridgeNonce = "q".repeat(43);
      return {
        leaseId: "quality-fixture-lease",
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
      assert.equal(input.runtimeOnly, false);
      observedDirectionSpec = input.directionSpec;
      const frames = await Promise.all(input.renderFrames.map(async (frame, index) => {
        const screenshotPath = join(root, `quality-${frame.id}.png`);
        const bytes = sharinganFixturePng(frame.width, frame.height);
        await writeFile(screenshotPath, bytes);
        return {
          frameId: frame.id,
          frameAttemptId: visualQaFrameAttemptId(input.frameAttemptIdPrefix, frame, index),
          width: frame.width,
          height: frame.height,
          status: "passed" as const,
          screenshotPath,
          captureIdentity: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            width: frame.width,
            height: frame.height,
          },
          reviewed: true,
        };
      }));
      return {
        findings: [{
          severity: "P2" as const,
          id: "visual-reviewed",
          message: "Every immutable quality frame was reviewed.",
          fix: "No action required.",
        }],
        frames,
      };
    },
    persistEvidence: persistGenerationTaskVisualEvidence,
    sharinganReference() {
      return undefined;
    },
  };
  const errors: unknown[] = [];
  const system = createProductionGenerationBootstrap({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-production-selected-research-test",
    repositoryDirForWorkspace: () => repositoryDir,
    resourceExternalFetch: async () => {
      throw new Error("external fetch is not used by this Plan");
    },
    createResourceRuntimePorts: () => ({
      agent: { async generateStructured() { throw new Error("no Resource Task is present"); } },
      researchEvidence: { async retrieveWebEvidence() { throw new Error("no Research Task is present"); } },
      sharinganCaptures: { async exportExactCapture() { throw new Error("no Sharingan Task is present"); } },
    }) as never,
    createArtifactRunner: () => artifactRunner,
    artifactQualityDependencies: qualityDependencies,
    leaseMs: 2_000,
    heartbeatMs: 500,
    pollMs: 10,
    onError: (error) => errors.push(error),
  });
  teardownRuntime = async () => {
    try {
      await system.runtime.stop();
    } finally {
      await runtimeSupervisor.shutdown();
    }
  };

  await system.runtime.start();
  try {
    await waitForDurableProgress({
      description: "production Generation bootstrap",
      read: () => store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan!.id),
      isSettled: ({ plan }) => (
        plan.status === "succeeded" || plan.status === "failed" || plan.status === "cancelled"
        || plan.status === "compile-failed"
      ),
      fingerprint: ({ plan, tasks }) => JSON.stringify({
        plan: [plan.status, plan.executionEpoch],
        tasks: tasks.map((task) => [
          task.kind,
          task.status,
          task.currentAttempt,
          task.materializationFailures,
          task.rebaseCount,
        ]),
      }),
      idleTimeoutMs: PRODUCTION_GENERATION_IDLE_TIMEOUT_MS,
      hardTimeoutMs: PRODUCTION_GENERATION_HARD_TIMEOUT_MS,
    });
  } catch (error) {
    const stalled = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    assert.fail(JSON.stringify({
      cause: error instanceof Error ? error.message : String(error),
      planStatus: stalled.plan.status,
      tasks: stalled.tasks.map((task) => ({
        kind: task.kind, status: task.status, failureClass: task.failureClass, error: task.error,
      })),
      errors: errors.map((item) => item instanceof Error ? item.message : String(item)),
    }, null, 2));
  }
  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
  if (detail.plan.status !== "succeeded") {
    assert.fail(JSON.stringify({
      planStatus: detail.plan.status,
      tasks: detail.tasks.map((task) => ({
        kind: task.kind,
        status: task.status,
        failureClass: task.failureClass,
        error: task.error,
      })),
      errors: errors.map((error) => error instanceof Error ? error.message : String(error)),
    }, null, 2));
  }
  assert.deepEqual(detail.tasks.map((task) => [task.kind, task.status]), [
    ["page", "succeeded"],
    ["prototype-validation", "succeeded"],
    ["checkpoint", "succeeded"],
  ]);
  assert.equal(artifactRunnerCalls, 1);
  assert.equal(Object.hasOwn(observedInputEnvironment ?? {}, "DEZIN_DAEMON_TOKEN"), true);
  assert.equal(observedInputEnvironment?.DEZIN_DAEMON_TOKEN, undefined);
  assert.doesNotMatch(childEnvironment, /^DEZIN_DAEMON_TOKEN=/m);
  assert.match(childEnvironment, /^OPENAI_API_KEY=artifact-provider-key$/m);
  assert.deepEqual(JSON.parse(observedDirectionSpec ?? "null"), selectedDirection);

  const [artifactRevision] = store.workspace.listRevisions(project.id, "checkout-page");
  assert.ok(artifactRevision);
  assert.deepEqual(store.workspace.listArtifactRevisionResourcePins(artifactRevision.id), [{
    workspaceId: workspace.id,
    ownerArtifactId: "checkout-page",
    revisionId: artifactRevision.id,
    resourceId: created.resource.id,
    resourceRevisionId: researchRevision.id,
  }]);
});
