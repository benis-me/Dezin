import { expect, test } from "vitest";

import {
  activeAgentActivityPhase,
  buildAgentTranscriptPage,
  groupMainAgentJobs,
} from "./agent-panel-model.ts";
import type { DesignJob, DesignThread } from "./types.ts";

const RESERVED_REPLY = "Main Agent orchestration is queued. The final result will replace this status.";

function job(overrides: Partial<DesignJob> = {}): DesignJob {
  return {
    schemaVersion: 2,
    id: "job-1",
    kind: "main-agent",
    runnerId: "fixture",
    model: null,
    status: "running",
    nodeId: null,
    parentJobId: null,
    contextHash: "context",
    canvasRevision: 1,
    expectedHeadVersionId: null,
    versionId: null,
    exportId: null,
    error: null,
    cancelRequested: false,
    activity: [],
    createdAt: 100,
    updatedAt: 100,
    finishedAt: null,
    ...overrides,
  };
}

function mainThread(messages: DesignThread["messages"] = []): DesignThread {
  return {
    schemaVersion: 2,
    id: "thread-main",
    scope: { type: "main" },
    messages,
    createdAt: 1,
    updatedAt: messages.at(-1)?.createdAt ?? 1,
  };
}

test("main Agent grouping keeps delegated work but omits completed conversation-only turns", () => {
  const conversation = job({
    id: "conversation",
    status: "ready",
    conversationOnly: true,
    finishedAt: 120,
  });
  const parent = job({ id: "parent" });
  const child = job({
    id: "child",
    kind: "node-generation",
    nodeId: "node-1",
    parentJobId: parent.id,
  });
  const orphan = job({
    id: "orphan",
    kind: "node-analysis",
    nodeId: "node-2",
    parentJobId: "missing-parent",
  });
  const thread = mainThread([{
    id: "conversation-reply",
    role: "assistant",
    content: "Done",
    jobId: conversation.id,
    createdAt: 120,
  }]);

  expect(groupMainAgentJobs([conversation, parent, child, orphan], thread)).toEqual([
    expect.objectContaining({ parentJobId: parent.id, jobs: [parent, child] }),
    expect.objectContaining({ parentJobId: "missing-parent", jobs: [orphan] }),
  ]);
});

test("transcript timeline keeps Prompt before execution before Response and replaces an unrepresented queued reply with Thinking", () => {
  const parent = job({ id: "parent", createdAt: 100 });
  const thread = mainThread([
    { id: "prompt-1", role: "user", content: "Build it", jobId: parent.id, createdAt: 100 },
    { id: "reply-1", role: "assistant", content: "Complete", jobId: parent.id, createdAt: 100 },
    { id: "prompt-2", role: "user", content: "Polish it", jobId: "queued-only", createdAt: 200 },
    { id: "queued-reply", role: "assistant", content: RESERVED_REPLY, jobId: "queued-only", createdAt: 201 },
  ]);
  const groups = groupMainAgentJobs([parent], thread);

  const page = buildAgentTranscriptPage({
    scopeKey: "main",
    scopeType: "main",
    thread,
    optimisticUserTurn: null,
    relatedJobs: [parent],
    mainJobGroups: groups,
    historyPages: 1,
  });

  expect(page.timeline.map((item) => `${item.kind}:${item.id}`)).toEqual([
    "message:message:prompt-1",
    "main-job-group:main-job-group:parent",
    "message:message:reply-1",
    "message:message:prompt-2",
    "thinking:thinking:queued-reply",
  ]);
  expect(page.presentableMessages.map((message) => message.id)).toEqual([
    "prompt-1",
    "reply-1",
    "prompt-2",
  ]);
  expect(page.reservedMainReplies).toHaveLength(1);
});

test("a fresh Node turn hides its reserved assistant marker and shows only Prompt then Job Thinking", () => {
  const nodeJob = job({
    id: "node-job",
    kind: "node-generation",
    nodeId: "node-1",
    parentJobId: null,
  });
  const thread: DesignThread = {
    schemaVersion: 2,
    id: "thread-node-1",
    scope: { type: "node", nodeId: "node-1" },
    messages: [
      { id: "node-prompt", role: "user", content: "Generate it", jobId: nodeJob.id, createdAt: 100 },
      { id: "node-reserved", role: "assistant", content: RESERVED_REPLY, jobId: nodeJob.id, createdAt: 100 },
    ],
    createdAt: 100,
    updatedAt: 100,
  };

  const page = buildAgentTranscriptPage({
    scopeKey: "node:node-1",
    scopeType: "node",
    thread,
    optimisticUserTurn: null,
    relatedJobs: [nodeJob],
    mainJobGroups: [],
    historyPages: 1,
  });

  expect(page.presentableMessages.map((message) => message.id)).toEqual(["node-prompt"]);
  expect(page.timeline.map((item) => `${item.kind}:${item.id}`)).toEqual([
    "message:message:node-prompt",
    "node-job:node-job:node-job",
  ]);
});

test("only the latest live activity owns the active phase and terminal Jobs own none", () => {
  const live = job();
  expect(activeAgentActivityPhase(live)).toBe("reasoning");
  expect(activeAgentActivityPhase({
    ...live,
    activity: [{ id: "tool", kind: "tool", text: "Updated the file", createdAt: 101 }],
  })).toBe("progress");
  expect(activeAgentActivityPhase({
    ...live,
    activity: [{ id: "search", kind: "text", text: "Searching the web for references", createdAt: 102 }],
  })).toBe("search");
  expect(activeAgentActivityPhase({
    ...live,
    activity: [{ id: "image", kind: "text", text: "Generating an image", createdAt: 103 }],
  })).toBe("image");
  expect(activeAgentActivityPhase({
    ...live,
    activity: [{ id: "reason", kind: "text", text: "Refining the hierarchy", createdAt: 104 }],
  })).toBe("reasoning");
  expect(activeAgentActivityPhase({ ...live, status: "ready", finishedAt: 110 })).toBeNull();
});
