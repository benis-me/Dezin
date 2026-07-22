import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Project,
  ProjectWorkspacePayload,
  Resource,
  ResourceRevision,
} from "../lib/api.ts";

const adapterHarness = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./canvas/workspace-graph-adapter.ts", async () => {
  const actual = await vi.importActual<typeof import("./canvas/workspace-graph-adapter.ts")>(
    "./canvas/workspace-graph-adapter.ts",
  );
  return {
    ...actual,
    workspaceGraphToFlow: (...args: Parameters<typeof actual.workspaceGraphToFlow>) => {
      adapterHarness.calls += 1;
      return actual.workspaceGraphToFlow(...args);
    },
  };
});

import App from "../App.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import * as ProjectStudioScreenModule from "./ProjectStudioScreen.tsx";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dezin.onboarded", "1");
});

afterEach(cleanup);

type ResourceRevisionStateBuilder = (
  resources: readonly Resource[],
  activeRevisionIds: Readonly<Record<string, string>>,
  revisions: readonly ResourceRevision[],
) => Readonly<Record<string, {
  revisionId: string;
  resourceKind: Resource["kind"];
  qualityState: "grounded" | "needs-review" | null;
}>>;

function project(): Project {
  return {
    id: "project-1",
    name: "Storefront",
    skillId: null,
    designSystemId: null,
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  };
}

const resource: Resource = {
  id: "research-1",
  workspaceId: "workspace-1",
  kind: "research",
  title: "Checkout research",
  headRevisionId: "research-revision-1",
  defaultPinPolicy: "follow-head",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const resourceRevision: ResourceRevision = {
  id: "research-revision-1",
  workspaceId: "workspace-1",
  resourceId: resource.id,
  sequence: 1,
  parentRevisionId: null,
  manifestPath: "resources/research-1/revision.json",
  summary: "Grounded checkout research",
  metadata: { qualityState: "grounded" },
  checksum: "research-checksum",
  provenance: {},
  createdByRunId: null,
  createdAt: 1,
};

function workspace(): ProjectWorkspacePayload {
  const graph = {
    workspaceId: "workspace-1",
    revision: 1,
    nodes: [
      { id: "page-1", workspaceId: "workspace-1", kind: "page" as const, artifactId: "artifact-1", name: "Home" },
      { id: "research-node", workspaceId: "workspace-1", kind: "resource" as const, resourceId: resource.id, name: resource.title },
    ],
    edges: [],
  };
  const snapshot = {
    id: "snapshot-1",
    workspaceId: "workspace-1",
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
    artifactRevisions: { "artifact-1": null },
    resourceRevisions: { [resource.id]: resourceRevision.id },
  };
  return {
    status: "ready",
    workspace: {
      id: "workspace-1",
      projectId: "project-1",
      mode: "standard",
      graphRevision: 1,
      activeSnapshotId: snapshot.id,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId: "workspace-1",
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
    snapshots: [snapshot],
    resources: [resource],
    resourceRevisions: [resourceRevision],
    layout: {
      workspaceId: "workspace-1",
      layoutId: "default",
      objects: [
        { id: "page-1", kind: "node", x: 20, y: 20, parentGroupId: null },
        { id: "research-node", kind: "node", x: 340, y: 20, parentGroupId: null },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-1",
    },
  };
}

test("Resource revision state indexing reads each Revision identity once instead of scanning per Resource", () => {
  const build = (ProjectStudioScreenModule as unknown as {
    buildResourceRevisionStates?: ResourceRevisionStateBuilder;
  }).buildResourceRevisionStates;
  expect(build).toBeTypeOf("function");

  let identityReads = 0;
  const resources = Array.from({ length: 80 }, (_, index): Resource => ({
    ...resource,
    id: `resource-${index}`,
    title: `Resource ${index}`,
    kind: index % 2 === 0 ? "research" : "file",
  }));
  const revisions = resources.map((entry, index): ResourceRevision => {
    const revision = {
      ...resourceRevision,
      id: `revision-${index}`,
      resourceId: entry.id,
      metadata: { qualityState: index % 2 === 0 ? "grounded" : "needs-review" },
    };
    Object.defineProperty(revision, "resourceId", {
      enumerable: true,
      get: () => {
        identityReads += 1;
        return entry.id;
      },
    });
    return revision;
  });
  const active = Object.fromEntries(resources.map((entry, index) => [entry.id, `revision-${index}`]));

  const states = build!(resources, active, revisions);

  expect(Object.keys(states)).toHaveLength(resources.length);
  expect(identityReads).toBe(revisions.length);
});

test("typing an Agent draft does not rebuild the Canvas graph model", async () => {
  adapterHarness.calls = 0;
  window.history.pushState({}, "", "/projects/project-1/canvas");
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace: async () => workspace(),
      listResources: async () => [resource],
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByText("Grounded")).toBeInTheDocument();
  await act(async () => { await Promise.resolve(); });
  const modelBuildsBeforeDraft = adapterHarness.calls;

  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Refine the information architecture" },
  });
  await act(async () => { await Promise.resolve(); });

  expect(adapterHarness.calls).toBe(modelBuildsBeforeDraft);
});

test.each([
  ["is still pending", () => new Promise<Resource[]>(() => {})],
  ["rejects", async () => { throw new Error("resource catalog unavailable"); }],
])("ready workspace pins remain exact while listResources %s", async (_case, listResources) => {
  const user = userEvent.setup();
  window.history.pushState({}, "", "/projects/project-1/canvas");
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project(),
      getWorkspace: async () => workspace(),
      listResources,
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByText("Grounded")).toBeInTheDocument();
  expect(screen.queryByText(/Awaiting/i)).not.toBeInTheDocument();

  const addMenu = screen.getByRole("button", { name: "Add files and context" });
  addMenu.focus();
  fireEvent.pointerDown(addMenu, { button: 0, ctrlKey: false });
  fireEvent.keyDown(addMenu, { key: "Enter" });
  await user.click(await screen.findByText("Reference a workspace item"));
  expect(await screen.findByRole("menuitem", { name: /Checkout research/ })).toBeInTheDocument();

  const node = rendered.container.querySelector<HTMLElement>('.react-flow__node[data-id="research-node"]');
  expect(node).not.toBeNull();
  node!.focus();
  fireEvent.keyDown(node!, { key: "Enter" });

  expect(window.location.pathname).toBe(
    "/projects/project-1/resources/research-1/revisions/research-revision-1",
  );
});
