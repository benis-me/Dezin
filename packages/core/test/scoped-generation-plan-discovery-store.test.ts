import assert from "node:assert/strict";
import test from "node:test";

import {
  Store,
  type StoreClock,
  type WorkspaceGenerationArtifactPlan,
} from "../src/index.ts";

const DISPATCH_CONTEXT_PACK_ID = `context-pack-${"a".repeat(64)}`;

function tiedClock(): StoreClock {
  let id = 0;
  return {
    now: () => 100_000,
    id: () => `scoped-plan-${String(++id).padStart(4, "0")}`,
  };
}

function seedWorkspace(store: Store) {
  const project = store.createProject({ name: "Scoped Plan discovery", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    commands: [
      {
        id: "add-primary-page",
        type: "add-node",
        node: {
          id: "primary-page-node",
          kind: "page",
          name: "Primary page",
          artifactId: "primary-page",
          createIdentity: { initialTrackId: "primary-page-track" },
        },
      },
      {
        id: "add-secondary-page",
        type: "add-node",
        node: {
          id: "secondary-page-node",
          kind: "page",
          name: "Secondary page",
          artifactId: "secondary-page",
          createIdentity: { initialTrackId: "secondary-page-track" },
        },
      },
    ],
  });
  let expectedSnapshotId = graph.snapshot.id;
  const revisions = new Map<string, string>();
  for (const [artifactId, trackId] of [
    ["primary-page", "primary-page-track"],
    ["secondary-page", "secondary-page-track"],
  ] as const) {
    const revision = store.workspace.createArtifactRevision({
      artifactId,
      trackId,
      parentRevisionId: null,
      sourceCommitHash: "1".repeat(40),
      sourceTreeHash: "2".repeat(40),
      kernelRevisionId: initial.activeKernelRevisionId,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    expectedSnapshotId = store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId,
    }).id;
    revisions.set(artifactId, revision.id);
  }
  return { project, revisions };
}

function artifactPlan(
  artifactId: "primary-page" | "secondary-page",
  baseRevisionId: string,
  dispatchContextPackId?: string,
): WorkspaceGenerationArtifactPlan {
  const primary = artifactId === "primary-page";
  return {
    operation: "revise",
    nodeId: primary ? "primary-page-node" : "secondary-page-node",
    artifactId,
    kind: "page",
    name: primary ? "Primary page" : "Secondary page",
    trackId: primary ? "primary-page-track" : "secondary-page-track",
    baseRevisionId,
    dependsOnArtifactIds: [],
    capabilityIds: [],
    responsiveFrameIds: ["desktop"],
    ...(dispatchContextPackId === undefined ? {} : { dispatchContextPackId }),
  };
}

function compilePlan(
  store: Store,
  projectId: string,
  plans: WorkspaceGenerationArtifactPlan[],
) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const layout = store.workspace.getLayout(projectId);
  const proposal = store.workspace.createProposal({
    projectId,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
      resourceOperations: [],
      artifactPlans: plans,
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
    },
    rationale: "Compile one scoped generated leaf",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(projectId, proposal.id, "generate");
  assert.ok(approved.plan);
  return store.workspace.compileApprovedGenerationPlanForProject(projectId, approved.plan.id).plan;
}

test("latest scoped Artifact Plan discovery is exact and deterministic without detail scans", () => {
  const store = new Store(":memory:", tiedClock());
  const { project, revisions } = seedWorkspace(store);
  assert.ok((store.db.prepare("PRAGMA index_list('generation_tasks')").all() as Array<{ name: string }>)
    .some(({ name }) => name === "idx_generation_tasks_scoped_artifact_plan"));
  const primaryRevision = revisions.get("primary-page")!;
  const secondaryRevision = revisions.get("secondary-page")!;

  const firstExact = compilePlan(store, project.id, [
    artifactPlan("primary-page", primaryRevision, DISPATCH_CONTEXT_PACK_ID),
  ]);
  const newestExact = compilePlan(store, project.id, [
    artifactPlan("primary-page", primaryRevision, `context-pack-${"b".repeat(64)}`),
  ]);
  compilePlan(store, project.id, [artifactPlan("primary-page", primaryRevision)]);
  compilePlan(store, project.id, [
    artifactPlan("primary-page", primaryRevision, `context-pack-${"c".repeat(64)}`),
    artifactPlan("secondary-page", secondaryRevision),
  ]);

  assert.notEqual(firstExact.id, newestExact.id);
  assert.equal(firstExact.createdAt, newestExact.createdAt, "the id must break equal timestamp ties");
  assert.equal(
    store.workspace.getLatestScopedArtifactGenerationPlanForProject(project.id, "primary-page")?.id,
    newestExact.id,
  );
  assert.equal(
    store.workspace.getLatestScopedArtifactGenerationPlanForProject(project.id, "secondary-page"),
    null,
  );
  assert.equal(
    store.workspace.getLatestScopedArtifactGenerationPlanForProject("missing-project", "primary-page"),
    null,
  );
  store.close();
});
