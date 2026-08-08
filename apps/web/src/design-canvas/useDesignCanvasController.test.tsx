import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  discardPendingDesignCanvasIntent,
  peekPendingDesignCanvasIntent,
  setPendingDesignCanvasIntent,
} from "../lib/pending-design-canvas.ts";
import type { DesignCanvasApi } from "./api.ts";
import type { DesignCanvas, DesignJob, DesignThread } from "./types.ts";
import { useDesignCanvasController } from "./useDesignCanvasController.ts";

const PROJECT_ID = "design-project";

function canvas(revision = 1, undoDepth = 0, redoDepth = 0): DesignCanvas {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: [],
    nodes: [],
    undoDepth,
    redoDepth,
    createdAt: 1,
    updatedAt: revision,
  };
}

const readyJob: DesignJob = {
  id: "job-1",
  kind: "main-agent",
  runnerId: "fixture",
  model: null,
  status: "ready",
  nodeId: null,
  parentJobId: null,
  contextHash: "context",
  versionId: null,
  exportId: null,
  error: null,
  activity: [],
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
};

const mainThread: DesignThread = {
  id: "thread-main",
  scope: { type: "main" },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

function fakeApi(overrides: Partial<DesignCanvasApi> = {}): DesignCanvasApi {
  return {
    getCanvas: vi.fn(async () => canvas()),
    applyIntents: vi.fn(async (_projectId, request) => canvas(request.baseRevision + 1, 1)),
    undo: vi.fn(async (_projectId, revision) => canvas(revision + 1)),
    redo: vi.fn(async (_projectId, revision) => canvas(revision + 1)),
    importLocalFiles: vi.fn(async () => canvas(2, 1)),
    appendMaterialVersion: vi.fn(async () => canvas(2, 1)),
    importProjectVersion: vi.fn(async () => canvas(2, 1)),
    listNodeVersions: vi.fn(async () => []),
    getExactVersionPreview: vi.fn(async (_projectId, nodeId, versionId) => ({ nodeId, versionId, url: `/preview/${versionId}` })),
    getThread: vi.fn(async () => mainThread),
    submitAgentTurn: vi.fn(async () => ({ thread: mainThread, job: readyJob, canvas: canvas(3, 2) })),
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async (_projectId: string, jobId: string): Promise<DesignJob> => ({ ...readyJob, id: jobId, status: "cancelled" })),
    startImplementationExport: vi.fn(async () => ({
      exportId: "export-1",
      job: { ...readyJob, kind: "implementation-export" as const },
    })),
    ...overrides,
  };
}

function Harness({ api }: { api: DesignCanvasApi }) {
  const controller = useDesignCanvasController({ projectId: PROJECT_ID, api });
  return (
    <div>
      <span data-testid="revision">{controller.canvas?.revision ?? "loading"}</span>
      <span data-testid="error">{controller.error ?? ""}</span>
      <button type="button" onClick={() => void controller.applyIntents([{ type: "add-node", node: { kind: "page" } }])}>mutate</button>
      <button type="button" onClick={() => void controller.appendMaterialVersion("image-1", new File(["v2"], "v2.png", { type: "image/png" }))}>append material version</button>
      <button type="button" onClick={() => void controller.cancelJob("job-live")}>cancel</button>
      <button type="button" onClick={() => void controller.refresh()}>refresh</button>
      {controller.pendingIntentRetryAvailable ? <button type="button" onClick={controller.retryPendingIntent}>retry handoff</button> : null}
    </div>
  );
}

afterEach(() => {
  discardPendingDesignCanvasIntent(PROJECT_ID);
  sessionStorage.clear();
});

test("StrictMode claims and completes the initial canvas handoff exactly once", async () => {
  setPendingDesignCanvasIntent({
    projectId: PROJECT_ID,
    prompt: "Create the launch page",
    context: [{
      kind: "project-version",
      title: "Source page",
      sourceProjectId: "source-project",
      sourceNodeId: "source-node",
      sourceVersionId: "source-version",
    }],
  });
  const api = fakeApi();

  render(<StrictMode><Harness api={api} /></StrictMode>);

  await waitFor(() => expect(api.importProjectVersion).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(api.submitAgentTurn).toHaveBeenCalledTimes(1));
  expect(api.submitAgentTurn).toHaveBeenCalledWith(PROJECT_ID, { type: "main" }, {
    prompt: "Create the launch page",
    context: { nodeIds: [] },
    idempotencyKey: `initial-design-canvas-${PROJECT_ID}`,
  });
  expect(peekPendingDesignCanvasIntent(PROJECT_ID)).toBeNull();
});

