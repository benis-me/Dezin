import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { discardPendingDesignCanvasIntent } from "../lib/pending-design-canvas.ts";
import type { DesignAgentTurnRequest, DesignCanvasApi } from "./api.ts";
import { DesignCanvasScreen } from "./DesignCanvasScreen.tsx";
import { CanvasAgentPanel } from "./FloatingNodeAgent.tsx";
import type {
  DesignAgentTurnResult,
  DesignCanvas,
  DesignCanvasIntent,
  DesignExportResult,
  DesignJob,
  DesignNode,
  DesignThread,
  DesignThreadScope,
} from "./types.ts";

const PROJECT_ID = "canvas-project";

function node(overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id: "page-1",
    kind: "page",
    name: "Landing page",
    geometry: { x: 80, y: 80, width: 480, height: 360 },
    state: "empty",
    currentVersionId: null,
    selectedVersionId: null,
    versionCount: 0,
    assetId: null,
    activeJobId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function canvas(nodes: DesignNode[] = [], revision = 1, undoDepth = 0, redoDepth = 0): DesignCanvas {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    revision,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeOrder: nodes.map((item) => item.id),
    nodes,
    undoDepth,
    redoDepth,
    createdAt: 1,
    updatedAt: revision,
  };
}

const thread: DesignThread = {
  id: "thread-main",
  scope: { type: "main" },
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

const job: DesignJob = {
  id: "job-1",
  kind: "main-agent",
  status: "ready",
  nodeId: null,
  parentJobId: null,
  contextHash: "context",
  versionId: null,
  exportId: null,
  error: null,
  activity: [{ id: "activity-1", kind: "status", text: "Coordinating Node Agents", createdAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  finishedAt: 2,
};

function createCanvasApi(initial: DesignCanvas) {
  let current = initial;
  const applyIntents = vi.fn(async (_projectId: string, request: { baseRevision: number; intents: readonly DesignCanvasIntent[] }) => {
    let nodes = current.nodes.map((item) => ({ ...item, geometry: { ...item.geometry } }));
    for (const intent of request.intents) {
      if (intent.type === "add-node") {
        const item = intent.node;
        const id = item.id ?? `${item.kind}-${nodes.length + 1}`;
        nodes.push(node({
          id,
          kind: item.kind,
          name: item.name ?? item.kind,
          geometry: { x: 100, y: 100, width: 400, height: 300, ...item.geometry },
          assetId: item.assetId ?? null,
        }));
      } else if (intent.type === "remove-node") {
        nodes = nodes.filter((item) => item.id !== intent.nodeId);
      } else if (intent.type === "update-node") {
        nodes = nodes.map((item) => item.id === intent.nodeId ? {
          ...item,
          name: intent.patch.name ?? item.name,
          geometry: { ...item.geometry, ...intent.patch.geometry },
          selectedVersionId: intent.patch.selectedVersionId === undefined ? item.selectedVersionId : intent.patch.selectedVersionId,
        } : item);
      } else if (intent.type === "replace-layout") {
        const byId = new Map(intent.nodes.map((item) => [item.nodeId, item.geometry]));
        nodes = nodes.map((item) => ({ ...item, geometry: byId.get(item.id) ?? item.geometry }));
      }
    }
    current = canvas(nodes, request.baseRevision + 1, current.undoDepth + 1);
    return current;
  });
  const api: DesignCanvasApi = {
    getCanvas: vi.fn(async () => current),
    applyIntents,
    undo: vi.fn(async (_projectId, revision) => (current = canvas(current.nodes, revision + 1, Math.max(0, current.undoDepth - 1), 1))),
    redo: vi.fn(async (_projectId, revision) => (current = canvas(current.nodes, revision + 1, 1, 0))),
    importLocalFiles: vi.fn(async (_projectId: string, files: readonly File[], position: { x: number; y: number }) => {
      const imported = files.map((file, index) => node({
        id: `asset-${index + 1}`,
        kind: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        geometry: { x: position.x + index * 30, y: position.y + index * 30, width: 320, height: 260 },
        state: "ready",
        assetId: `asset-${index + 1}`,
      }));
      current = canvas([...current.nodes, ...imported], current.revision + 1, current.undoDepth + 1);
      return current;
    }),
    importProjectVersion: vi.fn(async () => current),
    listNodeVersions: vi.fn(async (_projectId, nodeId) => current.nodes.find((item) => item.id === nodeId)?.currentVersionId ? [{
      id: "version-1", nodeId, sequence: 1, checksum: "sum", bytes: 128, contextHash: "context", jobId: null, runnerId: null, model: null, createdAt: 1,
    }] : []),
    getExactVersionPreview: vi.fn(async (_projectId, nodeId, versionId) => ({ nodeId, versionId, url: `https://preview.local/${nodeId}/${versionId}` })),
    getAssetPreviewUrl: vi.fn((_projectId, assetId) => `/assets/${assetId}`),
    getThread: vi.fn(async (_projectId, scope) => ({ ...thread, scope })),
    submitAgentTurn: vi.fn(async (_projectId: string, scope: DesignThreadScope, request: DesignAgentTurnRequest): Promise<DesignAgentTurnResult> => ({
      thread: { ...thread, scope, messages: [{ id: "message-1", role: "user", content: request.prompt, jobId: job.id, createdAt: 2 }] },
      job,
      canvas: current,
    })),
    listJobs: vi.fn(async () => []),
    cancelJob: vi.fn(async (): Promise<DesignJob> => ({ ...job, status: "cancelled" })),
    startImplementationExport: vi.fn(async (): Promise<DesignExportResult> => ({
      exportId: "export-1",
      job: { ...job, kind: "implementation-export", exportId: "export-1" },
    })),
  };
  return { api, applyIntents };
}

afterEach(() => {
  discardPendingDesignCanvasIntent(PROJECT_ID);
});

test("empty projects expose Quick Start and toolbar/right-click share one node catalog", async () => {
  const user = userEvent.setup();
  const { api, applyIntents } = createCanvasApi(canvas());
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  expect(await screen.findByRole("heading", { name: "Quick Start" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export code" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: /^Page\b/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({
    intents: [expect.objectContaining({ type: "add-node", node: expect.objectContaining({ kind: "page" }) })],
  })));
  expect(await screen.findByLabelText("Page Agent panel", { selector: "section" })).toBeInTheDocument();
  expect(document.querySelector(".react-flow__resize-control")).not.toBeNull();

  await user.click(screen.getByRole("button", { name: "Add Design node" }));
  expect(screen.getByRole("menu", { name: "Add Design node" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: /Research/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2));
  expect(await screen.findByLabelText("Research Agent panel", { selector: "section" })).toBeInTheDocument();

  fireEvent.contextMenu(screen.getByLabelText("Infinite Design canvas"), { clientX: 320, clientY: 260 });
  expect(screen.getByRole("menu", { name: "Add Design node" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: /Component/ }));
  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(3));
});

test("Agent panels preserve the native context menu without opening the canvas Node catalog", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node()]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.click(await screen.findByTestId("rf__node-page-1"));
  const nodePanel = await screen.findByLabelText("Landing page Agent panel", { selector: "section" });
  const nodeEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  expect(nodePanel.dispatchEvent(nodeEvent)).toBe(true);
  expect(nodeEvent.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Main Agent" }));
  const mainPanel = screen.getByLabelText("Main Agent panel");
  const mainEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  expect(mainPanel.dispatchEvent(mainEvent)).toBe(true);
  expect(mainEvent.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu", { name: "Add Design node" })).not.toBeInTheDocument();
});

test("add-node retries preserve one explicit id and open only that Node after a 409 refresh", async () => {
  const initial = canvas();
  const foreign = node({ id: "foreign-page", name: "Foreign page" });
  const canonical = canvas([foreign], 2);
  const { api, applyIntents } = createCanvasApi(initial);
  vi.mocked(api.getCanvas)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(canonical);
  const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
  applyIntents
    .mockRejectedValueOnce(conflict)
    .mockImplementationOnce(async (_projectId, request) => {
      const intent = request.intents[0];
      if (!intent || intent.type !== "add-node" || !intent.node.id) throw new Error("Expected explicit add-node id");
      return canvas([
        foreign,
        node({ id: intent.node.id, kind: intent.node.kind, name: intent.node.name ?? "Page", geometry: { ...foreign.geometry, ...intent.node.geometry } }),
      ], 3, 1);
    });

  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
  await screen.findByRole("heading", { name: "Quick Start" });
  fireEvent.click(screen.getByRole("button", { name: /^Page\b/ }));

  await waitFor(() => expect(applyIntents).toHaveBeenCalledTimes(2));
  const firstIntent = applyIntents.mock.calls[0]?.[1].intents[0];
  const replayedIntent = applyIntents.mock.calls[1]?.[1].intents[0];
  expect(firstIntent?.type).toBe("add-node");
  expect(replayedIntent?.type).toBe("add-node");
  if (firstIntent?.type !== "add-node" || replayedIntent?.type !== "add-node") throw new Error("Expected add-node intents");
  expect(firstIntent.node.id).toMatch(/^page-[0-9a-f-]{36}$/);
  expect(replayedIntent.node.id).toBe(firstIntent.node.id);
  expect(await screen.findByLabelText("Page Agent panel", { selector: "section" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Foreign page Agent panel", { selector: "section" })).not.toBeInTheDocument();
});

test("history controls and shortcuts stay locked while a scoped Node Job is active", async () => {
  const activeNode = node({ state: "generating", activeJobId: "job-active" });
  const { api } = createCanvasApi(canvas([activeNode], 4, 2, 1));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const undo = await screen.findByRole("button", { name: "Undo" });
  const redo = screen.getByRole("button", { name: "Redo" });
  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();
  expect(undo).toHaveAttribute("title", "Cancel active Node generation before using history");
  expect(redo).toHaveAttribute("title", "Cancel active Node generation before using history");

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "y", metaKey: true });
  expect(api.undo).not.toHaveBeenCalled();
  expect(api.redo).not.toHaveBeenCalled();
});

test("ready generated nodes mount only an exact-version iframe with a strict sandbox and gesture shield", async () => {
  const ready = node({ state: "failed", currentVersionId: "version-1", versionCount: 1, error: "Latest run failed" });
  const { api } = createCanvasApi(canvas([ready]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const frame = await screen.findByTitle("Landing page · version version-1");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame).toHaveAttribute("tabindex", "-1");
  expect(screen.getByText("Latest run failed")).toBeInTheDocument();
  const shield = screen.getByRole("button", { name: "Select Landing page; double click to interact with preview" });
  fireEvent.doubleClick(shield);
  expect(frame).toHaveAttribute("tabindex", "0");
  expect(screen.queryByRole("button", { name: "Select Landing page; double click to interact with preview" })).not.toBeInTheDocument();
});

test("material Node Agents expose their immutable Asset manifest as a read-only revision", async () => {
  const material = node({
    id: "image-1",
    kind: "image",
    name: "Direction reference",
    state: "ready",
    assetId: "asset-1234567890abcdef1234567890abcdef",
    geometry: { x: 80, y: 80, width: 360, height: 260 },
  });
  const { api } = createCanvasApi(canvas([material]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.click(await screen.findByTestId("rf__node-image-1"));
  expect(await screen.findByText("Asset revision · asset-1234567890ab…")).toBeInTheDocument();
  expect(screen.queryByLabelText("Version")).not.toBeInTheDocument();
});

test("switching directly between nodes remounts Agent scope without leaking transcript, draft, or focus", async () => {
  const user = userEvent.setup();
  const nodeA = node({ id: "page-a", name: "Node A" });
  const nodeB = node({ id: "page-b", name: "Node B", geometry: { x: 620, y: 80, width: 480, height: 360 } });
  const { api } = createCanvasApi(canvas([nodeA, nodeB]));
  vi.mocked(api.getThread).mockImplementation(async (_projectId, scope) => ({
    ...thread,
    id: scope.type === "node" ? `thread-${scope.nodeId}` : thread.id,
    scope,
    messages: scope.type === "node" && scope.nodeId === nodeA.id ? [{
      id: "message-a",
      role: "assistant",
      content: "Node A private transcript",
      jobId: null,
      createdAt: 2,
    }] : [],
  }));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  fireEvent.click(await screen.findByTestId("rf__node-page-a"));
  expect(await screen.findByText("Node A private transcript")).toBeInTheDocument();
  const nodeADraft = await screen.findByRole("textbox", { name: "Node A Agent message" });
  await user.type(nodeADraft, "Only for A");
  await user.click(screen.getByRole("button", { name: "Focus · 2" }));
  await user.click(screen.getByRole("button", { name: /Node B/ }));
  expect(screen.getByRole("button", { name: "Focus · 1" })).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("rf__node-page-b"));
  expect(await screen.findByLabelText("Node B Agent panel", { selector: "section" })).toBeInTheDocument();
  expect(screen.queryByText("Node A private transcript")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Node B Agent message" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Focus · 2" })).toBeInTheDocument();
});

test("Agent transcripts ignore an older request that resolves after a newer refresh", async () => {
  const user = userEvent.setup();
  let resolveOlder!: (value: DesignThread) => void;
  let resolveNewer!: (value: DesignThread) => void;
  const older = { ...thread, messages: [{ id: "old", role: "assistant" as const, content: "Older transcript", jobId: null, createdAt: 2 }] };
  const newer = { ...thread, messages: [{ id: "new", role: "assistant" as const, content: "Newest transcript", jobId: null, createdAt: 3 }] };
  const { api } = createCanvasApi(canvas());
  vi.mocked(api.getThread)
    .mockImplementationOnce(() => new Promise<DesignThread>((resolve) => { resolveOlder = resolve; }))
    .mockImplementationOnce(() => new Promise<DesignThread>((resolve) => { resolveNewer = resolve; }));

  render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={[]}
      jobs={[]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );
  await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(1));
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "refresh");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));
  await waitFor(() => expect(api.getThread).toHaveBeenCalledTimes(2));

  resolveNewer(newer);
  expect(await screen.findByText("Newest transcript")).toBeInTheDocument();
  resolveOlder(older);
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByText("Older transcript")).not.toBeInTheDocument();
  expect(screen.getByText("Newest transcript")).toBeInTheDocument();
});

