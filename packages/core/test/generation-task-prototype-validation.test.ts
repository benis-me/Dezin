import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGenerationTaskPrototypeValidationResult,
  normalizeGenerationTaskIntent,
  type ArtifactRevisionRecord,
  type GenerationTask,
  type GenerationTaskAttempt,
  type RenderFrameSpec,
  type WorkspaceSnapshotRecord,
} from "../src/index.ts";

const WORKSPACE_ID = "workspace-prototype-frame-validation";
const PLAN_ID = "plan-prototype-frame-validation";
const TASK_ID = "task-prototype-frame-validation";
const SNAPSHOT_ID = "snapshot-prototype-frame-validation";
const KERNEL_REVISION_ID = "kernel-prototype-frame-validation";

const PLANNED_FRAMES = [
  {
    id: "desktop",
    name: "Desktop",
    width: 1_440,
    height: 900,
  },
  {
    id: "details-desktop",
    name: "Details desktop",
    width: 1_440,
    height: 900,
  },
  {
    id: "details-mobile",
    name: "Details mobile",
    width: 390,
    height: 844,
  },
  {
    id: "home-desktop",
    name: "Home desktop",
    width: 1_440,
    height: 900,
  },
  {
    id: "home-mobile",
    name: "Home mobile",
    width: 390,
    height: 844,
  },
  {
    id: "mobile",
    name: "Mobile",
    width: 390,
    height: 844,
  },
] satisfies RenderFrameSpec[];

function validationTask(): GenerationTask {
  return {
    ...normalizeGenerationTaskIntent({
      id: TASK_ID,
      ordinal: 2,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      kind: "prototype-validation",
      target: { type: "workspace", workspaceId: WORKSPACE_ID, id: WORKSPACE_ID },
      dependencyIds: ["task-home", "task-details"],
      payload: {
        version: 1,
        prototypeIntents: [],
        responsiveFrames: structuredClone(PLANNED_FRAMES),
        artifactIds: ["page-details", "page-home"],
      },
      capabilities: [],
      qaProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 1,
        maxRepairRounds: 0,
        maxOutputBytes: 8_000_000,
        capacityClasses: ["render-qa"],
      },
    }),
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
    createdAt: 1_000,
    finishedAt: null,
  };
}

function validationAttempt(task: GenerationTask): GenerationTaskAttempt {
  return {
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    attempt: 1,
    target: task.target,
    baseRevisionId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    expectedSnapshotId: SNAPSHOT_ID,
    contextPackId: null,
    kernelRevisionId: KERNEL_REVISION_ID,
    payload: task.payload,
    dependencyOutputs: [
      {
        ordinal: 0,
        taskId: "task-home",
        resultRevisionId: "revision-home",
        resultResourceRevisionId: null,
        resultSnapshotId: "snapshot-after-home",
      },
      {
        ordinal: 1,
        taskId: "task-details",
        resultRevisionId: "revision-details",
        resultResourceRevisionId: null,
        resultSnapshotId: SNAPSHOT_ID,
      },
    ],
    resourcePins: [],
    componentPins: [],
    inputHash: "prototype-frame-validation-input-hash",
    retryContextPolicy: "same-context",
    executionMode: "full",
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
    lease: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    createdAt: 10_000,
    startedAt: 10_001,
    finishedAt: null,
  };
}

function artifactRevision(input: {
  artifactId: "page-home" | "page-details";
  revisionId: "revision-home" | "revision-details";
  frames: RenderFrameSpec[];
}): ArtifactRevisionRecord {
  const suffix = input.artifactId === "page-home" ? "home" : "details";
  return {
    id: input.revisionId,
    workspaceId: WORKSPACE_ID,
    artifactId: input.artifactId,
    trackId: `track-${suffix}`,
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    artifactRoot: `artifacts/${input.artifactId}`,
    kernelRevisionId: KERNEL_REVISION_ID,
    renderSpec: { frames: structuredClone(input.frames) },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: `context-${suffix}`,
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 20_000,
  };
}

function snapshot(): WorkspaceSnapshotRecord {
  return {
    id: SNAPSHOT_ID,
    workspaceId: WORKSPACE_ID,
    sequence: 3,
    parentSnapshotId: "snapshot-before-validation",
    graphRevision: 2,
    kernelRevisionId: KERNEL_REVISION_ID,
    reason: "artifact-published",
    provenance: {
      kind: "artifact-publication",
      revisionId: "revision-details",
      planId: PLAN_ID,
      taskId: "task-details",
    },
    createdByRunId: null,
    createdAt: 30_000,
    graph: {
      workspaceId: WORKSPACE_ID,
      revision: 2,
      nodes: [
        {
          id: "node-home",
          workspaceId: WORKSPACE_ID,
          kind: "page",
          name: "Home",
          artifactId: "page-home",
        },
        {
          id: "node-details",
          workspaceId: WORKSPACE_ID,
          kind: "page",
          name: "Details",
          artifactId: "page-details",
        },
      ],
      edges: [],
    },
    artifactTracks: {
      "page-home": "track-home",
      "page-details": "track-details",
    },
    artifactRevisions: {
      "page-home": "revision-home",
      "page-details": "revision-details",
    },
    resourceRevisions: {},
  };
}