test("a failed handoff remains pending and retries without re-importing completed context", async () => {
  setPendingDesignCanvasIntent({
    projectId: PROJECT_ID,
    prompt: "",
    context: [{
      kind: "project-version",
      title: "Source page",
      sourceProjectId: "source-project",
      sourceNodeId: "source-node",
      sourceVersionId: "source-version",
    }],
  });
  const importProjectVersion = vi.fn()
    .mockRejectedValueOnce(new Error("daemon unavailable"))
    .mockResolvedValue(canvas(2, 1));
  const api = fakeApi({ importProjectVersion });
  render(<Harness api={api} />);

  expect(await screen.findByRole("button", { name: "retry handoff" })).toBeInTheDocument();
  expect(peekPendingDesignCanvasIntent(PROJECT_ID)?.context).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "retry handoff" }));

  await waitFor(() => expect(importProjectVersion).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(peekPendingDesignCanvasIntent(PROJECT_ID)).toBeNull());
});

test("a CAS conflict refreshes canonical revision and replays an absolute mutation once", async () => {
  const getCanvas = vi.fn()
    .mockResolvedValueOnce(canvas(1))
    .mockResolvedValueOnce(canvas(4));
  const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
  const applyIntents = vi.fn()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce(canvas(5, 1));
  const api = fakeApi({ getCanvas, applyIntents });
  render(<Harness api={api} />);
  await screen.findByText("1");

  fireEvent.click(screen.getByRole("button", { name: "mutate" }));

  await screen.findByText("5");
  expect(applyIntents).toHaveBeenNthCalledWith(1, PROJECT_ID, expect.objectContaining({ baseRevision: 1 }));
  expect(applyIntents).toHaveBeenNthCalledWith(2, PROJECT_ID, expect.objectContaining({ baseRevision: 4 }));
});

test("material revision imports flow through the mutation queue and update the canonical Canvas", async () => {
  const appendMaterialVersion = vi.fn(async () => canvas(6, 2));
  const api = fakeApi({ appendMaterialVersion });
  render(<Harness api={api} />);
  await screen.findByText("1");

  fireEvent.click(screen.getByRole("button", { name: "append material version" }));

  await screen.findByText("6");
  expect(appendMaterialVersion).toHaveBeenCalledWith(PROJECT_ID, "image-1", expect.objectContaining({ name: "v2.png" }));
});

test("cancelling a live job refreshes the canvas projection before polling can stop", async () => {
  const getCanvas = vi.fn()
    .mockResolvedValueOnce(canvas(1))
    .mockResolvedValueOnce(canvas(2));
  const api = fakeApi({ getCanvas });
  render(<Harness api={api} />);
  await screen.findByText("1");

  fireEvent.click(screen.getByRole("button", { name: "cancel" }));

  await screen.findByText("2");
  expect(api.cancelJob).toHaveBeenCalledWith(PROJECT_ID, "job-live");
  expect(getCanvas).toHaveBeenCalledTimes(2);
});

test("a stale failed refresh cannot overwrite a newer successful refresh", async () => {
  let rejectStale!: (problem: unknown) => void;
  const getCanvas = vi.fn()
    .mockResolvedValueOnce(canvas(1))
    .mockImplementationOnce(() => new Promise<DesignCanvas>((_resolve, reject) => {
      rejectStale = reject;
    }))
    .mockResolvedValueOnce(canvas(3));
  const api = fakeApi({ getCanvas });
  render(<Harness api={api} />);
  await screen.findByText("1");

  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await screen.findByText("3");

  rejectStale(new Error("stale daemon failure"));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent(""));
});

test("a successful retry clears an initial-load failure", async () => {
  const getCanvas = vi.fn()
    .mockRejectedValueOnce(new Error("daemon unavailable"))
    .mockResolvedValueOnce(canvas(2));
  const api = fakeApi({ getCanvas });
  render(<Harness api={api} />);

  await screen.findByText("daemon unavailable");
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));

  await screen.findByText("2");
  expect(screen.getByTestId("error")).toHaveTextContent("");
});

test("an older initial-load failure cannot replace a newer successful refresh", async () => {
  let rejectInitial!: (problem: unknown) => void;
  const getCanvas = vi.fn()
    .mockImplementationOnce(() => new Promise<DesignCanvas>((_resolve, reject) => {
      rejectInitial = reject;
    }))
    .mockResolvedValueOnce(canvas(4));
  const api = fakeApi({ getCanvas });
  render(<Harness api={api} />);

  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await screen.findByText("4");
  rejectInitial(new Error("late initial failure"));

  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent(""));
  expect(screen.getByTestId("revision")).toHaveTextContent("4");
});
