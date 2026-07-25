import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { expect, test, vi } from "vitest";

import { ApiProvider } from "../lib/api-context.tsx";
import type {
  Project,
  ProjectWorkspacePayload,
  WorkspaceLayoutCommand,
} from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

function project(id = "project-1"): Project {
  return {
    id,
    name: "Storefront",
    skillId: null,
    designSystemId: null,
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyWorkspace(projectId = "project-1"): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const workspaceId = `workspace-${projectId}`;
  const graph = { workspaceId, revision: 1, nodes: [], edges: [] };
  const activeSnapshot = {
    id: "snapshot-1",
    workspaceId,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: 1,
    kernelRevisionId: "kernel-1",
    reason: "workspace-created",
    provenance: { kind: "workspace-created" as const },
    createdByRunId: null,
    createdAt: 1,
    graph,
    artifactTracks: {},
    artifactRevisions: {},
    resourceRevisions: {},
  };
  return {
    status: "ready",
    workspace: {
      id: workspaceId,
      projectId,
      mode: "standard",
      graphRevision: 1,
      activeSnapshotId: activeSnapshot.id,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId,
      sequence: 1,
      parentRevisionId: null,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      checksum: "kernel-checksum",
      createdAt: 1,
    },
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [activeSnapshot],
    layout: {
      workspaceId,
      layoutId: "default",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-1",
    },
  };
}

function ViewportAuthorityProbe() {
  const studio = useProjectStudio("project-1");
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  return (
    <div>
      <output data-testid="viewport-authority">
        {studio.viewport.x}:{studio.viewport.y}:{studio.viewport.zoom}
      </output>
      <button
        type="button"
        onClick={() => studio.setViewport({ x: 99, y: 24, zoom: 1.2 })}
      >
        Set local viewport
      </button>
      <button type="button" onClick={studio.reconcileGenerationPublication}>
        Reconcile workspace
      </button>
    </div>
  );
}

function LayoutPollingRaceProbe() {
  const studio = useProjectStudio("project-1");
  const [saveSettled, setSaveSettled] = useState(false);
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  return (
    <div>
      <output data-testid="layout-polling-head">
        {studio.load.workspace.activeSnapshot.id}:{studio.load.workspace.layout.viewport.x}
      </output>
      <output data-testid="layout-save-settled">{String(saveSettled)}</output>
      <button
        type="button"
        onClick={() => void studio.saveLayout([{
            type: "set-viewport",
            viewport: { x: 44, y: 0, zoom: 1 },
          }])
          .then(() => setSaveSettled(true))}
      >
        Save delayed layout
      </button>
      <button type="button" onClick={studio.reconcileGenerationPublication}>
        Poll newer workspace
      </button>
    </div>
  );
}

function GraphPollingRaceProbe() {
  const studio = useProjectStudio("project-1");
  const [graphSettled, setGraphSettled] = useState(false);
  if (studio.load.status !== "ready") return <span>{studio.load.status}</span>;
  return (
    <div>
      <output data-testid="graph-polling-head">
        {studio.load.workspace.graph.revision}:{studio.load.workspace.activeSnapshot.id}
      </output>
      <output data-testid="graph-save-settled">{String(graphSettled)}</output>
      <button
        type="button"
        onClick={() => void studio.applyGraphCommands([{
            id: "rename-delayed",
            type: "rename-node",
            nodeId: "page-1",
            name: "Delayed rename",
          }])
          .then(() => setGraphSettled(true))}
      >
        Apply delayed graph
      </button>
      <button type="button" onClick={studio.reconcileGenerationPublication}>
        Poll newer graph
      </button>
    </div>
  );
}

const cleanupSaveCommand: readonly WorkspaceLayoutCommand[] = [{
  type: "set-viewport",
  viewport: { x: 12, y: 24, zoom: 0.8 },
}];

function SwitchingCleanupSaveProbe({ projectId }: { projectId: string }) {
  const studio = useProjectStudio(projectId);
  useEffect(() => {
    if (studio.load.status !== "ready") return;
    return () => {
      void studio.saveLayout(cleanupSaveCommand).catch(() => {});
    };
  }, [projectId, studio.load.status, studio.saveLayout]);
  return (
    <output data-testid="switching-save-state">
      {studio.load.status === "ready" ? studio.load.project.id : studio.load.status}
    </output>
  );
}

test("an authoritative workspace reconcile supersedes a local viewport override", async () => {
  const initial = readyWorkspace();
  const reconciled = {
    ...readyWorkspace(),
    layout: {
      ...initial.layout,
      viewport: { x: -240, y: 72, zoom: 0.64 },
      checksum: "layout-reconciled",
    },
  };
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(reconciled);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
    })}>
      <ViewportAuthorityProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("viewport-authority")).toHaveTextContent("0:0:1");
  fireEvent.click(screen.getByRole("button", { name: "Set local viewport" }));
  expect(screen.getByTestId("viewport-authority")).toHaveTextContent("99:24:1.2");

  fireEvent.click(screen.getByRole("button", { name: "Reconcile workspace" }));

  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("viewport-authority")).toHaveTextContent("-240:72:0.64"));
});

