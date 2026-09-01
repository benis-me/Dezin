import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AgentInfo } from "../lib/api.ts";
import type { DesignCanvasApi } from "./api.ts";
import type { DesignInvalidationMessage, DesignJob, DesignNode, DesignThread, DesignThreadScope } from "./types.ts";
import {
  useAgentTranscriptController,
  useCanvasAgentPanelController,
  useJobActionController,
} from "./useCanvasAgentPanelController.ts";

const PROJECT_ID = "agent-panel-project";
const AGENT: AgentInfo = {
  id: "claude",
  command: "claude",
  available: true,
  availability: "ready",
  models: ["sonnet"],
};

function thread(scope: DesignThreadScope, messages: DesignThread["messages"] = []): DesignThread {
  return {
    schemaVersion: 2,
    id: scope.type === "main" ? "thread-main" : `thread-${scope.nodeId}`,
    scope,
    messages,
    createdAt: 1,
    updatedAt: messages.at(-1)?.createdAt ?? 1,
  };
}

function contextNode(id: string): DesignNode {
  return {
    id,
    kind: "page",
    name: id,
    geometry: { x: 0, y: 0, width: 320, height: 240 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function panelOptions({
  api,
  scope = { type: "main" },
  jobs = [],
  onSubmit = vi.fn(async () => {}),
}: {
  api: DesignCanvasApi;
  scope?: DesignThreadScope;
  jobs?: readonly DesignJob[];
  onSubmit?: (prompt: string, nodeIds: readonly string[], selection: { agentCommand?: string; model?: string | null }) => Promise<void>;
}) {
  return {
    projectId: PROJECT_ID,
    api,
    scope,
    nodes: [],
    jobs,
    versions: [],
    agents: [AGENT],
    initialAgentCommand: AGENT.command,
    initialModel: "",
    onSubmit,
    onAttachFiles: vi.fn(async () => {}),
    onRescanAgents: vi.fn(async () => {}),
  };
}

test("panel controller publishes an optimistic Prompt immediately and reconciles it with the canonical thread", async () => {
  const initial = thread({ type: "main" });
  const canonical = thread({ type: "main" }, [{
    id: "message-user",
    role: "user",
    content: "Build the launch page",
    jobId: "job-new",
    createdAt: 10,
  }]);
  const getThread = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(canonical);
  let finishSubmit!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
    finishSubmit = resolve;
  }));
  const api = { getThread } as unknown as DesignCanvasApi;
  const { result } = renderHook(() => useCanvasAgentPanelController({
    ...panelOptions({ api, onSubmit }),
    agentSelection: { agentCommand: "claude", model: "claude-opus-5[1m]" },
  }));

  await waitFor(() => expect(result.current.thread).toEqual(initial));
  act(() => result.current.setDraft("Build the launch page"));
  act(() => {
    void result.current.submit();
    void result.current.submit();
  });

  expect(result.current.visibleOptimisticUserTurn?.message.content).toBe("Build the launch page");
  expect(result.current.submitting).toBe(true);
  expect(result.current.draft).toBe("");
  expect(onSubmit).toHaveBeenCalledWith("Build the launch page", [], {
    agentCommand: "claude",
    model: null,
  });

  act(() => result.current.setDraft("Review the copy next"));
  await act(async () => finishSubmit());
  await waitFor(() => expect(result.current.thread).toEqual(canonical));
  expect(result.current.visibleOptimisticUserTurn).toBeNull();
  expect(result.current.draft).toBe("Review the copy next");
  expect(result.current.submitting).toBe(false);
});

