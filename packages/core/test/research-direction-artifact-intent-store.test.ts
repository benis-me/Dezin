import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ResearchDirectionArtifactIntentConflictError,
  Store,
  WorkspacePointerConflictError,
  WorkspaceProposalValidationError,
  type CreateWorkspaceProposalInput,
  type ResearchDirectionArtifactIntentRequestFacts,
  type StoreClock,
} from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 80_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `research-intent-id-${++id}`,
  };
}

const REQUEST_ID = "selection-00000000-0000-4000-8000-000000000001";
const FROZEN_CODEBUDDY_AGENT = Object.freeze({
  providerId: "codebuddy" as const,
  command: "codebuddy" as const,
  model: "gpt-5.6-sol",
});

function seed(existingInformsEdge = false) {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Research direction intent", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const research = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Checkout research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    research.resource.id,
    {
      revisionId: "research-revision-one",
      parentRevisionId: null,
      manifestPath: "resource-revisions/research-revision-one/manifest.json",
      summary: "Grounded checkout directions",
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
  const resourceSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    research.resource.id,
    revision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: research.snapshot.id,
      reason: "Seed immutable Research",
    },
  );
  const shell = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: research.snapshot.graphRevision,
    expectedSnapshotId: resourceSnapshot.id,
    commands: [
      {
        id: "add-checkout-page",
        type: "add-node",
        node: {
          id: "checkout-page-node",
          kind: "page",
          name: "Checkout page",
          artifactId: "checkout-page",
          createIdentity: { initialTrackId: "checkout-page-track" },
        },
      },
      ...(existingInformsEdge ? [{
        id: "add-existing-research-edge",
        type: "add-edge" as const,
        edge: {
          id: "existing-research-edge",
          workspaceId: research.resource.workspaceId,
          kind: "informs" as const,
          sourceNodeId: research.node.id,
          targetNodeId: "checkout-page-node",
        },
      }] : []),
    ],
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  assert.equal(workspace.activeSnapshotId, shell.snapshot.id);
  const layout = store.workspace.getLayout(project.id);
  const request: ResearchDirectionArtifactIntentRequestFacts = {
    workspaceId: workspace.id,
    resourceId: research.resource.id,
    revisionId: revision.id,
    directionId: "quiet-confidence",
    artifactId: "checkout-page",
    agent: FROZEN_CODEBUDDY_AGENT,
    resourceHeadRevisionId: revision.id,
    graphRevision: workspace.graphRevision,
    snapshotId: workspace.activeSnapshotId,
    layoutChecksum: layout.checksum,
    confirmHypothesis: false,
  };
  const proposal: CreateWorkspaceProposalInput = {
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: request.graphRevision,
    baseSnapshotId: request.snapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: request.layoutChecksum,
    operations: existingInformsEdge ? [] : [{
      id: "add-selected-research-edge",
      type: "add-edge",
      edge: {
        id: "selected-research-edge",
        workspaceId: workspace.id,
        kind: "informs",
        sourceNodeId: research.node.id,
        targetNodeId: "checkout-page-node",
      },
    }],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      agent: FROZEN_CODEBUDDY_AGENT,
      resourceOperations: [{
        operation: "reuse",
        nodeId: research.node.id,
        resourceId: research.resource.id,
        kind: "research",
        title: research.resource.title,
        revisionPolicy: { kind: "exact", resourceRevisionId: revision.id },
      }],
      artifactPlans: [{
        operation: "create",
        nodeId: "checkout-page-node",
        artifactId: "checkout-page",
        kind: "page",
        name: "Checkout page",
        trackId: "checkout-page-track",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
        researchDirectionSelection: {
          protocol: "dezin.research-direction-selection.v1",
          version: 1,
          resourceId: research.resource.id,
          revisionId: revision.id,
          directionId: request.directionId,
        },
      }],
      dependencyPlans: [{
        kind: "resource",
        ownerArtifactId: "checkout-page",
        resourceId: research.resource.id,
      }],
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
    rationale: "Use the selected quiet confidence direction.",
    assumptions: ["Human selected an exact immutable Research direction."],
    createdByRunId: null,
  };
  return { store, project, research, revision, request, proposal };
}

