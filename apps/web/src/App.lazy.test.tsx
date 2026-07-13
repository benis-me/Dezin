import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import type { ReadyProjectWorkspacePayload } from "./lib/api.ts";
import { makeFakeApi } from "./test/fake-api.ts";

const loaded = vi.hoisted(() => ({ studio: 0, workspace: 0, settings: 0, canvas: 0 }));

vi.mock("./project-studio/ProjectStudioScreen.tsx", async (importOriginal) => {
  loaded.studio += 1;
  return importOriginal<typeof import("./project-studio/ProjectStudioScreen.tsx")>();
});

vi.mock("./screens/WorkspaceScreen.tsx", () => {
  loaded.workspace += 1;
  return { WorkspaceScreen: () => <div>Lazy workspace</div> };
});

vi.mock("./screens/SettingsScreen.tsx", () => {
  loaded.settings += 1;
  return { SettingsScreen: () => <div>Lazy settings</div> };
});

vi.mock("./moodboard/MoodboardCanvas.tsx", () => {
  loaded.canvas += 1;
  return { MoodboardCanvas: () => <div>Lazy canvas</div> };
});

beforeEach(() => {
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/");
});

afterEach(cleanup);

function readyWorkspace(projectId: string): ReadyProjectWorkspacePayload {
  const workspaceId = `w-${projectId}`;
  const graph = { workspaceId, revision: 1, nodes: [], edges: [] };
  const activeSnapshot = {
    id: "s1",
    workspaceId,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: 1,
    kernelRevisionId: "k1",
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
      activeKernelRevisionId: "k1",
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot,
    activeKernelRevision: {
      id: "k1",
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
    layout: { workspaceId, layoutId: "default", objects: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

const api = makeFakeApi({
  listSkills: async () => [],
  listDesignSystems: async () => [],
  getProject: async (id) => ({
    id,
    name: "Standard project",
    skillId: null,
    designSystemId: "modern-minimal",
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  }),
  getWorkspace: async (id) => readyWorkspace(id),
  getMoodboard: async (id) => ({
    id,
    name: "Lazy board",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    coverAssetId: null,
    assets: [],
    nodes: [],
    conversations: [],
    messages: [],
  }),
});

function renderApp() {
  return render(
    <ApiProvider client={api}>
      <App />
    </ApiProvider>,
  );
}

test("Home keeps route modules unloaded until each route is entered", async () => {
  renderApp();
  expect(screen.getByRole("heading", { name: "Start a design" })).toBeInTheDocument();
  expect(loaded).toEqual({ studio: 0, workspace: 0, settings: 0, canvas: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await waitFor(() => expect(loaded.settings).toBe(1));
  expect(loaded.studio).toBe(0);
  expect(loaded.workspace).toBe(0);
  expect(loaded.canvas).toBe(0);

  cleanup();
  window.history.pushState({}, "", "/projects/p1");
  renderApp();
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(loaded.studio).toBe(1);
  expect(loaded.workspace).toBe(0);
  expect(loaded.canvas).toBe(0);

  cleanup();
  window.history.pushState({}, "", "/moodboards/b1");
  renderApp();
  await waitFor(() => expect(loaded.canvas).toBe(1));
});
