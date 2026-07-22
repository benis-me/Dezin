import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  Store,
  type GenerationTaskAttemptClaim,
} from "../../../packages/core/src/index.ts";
import { BUNDLED_DESIGN_SYSTEMS, DesignRegistry } from "../../../packages/design/src/index.ts";
import { RuntimeSupervisor } from "../src/runtime-supervisor.ts";
import { beginArtifactCandidateTransaction } from "../src/orchestration/artifact-candidate-transaction.ts";
import type { ArtifactPreparedCandidate } from "../src/orchestration/generation-task-executor.ts";
import { createProductionGenerationSystem } from "../src/orchestration/production-generation-system.ts";
import { createProductionResourceTaskExecutor } from "../src/orchestration/production-resource-task-adapter.ts";

const DESKTOP_FRAME = { id: "desktop", name: "Desktop", width: 1_440, height: 900 } as const;

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Generation Plan did not settle before the deadline");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializeRepository(repositoryDir: string): Promise<void> {
  await mkdir(repositoryDir, { recursive: true });
  git(repositoryDir, "init", "-q");
  git(repositoryDir, "config", "user.name", "Dezin acceptance");
  git(repositoryDir, "config", "user.email", "acceptance@dezin.local");
  await writeFile(join(repositoryDir, "README.md"), "# Production generation acceptance\n", "utf8");
  git(repositoryDir, "add", "README.md");
  git(repositoryDir, "commit", "-q", "-m", "base");
}

function nonEmptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [{
      operation: "create" as const,
      nodeId: "direction-board-node",
      resourceId: "direction-moodboard",
      kind: "moodboard" as const,
      title: "Product direction board",
      revisionPolicy: { kind: "generate" as const },
    }],
    artifactPlans: [
      {
        operation: "create" as const,
        nodeId: "card-node",
        artifactId: "card-component",
        kind: "component" as const,
        name: "Product card",
        trackId: "card-track",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      },
      {
        operation: "create" as const,
        nodeId: "catalog-node",
        artifactId: "catalog-page",
        kind: "page" as const,
        name: "Catalog",
        trackId: "catalog-track",
        baseRevisionId: null,
        dependsOnArtifactIds: ["card-component"],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      },
    ],
    dependencyPlans: [
      {
        kind: "resource" as const,
        ownerArtifactId: "card-component",
        resourceId: "direction-moodboard",
      },
      {
        kind: "component-instance" as const,
        ownerArtifactId: "catalog-page",
        instanceId: "catalog-card-instance",
        componentArtifactId: "card-component",
        componentRevisionId: null,
        sourceLocator: { designNodeId: "catalog-card-slot" },
        overrides: {},
        status: "linked" as const,
      },
    ],
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

