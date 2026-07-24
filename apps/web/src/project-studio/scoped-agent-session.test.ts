import { beforeEach, expect, test } from "vitest";

import {
  emptyAgentSession,
  readAgentSession,
  writeAgentSession,
  type AgentSession,
} from "./scoped-agent-session.ts";

const TURN_ID = "turn-12345678-1234-4123-8123-123456789abc";

beforeEach(() => {
  localStorage.clear();
});

test("round-trips a scope-owned draft, immutable context, transcript, outbox, and receipt", () => {
  const session: AgentSession = {
    draft: "Refine the checkout hierarchy",
    contextItems: [{
      id: "artifact:checkout:revision-7",
      type: "context-ref",
      title: "Checkout",
      subtitle: "Page Revision",
      ref: { kind: "artifact", id: "artifact-checkout", revisionId: "revision-7" },
      projectId: "project-1",
      artifactId: "artifact-checkout",
      revisionId: "revision-7",
    }],
    transcript: [{
      id: `user:${TURN_ID}`,
      turnId: TURN_ID,
      role: "user",
      content: "Refine the checkout hierarchy",
      createdAt: 7,
      state: "submitted",
    }],
    outbox: {
      kind: "scoped",
      scopeType: "resource",
      targetId: "resource-research",
      turnId: TURN_ID,
      fingerprint: "exact-request-fingerprint",
      createdAt: 7,
      request: {
        turnId: TURN_ID,
        intent: "edit",
        message: "Refine the checkout hierarchy",
        agentCommand: "codebuddy",
        model: "hunyuan",
        explicitContext: [{ kind: "artifact", id: "artifact-checkout", revisionId: "revision-7" }],
        graphRevision: 4,
        baseRevisionId: "resource-revision-3",
        selection: [],
      },
    },
    receipt: {
      kind: "scoped",
      turnId: TURN_ID,
      receipt: {
        contextPackId: `context-pack-${"a".repeat(64)}`,
        task: {
          id: "task-resource-research",
          ordinal: 0,
          workspaceId: "workspace-1",
          planId: "plan-resource-research",
          kind: "resource",
          target: { type: "resource", workspaceId: "workspace-1", id: "resource-research" },
          dependencyIds: [],
          capabilities: [],
          status: "queued",
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
          createdAt: 8,
          finishedAt: null,
        },
      },
      createdAt: 8,
    },
  };

  writeAgentSession("project-1", "resource:resource-research", session);

  expect(readAgentSession("project-1", "resource:resource-research")).toEqual(session);
  expect(readAgentSession("project-1", "artifact:artifact-checkout")).toEqual(emptyAgentSession());
});

test("rejects malformed daemon identities instead of replaying an untrusted outbox", () => {
  localStorage.setItem(
    "dezin.project-studio.agent.v1:project-1:workspace",
    JSON.stringify({
      version: 1,
      projectId: "project-1",
      scopeKey: "workspace",
      draft: "Safe draft survives",
      contextItems: [{
        id: "bad-context",
        type: "context-ref",
        title: "Unversioned artifact",
        ref: { kind: "artifact", id: "artifact-1" },
      }],
      transcript: [{
        id: "bad-turn",
        turnId: "turn-not-canonical",
        role: "user",
        content: "Do not replay",
        createdAt: 1,
        state: "submitted",
      }],
      outbox: {
        kind: "workspace",
        turnId: "turn-not-canonical",
        fingerprint: "bad",
        createdAt: 1,
        request: {
          turnId: "turn-not-canonical",
          message: "Do not replay",
          explicitContext: [],
          graphRevision: 1,
        },
      },
      receipt: null,
    }),
  );

  expect(readAgentSession("project-1", "workspace")).toEqual({
    draft: "Safe draft survives",
    contextItems: [],
    transcript: [],
    outbox: null,
    receipt: null,
  });
});

test("does not restore data whose persisted project or scope identity was changed", () => {
  localStorage.setItem(
    "dezin.project-studio.agent.v1:project-1:artifact%3Aartifact-1",
    JSON.stringify({
      version: 1,
      projectId: "project-other",
      scopeKey: "artifact:artifact-1",
      draft: "Wrong project",
    }),
  );

  expect(readAgentSession("project-1", "artifact:artifact-1")).toEqual(emptyAgentSession());
});

test("does not restore an outbox or receipt owned by another Agent scope", () => {
  const resourceSession: AgentSession = {
    draft: "Keep this artifact draft",
    contextItems: [],
    transcript: [],
    outbox: {
      kind: "scoped",
      scopeType: "resource",
      targetId: "resource-other",
      turnId: TURN_ID,
      fingerprint: "resource-request",
      createdAt: 1,
      request: {
        turnId: TURN_ID,
        intent: "edit",
        message: "Mutate another scope",
        explicitContext: [],
        graphRevision: 1,
        baseRevisionId: "resource-revision-1",
      },
    },
    receipt: {
      kind: "scoped",
      turnId: TURN_ID,
      createdAt: 2,
      receipt: {
        contextPackId: `context-pack-${"b".repeat(64)}`,
        task: {
          id: "task-resource-other",
          ordinal: 0,
          workspaceId: "workspace-1",
          planId: "plan-resource-other",
          kind: "resource",
          target: { type: "resource", workspaceId: "workspace-1", id: "resource-other" },
          dependencyIds: [],
          capabilities: [],
          status: "queued",
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
          createdAt: 2,
          finishedAt: null,
        },
      },
    },
  };

  writeAgentSession("project-1", "artifact:artifact-1", resourceSession);

  expect(readAgentSession("project-1", "artifact:artifact-1")).toEqual({
    ...emptyAgentSession(),
    draft: "Keep this artifact draft",
  });
});

test("does not persist presentation-only preview URLs from writable browser state", () => {
  writeAgentSession("project-1", "workspace", {
    ...emptyAgentSession(),
    contextItems: [{
      id: "resource:file-1:revision-1",
      type: "context-ref",
      title: "Reference image",
      ref: { kind: "resource", id: "file-1", resourceKind: "file", revisionId: "revision-1" },
      previewUrl: "https://tracking.invalid/pixel.png",
      projectId: "project-1",
      revisionId: "revision-1",
    }],
  });

  expect(localStorage.getItem("dezin.project-studio.agent.v1:project-1:workspace"))
    .not.toContain("tracking.invalid");
  expect(readAgentSession("project-1", "workspace").contextItems[0]).not.toHaveProperty("previewUrl");
});

test("rejects a structurally malformed scoped receipt even when its outer scope matches", () => {
  const key = "dezin.project-studio.agent.v1:project-1:artifact%3Aartifact-1";
  localStorage.setItem(key, JSON.stringify({
    version: 1,
    projectId: "project-1",
    scopeKey: "artifact:artifact-1",
    draft: "Keep the draft",
    contextItems: [],
    transcript: [],
    outbox: null,
    receipt: {
      kind: "scoped",
      turnId: TURN_ID,
      createdAt: 2,
      receipt: {
        contextPackId: "context-pack-1",
        task: {
          id: "task-1",
          ordinal: 0,
          workspaceId: "workspace-1",
          planId: "plan-1",
          kind: "page",
          target: { type: "artifact", workspaceId: "workspace-1", id: "artifact-1", trackId: "track-1" },
          dependencyIds: [],
          capabilities: [],
          status: "pretend-success",
          currentAttempt: "zero",
        },
      },
    },
  }));

  expect(readAgentSession("project-1", "artifact:artifact-1")).toEqual({
    ...emptyAgentSession(),
    draft: "Keep the draft",
  });
});