test("Main Agent groups every live child by its parent turn and labels the target Node", async () => {
  const childNodes = ["Checkout", "Header", "Pricing", "FAQ", "Footer", "Account", "Search"].map((name, index) => (
    node({ id: `node-${index + 1}`, name })
  ));
  const parentA: DesignJob = { ...job, id: "job-main-a", createdAt: 10, updatedAt: 10 };
  const parentB: DesignJob = { ...job, id: "job-main-b", createdAt: 20, updatedAt: 20 };
  const childJobs = childNodes.map((target, index): DesignJob => ({
    ...job,
    id: `job-child-${index + 1}`,
    kind: "node-generation",
    status: "queued",
    nodeId: target.id,
    parentJobId: index < 6 ? parentA.id : parentB.id,
    createdAt: 30 + index,
    updatedAt: 30 + index,
    finishedAt: null,
  }));
  const { api } = createCanvasApi(canvas(childNodes));
  vi.mocked(api.getThread).mockResolvedValue({
    ...thread,
    messages: [
      { id: "message-turn-a", role: "user", content: "Build six launch surfaces", jobId: parentA.id, createdAt: 10 },
      { id: "message-turn-b", role: "user", content: "Add global search", jobId: parentB.id, createdAt: 20 },
    ],
  });
  const rendered = render(
    <CanvasAgentPanel
      projectId={PROJECT_ID}
      api={api}
      scope={{ type: "main" }}
      title="Main Agent"
      subtitle="Coordinates the canvas"
      nodes={childNodes}
      jobs={[parentA, parentB, ...childJobs]}
      onSubmit={async () => {}}
      onCancelJob={async () => {}}
      onAttachFiles={async () => {}}
    />,
  );

  const firstTurn = await screen.findByLabelText("Turn · Build six launch surfaces");
  expect(firstTurn).toHaveAttribute("data-parent-job-id", parentA.id);
  expect(within(firstTurn).getByText("6 child Agents")).toBeInTheDocument();
  for (const target of childNodes.slice(0, 6)) {
    const activity = within(firstTurn).getByLabelText(`Node generation · ${target.name} · queued`);
    expect(activity).toHaveAttribute("data-node-id", target.id);
    expect(activity).toHaveAttribute("data-parent-job-id", parentA.id);
  }
  expect(rendered.container.querySelectorAll('[data-job-id^="job-child-"]')).toHaveLength(7);

  const secondTurn = screen.getByLabelText("Turn · Add global search");
  expect(within(secondTurn).getByText("1 child Agent")).toBeInTheDocument();
  expect(within(secondTurn).getByLabelText("Node generation · Search · queued")).toBeInTheDocument();
});

