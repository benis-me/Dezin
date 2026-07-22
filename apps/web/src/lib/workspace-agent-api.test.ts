import { expect, test, vi } from "vitest";

import {
  createApiClient,
  type FetchLike,
  type GenerationTask,
  type ScopedAgentTurnReceipt,
  type WorkspaceProposal,
} from "./api.ts";

function proposal(): WorkspaceProposal {
  return {
    id: "proposal-1",
    workspaceId: "workspace-1",
    revision: 1,
    kind: "workspace-generation",
    baseGraphRevision: 3,
    baseSnapshotId: "snapshot-1",
    baseGraph: { workspaceId: "workspace-1", revision: 3, nodes: [], edges: [] },
    layoutId: "default",
    baseLayoutChecksum: "layout-1",
    baseLayout: {
      workspaceId: "workspace-1",
      layoutId: "default",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-1",
    },
    status: "draft",
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
    rationale: "Agent-planned workspace",
    assumptions: [],
    review: { kind: "none" },
    createdByRunId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("Workspace Agent API posts only caller context and forwards cancellation", async () => {
  const expected = proposal();
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify(expected), {
    status: 201,
    headers: { "content-type": "application/json" },
  }));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();
  const input = {
    turnId: "turn-00000000-0000-4000-8000-000000000041",
    message: "Plan a checkout flow",
    explicitContext: [],
    graphRevision: 3,
    selection: [{ kind: "node" as const, id: "node-1" }],
  };

  await expect(api.workspaceAgentTurn("project /1", input, controller.signal)).resolves.toEqual(expected);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://daemon/api/projects/project%20%2F1/workspace/agent/turns",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
      signal: controller.signal,
    }),
  );
});

function scopedReceipt(type: "artifact" | "resource"): ScopedAgentTurnReceipt {
  return {
    task: {
      id: `task-${type}`,
      ordinal: 0,
      workspaceId: "workspace-1",
      planId: `plan-${type}`,
      kind: type === "artifact" ? "page" : "resource",
      target: type === "artifact"
        ? { type, workspaceId: "workspace-1", id: "target /1", trackId: "track-main" }
        : { type, workspaceId: "workspace-1", id: "target /1" },
      dependencyIds: [],
      capabilities: [],
      status: "materialization-pending",
      blockedReason: null,
      blockedByTaskId: null,
      pendingContextPolicy: null,
      currentAttempt: 0,
      materializationFailures: 0,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: null,
      createdAt: 1,
      finishedAt: null,
    } satisfies GenerationTask,
    contextPackId: `context-pack-${"c".repeat(64)}`,
  };
}

test("scoped Agent APIs keep target ownership in encoded Artifact and Resource paths", async () => {
  const receipts = [scopedReceipt("artifact"), scopedReceipt("resource")];
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(JSON.stringify(receipts.shift()), {
    status: 202,
    headers: { "content-type": "application/json" },
  }));
  const api = createApiClient({ baseUrl: "http://daemon", fetchImpl });
  const controller = new AbortController();
  const input = {
    turnId: "turn-00000000-0000-4000-8000-000000000000",
    intent: "edit" as const,
    message: "Refine the exact target",
    explicitContext: [],
    graphRevision: 8,
    baseRevisionId: "revision-1",
    selection: [{ kind: "element" as const, id: "hero-cta", revisionId: "revision-1" }],
  };

  await expect(api.artifactAgentTurn("project /1", "target /1", input, controller.signal))
    .resolves.toMatchObject({ task: { planId: "plan-artifact" } });
  await expect(api.resourceAgentTurn("project /1", "target /1", input, controller.signal))
    .resolves.toMatchObject({ task: { planId: "plan-resource" } });
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://daemon/api/projects/project%20%2F1/artifacts/target%20%2F1/agent/turns",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input), signal: controller.signal }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://daemon/api/projects/project%20%2F1/resources/target%20%2F1/agent/turns",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input), signal: controller.signal }),
  );
});