function deterministicArtifactLeaf(input: {
  projectId: string;
  repositoryDir: string;
  executions: string[];
}) {
  return {
    async execute(
      claim: GenerationTaskAttemptClaim,
      signal: AbortSignal,
    ): Promise<ArtifactPreparedCandidate> {
      assert.ok(claim.task.kind === "component" || claim.task.kind === "page");
      assert.equal(claim.task.target.type, "artifact");
      const contextPackId = claim.attempt.contextPackId;
      if (contextPackId === null) assert.fail("Artifact Attempt must freeze one Context Pack");
      assert.ok(contextPackId.startsWith("context-pack-"));
      assert.ok(claim.attempt.sourceCommitHash);
      assert.ok(claim.attempt.sourceTreeHash);
      const frames = structuredClone(claim.task.payload.responsiveFrames) as Array<{
        id: string;
        name: string;
        width: number;
        height: number;
      }>;
      assert.ok(Array.isArray(frames) && frames.length > 0);
      input.executions.push(claim.task.kind);
      const attempt = {
        workspaceId: claim.task.workspaceId,
        taskId: claim.task.id,
        attempt: claim.attempt.attempt,
        inputHash: claim.attempt.inputHash,
        createdAt: claim.attempt.createdAt,
        sourceCommitHash: claim.attempt.sourceCommitHash,
        sourceTreeHash: claim.attempt.sourceTreeHash,
      };
      const transaction = await beginArtifactCandidateTransaction({
        repositoryDir: input.repositoryDir,
        attempt,
      });
      try {
        await writeFile(
          join(transaction.dir, `${claim.task.target.id}.html`),
          `<main data-design-node-id="${claim.task.target.id}">${claim.task.target.id}</main>\n`,
          "utf8",
        );
        const candidate = await transaction.commit(`generate ${claim.task.target.id}`, signal);
        const contextPackHash = contextPackId.slice("context-pack-".length);
        const round = 0;
        const visualDescriptors = frames.map((frame) => {
          const frameAttemptId = `quality-round-${round}-${frame.id}`;
          const sha256 = createHash("sha256")
            .update(`${claim.task.id}:${claim.attempt.attempt}:${frame.id}`)
            .digest("hex");
          const byteLength = 1_024;
          const storageKey = [
            "generation-task-evidence",
            input.projectId,
            claim.task.workspaceId,
            claim.task.planId,
            claim.task.id,
            `attempt-${claim.attempt.attempt}`,
            "visual",
            `round-${round}-${frame.id}-${sha256}.png`,
          ].join("/");
          const summary = { frameId: frame.id, frameAttemptId, sha256, byteLength, storageKey };
          return {
            summary,
            descriptor: {
              protocol: "dezin.generation-task-visual-evidence.v1",
              owner: {
                projectId: input.projectId,
                workspaceId: claim.task.workspaceId,
                planId: claim.task.planId,
                taskId: claim.task.id,
                attempt: claim.attempt.attempt,
                candidateCommitHash: candidate.commitHash,
                candidateTreeHash: candidate.treeHash,
                contextPackId,
                contextPackHash,
              },
              frame: { ...frame, frameAttemptId },
              round,
              mediaType: "image/png",
              sha256,
              byteLength,
              storageKey,
            },
          };
        });
        const evaluatedFrames = claim.task.qaProfile.requireRuntimeChecks
          || claim.task.qaProfile.requireVisualReview;
        const qualityEvidence = {
          protocol: "dezin.standard-artifact-quality.v1",
          candidate: { commitHash: candidate.commitHash, treeHash: candidate.treeHash },
          contextPack: { id: contextPackId, hash: contextPackHash },
          frames,
          frameResults: evaluatedFrames ? frames.map((frame) => ({
            frameId: frame.id,
            frameAttemptId: `quality-round-${round}-${frame.id}`,
            width: frame.width,
            height: frame.height,
            status: "passed",
            reviewed: claim.task.qaProfile.requireVisualReview,
          })) : [],
          round,
          ...(claim.task.qaProfile.requireRuntimeChecks ? {
            runtimeChecks: frames.map((frame) => ({ id: `frame:${frame.id}`, status: "passed" })),
          } : {}),
          ...(claim.task.qaProfile.requireVisualReview ? {
            visualReview: {
              status: "passed",
              fidelity: 0.99,
              evidence: visualDescriptors.map((item) => item.summary),
            },
            visualEvidence: visualDescriptors.map((item) => item.descriptor),
          } : {}),
        };
        return {
          kind: "artifact-candidate",
          taskId: claim.task.id,
          workspaceId: claim.task.workspaceId,
          artifactId: claim.task.target.id,
          trackId: claim.task.target.trackId,
          sourceCommitHash: candidate.commitHash,
          sourceTreeHash: candidate.treeHash,
          renderSpec: { frames },
          quality: { state: "passed", score: 100, findings: [] },
          evidence: {
            protocol: "dezin.artifact-run.v1",
            projectId: input.projectId,
            taskId: claim.task.id,
            planId: claim.task.planId,
            workspaceId: claim.task.workspaceId,
            attempt: claim.attempt.attempt,
            attemptCreatedAt: claim.attempt.createdAt,
            inputHash: claim.attempt.inputHash,
            contextPackId,
            contextPackHash,
            sourceBase: {
              commitHash: claim.attempt.sourceCommitHash,
              treeHash: claim.attempt.sourceTreeHash,
            },
            candidateRetentionRef: transaction.attemptRef,
            selectedRound: 0,
            versions: [{
              round: 0,
              commitHash: candidate.commitHash,
              treeHash: candidate.treeHash,
              passed: true,
              score: 100,
            }],
            ...(claim.task.qaProfile.requireRuntimeChecks ? {
              runtimeChecks: qualityEvidence.runtimeChecks,
            } : {}),
            ...(claim.task.qaProfile.requireVisualReview ? {
              visualReview: qualityEvidence.visualReview,
            } : {}),
            qualityEvidence,
          },
        };
      } finally {
        await transaction.dispose();
      }
    },
  };
}

