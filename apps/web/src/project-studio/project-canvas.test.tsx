import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiProvider } from "../lib/api-context.tsx";
import {
  ApiError,
  type GraphCommandRequest,
  type Project,
  type ReadyProjectWorkspacePayload,
  type WorkspaceGraph,
  type WorkspaceGraphCommand,
  type WorkspaceLayout,
  type WorkspaceLayoutCommand,
} from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { ProjectCanvas, isCanvasShortcutTarget } from "./canvas/ProjectCanvas.tsx";
import { applyWorkspaceLayoutCommands } from "./canvas/workspace-layout.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const graph: WorkspaceGraph = {
  workspaceId: "workspace-1",
  revision: 1,
  nodes: [
    { id: "page-1", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-1", name: "Checkout" },
    { id: "page-2", workspaceId: "workspace-1", kind: "page", artifactId: "artifact-page-2", name: "Receipt" },
  ],
  edges: [{
    id: "prototype-1",
    workspaceId: "workspace-1",
    kind: "prototype",
    sourceNodeId: "page-1",
    targetNodeId: "page-2",
    prototype: { status: "planned" },
  }],
};

const layout: WorkspaceLayout = {
  workspaceId: "workspace-1",
  layoutId: "default",
  objects: [
    { id: "journey", kind: "group", x: 40, y: 40, width: 700, height: 380, parentGroupId: null, label: "Purchase journey", collapsed: false },
    { id: "page-1", kind: "node", x: 40, y: 70, parentGroupId: "journey" },
    { id: "page-2", kind: "node", x: 370, y: 70, parentGroupId: "journey" },
  ],
  viewport: { x: 0, y: 0, zoom: 0.8 },
};

function CanvasHarness({
  onSaveLayout,
  onApplyGraphCommands = async () => {},
  onOpenArtifact = () => {},
  canvasLayout = layout,
}: {
  onSaveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  onApplyGraphCommands?: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  onOpenArtifact?: (artifactId: string) => void;
  canvasLayout?: WorkspaceLayout;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  return (
    <ProjectCanvas
      projectId="project-1"
      projectName="Storefront system"
      graph={graph}
      layout={canvasLayout}
      artifactRevisionIds={{ "artifact-page-1": "revision-1" }}
      selectedNodeIds={selection}
      onSelectionChange={setSelection}
      onSaveLayout={onSaveLayout}
      onApplyGraphCommands={onApplyGraphCommands}
      onOpenArtifact={onOpenArtifact}
    />
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/projects/project-1/canvas");
});

afterEach(() => vi.restoreAllMocks());

test("canvas renders immutable-node Outline parity and never mounts iframe content", () => {
  const { container } = render(
    <CanvasHarness onSaveLayout={async () => layout} />,
  );

  expect(screen.getByRole("application", { name: "Project canvas" })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Workspace outline" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Select Page Checkout.*outgoing 1/i })).toBeInTheDocument();
  expect(container.querySelector("iframe")).toBeNull();

  const open = screen.getByRole("link", { name: "Open Checkout" });
  expect(open).toHaveAttribute("href", "/projects/project-1/artifacts/artifact-page-1");
});

test("canvas exposes truthful keyboard instructions without advertising semantic deletion", () => {
  const { container } = render(<CanvasHarness onSaveLayout={async () => layout} />);
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="page-1"]');
  expect(node).not.toBeNull();

  const nodeDescriptionId = node!.getAttribute("aria-describedby")!;
  const nodeDescription = document.getElementById(nodeDescriptionId);
  const edgeDescription = document.getElementById(nodeDescriptionId.replace("node-desc", "edge-desc"));
  expect(nodeDescription).toHaveTextContent("Enter opens");
  expect(nodeDescription).toHaveTextContent("not deleted with the keyboard");
  expect(edgeDescription).toHaveTextContent("not deleted with the keyboard");
  expect(nodeDescription).not.toHaveTextContent("Press delete");
  expect(edgeDescription).not.toHaveTextContent("Press delete");
});

test("double-clicking a connection Handle never opens the artifact", () => {
  const onOpenArtifact = vi.fn();
  render(
    <CanvasHarness
      onSaveLayout={async () => layout}
      onOpenArtifact={onOpenArtifact}
    />,
  );

  fireEvent.doubleClick(screen.getByRole("button", { name: "Connect from Checkout" }));
  expect(onOpenArtifact).not.toHaveBeenCalled();
});

test("Group and Delete Group toolbar actions persist layout commands only", async () => {
  const onSaveLayout = vi.fn(async (_commands: readonly WorkspaceLayoutCommand[]) => layout);
  const onApplyGraphCommands = vi.fn(async () => {});
  render(<CanvasHarness onSaveLayout={onSaveLayout} onApplyGraphCommands={onApplyGraphCommands} />);

  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  fireEvent.click(screen.getByRole("button", { name: "Group selection" }));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  expect(onSaveLayout.mock.calls[0]?.[0][0]).toMatchObject({ type: "add-group" });
  expect(onApplyGraphCommands).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Select Group Purchase journey/i }));
  fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove frame" }));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  expect(onSaveLayout.mock.calls[1]?.[0].at(-1)).toEqual({ type: "delete-group", groupId: "journey", ungroupChildren: true });
  expect(onApplyGraphCommands).not.toHaveBeenCalled();
});

