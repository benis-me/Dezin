import assert from "node:assert/strict";
import test from "node:test";

import {
  createStoreBackedMoodboardAttemptContextAuthority,
} from "../src/orchestration/moodboard-attempt-context-authority.ts";

const HASH = "a".repeat(64);

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 2,
    inputHash: "b".repeat(64),
    contextPackId: `context-pack-${HASH}`,
    target: {
      type: "resource",
      workspaceId: "workspace-1",
      id: "resource-1",
    },
    ...overrides,
  };
}

test("resolves a Moodboard scan Context Pack only from the exact durable Attempt", () => {
  const calls: unknown[][] = [];
  const authority = createStoreBackedMoodboardAttemptContextAuthority({
    projectCatalog: {
      listProjects: () => [{ id: "project-other" }, { id: "project-1" }],
    },
    workspaceStore: {
      getWorkspace(projectId) {
        return projectId === "project-1"
          ? { id: "workspace-1" }
          : { id: "workspace-other" };
      },
      getGenerationTaskAttemptForProject(projectId, planId, taskId, attemptNumber) {
        calls.push([projectId, planId, taskId, attemptNumber]);
        return attempt();
      },
    },
  });

  assert.deepEqual(authority.resolveMoodboardAttemptContext({
    taskId: "task-1",
    planId: "plan-1",
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    revisionId: "revision-1",
    attempt: 2,
    inputHash: "b".repeat(64),
  }), {
    contextPackId: `context-pack-${HASH}`,
    contextPackHash: HASH,
  });
  assert.deepEqual(calls, [["project-1", "plan-1", "task-1", 2]]);
});

test("restores frozen Research target semantics from the same durable Attempt payload", () => {
  const authority = createStoreBackedMoodboardAttemptContextAuthority({
    projectCatalog: { listProjects: () => [{ id: "project-1" }] },
    workspaceStore: {
      getWorkspace: () => ({ id: "workspace-1" }),
      getGenerationTaskAttemptForProject: () => attempt({
        payload: {
          version: 2,
          operation: {
            operation: "create",
            nodeId: "node-research",
            resourceId: "resource-1",
            kind: "research",
            title: "Listening Club Research",
            instructions: "Return evidence-backed directions.",
          },
          brief: {
            proposalRationale: "Ground the product direction.",
            assumptions: ["The audience values small-group listening."],
            targetInstructions: {
              operation: "create",
              kind: "research",
              title: "Listening Club Research",
              instructions: "Return evidence-backed directions.",
            },
          },
        },
      }),
    },
  });

  assert.deepEqual(authority.resolveMoodboardAttemptContext({
    taskId: "task-1",
    planId: "plan-1",
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    revisionId: "revision-1",
    attempt: 2,
    inputHash: "b".repeat(64),
  }), {
    contextPackId: `context-pack-${HASH}`,
    contextPackHash: HASH,
    researchTaskAuthority: {
      operation: "create",
      nodeId: "node-research",
      title: "Listening Club Research",
      brief: {
        proposalRationale: "Ground the product direction.",
        assumptions: ["The audience values small-group listening."],
        targetInstructions: {
          operation: "create",
          kind: "research",
          title: "Listening Club Research",
          instructions: "Return evidence-backed directions.",
        },
      },
    },
  });
});

test("rejects a durable Attempt whose immutable input or Resource target differs", () => {
  for (const patch of [
    { inputHash: "c".repeat(64) },
    { target: { type: "resource", workspaceId: "workspace-1", id: "resource-foreign" } },
    { contextPackId: `context-pack-${"d".repeat(64)}`.slice(1) },
  ]) {
    const authority = createStoreBackedMoodboardAttemptContextAuthority({
      projectCatalog: { listProjects: () => [{ id: "project-1" }] },
      workspaceStore: {
        getWorkspace: () => ({ id: "workspace-1" }),
        getGenerationTaskAttemptForProject: () => attempt(patch),
      },
    });
    assert.equal(authority.resolveMoodboardAttemptContext({
      taskId: "task-1",
      planId: "plan-1",
      workspaceId: "workspace-1",
      resourceId: "resource-1",
      revisionId: "revision-1",
      attempt: 2,
      inputHash: "b".repeat(64),
    }), null);
  }
});
