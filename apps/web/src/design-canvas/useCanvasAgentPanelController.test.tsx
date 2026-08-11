import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AgentInfo } from "../lib/api.ts";
import type { DesignCanvasApi } from "./api.ts";
import type { DesignInvalidationMessage, DesignThread, DesignThreadScope } from "./types.ts";
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

function panelOptions({
  api,
  scope = { type: "main" },
  onSubmit = vi.fn(async () => {}),
}: {
  api: DesignCanvasApi;
  scope?: DesignThreadScope;
  onSubmit?: (prompt: string, nodeIds: readonly string[], selection: { agentCommand?: string; model?: string | null }) => Promise<void>;
}) {
  return {
    projectId: PROJECT_ID,
    api,
    scope,
    nodes: [],
    jobs: [],
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
  const { result } = renderHook(() => useCanvasAgentPanelController(panelOptions({ api, onSubmit })));

  await waitFor(() => expect(result.current.thread).toEqual(initial));
  act(() => result.current.setDraft("Build the launch page"));
  act(() => void result.current.submit());

  expect(result.current.visibleOptimisticUserTurn?.message.content).toBe("Build the launch page");
  expect(result.current.submitting).toBe(true);
  expect(onSubmit).toHaveBeenCalledWith("Build the launch page", [], {
    agentCommand: "claude",
    model: null,
  });

  await act(async () => finishSubmit());
  await waitFor(() => expect(result.current.thread).toEqual(canonical));
  expect(result.current.visibleOptimisticUserTurn).toBeNull();
  expect(result.current.draft).toBe("");
  expect(result.current.submitting).toBe(false);
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
  scrollHeight = 1_200;
  rerender({ tailKey: "two" });
  expect(transcript.scrollTop).toBe(1_200);

  transcript.scrollTop = 100;
  act(() => result.current.onScroll({ currentTarget: transcript } as React.UIEvent<HTMLDivElement>));
  scrollHeight = 1_400;
  rerender({ tailKey: "three" });
  expect(transcript.scrollTop).toBe(100);
});
