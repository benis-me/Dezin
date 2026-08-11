import { expect, test } from "vitest";

import {
  AGENT_OUTPUT_BLOCK_TYPES,
  activeAgentActivityPhase,
  buildAgentOutputModel,
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

test("Agent output blocks aggregate by activity type and retain first-activity order", () => {
  const model = buildAgentOutputModel(job({
    activity: [
      { id: "tool-1", kind: "tool", text: "Opened the source", createdAt: 130 },
      { id: "reason-1", kind: "text", text: "Inspecting the hierarchy", createdAt: 110 },
      { id: "search-1", kind: "text", text: "Searching the web for typography", createdAt: 120 },
      { id: "reason-2", kind: "text", text: "Refining the layout", createdAt: 140 },
      { id: "tool-2", kind: "status", text: "Validated the result", createdAt: 150 },
    ],
  }));

  expect(model.activePhase).toBe("progress");
  expect(model.blocks.map((block) => [block.type, block.active])).toEqual([
    ["trace", false],
    ["search", false],
    ["tool-group", true],
  ]);
  expect(model.blocks[0]).toMatchObject({
    type: "trace",
    items: [{ id: "reason-1" }, { id: "reason-2" }],
  });
  expect(model.blocks[2]).toMatchObject({
    type: "tool-group",
    items: [{ id: "tool-1" }, { id: "tool-2" }],
  });
});

test("terminal Agent output exposes outcome and export metadata with zero active blocks", () => {
  const model = buildAgentOutputModel(job({
    kind: "implementation-export",
    status: "ready",
    exportId: "export-1",
    activity: [{ id: "reason", kind: "text", text: "Packaging the app", createdAt: 120 }],
    updatedAt: 180,
    finishedAt: 180,
  }));

  expect(model.activePhase).toBeNull();
  expect(model.blocks.some((block) => block.active)).toBe(false);
  expect(model.blocks.map((block) => block.type)).toEqual(["trace", "outcome", "export"]);
  expect(model.blocks[1]).toEqual({
    type: "outcome",
    id: "job-1:outcome",
    createdAt: 180,
    active: false,
    phase: null,
    status: "ready",
    label: "Complete",
    durationMs: 80,
    versionId: null,
  });
  expect(model.blocks[2]).toMatchObject({
    type: "export",
    exportId: "export-1",
    status: "ready",
    active: false,
  });
});

test("failed Agent output exposes explicit error metadata instead of an active phase", () => {
  const model = buildAgentOutputModel(job({
    kind: "node-generation",
    nodeId: "node-1",
    status: "failed",
    error: "Generated HTML contains an unpinned or external URL",
    activity: [{ id: "validate", kind: "status", text: "Validating the result", createdAt: 130 }],
    updatedAt: 170,
    finishedAt: 170,
  }));

  expect(model.activePhase).toBeNull();
  expect(model.blocks.map((block) => block.type)).toEqual(["tool-group", "error"]);
  expect(model.blocks.at(-1)).toEqual({
    type: "error",
    id: "job-1:error",
    createdAt: 170,
    active: false,
    phase: null,
    status: "failed",
    message: "Generated HTML contains an unpinned or external URL",
    durationMs: 70,
  });
});

test("an activity-free live Job has one active trace placeholder", () => {
  const model = buildAgentOutputModel(job({ activity: [] }));

  expect(model.activePhase).toBe("reasoning");
  expect(model.blocks).toEqual([{
    type: "trace",
    id: "job-1:reasoning",
    createdAt: 100,
    active: true,
    phase: "reasoning",
    items: [],
  }]);
});

test("the output registry stays closed and never guesses rich blocks from markdown", () => {
  const model = buildAgentOutputModel(job({
    activity: [{
      id: "markdown",
      kind: "text",
      text: "Approval required\n\n| Metric | Value |\n| --- | --- |\n| Insight | Strong hierarchy |",
      createdAt: 110,
    }],
  }));

  expect(AGENT_OUTPUT_BLOCK_TYPES).toEqual([
    "trace",
    "tool-group",
    "search",
    "image",
    "outcome",
    "error",
    "export",
  ]);
  expect(model.blocks.map((block) => block.type)).toEqual(["trace"]);
  expect(model.blocks[0]).toMatchObject({
    type: "trace",
    items: [{ id: "markdown" }],
  });
});

test("the normalized model assigns activePhase to the chronologically latest activity", () => {
  const model = buildAgentOutputModel(job({
    activity: [
      { id: "new-tool", kind: "tool", text: "Published the artifact", createdAt: 200 },
      { id: "old-reasoning", kind: "text", text: "Earlier reasoning", createdAt: 110 },
    ],
  }));

  expect(model.activePhase).toBe("progress");
  expect(model.blocks.map((block) => [block.type, block.active])).toEqual([
    ["trace", false],
    ["tool-group", true],
  ]);
});

test("search and image blocks retain renderer-ready metadata while aggregating repeated activity", () => {
  const model = buildAgentOutputModel(job({
    activity: [
      {
        id: "image-1",
        kind: "text",
        text: "Generating an image “Tokyo at dusk”",
        createdAt: 110,
      },
      {
        id: "search-1",
        kind: "text",
        text: "Searched the web for references https://example.com/type",
        createdAt: 120,
      },
      {
        id: "image-2",
        kind: "text",
        text: "Rendering an image “Tokyo after rain”",
        createdAt: 130,
      },
    ],
  }));

  expect(model.blocks.map((block) => block.type)).toEqual(["image", "search"]);
  expect(model.blocks[0]).toMatchObject({
    type: "image",
    prompt: "Tokyo after rain",
    active: true,
    items: [{ id: "image-1" }, { id: "image-2" }],
  });
  expect(model.blocks[1]).toMatchObject({
    type: "search",
    active: false,
    results: [{ id: "search-1", href: "https://example.com/type", state: "done" }],
  });
});