function revisions(): ArtifactRevisionRecord[] {
  return [
    artifactRevision({
      artifactId: "page-home",
      revisionId: "revision-home",
      frames: PLANNED_FRAMES.filter((frame) => (
        frame.id === "desktop" || frame.id === "mobile" || frame.id.startsWith("home-")
      )),
    }),
    artifactRevision({
      artifactId: "page-details",
      revisionId: "revision-details",
      frames: PLANNED_FRAMES.filter((frame) => (
        frame.id === "desktop" || frame.id === "mobile" || frame.id.startsWith("details-")
      )),
    }),
  ];
}

function buildValidationResult(
  artifactRevisions = revisions(),
  task = validationTask(),
) {
  return buildGenerationTaskPrototypeValidationResult({
    task,
    attempt: validationAttempt(task),
    snapshot: snapshot(),
    artifactRevisions,
    resourceRevisions: [],
  });
}

test("v1 prototype validation accepts exact subsets whose union covers the global Frame plan", () => {
  const result = buildValidationResult();

  assert.deepEqual(result.evidence.artifacts, [
    {
      artifactId: "page-details",
      revisionId: "revision-details",
      trackId: "track-details",
      frameIds: ["desktop", "details-desktop", "details-mobile", "mobile"],
    },
    {
      artifactId: "page-home",
      revisionId: "revision-home",
      trackId: "track-home",
      frameIds: ["desktop", "home-desktop", "home-mobile", "mobile"],
    },
  ]);
  assert.deepEqual(result.evidence.frames, PLANNED_FRAMES);
});

test("v1 prototype validation rejects a missing globally planned Frame", () => {
  const artifactRevisions = revisions();
  const details = artifactRevisions.find((revision) => revision.artifactId === "page-details");
  assert.ok(details);
  assert.ok(Array.isArray(details.renderSpec.frames));
  details.renderSpec.frames = details.renderSpec.frames.filter((frame) => frame.id !== "details-desktop");

  assert.throws(
    () => buildValidationResult(artifactRevisions),
    /Frame union diverges from the immutable validation plan/,
  );
});

test("v1 prototype validation rejects a Frame absent from the global plan", () => {
  const artifactRevisions = revisions();
  const home = artifactRevisions.find((revision) => revision.artifactId === "page-home");
  assert.ok(home);
  assert.ok(Array.isArray(home.renderSpec.frames));
  home.renderSpec.frames.push({
    id: "home-tablet-unplanned",
    name: "Home tablet",
    width: 768,
    height: 1_024,
  });

  assert.throws(
    () => buildValidationResult(artifactRevisions),
    /Frame home-tablet-unplanned is absent from the immutable validation plan/,
  );
});

test("v1 prototype validation rejects planned Frame object drift", () => {
  const artifactRevisions = revisions();
  const home = artifactRevisions.find((revision) => revision.artifactId === "page-home");
  assert.ok(home);
  assert.ok(Array.isArray(home.renderSpec.frames));
  const plannedHomeFrame = home.renderSpec.frames.findIndex((frame) => frame.id === "home-desktop");
  assert.notEqual(plannedHomeFrame, -1);
  home.renderSpec.frames[plannedHomeFrame] = {
    ...home.renderSpec.frames[plannedHomeFrame]!,
    name: "Drifted Home desktop",
  };

  assert.throws(
    () => buildValidationResult(artifactRevisions),
    /Frame home-desktop is not the immutable planned Frame/,
  );
});

test("v1 prototype validation rejects duplicate Frame ids within one Revision", () => {
  const artifactRevisions = revisions();
  const home = artifactRevisions.find((revision) => revision.artifactId === "page-home");
  assert.ok(home);
  assert.ok(Array.isArray(home.renderSpec.frames));
  const homeFrame = home.renderSpec.frames.find((frame) => frame.id === "home-desktop");
  assert.ok(homeFrame);
  home.renderSpec.frames.push(structuredClone(homeFrame));

  assert.throws(
    () => buildValidationResult(artifactRevisions),
    /Revision revision-home has duplicate Frame home-desktop/,
  );
});

test("v1 prototype validation rejects duplicate ids in the global Frame plan", () => {
  const task = validationTask();
  const payload = task.payload as { responsiveFrames: RenderFrameSpec[] };
  payload.responsiveFrames.push(structuredClone(payload.responsiveFrames[0]!));

  assert.throws(
    () => buildValidationResult(revisions(), task),
    /Prototype validation Frame ids must be unique/,
  );
});
