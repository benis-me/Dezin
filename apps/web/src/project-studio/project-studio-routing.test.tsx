import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App.tsx";
import { Shell } from "../components/Shell.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type { Project, ProjectWorkspacePayload } from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { makeFakeApi } from "../test/fake-api.ts";

function project(id: string, mode: Project["mode"] = "standard"): Project {
  return {
    id,
    name: `Project ${id}`,
    skillId: null,
    designSystemId: "modern-minimal",
    mode,
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyWorkspace(projectId: string): ProjectWorkspacePayload {
  const workspaceId = `workspace-${projectId}`;
  const artifactId = `artifact-${projectId}`;
  const snapshotId = `snapshot-${projectId}`;
  const kernelRevisionId = `kernel-${projectId}`;
  const graph = {
    workspaceId,
    revision: 1,
    nodes: [{ id: `node-${projectId}`, workspaceId, name: "Landing page", kind: "page" as const, artifactId }],
    edges: [],
  };
  const snapshot = {
    id: snapshotId,
    workspaceId,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: 1,
    kernelRevisionId,
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
      activeSnapshotId: snapshotId,
      activeKernelRevisionId: kernelRevisionId,
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: kernelRevisionId,
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
    artifacts: [{
      id: artifactId,
      workspaceId,
      kind: "page",
      name: "Landing page",
      sourceRoot: ".",
      legacyWrapped: true,
      activeTrackId: null,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }],
    tracks: [],
    revisions: [],
    snapshots: [snapshot],
    layout: {
      workspaceId,
      layoutId: "default",
      objects: [{ id: `node-${projectId}`, kind: "node", x: 0, y: 0, parentGroupId: null }],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: `layout-${projectId}`,
    },
  };
}

beforeEach(() => {
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/projects/p-1/canvas");
});

afterEach(cleanup);

test("Canvas and Artifact routes preserve the project-keyed Studio and Workspace Agent draft", async () => {
  const getProject = vi.fn(async (id: string) => project(id));
  const getWorkspace = vi.fn(async (id: string) => readyWorkspace(id));
  render(
    <ApiProvider client={makeFakeApi({ getProject, getWorkspace })}>
      <App />
    </ApiProvider>,
  );

  const canvas = await screen.findByRole("region", { name: "Project canvas" });
  const shell = screen.getByTestId("project-studio-shell");
  const draft = screen.getByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Create a checkout page" } });

  act(() => navigate("/projects/p-1/artifacts/artifact-p-1"));

  expect(await screen.findByRole("region", { name: "Artifact editor" })).toBeInTheDocument();
  expect(screen.getByText("artifact-p-1")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Project canvas" })).not.toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("Create a checkout page");
  expect(canvas).not.toBeInTheDocument();
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);

  act(() => navigate("/projects/p-1/artifacts/artifact-p-1-b"));
  expect(await screen.findByText("artifact-p-1-b")).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);

  act(() => navigate("/projects/p-2/canvas"));

  await waitFor(() => expect(screen.getByTestId("project-studio-shell")).not.toBe(shell));
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("");
  expect(getProject).toHaveBeenCalledTimes(2);
  expect(getWorkspace).toHaveBeenCalledTimes(2);
});

test("StrictMode remounts share one in-flight project workspace read", async () => {
  const getProject = vi.fn(async (id: string) => project(id));
  const getWorkspace = vi.fn(async (id: string) => readyWorkspace(id));
  render(
    <StrictMode>
      <ApiProvider client={makeFakeApi({ getProject, getWorkspace })}>
        <App />
      </ApiProvider>
    </StrictMode>,
  );

  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);
});

test("same-project navigation while loading neither refetches nor accepts a stale project response", async () => {
  let resolveFirstProject!: (value: Project) => void;
  let resolveFirstWorkspace!: (value: ProjectWorkspacePayload) => void;
  const firstProject = new Promise<Project>((resolve) => { resolveFirstProject = resolve; });
  const firstWorkspace = new Promise<ProjectWorkspacePayload>((resolve) => { resolveFirstWorkspace = resolve; });
  const getProject = vi.fn((id: string) => id === "p-1" ? firstProject : Promise.resolve(project(id)));
  const getWorkspace = vi.fn((id: string) => id === "p-1" ? firstWorkspace : Promise.resolve(readyWorkspace(id)));
  render(
    <ApiProvider client={makeFakeApi({ getProject, getWorkspace })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("status", { name: "Loading project canvas" })).toBeInTheDocument();
  act(() => navigate("/projects/p-1/artifacts/artifact-p-1"));
  expect(await screen.findByRole("status", { name: "Loading artifact editor" })).toBeInTheDocument();
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);

  act(() => navigate("/projects/p-2/canvas"));
  expect(await screen.findByText("Project p-2")).toBeInTheDocument();

  await act(async () => {
    resolveFirstProject(project("p-1"));
    resolveFirstWorkspace(readyWorkspace("p-1"));
    await firstProject;
    await firstWorkspace;
  });
  expect(screen.getByText("Project p-2")).toBeInTheDocument();
  expect(screen.queryByText("Project p-1")).not.toBeInTheDocument();
});

