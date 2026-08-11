import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { DesignCanvasApi } from "./api.ts";
import type { DesignCanvas, DesignInvalidationMessage, DesignJob, DesignThread } from "./types.ts";
import { useDesignCanvasController } from "./useDesignCanvasController.ts";

const PROJECT_ID = "design-project";

function canvas(revision = 1, undoDepth = 0, redoDepth = 0): DesignCanvas {
  return {
    schemaVersion: 2,
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
  schemaVersion: 2,
  id: "job-1",
  kind: "main-agent",
  runnerId: "fixture",
  model: null,
  status: "ready",
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
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
};

const mainThread: DesignThread = {
  schemaVersion: 2,
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
    downloadExactVersionHtml: vi.fn(async () => new Blob()),
    getThread: vi.fn(async () => mainThread),
    submitAgentTurn: vi.fn(async () => ({ thread: mainThread, job: readyJob, canvas: canvas(3, 2) })),
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async (_projectId: string, jobId: string): Promise<DesignJob> => ({ ...readyJob, id: jobId, status: "cancelled" })),
    retryJob: vi.fn(async (_projectId: string, jobId: string) => ({
      retryOfJobId: jobId,
      thread: mainThread,
      job: { ...readyJob, id: "job-retry", status: "queued" as const },
      canvas: canvas(3, 2),
    })),
    startImplementationExport: vi.fn(async () => ({
      exportId: "export-1",
      job: { ...readyJob, kind: "implementation-export" as const },
    })),
    ...overrides,
    // eslint-disable-next-line require-yield
    streamInvalidations: overrides.streamInvalidations ?? (async function* () {}),
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
      <button type="button" onClick={() => void controller.retryJob("job-failed")}>retry failed job</button>
      <button type="button" onClick={() => void controller.refresh()}>refresh</button>
    </div>
  );
}

afterEach(() => {
  sessionStorage.clear();
});

test("loading a Canvas never claims a browser-owned pending bootstrap handoff", async () => {
  sessionStorage.setItem(`dezin.design-canvas.intent.${PROJECT_ID}`, JSON.stringify({
    projectId: PROJECT_ID,
    prompt: "Create the launch page",
    context: [{
      kind: "project-version",
      title: "Source page",
      sourceProjectId: "source-project",
      sourceNodeId: "source-node",
      sourceVersionId: "source-version",
    }],
  }));
  const api = fakeApi();

  render(<StrictMode><Harness api={api} /></StrictMode>);

  await screen.findByText("1");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(api.importProjectVersion).not.toHaveBeenCalled();
  expect(api.submitAgentTurn).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(`dezin.design-canvas.intent.${PROJECT_ID}`)).not.toBeNull();
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

test("cancelling a live job refreshes the canonical canvas projection immediately", async () => {
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

test("an invalidation event refreshes Canvas and Jobs from canonical GETs", async () => {
  let emit!: (message: DesignInvalidationMessage) => void;
  const streamInvalidations = vi.fn(async function* () {
    yield await new Promise<DesignInvalidationMessage>((resolve) => { emit = resolve; });
  });
  const getCanvas = vi.fn()
    .mockResolvedValueOnce(canvas(1))
    .mockResolvedValueOnce(canvas(5));
  const listJobs = vi.fn(async () => []);
  const api = fakeApi({ getCanvas, listJobs, streamInvalidations });
  render(<Harness api={api} />);

  await screen.findByText("1");
  await waitFor(() => expect(streamInvalidations).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal)));
  await act(async () => emit({
    type: "invalidate",
    cursor: "epoch:1",
    epoch: "epoch",
    sequence: 1,
    topics: ["jobs"],
  }));

  await screen.findByText("5");
  expect(getCanvas).toHaveBeenCalledTimes(2);
  expect(listJobs).toHaveBeenCalledTimes(2);
});

test("retrying a failed Job installs its successor projection before refreshing authority", async () => {
  const getCanvas = vi.fn()
    .mockResolvedValueOnce(canvas(1))
    .mockResolvedValueOnce(canvas(4));
  const retryJob = vi.fn(async () => ({
    retryOfJobId: "job-failed",
    thread: mainThread,
    job: { ...readyJob, id: "job-retry", status: "queued" as const },
    canvas: canvas(3, 2),
  }));
  const api = fakeApi({ getCanvas, retryJob });
  render(<Harness api={api} />);
  await screen.findByText("1");

  fireEvent.click(screen.getByRole("button", { name: "retry failed job" }));

  await screen.findByText("4");
  expect(retryJob).toHaveBeenCalledWith(PROJECT_ID, "job-failed");
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