test("a same-head workspace poll preserves the local viewport override", async () => {
  const initial = readyWorkspace();
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(readyWorkspace());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
    })}>
      <ViewportAuthorityProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("viewport-authority")).toHaveTextContent("0:0:1");
  fireEvent.click(screen.getByRole("button", { name: "Set local viewport" }));
  expect(screen.getByTestId("viewport-authority")).toHaveTextContent("99:24:1.2");

  fireEvent.click(screen.getByRole("button", { name: "Reconcile workspace" }));

  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("viewport-authority")).toHaveTextContent("99:24:1.2"));
});

test("a non-viewport layout update preserves the local viewport override", async () => {
  const initial = readyWorkspace();
  const layoutUpdate = {
    ...readyWorkspace(),
    layout: {
      ...initial.layout,
      checksum: "layout-node-moved",
    },
  } satisfies Extract<ProjectWorkspacePayload, { status: "ready" }>;
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(layoutUpdate);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
    })}>
      <ViewportAuthorityProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("viewport-authority")).toHaveTextContent("0:0:1");
  fireEvent.click(screen.getByRole("button", { name: "Set local viewport" }));
  expect(screen.getByTestId("viewport-authority")).toHaveTextContent("99:24:1.2");

  fireEvent.click(screen.getByRole("button", { name: "Reconcile workspace" }));

  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("viewport-authority")).toHaveTextContent("99:24:1.2"));
});

test("a delayed layout-save response cannot overwrite a newer polled workspace head", async () => {
  const initial = readyWorkspace();
  const polled = {
    ...readyWorkspace(),
    workspace: {
      ...initial.workspace,
      graphRevision: 2,
      activeSnapshotId: "snapshot-2",
      updatedAt: 2,
    },
    graph: {
      ...initial.graph,
      revision: 2,
    },
    activeSnapshot: {
      ...initial.activeSnapshot,
      id: "snapshot-2",
      sequence: 2,
      graphRevision: 2,
      graph: {
        ...initial.graph,
        revision: 2,
      },
    },
    snapshots: [
      initial.activeSnapshot,
      {
        ...initial.activeSnapshot,
        id: "snapshot-2",
        sequence: 2,
        graphRevision: 2,
        graph: {
          ...initial.graph,
          revision: 2,
        },
      },
    ],
    layout: {
      ...initial.layout,
      viewport: { x: 96, y: 0, zoom: 1 },
      checksum: "layout-polled",
    },
  } satisfies Extract<ProjectWorkspacePayload, { status: "ready" }>;
  let resolveSave!: (layout: typeof initial.layout) => void;
  const delayedSave = new Promise<typeof initial.layout>((resolve) => {
    resolveSave = resolve;
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(polled);
  const saveWorkspaceLayout = vi.fn(() => delayedSave);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
      saveWorkspaceLayout,
    })}>
      <LayoutPollingRaceProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("layout-polling-head")).toHaveTextContent("snapshot-1:0");
  fireEvent.click(screen.getByRole("button", { name: "Save delayed layout" }));
  await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Poll newer workspace" }));
  await waitFor(() => expect(screen.getByTestId("layout-polling-head")).toHaveTextContent("snapshot-2:96"));

  resolveSave({
    ...initial.layout,
    viewport: { x: 44, y: 0, zoom: 1 },
    checksum: "layout-saved",
  });

  await waitFor(() => expect(screen.getByTestId("layout-save-settled")).toHaveTextContent("true"));
  expect(screen.getByTestId("layout-polling-head")).toHaveTextContent("snapshot-2:96");
});