test("workspace loading failures and Standard/unsupported mismatches render accessible errors", async () => {
  const { unmount } = render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => { throw new Error("Workspace service unavailable"); },
        getWorkspace: async () => readyWorkspace("p-1"),
      })}
    >
      <App />
    </ApiProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace service unavailable");
  expect(screen.getByTestId("project-studio-drag-region")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back to projects" })).toBeInTheDocument();

  unmount();
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => project("p-1", "standard"),
        getWorkspace: async () => ({
          status: "unsupported",
          code: "workspace_requires_standard_project",
          projectId: "p-1",
          projectMode: "prototype",
        }),
      })}
    >
      <App />
    </ApiProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Standard project workspace is unavailable");
  expect(screen.queryByTestId("project-studio-shell")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Conversation")).not.toBeInTheDocument();
});

test("a failed Studio load can retry without remounting the route", async () => {
  let attempt = 0;
  const getProject = vi.fn(async (id: string) => {
    attempt += 1;
    if (attempt === 1) throw new Error("Temporary workspace failure");
    return project(id);
  });
  const getWorkspace = vi.fn(async (id: string) => readyWorkspace(id));
  render(
    <ApiProvider client={makeFakeApi({ getProject, getWorkspace })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary workspace failure");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(getProject).toHaveBeenCalledTimes(2);
  expect(getWorkspace).toHaveBeenCalledTimes(2);
});

test("the Settings overlay does not unmount a project Studio or lose its Agent draft", async () => {
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async (id) => project(id),
        getWorkspace: async (id) => readyWorkspace(id),
      })}
    >
      <App />
    </ApiProvider>,
  );
  const shell = await screen.findByTestId("project-studio-shell");
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Keep this workspace plan" },
  });

  fireEvent.keyDown(window, { key: ",", metaKey: true });

  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(shell.querySelector<HTMLTextAreaElement>("textarea[aria-label='Workspace Agent draft']")).toHaveValue("Keep this workspace plan");
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
});

test("a direct Artifact deep link has an accessible loading state before the Studio resolves", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => new Promise<Project>(() => {}),
        getWorkspace: async () => new Promise<ProjectWorkspacePayload>(() => {}),
      })}
    >
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("status", { name: "Loading artifact editor" })).toHaveAttribute("aria-live", "polite");
  expect(screen.getByTestId("project-studio-drag-region")).toBeInTheDocument();
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
});

test("Prototype projects retain the legacy Workspace screen without a nested Studio shell", async () => {
  window.history.pushState({}, "", "/projects/prototype/canvas");
  const listWorkspaceProposals = vi.fn(async () => {
    throw new Error("Prototype projects must not read Proposals");
  });
  render(
    <ApiProvider
      client={makeFakeApi({
        getProject: async () => project("prototype", "prototype"),
        getWorkspace: async () => ({
          status: "unsupported",
          code: "workspace_requires_standard_project",
          projectId: "prototype",
          projectMode: "prototype",
        }),
        listWorkspaceProposals,
      })}
    >
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByText("Preview")).toBeInTheDocument();
  expect(screen.getByLabelText("Conversation")).toBeInTheDocument();
  expect(screen.queryByTestId("project-studio-shell")).not.toBeInTheDocument();
  expect(listWorkspaceProposals).not.toHaveBeenCalled();
});

test("the special new-project route stays in the legacy Workspace flow without workspace reads", async () => {
  window.history.pushState({}, "", "/projects/new");
  const getProject = vi.fn(async () => project("new"));
  const getWorkspace = vi.fn(async () => readyWorkspace("new"));
  render(
    <ApiProvider client={makeFakeApi({ getProject, getWorkspace })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByText("Preview")).toBeInTheDocument();
  expect(screen.getByLabelText("Conversation")).toBeInTheDocument();
  expect(getProject).not.toHaveBeenCalled();
  expect(getWorkspace).not.toHaveBeenCalled();
});

test("Shell keeps Canvas and Artifact backgrounds full-bleed while Settings owns the URL", () => {
  window.history.pushState({}, "", "/settings");
  const { rerender } = render(
    <Shell
      dark={false}
      onToggleDark={() => {}}
      onOpenSettings={() => {}}
      routeOverride={{ name: "project-canvas", id: "p-1" }}
    >
      <div>Canvas background</div>
    </Shell>,
  );
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
  expect(screen.queryByRole("separator", { name: "Resize app sidebar" })).not.toBeInTheDocument();

  rerender(
    <Shell
      dark={false}
      onToggleDark={() => {}}
      onOpenSettings={() => {}}
      routeOverride={{ name: "project-artifact", id: "p-1", artifactId: "a-1" }}
    >
      <div>Artifact background</div>
    </Shell>,
  );
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
  expect(screen.queryByRole("separator", { name: "Resize app sidebar" })).not.toBeInTheDocument();
});