test("Main Agent toggles from the topbar, sees canvas scope, and submits orchestration turns", async () => {
  const user = userEvent.setup();
  const { api } = createCanvasApi(canvas([node()]));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  await user.click(await screen.findByRole("button", { name: "Main Agent" }));
  expect(screen.getByLabelText("Main Agent panel")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Focus · 1" }));
  expect(screen.getByText("The entire canvas is always available. Selected Nodes receive extra focus.")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Main Agent message" }), "Create a Page and ask its Agent to design the checkout");
  await user.click(screen.getByRole("button", { name: "Send to Main Agent" }));
  await waitFor(() => expect(api.submitAgentTurn).toHaveBeenCalledWith(
    PROJECT_ID,
    { type: "main" },
    expect.objectContaining({ prompt: "Create a Page and ask its Agent to design the checkout", context: { nodeIds: ["page-1"] } }),
  ));
});

test("Export opens Main Agent and keeps the implementation job visible through completion", async () => {
  const user = userEvent.setup();
  const revealExport = vi.fn(async () => "revealed" as const);
  const { api } = createCanvasApi(canvas([node({ state: "ready", currentVersionId: "version-1", versionCount: 1 })]));
  const exportJob: DesignJob = {
    ...job,
    id: "job-export",
    kind: "implementation-export",
    status: "ready",
    exportId: "export-1",
    activity: [{ id: "activity-export", kind: "status", text: "High-fidelity implementation ready", createdAt: 3 }],
    finishedAt: 3,
  };
  let exported = false;
  vi.mocked(api.startImplementationExport).mockImplementation(async () => {
    exported = true;
    return { exportId: "export-1", job: exportJob };
  });
  vi.mocked(api.listJobs).mockImplementation(async () => exported ? [exportJob] : []);
  render(
    <DesignCanvasScreen
      projectId={PROJECT_ID}
      projectName="Editorial"
      projectPath="/tmp/editorial"
      api={api}
      onRevealExport={revealExport}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Export code" }));
  expect(await screen.findByLabelText("Main Agent panel")).toBeInTheDocument();
  await waitFor(() => expect(api.startImplementationExport).toHaveBeenCalledWith(PROJECT_ID, 1));
  expect(await screen.findByText("Implementation export")).toBeInTheDocument();
  expect(screen.getByText("Export ready · export-1")).toBeInTheDocument();
  expect(screen.getByText("High-fidelity implementation ready")).toBeInTheDocument();
  expect(screen.getByTitle("/tmp/editorial/design/exports/export-1")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Reveal export" }));
  await waitFor(() => expect(revealExport).toHaveBeenCalledWith("export-1"));
  expect(await screen.findByText("Opened in Finder.")).toBeInTheDocument();
});

test("Export stays disabled while any generated Node still has projected or listed live work", async () => {
  const nodeA = node({
    id: "page-a",
    name: "Checkout",
    state: "generating",
    currentVersionId: "version-a",
    versionCount: 1,
    activeJobId: "job-projected",
  });
  const nodeB = node({
    id: "page-b",
    name: "Account",
    state: "ready",
    currentVersionId: "version-b",
    versionCount: 1,
  });
  const { api } = createCanvasApi(canvas([nodeA, nodeB]));
  vi.mocked(api.listJobs).mockResolvedValue([{
    ...job,
    id: "job-listed",
    kind: "node-generation",
    status: "running",
    nodeId: nodeB.id,
    finishedAt: null,
  }]);

  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);

  const exportButton = await screen.findByRole("button", { name: "Export code" });
  expect(exportButton).toBeDisabled();
  expect(exportButton).toHaveAttribute(
    "title",
    "Wait for Node generation to finish before exporting: Checkout, Account",
  );
  expect(api.startImplementationExport).not.toHaveBeenCalled();
});

test("file drops become material context nodes and undo/redo shortcuts call authoritative history", async () => {
  const { api } = createCanvasApi(canvas([node()], 1, 1, 1));
  render(<DesignCanvasScreen projectId={PROJECT_ID} projectName="Editorial" api={api} />);
  await screen.findByText("Landing page");
  const surface = screen.getByLabelText("Infinite Design canvas");
  fireEvent.drop(surface, { clientX: 200, clientY: 180, dataTransfer: { files: [new File(["image"], "reference.png", { type: "image/png" })], types: ["Files"] } });
  await waitFor(() => expect(api.importLocalFiles).toHaveBeenCalledTimes(1));

  fireEvent.keyDown(window, { key: "z", metaKey: true });
  await waitFor(() => expect(api.undo).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
  await waitFor(() => expect(api.redo).toHaveBeenCalledTimes(1));
});