test("production Generation system recovers an approved shell and runs validation through checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-system-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Production Generation", mode: "standard" });
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
    rationale: "Exercise the complete production scheduler",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);

  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const unexpectedLeaf = async (): Promise<never> => assert.fail("empty Plan must not invoke Agent leaves");
  const system = createProductionGenerationSystem({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-production-system-test",
    repositoryDirForWorkspace: () => repositoryDir,
    artifacts: { execute: unexpectedLeaf },
    resources: {
      execute: unexpectedLeaf,
      cleanupIfUnreferenced: async () => false,
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
  assert.equal(detail.plan.constructionSealed, true);
  assert.equal(detail.plan.status, "succeeded");
  assert.deepEqual(detail.tasks.map((task) => task.kind), ["prototype-validation", "checkpoint"]);
  assert.ok(detail.tasks.every((task) => task.status === "succeeded"));
  assert.deepEqual(
    detail.tasks.map((task) => task.currentAttempt),
    [1, 1],
  );
  assert.ok(store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id)
    .some((event) => event.type === "plan-succeeded"));
});

test("production rebase maintenance never decodes terminal Generation Plan history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-active-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.db"));
  t.after(() => store.close());
  const project = store.createProject({ name: "Active Plan scan", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const repositoryDir = join(root, "projects", project.id);
  await mkdir(repositoryDir, { recursive: true });
  let historicalReads = 0;
  Object.defineProperty(store.workspace, "listGenerationPlans", {
    configurable: true,
    value: () => {
      historicalReads += 1;
      return assert.fail("maintenance must query active Plan ids directly");
    },
  });
  const runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
  const unused = async (): Promise<never> => assert.fail("no Generation Task should execute");
  const system = createProductionGenerationSystem({
    store,
    dataDir: root,
    designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
    runtimeSupervisor,
    daemonOwnerId: "daemon-active-scan-test",
    repositoryDirForWorkspace: () => repositoryDir,
    artifacts: { execute: unused },
    resources: { execute: unused, cleanupIfUnreferenced: async () => false },
  });
  t.after(async () => {
    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
  });

  assert.deepEqual(await system.planService.reconcileNeedsRebaseTasks(), { planIds: [] });
  assert.equal(historicalReads, 0);
});