test("a quick move then Group computes structural commands from the saved move", async () => {
  let resolveMove!: (next: WorkspaceLayout) => void;
  const moveResponse = new Promise<WorkspaceLayout>((resolve) => { resolveMove = resolve; });
  const onSaveLayout = vi.fn()
    .mockImplementationOnce(() => moveResponse)
    .mockImplementationOnce(async (commands: readonly WorkspaceLayoutCommand[]) => applyWorkspaceLayoutCommands(
      applyWorkspaceLayoutCommands(layout, [{ type: "move", objectId: "page-1", x: 41, y: 70 }]),
      commands,
    ));
  render(<CanvasHarness onSaveLayout={onSaveLayout} />);

  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  fireEvent.keyDown(screen.getByRole("application", { name: "Project canvas" }), { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Group selection" }));
  expect(onSaveLayout).toHaveBeenCalledTimes(1);

  resolveMove(applyWorkspaceLayoutCommands(layout, onSaveLayout.mock.calls[0]![0]));
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledTimes(2));
  expect(onSaveLayout.mock.calls[1]![0][0]).toMatchObject({
    type: "add-group",
    bounds: { x: 33 },
  });
});

test("changing selection closes a pending group removal confirmation", () => {
  render(<CanvasHarness onSaveLayout={async () => layout} />);
  fireEvent.click(screen.getByRole("button", { name: /Select Group Purchase journey/i }));
  fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
  expect(screen.getByRole("button", { name: "Remove frame" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  expect(screen.queryByRole("button", { name: "Remove frame" })).toBeNull();
});

test("canvas keyboard controls open, clear, switch tools, fit, and persist one owned arrow movement", async () => {
  const onOpenArtifact = vi.fn();
  const onSaveLayout = vi.fn(async (_commands: readonly WorkspaceLayoutCommand[]) => layout);
  render(<CanvasHarness onSaveLayout={onSaveLayout} onOpenArtifact={onOpenArtifact} />);
  fireEvent.click(screen.getByRole("button", { name: /Select Page Checkout/i }));
  const canvas = screen.getByRole("application", { name: "Project canvas" });

  fireEvent.keyDown(canvas, { key: "Enter" });
  expect(onOpenArtifact).toHaveBeenCalledWith("artifact-page-1");
  fireEvent.keyDown(canvas, { key: "h" });
  expect(screen.getByRole("button", { name: "Hand tool" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(canvas, { key: "v" });
  expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(canvas, { key: "1", shiftKey: true });
  expect(screen.getByRole("status", { name: "Canvas status" })).toHaveTextContent("Fit workspace");
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  await waitFor(() => expect(onSaveLayout).toHaveBeenCalledWith([
    { type: "move", objectId: "page-1", x: 41, y: 70 },
  ]));
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Group selection" })).toBeDisabled();
});

test("full semantic zoom exposes keyboard Page handles and compact zoom removes them from the accessibility tree", async () => {
  const onApplyGraphCommands = vi.fn(async (_commands: readonly WorkspaceGraphCommand[]) => {});
  const { unmount } = render(
    <CanvasHarness onSaveLayout={async () => layout} onApplyGraphCommands={onApplyGraphCommands} />,
  );

  const source = screen.getByRole("button", { name: "Connect from Checkout" });
  const target = screen.getByRole("button", { name: "Connect into Receipt" });
  let pointedElement: Element = source;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => pointedElement,
  });
  fireEvent.keyDown(source, { key: "Enter" });
  pointedElement = target;
  fireEvent.keyDown(target, { key: "Enter" });
  await waitFor(() => expect(onApplyGraphCommands).toHaveBeenCalledTimes(1));
  expect(onApplyGraphCommands.mock.calls[0]?.[0][0]).toMatchObject({ type: "add-edge" });
  Reflect.deleteProperty(document, "elementFromPoint");

  unmount();
  render(
    <CanvasHarness
      canvasLayout={{ ...layout, viewport: { ...layout.viewport, zoom: 0.6 } }}
      onSaveLayout={async () => layout}
    />,
  );
  expect(screen.queryByRole("button", { name: "Connect from Checkout" })).not.toBeInTheDocument();
});

test("shortcut target guard uses closest and ignores nested interactive/contenteditable targets", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <button><span id="inside-button">Icon</span></button>
    <div contenteditable="true"><span id="inside-editable">Text</span></div>
    <div id="plain">Canvas</div>
  `;
  expect(isCanvasShortcutTarget(host.querySelector("#inside-button"))).toBe(true);
  expect(isCanvasShortcutTarget(host.querySelector("#inside-editable"))).toBe(true);
  expect(isCanvasShortcutTarget(host.querySelector("#plain"))).toBe(false);
});

function project(): Project {
  return { id: "project-1", name: "Storefront", skillId: null, designSystemId: null, mode: "standard", createdAt: 1, updatedAt: 1 };
}

function readyWorkspace(revision = 1, nextLayout = layout): ReadyProjectWorkspacePayload {
  const currentGraph = { ...graph, revision };
  const snapshotId = `snapshot-${revision}`;
  const snapshot = {
    id: snapshotId,
    workspaceId: graph.workspaceId,
    sequence: revision,
    parentSnapshotId: revision === 1 ? null : `snapshot-${revision - 1}`,
    graphRevision: revision,
    kernelRevisionId: "kernel-1",
    reason: "graph-command",
    provenance: revision === 1 ? { kind: "workspace-created" as const } : { kind: "graph-command" as const, commandIds: ["command"] },
    createdByRunId: null,
    createdAt: revision,
    graph: currentGraph,
    artifactTracks: {},
    artifactRevisions: { "artifact-page-1": "revision-1", "artifact-page-2": null },
    resourceRevisions: {},
  };
  return {
    status: "ready",
    workspace: { id: graph.workspaceId, projectId: "project-1", mode: "standard", graphRevision: revision, activeSnapshotId: snapshotId, activeKernelRevisionId: "kernel-1", createdAt: 1, updatedAt: revision },
    graph: currentGraph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId: graph.workspaceId,
      sequence: 1,
      parentRevisionId: null,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: { requiredFrameIds: [], blockingSeverities: [], requireRuntimeChecks: false, requireVisualReview: false },
      checksum: "kernel",
      createdAt: 1,
    },
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [snapshot],
    layout: nextLayout,
  };
}

function StudioMutationProbe() {
  const studio = useProjectStudio("project-1");
  if (studio.load.status !== "ready") return <div>{studio.load.status}</div>;
  return (
    <div>
      <output data-testid="studio-pointers">
        {studio.load.workspace.graph.revision}:{studio.load.workspace.activeSnapshot.id}:{studio.load.workspace.layout.viewport.x}
      </output>
      <button type="button" onClick={() => void studio.saveLayout([{ type: "set-viewport", viewport: { x: 44, y: 0, zoom: 1 } }])}>
        Save layout
      </button>
      <button
        type="button"
        onClick={() => void studio.applyGraphCommands([{
          id: "command-next",
          type: "rename-node",
          nodeId: "page-1",
          name: "Checkout next",
        }])}
      >
        Apply graph
      </button>
      <button
        type="button"
        onClick={() => void studio.applyGraphCommands([{
          id: "command-edge",
          type: "add-edge",
          edge: {
            id: "prototype-conflict",
            workspaceId: graph.workspaceId,
            kind: "prototype",
            sourceNodeId: "page-1",
            targetNodeId: "page-2",
          },
        }])}
      >
        Add graph edge
      </button>
    </div>
  );
}

describe("Project Studio authoritative persistence", () => {
  test("layout save rebases once on graph revision conflict", async () => {
    const refreshed = readyWorkspace(2);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const savedLayout = { ...layout, viewport: { x: 44, y: 0, zoom: 1 } };
    const saveWorkspaceLayout = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce(savedLayout);
    render(
      <ApiProvider client={makeFakeApi({ getProject: async () => project(), getWorkspace, saveWorkspaceLayout })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(2));
    expect(saveWorkspaceLayout.mock.calls.map((call) => call[1].graphRevision)).toEqual([1, 2]);
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2:44");
  });

  test("overlapping layout saves serialize so an older full-layout response cannot clobber a newer one", async () => {
    let resolveFirst!: (value: WorkspaceLayout) => void;
    const first = new Promise<WorkspaceLayout>((resolve) => { resolveFirst = resolve; });
    const saveWorkspaceLayout = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ...layout, viewport: { x: 88, y: 0, zoom: 1 } });
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace: async () => readyWorkspace(1),
        saveWorkspaceLayout,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    const save = await screen.findByRole("button", { name: "Save layout" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));
    resolveFirst({ ...layout, viewport: { x: 44, y: 0, zoom: 1 } });
    await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(2));
    expect(saveWorkspaceLayout.mock.invocationCallOrder[0]).toBeLessThan(saveWorkspaceLayout.mock.invocationCallOrder[1]!);
  });

  test("graph mutation atomically advances graph and Snapshot pointers for the next CAS", async () => {
    const next = readyWorkspace(2);
    const applyWorkspaceGraphCommands = vi.fn(async (_projectId: string, _input: GraphCommandRequest) => ({ graph: next.graph, snapshot: next.activeSnapshot }));
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace: async () => readyWorkspace(1),
        applyWorkspaceGraphCommands,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply graph" }));
    await waitFor(() => expect(screen.getByTestId("studio-pointers")).toHaveTextContent("2:snapshot-2"));
    fireEvent.click(screen.getByRole("button", { name: "Apply graph" }));
    await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2));
    expect(applyWorkspaceGraphCommands.mock.calls[0]?.[1]).toMatchObject({ baseGraphRevision: 1, expectedSnapshotId: "snapshot-1" });
    expect(applyWorkspaceGraphCommands.mock.calls[1]?.[1]).toMatchObject({ baseGraphRevision: 2, expectedSnapshotId: "snapshot-2" });
  });

  test("a graph conflict refreshes authoritative pointers and safely replays an add-edge command once", async () => {
    const refreshed = readyWorkspace(2);
    const published = readyWorkspace(3);
    const getWorkspace = vi.fn()
      .mockResolvedValueOnce(readyWorkspace(1))
      .mockResolvedValueOnce(refreshed);
    const applyWorkspaceGraphCommands = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, "stale", { code: "workspace_revision_conflict" }))
      .mockResolvedValueOnce({ graph: published.graph, snapshot: published.activeSnapshot });
    render(
      <ApiProvider client={makeFakeApi({
        getProject: async () => project(),
        getWorkspace,
        applyWorkspaceGraphCommands,
      })}>
        <StudioMutationProbe />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add graph edge" }));
    await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(2));
    expect(applyWorkspaceGraphCommands.mock.calls.map((call) => call[1])).toMatchObject([
      { baseGraphRevision: 1, expectedSnapshotId: "snapshot-1" },
      { baseGraphRevision: 2, expectedSnapshotId: "snapshot-2" },
    ]);
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("studio-pointers")).toHaveTextContent("3:snapshot-3");
  });
});
