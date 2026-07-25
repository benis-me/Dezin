import { describe, expect, test } from "vitest";
import type {
  GenerationPlanDetail,
  GenerationTask,
  GenerationTaskStatus,
} from "../../lib/api.ts";
import {
  buildGenerationTargetStates,
  generationPlanResultKey,
} from "./generation-target-state.ts";

function task(
  id: string,
  status: GenerationTaskStatus,
  target: GenerationTask["target"],
  overrides: Partial<GenerationTask> = {},
): GenerationTask {
  return {
    id,
    ordinal: 1,
    workspaceId: "workspace-1",
    planId: "plan-1",
    kind: target.type === "resource" ? "resource" : "page",
    target,
    dependencyIds: [],
    capabilities: [],
    status,
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
    createdAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

function detail(tasks: GenerationTask[]): GenerationPlanDetail {
  return {
    plan: {
      id: "plan-1",
      workspaceId: "workspace-1",
      proposalId: "proposal-1",
      proposalRevision: 1,
      baseSnapshotId: "snapshot-1",
      status: "failed",
      compileError: null,
      createdAt: 1,
      finishedAt: 2,
    },
    tasks,
    dependencies: [],
    currentAttempts: [],
  };
}

describe("generation target state projection", () => {
  test.each([
    ["materialization-pending", "queued"],
    ["retry-wait", "queued"],
    ["queued", "queued"],
    ["running", "running"],
    ["candidate-ready", "running"],
    ["needs-rebase", "running"],
    ["awaiting-context-refresh", "running"],
    ["cancel-requested", "running"],
    ["succeeded", "complete"],
    ["failed", "failed"],
    ["blocked-context", "blocked"],
    ["blocked", "blocked"],
    ["cancelled", "cancelled"],
  ] as const)("maps %s to %s", (status, expected) => {
    const states = buildGenerationTargetStates(detail([
      task("task-1", status, {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-1",
        trackId: "track-1",
      }),
    ]));

    expect(states.artifacts["artifact-1"]).toMatchObject({
      state: expected,
      planId: "plan-1",
      taskId: "task-1",
    });
  });

  test("projects direct artifact and resource failures with public, actionable messages", () => {
    const states = buildGenerationTargetStates(detail([
      task("page-task", "failed", {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-page",
      }, {
        error: {
          message: "Agent failed while reading /Users/ben/Projects/dezin/.dezin/data/private-output.json.",
        },
      }),
      task("research-task", "blocked", {
        type: "resource",
        workspaceId: "workspace-1",
        id: "research-1",
      }, {
        kind: "resource",
        blockedReason: "Blocked by failed prerequisite /private/tmp/dezin/Session-Metadata.json",
      }),
    ]));

    expect(states.artifacts["artifact-page"]?.message).toBe(
      "Agent failed while reading private-output.json.",
    );
    expect(states.resources["research-1"]?.message).toBe(
      "Blocked by failed prerequisite Session-Metadata.json",
    );
  });

  test("ignores checkpoint and propagation tasks so they cannot replace the direct target status", () => {
    const artifactTarget = {
      type: "artifact" as const,
      workspaceId: "workspace-1",
      id: "artifact-1",
      trackId: "track-1",
    };
    const states = buildGenerationTargetStates(detail([
      task("page-task", "running", artifactTarget, { ordinal: 2, kind: "page" }),
      task("checkpoint-task", "failed", artifactTarget, {
        ordinal: 9,
        kind: "checkpoint",
        error: { message: "Checkpoint publication failed" },
      }),
    ]));

    expect(states.artifacts["artifact-1"]).toMatchObject({
      state: "running",
      taskId: "page-task",
    });
  });

  test("returns stable empty maps when no build plan has been observed", () => {
    expect(buildGenerationTargetStates(null)).toEqual({
      artifacts: {},
      resources: {},
    });
  });

  test("keys only published Task results so background reconciliation is idempotent", () => {
    expect(generationPlanResultKey(detail([
      task("page-task", "running", {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-page",
      }),
    ]))).toBeNull();

    expect(generationPlanResultKey(detail([
      task("page-task", "succeeded", {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-page",
      }, {
        resultRevisionId: "revision-1",
        resultSnapshotId: "snapshot-2",
      }),
    ]))).toBe("plan-1:page-task:revision-1::snapshot-2");
  });
});