test("panel controller keeps the next Prompt editable while the current scope turn is live", async () => {
  const activeJob: DesignJob = {
    schemaVersion: 2,
    id: "job-active-main",
    kind: "main-agent",
    runnerId: "claude",
    model: null,
    status: "running",
    nodeId: null,
    parentJobId: null,
    contextHash: "a".repeat(64),
    canvasRevision: 0,
    expectedHeadVersionId: null,
    versionId: null,
    exportId: null,
    error: null,
    cancelRequested: false,
    conversationOnly: false,
    activity: [],
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
  };
  const api = {
    getThread: vi.fn(async () => thread({ type: "main" })),
    // eslint-disable-next-line require-yield
    streamInvalidations: vi.fn(async function* () {}),
  } as unknown as DesignCanvasApi;
  const onSubmit = vi.fn(async () => {});
  const { result } = renderHook(() => useCanvasAgentPanelController(panelOptions({
    api,
    jobs: [activeJob],
    onSubmit,
  })));

  await waitFor(() => expect(result.current.thread).not.toBeNull());
  act(() => result.current.setDraft("Queue this as my next Prompt"));
  await act(async () => result.current.submit());

  expect(result.current.activeTurnJob).toEqual(activeJob);
  expect(result.current.draft).toBe("Queue this as my next Prompt");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("panel controller consumes each context seed once after filtering, deduplicating, and capping it", async () => {
  const nodes = Array.from({ length: 26 }, (_, index) => contextNode(`node-${index + 1}`));
  const api = {
    getThread: vi.fn(async () => thread({ type: "main" })),
    // eslint-disable-next-line require-yield
    streamInvalidations: vi.fn(async function* () {}),
  } as unknown as DesignCanvasApi;
  const initialSeed = ["missing", nodes[0]!.id, nodes[0]!.id, ...nodes.map((node) => node.id)];
  const { result, rerender } = renderHook(
    ({ generation, seed, availableNodes }: {
      generation: number;
      seed: readonly string[];
      availableNodes: readonly DesignNode[];
    }) => useCanvasAgentPanelController({
      ...panelOptions({ api }),
      nodes: availableNodes,
      initialContextNodeIds: seed,
      contextSeedGeneration: generation,
    }),
    { initialProps: { generation: 1, seed: initialSeed, availableNodes: nodes } },
  );

  expect(result.current.contextNodeIds).toEqual(nodes.slice(0, 24).map((node) => node.id));

  act(() => result.current.setContextNodeIds([nodes[1]!.id]));
  rerender({ generation: 1, seed: [nodes[25]!.id], availableNodes: [...nodes] });
  expect(result.current.contextNodeIds).toEqual([nodes[1]!.id]);

  rerender({
    generation: 2,
    seed: ["missing", nodes[25]!.id, nodes[25]!.id],
    availableNodes: [...nodes],
  });
  await waitFor(() => expect(result.current.contextNodeIds).toEqual([nodes[25]!.id]));
});

test("a late thread response from the previous scope cannot replace the current scope", async () => {
  let finishMain!: (value: DesignThread) => void;
  const getThread = vi.fn((_projectId: string, scope: DesignThreadScope) => (
    scope.type === "main"
      ? new Promise<DesignThread>((resolve) => { finishMain = resolve; })
      : Promise.resolve(thread(scope))
  ));
  const api = { getThread } as unknown as DesignCanvasApi;
  const { result, rerender } = renderHook(
    ({ scope }: { scope: DesignThreadScope }) => useCanvasAgentPanelController(panelOptions({ api, scope })),
    { initialProps: { scope: { type: "main" } as DesignThreadScope } },
  );

  rerender({ scope: { type: "node", nodeId: "node-1" } });
  await waitFor(() => expect(result.current.thread?.scope).toEqual({ type: "node", nodeId: "node-1" }));
  await act(async () => finishMain(thread({ type: "main" })));
  expect(result.current.thread?.scope).toEqual({ type: "node", nodeId: "node-1" });
});

test("the matching thread invalidation reloads the canonical thread without polling", async () => {
  const scope: DesignThreadScope = { type: "node", nodeId: "node-1" };
  const initial = thread(scope);
  const canonical = thread(scope, [{
    id: "message-agent",
    role: "assistant",
    content: "Ready",
    jobId: "job-1",
    createdAt: 10,
  }]);
  let emit!: (message: DesignInvalidationMessage) => void;
  const streamInvalidations = vi.fn(async function* () {
    yield await new Promise<DesignInvalidationMessage>((resolve) => { emit = resolve; });
  });
  const getThread = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(canonical);
  const api = { getThread, streamInvalidations } as unknown as DesignCanvasApi;
  const { result } = renderHook(() => useCanvasAgentPanelController(panelOptions({ api, scope })));

  await waitFor(() => expect(result.current.thread).toEqual(initial));
  await waitFor(() => expect(streamInvalidations).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal)));
  await act(async () => emit({
    type: "invalidate",
    cursor: "epoch:2",
    epoch: "epoch",
    sequence: 2,
    topics: ["thread:node:node-1"],
  }));

  await waitFor(() => expect(result.current.thread).toEqual(canonical));
  expect(getThread).toHaveBeenCalledTimes(2);
});

test("Job actions keep rejection feedback visible and allow the same action to retry", async () => {
  const onCancel = vi.fn()
    .mockRejectedValueOnce(new Error("daemon busy"))
    .mockResolvedValueOnce(undefined);
  const onRetry = vi.fn()
    .mockRejectedValueOnce(new Error("revision moved"))
    .mockResolvedValueOnce(undefined);
  const { result } = renderHook(() => useJobActionController({
    jobId: "job-failed",
    active: true,
    displayLabel: "Landing page generation",
    onCancel,
    onRetry,
  }));

  await act(async () => result.current.stop());
  expect(result.current.stopError).toContain("Couldn't stop Landing page generation. daemon busy");
  await act(async () => result.current.stop());
  expect(result.current.stopError).toBeNull();
  expect(onCancel).toHaveBeenCalledTimes(2);

  await act(async () => result.current.retry());
  expect(result.current.retryError).toContain("Couldn't retry Landing page generation. revision moved");
  await act(async () => result.current.retry());
  expect(result.current.retryError).toBeNull();
  expect(onRetry).toHaveBeenCalledTimes(2);
});

test("transcript controller follows only when the reader remains near the tail", () => {
  const { result, rerender } = renderHook(
    ({ tailKey }) => useAgentTranscriptController({
      scopeKey: "main",
      tailKey,
      optimisticUserTurnId: null,
      threadMessageCount: 0,
      threadUpdatedAt: 1,
    }),
    { initialProps: { tailKey: "one" } },
  );
  const transcript = document.createElement("div");
  let scrollHeight = 1_000;
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => scrollHeight },
    clientHeight: { get: () => 300 },
  });
  result.current.transcriptRef.current = transcript;

  transcript.scrollTop = 690;
  act(() => result.current.onScroll({ currentTarget: transcript } as React.UIEvent<HTMLDivElement>));
  expect(result.current.showScrollToBottom).toBe(false);
  scrollHeight = 1_200;
  rerender({ tailKey: "two" });
  expect(transcript.scrollTop).toBe(1_200);

  transcript.scrollTop = 100;
  act(() => result.current.onScroll({ currentTarget: transcript } as React.UIEvent<HTMLDivElement>));
  expect(result.current.showScrollToBottom).toBe(true);
  scrollHeight = 1_400;
  rerender({ tailKey: "three" });
  expect(transcript.scrollTop).toBe(100);
  act(() => result.current.scrollToBottom());
  expect(transcript.scrollTop).toBe(1_400);
  expect(result.current.showScrollToBottom).toBe(false);
});