test("production Generation system publishes one real Resource to Component to Page DAG exactly once across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dezin-production-generation-dag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, "store.db");
  const repositoryDir = join(root, "projects", "generation-dag");
  await initializeRepository(repositoryDir);
  const executions: string[] = [];
  const errors: unknown[] = [];
  let store: Store | null = new Store(storePath);
  let runtimeSupervisor: RuntimeSupervisor | null = null;
  let system: ReturnType<typeof createProductionGenerationSystem> | null = null;

  try {
    const project = store.createProject({ name: "Production Generation DAG", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const layout = store.workspace.getLayout(project.id);
    const proposal = store.workspace.createProposal({
      projectId: project.id,
      kind: "workspace-generation",
      baseGraphRevision: workspace.graphRevision,
      baseSnapshotId: workspace.activeSnapshotId,
      layoutId: layout.layoutId,
      baseLayoutChecksum: layout.checksum,
      operations: [
        {
          id: "add-direction-moodboard",
          type: "add-node",
          node: {
            id: "direction-board-node",
            kind: "resource",
            name: "Product direction board",
            resourceId: "direction-moodboard",
            createIdentity: { resourceKind: "moodboard", defaultPinPolicy: "pin-current" },
          },
        },
        {
          id: "add-card-component",
          type: "add-node",
          node: {
            id: "card-node",
            kind: "component",
            name: "Product card",
            artifactId: "card-component",
            createIdentity: { initialTrackId: "card-track" },
          },
        },
        {
          id: "add-catalog-page",
          type: "add-node",
          node: {
            id: "catalog-node",
            kind: "page",
            name: "Catalog",
            artifactId: "catalog-page",
            createIdentity: { initialTrackId: "catalog-track" },
          },
        },
      ],
      layoutOperations: [],
      generation: nonEmptyGeneration(),
      rationale: "Generate a moodboard-backed reusable card and its catalog Page",
      assumptions: [],
    });
    const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
    assert.ok(approved.plan);

    // A corrupt, unrelated sibling must not be decoded while validation reads
    // the exact Resource Revision pinned by the generated DAG.
    store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES ('unrelated-corrupt-resource', ?, 'research', 'Unrelated', NULL,
                 'manual', NULL, 1, 1)`,
    ).run(workspace.id);
    store.db.prepare(
      `INSERT INTO resource_revisions (
         id, workspace_id, resource_id, sequence, parent_revision_id,
         manifest_path, summary, metadata_json, checksum, provenance_json,
         created_by_run_id, created_at
       ) VALUES ('unrelated-corrupt-revision', ?, 'unrelated-corrupt-resource', 1, NULL,
                 'resources/unrelated-corrupt.json', 'Unrelated', '{', ?, '{}', NULL, 1)`,
    ).run(workspace.id, "f".repeat(64));

    const resources = createProductionResourceTaskExecutor({
      storageRoot: root,
      store: store.workspace,
      implementations: {
        async moodboard(input) {
          assert.equal(input.resourceId, "direction-moodboard");
          assert.ok(input.contextPackId.startsWith("context-pack-"));
          assert.equal(input.signal.aborted, false);
          executions.push("resource");
          const bundle = {
            format: "dezin-moodboard-resource-bundle",
            version: 2,
            board: {
              id: input.resourceId,
              name: "Product direction board",
              concept: "Editorial commerce",
              designThesis: "Use a restrained editorial system to make product comparison calm and legible.",
              contextPackId: input.contextPackId,
              createdAt: 0,
              updatedAt: 0,
            },
            nodes: [{
              id: "direction-thesis",
              boardId: input.resourceId,
              type: "note",
              x: 48,
              y: 48,
              width: 520,
              height: 240,
              rotation: 0,
              zIndex: 0,
              data: { title: "Editorial commerce", text: "Quiet hierarchy, precise product proof, decisive action." },
              createdAt: 0,
              updatedAt: 0,
            }],
            messages: [],
            assets: [],
          };
          return {
            bytes: new TextEncoder().encode(JSON.stringify(bundle)),
            mimeType: "application/json",
            summary: "Editorial commerce direction moodboard",
            metadata: { format: bundle.format, version: bundle.version, mimeType: "application/json" },
            provenance: { generator: "deterministic-moodboard-acceptance-adapter" },
            evidence: { protocol: "dezin.deterministic-resource-acceptance.v1", contextPackId: input.contextPackId },
          };
        },
      },
    });
    runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
    system = createProductionGenerationSystem({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-production-dag-first",
      repositoryDirForWorkspace: () => repositoryDir,
      artifacts: deterministicArtifactLeaf({ projectId: project.id, repositoryDir, executions }),
      resources,
      leaseMs: 5_000,
      heartbeatMs: 500,
      pollMs: 10,
      onError: (error) => errors.push(error),
    });

    const originalListSnapshots = store.workspace.listSnapshots.bind(store.workspace);
    const originalListResources = store.workspace.listResources.bind(store.workspace);
    const originalListResourceRevisions = store.workspace.listResourceRevisions.bind(store.workspace);
    store.workspace.listSnapshots = (() => assert.fail(
      "production generation must read exact Snapshots",
    )) as typeof store.workspace.listSnapshots;
    store.workspace.listResources = (() => assert.fail(
      "production generation must not scan Resources to find one Revision",
    )) as typeof store.workspace.listResources;
    store.workspace.listResourceRevisions = (() => assert.fail(
      "production generation must not scan Resource Revision history",
    )) as typeof store.workspace.listResourceRevisions;
    try {
      await system.runtime.start();
      await waitFor(() => {
        const status = store!.workspace.getGenerationPlanForProject(project.id, approved.plan!.id).status;
        if (status === "succeeded" || status === "failed" || status === "cancelled"
          || status === "compile-failed") return true;
        return store!.workspace.getGenerationPlanDetailForProject(project.id, approved.plan!.id).tasks
          .some((task) => task.status === "failed" || task.status === "blocked-context");
      }, 15_000);
    } catch {
      const stalled = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
      assert.fail(JSON.stringify({
        plan: stalled.plan,
        tasks: stalled.tasks.map((task) => ({
          kind: task.kind,
          status: task.status,
          failureClass: task.failureClass,
          error: task.error,
          materializationFailures: task.materializationFailures,
        })),
        executions,
        errors: errors.map((error) => error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error),
      }, null, 2));
    } finally {
      store.workspace.listSnapshots = originalListSnapshots;
      store.workspace.listResources = originalListResources;
      store.workspace.listResourceRevisions = originalListResourceRevisions;
    }

    const detail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    assert.equal(detail.plan.constructionSealed, true);
    assert.equal(detail.plan.status, "succeeded", JSON.stringify({
      tasks: detail.tasks.map((task) => ({
        kind: task.kind,
        status: task.status,
        failureClass: task.failureClass,
        error: task.error,
        currentAttempt: task.currentAttempt,
      })),
      executions,
      errors: errors.map((error) => error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error),
    }, null, 2));
    assert.deepEqual(
      detail.tasks.map((task) => task.kind),
      ["resource", "component", "page", "prototype-validation", "checkpoint"],
    );
    assert.ok(detail.tasks.every((task) => task.status === "succeeded"));
    assert.deepEqual(detail.tasks.map((task) => task.currentAttempt), [1, 1, 1, 1, 1]);
    assert.deepEqual(executions, ["resource", "component", "page"]);
    assert.equal(errors.length, 0);

    const resourceTask = detail.tasks.find((task) => task.kind === "resource")!;
    const componentTask = detail.tasks.find((task) => task.kind === "component")!;
    const pageTask = detail.tasks.find((task) => task.kind === "page")!;
    const validationTask = detail.tasks.find((task) => task.kind === "prototype-validation")!;
    const checkpointTask = detail.tasks.find((task) => task.kind === "checkpoint")!;
    assert.ok(resourceTask.resultResourceRevisionId);
    assert.ok(componentTask.resultRevisionId);
    assert.ok(pageTask.resultRevisionId);
    assert.ok(validationTask.resultSnapshotId);
    assert.ok(checkpointTask.resultSnapshotId);

    const activeWorkspace = store.workspace.getWorkspace(project.id)!;
    const activeSnapshot = store.workspace.listSnapshots(project.id)
      .find((snapshot) => snapshot.id === activeWorkspace.activeSnapshotId)!;
    assert.equal(activeSnapshot.resourceRevisions["direction-moodboard"], resourceTask.resultResourceRevisionId);
    assert.equal(activeSnapshot.artifactRevisions["card-component"], componentTask.resultRevisionId);
    assert.equal(activeSnapshot.artifactRevisions["catalog-page"], pageTask.resultRevisionId);
    assert.equal(checkpointTask.resultSnapshotId, activeSnapshot.id);
    assert.equal(store.workspace.getTrack("card-track")?.headRevisionId, componentTask.resultRevisionId);
    assert.equal(store.workspace.getTrack("catalog-track")?.headRevisionId, pageTask.resultRevisionId);
    assert.deepEqual(
      store.workspace.listArtifactRevisionResourcePins(componentTask.resultRevisionId!)
        .map((pin) => ({
          revisionId: pin.revisionId,
          resourceId: pin.resourceId,
          resourceRevisionId: pin.resourceRevisionId,
        })),
      [{
        revisionId: componentTask.resultRevisionId,
        resourceId: "direction-moodboard",
        resourceRevisionId: resourceTask.resultResourceRevisionId,
      }],
    );
    assert.deepEqual(
      store.workspace.listArtifactRevisionDependencies(pageTask.resultRevisionId!)
        .map((dependency) => ({
          instanceId: dependency.instanceId,
          componentArtifactId: dependency.componentArtifactId,
          componentRevisionId: dependency.componentRevisionId,
          status: dependency.status,
        })),
      [{
        instanceId: "catalog-card-instance",
        componentArtifactId: "card-component",
        componentRevisionId: componentTask.resultRevisionId,
        status: "linked",
      }],
    );
    const events = store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id);
    assert.equal(events.at(-1)?.type, "plan-succeeded");
    assert.equal(events.filter((event) => event.type === "task-succeeded").length, 5);

    const durableBeforeRestart = {
      snapshotIds: store.workspace.listSnapshots(project.id).map((snapshot) => snapshot.id),
      eventSequences: events.map((event) => event.sequence),
      componentRevisionIds: store.workspace.listRevisions(project.id, "card-component")
        .map((revision) => revision.id),
      pageRevisionIds: store.workspace.listRevisions(project.id, "catalog-page")
        .map((revision) => revision.id),
      resourceRevisionIds: store.workspace.listResourceRevisions(project.id, "direction-moodboard")
        .map((revision) => revision.id),
      revisionRefNames: git(repositoryDir, "for-each-ref", "--format=%(refname)", "refs/dezin/revisions")
        .split("\n").filter(Boolean),
    };

    await system.runtime.stop();
    await runtimeSupervisor.shutdown();
    system = null;
    runtimeSupervisor = null;
    store.close();
    store = new Store(storePath);

    const restartResources = createProductionResourceTaskExecutor({
      storageRoot: root,
      store: store.workspace,
      implementations: {
        async moodboard() {
          executions.push("resource-after-restart");
          throw new Error("terminal Plan must not execute a Resource again");
        },
      },
    });
    runtimeSupervisor = new RuntimeSupervisor({ dataDir: root, store });
    system = createProductionGenerationSystem({
      store,
      dataDir: root,
      designRegistry: new DesignRegistry(BUNDLED_DESIGN_SYSTEMS),
      runtimeSupervisor,
      daemonOwnerId: "daemon-production-dag-restart",
      repositoryDirForWorkspace: () => repositoryDir,
      artifacts: {
        async execute() {
          executions.push("artifact-after-restart");
          throw new Error("terminal Plan must not execute an Artifact again");
        },
      },
      resources: restartResources,
      leaseMs: 5_000,
      heartbeatMs: 500,
      pollMs: 10,
      onError: (error) => errors.push(error),
    });
    await system.runtime.start();
    await system.scheduler.tick();

    const restartedDetail = store.workspace.getGenerationPlanDetailForProject(project.id, approved.plan.id);
    assert.equal(restartedDetail.plan.status, "succeeded");
    assert.deepEqual(restartedDetail.tasks.map((task) => task.currentAttempt), [1, 1, 1, 1, 1]);
    assert.deepEqual(executions, ["resource", "component", "page"]);
    assert.equal(errors.length, 0);
    assert.deepEqual(
      {
        snapshotIds: store.workspace.listSnapshots(project.id).map((snapshot) => snapshot.id),
        eventSequences: store.workspace.listGenerationPlanEventsForProject(project.id, approved.plan.id)
          .map((event) => event.sequence),
        componentRevisionIds: store.workspace.listRevisions(project.id, "card-component")
          .map((revision) => revision.id),
        pageRevisionIds: store.workspace.listRevisions(project.id, "catalog-page")
          .map((revision) => revision.id),
        resourceRevisionIds: store.workspace.listResourceRevisions(project.id, "direction-moodboard")
          .map((revision) => revision.id),
        revisionRefNames: git(repositoryDir, "for-each-ref", "--format=%(refname)", "refs/dezin/revisions")
          .split("\n").filter(Boolean),
      },
      durableBeforeRestart,
    );
  } finally {
    await system?.runtime.stop().catch(() => undefined);
    await runtimeSupervisor?.shutdown().catch(() => undefined);
    store?.close();
  }
});