test("a saved layout merges into a newer polled graph head when its layout checksum has not advanced", async () => {
  const initial = readyWorkspace();
  const nextGraph = {
    ...initial.graph,
    revision: 2,
  };
  const nextSnapshot = {
    ...initial.activeSnapshot,
    id: "snapshot-2",
    sequence: 2,
    graphRevision: 2,
    graph: nextGraph,
  };
  const polled = {
    ...initial,
    workspace: {
      ...initial.workspace,
      graphRevision: 2,
      activeSnapshotId: "snapshot-2",
      updatedAt: 2,
    },
    graph: nextGraph,
    activeSnapshot: nextSnapshot,
    snapshots: [initial.activeSnapshot, nextSnapshot],
  } satisfies Extract<ProjectWorkspacePayload, { status: "ready" }>;
  let resolveSave!: (layout: typeof initial.layout) => void;
  const delayedSave = new Promise<typeof initial.layout>((resolve) => {
    resolveSave = resolve;
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(polled);
  const saveWorkspaceLayout = vi.fn(() => delayedSave);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
      saveWorkspaceLayout,
    })}>
      <LayoutPollingRaceProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("layout-polling-head")).toHaveTextContent("snapshot-1:0");
  fireEvent.click(screen.getByRole("button", { name: "Save delayed layout" }));
  await waitFor(() => expect(saveWorkspaceLayout).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Poll newer workspace" }));
  await waitFor(() => expect(screen.getByTestId("layout-polling-head")).toHaveTextContent("snapshot-2:0"));

  resolveSave({
    ...initial.layout,
    viewport: { x: 44, y: 0, zoom: 1 },
    checksum: "layout-saved",
  });

  await waitFor(() => expect(screen.getByTestId("layout-save-settled")).toHaveTextContent("true"));
  expect(screen.getByTestId("layout-polling-head")).toHaveTextContent("snapshot-2:44");
});

test("a delayed graph response cannot roll a newer polled graph revision backward", async () => {
  const initial = readyWorkspace();
  const graphAt = (revision: number) => ({
    ...initial.graph,
    revision,
  });
  const snapshotAt = (sequence: number) => ({
    ...initial.activeSnapshot,
    id: `snapshot-${sequence}`,
    sequence,
    graphRevision: sequence,
    graph: graphAt(sequence),
  });
  const polled = {
    ...initial,
    workspace: {
      ...initial.workspace,
      graphRevision: 3,
      activeSnapshotId: "snapshot-3",
      updatedAt: 3,
    },
    graph: graphAt(3),
    activeSnapshot: snapshotAt(3),
    snapshots: [initial.activeSnapshot, snapshotAt(3)],
  } satisfies Extract<ProjectWorkspacePayload, { status: "ready" }>;
  let resolveGraph!: (result: {
    graph: typeof initial.graph;
    snapshot: typeof initial.activeSnapshot;
  }) => void;
  const delayedGraph = new Promise<{
    graph: typeof initial.graph;
    snapshot: typeof initial.activeSnapshot;
  }>((resolve) => {
    resolveGraph = resolve;
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(polled);
  const applyWorkspaceGraphCommands = vi.fn(() => delayedGraph);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace,
      listWorkspaceProposals: async () => [],
      applyWorkspaceGraphCommands,
    })}>
      <GraphPollingRaceProbe />
    </ApiProvider>,
  );

  expect(await screen.findByTestId("graph-polling-head")).toHaveTextContent("1:snapshot-1");
  fireEvent.click(screen.getByRole("button", { name: "Apply delayed graph" }));
  await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Poll newer graph" }));
  await waitFor(() => expect(screen.getByTestId("graph-polling-head")).toHaveTextContent("3:snapshot-3"));

  resolveGraph({
    graph: graphAt(2),
    snapshot: snapshotAt(2),
  });

  await waitFor(() => expect(screen.getByTestId("graph-save-settled")).toHaveTextContent("true"));
  expect(screen.getByTestId("graph-polling-head")).toHaveTextContent("3:snapshot-3");
});

test("a cleanup holding the previous project's save callback cannot write after a direct project switch", async () => {
  const saveWorkspaceLayout = vi.fn(async (_projectId: string) => {
    throw new Error("A stale project callback must never reach the API.");
  });
  const api = makeFakeApi({
    getProject: async (projectId) => project(projectId),
    getWorkspace: async (projectId) => readyWorkspace(projectId),
    listWorkspaceProposals: async () => [],
    saveWorkspaceLayout,
  });
  const rendered = render(
    <ApiProvider client={api}>
      <SwitchingCleanupSaveProbe projectId="project-1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("switching-save-state")).toHaveTextContent("project-1"));

  rendered.rerender(
    <ApiProvider client={api}>
      <SwitchingCleanupSaveProbe projectId="project-2" />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("switching-save-state")).toHaveTextContent("project-2"));
  expect(saveWorkspaceLayout).not.toHaveBeenCalled();
});