test("Research selection atomically creates one visible informs edge and one immutable Artifact Plan", () => {
  const fixture = seed();
  const result = fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );

  assert.equal(result.created, true);
  assert.equal(result.selectionRequestId, REQUEST_ID);
  assert.equal(result.task.target.type, "artifact");
  assert.equal(result.task.target.id, "checkout-page");
  assert.equal(result.plan.proposalId, result.proposal.id);
  assert.equal(result.graph.edges.filter((edge) => edge.kind === "informs"
    && edge.sourceNodeId === fixture.research.node.id
    && edge.targetNodeId === "checkout-page-node").length, 1);
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM research_direction_artifact_intents",
  ).get() as { count: number }).count), 1);
  fixture.store.close();
});

test("Research selection rejects Head drift atomically before creating a Proposal or Plan", () => {
  const fixture = seed();
  const successor = fixture.store.workspace.createResourceRevisionCandidateForProject(
    fixture.project.id,
    fixture.research.resource.id,
    {
      revisionId: "research-revision-two",
      parentRevisionId: fixture.revision.id,
      manifestPath: "resource-revisions/research-revision-two/manifest.json",
      summary: "Newer Research Head",
      metadata: { mimeType: "application/json" },
      checksum: "b".repeat(64),
      provenance: { source: "head-drift-test" },
    },
  );
  fixture.store.db.prepare(
    "UPDATE resources SET head_revision_id = ? WHERE id = ?",
  ).run(successor.id, fixture.research.resource.id);

  assert.throws(
    () => fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
      fixture.project.id,
      REQUEST_ID,
      fixture.request,
      fixture.proposal,
    ),
    (error: unknown) => error instanceof WorkspacePointerConflictError
      && error.pointer === "resource-head"
      && error.expectedId === fixture.revision.id
      && error.actualId === successor.id,
  );
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_proposals",
  ).get() as { count: number }).count), 0);
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_plans",
  ).get() as { count: number }).count), 0);
  fixture.store.close();
});

test("archived Research keeps immutable history but cannot create a new Artifact intent", () => {
  const fixture = seed();
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  const graph = fixture.store.workspace.getGraph(fixture.project.id);
  fixture.store.workspace.updateResourceForProject(
    fixture.project.id,
    fixture.research.resource.id,
    {
      action: "archive",
      baseGraphRevision: graph.revision,
      expectedSnapshotId: workspace.activeSnapshotId,
      consumerImpactConfirmed: true,
    },
  );

  assert.throws(
    () => fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
      fixture.project.id,
      REQUEST_ID,
      fixture.request,
      fixture.proposal,
    ),
    (error: unknown) => error instanceof WorkspaceProposalValidationError
      && /active Research Resource/.test(error.message),
  );
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_proposals",
  ).get() as { count: number }).count), 0);
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_plans",
  ).get() as { count: number }).count), 0);
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM research_direction_artifact_intents",
  ).get() as { count: number }).count), 0);
  fixture.store.close();
});

test("Research selection request replay returns the original receipt after later Workspace changes", () => {
  const fixture = seed();
  const created = fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );
  const current = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  fixture.store.workspace.applyGraphCommands(fixture.project.id, {
    baseGraphRevision: current.graphRevision,
    expectedSnapshotId: current.activeSnapshotId,
    commands: [{
      id: "add-unrelated-component",
      type: "add-node",
      node: {
        id: "unrelated-component-node",
        kind: "component",
        name: "Unrelated component",
        artifactId: "unrelated-component",
        createIdentity: { initialTrackId: "unrelated-component-track" },
      },
    }],
  });

  const replay = fixture.store.workspace.getResearchDirectionArtifactIntentReceiptForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
  );
  assert.ok(replay);
  assert.equal(replay.created, false);
  assert.equal(replay.proposal.id, created.proposal.id);
  assert.equal(replay.plan.id, created.plan.id);
  assert.equal(replay.task.id, created.task.id);
  assert.equal(replay.graph.revision, created.graph.revision);
  assert.equal(replay.snapshot.id, created.snapshot.id);

  const combinedReplay = fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );
  assert.equal(combinedReplay.created, false);
  assert.equal(combinedReplay.plan.id, created.plan.id);
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_plans",
  ).get() as { count: number }).count), 1);
  fixture.store.close();
});

test("legacy Research selection identities replay only when the durable Proposal freezes the same Agent", () => {
  const fixture = seed();
  const created = fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );
  const row = fixture.store.db.prepare(
    "SELECT request_json FROM research_direction_artifact_intents WHERE request_id = ?",
  ).get(REQUEST_ID) as { request_json: string };
  const legacyRequest = JSON.parse(row.request_json) as Record<string, unknown>;
  delete legacyRequest.agent;
  const legacyRequestJson = JSON.stringify(legacyRequest);
  const legacyRequestHash = createHash("sha256").update(legacyRequestJson).digest("hex");
  fixture.store.db.exec("DROP TRIGGER research_direction_artifact_intent_update_immutable");
  fixture.store.db.prepare(
    "UPDATE research_direction_artifact_intents SET request_hash = ?, request_json = ? WHERE request_id = ?",
  ).run(legacyRequestHash, legacyRequestJson, REQUEST_ID);

  const replay = fixture.store.workspace.getResearchDirectionArtifactIntentReceiptForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
  );
  assert.equal(replay?.proposal.id, created.proposal.id);
  assert.equal(replay?.requestHash, legacyRequestHash);
  assert.throws(
    () => fixture.store.workspace.getResearchDirectionArtifactIntentReceiptForProject(
      fixture.project.id,
      REQUEST_ID,
      {
        ...fixture.request,
        agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-terra" },
      },
    ),
    ResearchDirectionArtifactIntentConflictError,
  );
  fixture.store.close();
});

test("Research selection request id rejects direction, provider, and model substitution", () => {
  const fixture = seed();
  fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );
  for (const request of [
    { ...fixture.request, directionId: "different-direction" },
    {
      ...fixture.request,
      agent: { providerId: "claude" as const, command: "claude" as const, model: null },
    },
    {
      ...fixture.request,
      agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-terra" },
    },
  ]) {
    assert.throws(
      () => fixture.store.workspace.getResearchDirectionArtifactIntentReceiptForProject(
        fixture.project.id,
        REQUEST_ID,
        request,
      ),
      ResearchDirectionArtifactIntentConflictError,
    );
  }
  fixture.store.close();
});

test("Research selection reuses an existing informs edge without duplicating it", () => {
  const fixture = seed(true);
  const result = fixture.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
    fixture.project.id,
    REQUEST_ID,
    fixture.request,
    fixture.proposal,
  );
  assert.equal(result.graph.edges.filter((edge) => edge.kind === "informs"
    && edge.sourceNodeId === fixture.research.node.id
    && edge.targetNodeId === "checkout-page-node").length, 1);
  fixture.store.close();
});

test("an Artifact cannot consume Research generated in the same Plan", () => {
  const fixture = seed();
  const invalid = structuredClone(fixture.proposal);
  if (invalid.generation.kind !== "workspace-generation") assert.fail("expected Workspace generation fixture");
  invalid.operations = [];
  invalid.generation.resourceOperations = [{
    operation: "revise",
    nodeId: fixture.research.node.id,
    resourceId: fixture.research.resource.id,
    kind: "research",
    title: fixture.research.resource.title,
    revisionPolicy: { kind: "generate" },
  }];
  delete invalid.generation.artifactPlans[0]!.researchDirectionSelection;
  const draft = fixture.store.workspace.createProposal(invalid);

  assert.throws(
    () => fixture.store.workspace.approveProposalForProject(fixture.project.id, draft.id, "generate"),
    (error: unknown) => error instanceof WorkspaceProposalValidationError
      && /cannot consume Research generated in the same Plan/.test(error.message),
  );
  assert.equal(fixture.store.workspace.getProposalForProject(fixture.project.id, draft.id)?.status, "draft");
  assert.equal(Number((fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_plans WHERE proposal_id = ?",
  ).get(draft.id) as { count: number }).count), 0);
  fixture.store.close();
});
