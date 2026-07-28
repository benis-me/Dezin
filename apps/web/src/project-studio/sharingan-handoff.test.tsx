import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../App.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type {
  CreateProjectInput,
  MaterializeResourceInput,
  MaterializeResourceResult,
  Project,
  ProjectWorkspacePayload,
  WorkspaceAgentTurnInput,
  WorkspaceProposal,
} from "../lib/api.ts";
import {
  peekPendingDesignWorkspaceTurn,
  takePendingAgent,
  takePendingBrief,
  takePendingImages,
  takePendingModel,
  takePendingRefs,
} from "../lib/pending-brief.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { validPngFile } from "../test/image-fixtures.ts";

vi.mock("../lib/native.ts", () => ({
  native: {
    isElectron: true,
    platform: "darwin",
    pickFiles: async () => [],
    pickFolder: async () => [],
  },
}));

function project(id: string, name: string, sharingan = false): Project {
  return {
    id,
    name,
    skillId: null,
    designSystemId: sharingan ? null : "modern-minimal",
    mode: "standard",
    ...(sharingan
      ? { sharingan: true, sourceUrl: "https://source.example" }
      : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyWorkspace(projectId: string): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const workspaceId = `workspace-${projectId}`;
  const graph = { workspaceId, revision: 1, nodes: [], edges: [] };
  const activeSnapshot = {
    id: `snapshot-${projectId}`,
    workspaceId,
    sequence: 1,
    parentSnapshotId: null,
    graphRevision: 1,
    kernelRevisionId: `kernel-${projectId}`,
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
      activeKernelRevisionId: activeSnapshot.kernelRevisionId,
      createdAt: 1,
      updatedAt: 1,
    },
    graph,
    activeSnapshot,
    activeKernelRevision: {
      id: activeSnapshot.kernelRevisionId,
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
      checksum: "layout-checksum",
    },
  };
}

function referenceWorkspace(projectId: string): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const current = readyWorkspace(projectId);
  const artifactId = `artifact-${projectId}`;
  const trackId = `track-${projectId}`;
  const revisionId = `revision-${projectId}`;
  const snapshot = {
    ...current.activeSnapshot,
    artifactTracks: { [artifactId]: trackId },
    artifactRevisions: { [artifactId]: revisionId },
  };
  return {
    ...current,
    activeSnapshot: snapshot,
    artifacts: [{
      id: artifactId,
      workspaceId: current.workspace.id,
      kind: "page",
      name: "Landing page",
      sourceRoot: `artifacts/${artifactId}`,
      legacyWrapped: false,
      activeTrackId: trackId,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }],
    tracks: [{
      id: trackId,
      artifactId,
      name: "Main",
      headRevisionId: revisionId,
      legacyVariantId: null,
      createdAt: 1,
    }],
    revisions: [{
      id: revisionId,
      workspaceId: current.workspace.id,
      artifactId,
      trackId,
      sequence: 1,
      parentRevisionId: null,
      sourceCommitHash: "1".repeat(40),
      sourceTreeHash: "2".repeat(40),
      artifactRoot: `artifacts/${artifactId}`,
      kernelRevisionId: current.activeKernelRevision.id,
      renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100 },
      contextPackHash: null,
      producedByRunId: null,
      legacyRunId: null,
      createdAt: 1,
    }],
    snapshots: [snapshot],
  };
}

function draftProposal(
  ready: Extract<ProjectWorkspacePayload, { status: "ready" }>,
): WorkspaceProposal {
  return {
    id: "proposal-sharingan-handoff",
    workspaceId: ready.workspace.id,
    revision: 1,
    kind: "workspace-generation",
    baseGraphRevision: ready.graph.revision,
    baseSnapshotId: ready.activeSnapshot.id,
    baseGraph: ready.graph,
    layoutId: ready.layout.layoutId,
    baseLayoutChecksum: ready.layout.checksum,
    baseLayout: ready.layout,
    status: "draft",
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      agent: { providerId: "codex", command: "codex", model: "gpt-5.1-codex-mini" },
      resourceOperations: [],
      artifactPlans: [],
      dependencyPlans: [],
      prototypeIntents: [],
      capabilities: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    },
    rationale: "Recreate the source with the supplied references.",
    assumptions: [],
    review: { kind: "none" },
    createdByRunId: null,
    createdAt: 2,
    updatedAt: 2,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  cleanup();
});

test("Sharingan Home context reaches the first ProjectStudio turn without entering Prototype queues", async () => {
  const user = userEvent.setup();
  const sourceProject = project("p-reference", "Editorial reference");
  const createdProject = project("p-sharingan", "Source clone", true);
  const ready = readyWorkspace(createdProject.id);
  const sourceReady = referenceWorkspace(sourceProject.id);
  const currentSettings = await makeFakeApi().getSettings();
  const getSettings = vi.fn()
    .mockResolvedValueOnce({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.1-codex-mini",
      sharinganAffirmed: true,
    })
    .mockResolvedValue({
      ...currentSettings,
      agentCommand: "codebuddy",
      model: "hunyuan",
      sharinganAffirmed: true,
    });
  const createProject = vi.fn(async (_input: CreateProjectInput) => createdProject);
  const uploadRef = vi.fn(async (_projectId: string, name: string) => ({
    name,
    path: `.refs/${name}`,
  }));
  const materializedContexts: Array<{ resourceId: string; revisionId: string }> = [];
  const materializeResource = vi.fn(async (
    _projectId: string,
    input: MaterializeResourceInput,
  ): Promise<MaterializeResourceResult> => {
    const sequence = materializedContexts.length + 1;
    const resourceId = `resource-sharingan-${sequence}`;
    const revisionId = `revision-sharingan-${sequence}`;
    materializedContexts.push({ resourceId, revisionId });
    const node = {
      id: `node-sharingan-${sequence}`,
      workspaceId: ready.workspace.id,
      kind: "resource" as const,
      name: input.title,
      resourceId,
    };
    const graph = {
      ...ready.graph,
      revision: ready.graph.revision + sequence,
      nodes: materializedContexts.map((context, index) => ({
        id: `node-sharingan-${index + 1}`,
        workspaceId: ready.workspace.id,
        kind: "resource" as const,
        name: index === 0 ? "direction.png" : "Editorial reference",
        resourceId: context.resourceId,
      })),
    };
    return {
      resource: {
        id: resourceId,
        workspaceId: ready.workspace.id,
        kind: input.kind,
        title: input.title,
        headRevisionId: revisionId,
        defaultPinPolicy: input.defaultPinPolicy,
        archivedAt: null,
        createdAt: sequence + 1,
        updatedAt: sequence + 1,
      },
      revision: {
        id: revisionId,
        workspaceId: ready.workspace.id,
        resourceId,
        sequence: 1,
        parentRevisionId: null,
        manifestPath: `resource-revisions/${resourceId}/manifest.json`,
        summary: `Uploaded file: ${input.title}`,
        metadata: {},
        checksum: String(sequence).repeat(64),
        provenance: {},
        createdByRunId: null,
        createdAt: sequence + 1,
      },
      node,
      graph,
      snapshot: {
        ...ready.activeSnapshot,
        id: `snapshot-sharingan-${sequence}`,
        sequence: ready.activeSnapshot.sequence + sequence,
        graphRevision: graph.revision,
        graph,
        resourceRevisions: Object.fromEntries(
          materializedContexts.map((context) => [context.resourceId, context.revisionId]),
        ),
      },
    };
  });
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));

  render(
    <ApiProvider client={makeFakeApi({
      listProjects: async () => [sourceProject],
      createProject,
      getProject: async (id) => id === sourceProject.id ? sourceProject : createdProject,
      getWorkspace: async (id) => id === sourceProject.id ? sourceReady : ready,
      getFileText: async () => "<main>Editorial reference artifact</main>",
      getSettings,
      listAgents: async () => [
        {
          id: "codex",
          command: "codex",
          available: true,
          version: "1",
          models: ["gpt-5.1-codex-mini"],
        },
        {
          id: "codebuddy",
          command: "codebuddy",
          available: true,
          version: "1",
          models: ["hunyuan"],
        },
      ],
      uploadRef,
      materializeResource,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" }))
    .toHaveTextContent("gpt-5.1-codex-mini"));
  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  fireEvent.change(imageInput!, {
    target: { files: [validPngFile("direction.png")] },
  });
  await screen.findByLabelText("Remove direction.png");
  const attachButton = screen.getByRole("button", { name: "Add files and context" });
  fireEvent.keyDown(attachButton, { key: "Enter" });
  await screen.findByRole("menu");
  await user.hover(await screen.findByText("Reference a project"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Editorial reference" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reference Landing page" }));
  await screen.findByLabelText("Remove Editorial reference / Landing page");

  fireEvent.doubleClick(screen.getByRole("heading", { name: "Start a design" }));
  fireEvent.change(screen.getByPlaceholderText("Paste a URL to clone…"), {
    target: { value: "https://source.example" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
    mode: "standard",
    sharingan: true,
    sourceUrl: "https://source.example",
    initialTurnId: expect.stringMatching(
      /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  }));
  expect(uploadRef.mock.calls.map(([projectId, name]) => [projectId, name])).toEqual([
    ["p-sharingan", "home-image-1-direction.png"],
  ]);
  expect(materializeResource.mock.calls.map(([projectId, input]) => [
    projectId,
    input.title,
    input.source,
  ])).toEqual([
    ["p-sharingan", "direction.png", {
      type: "uploaded-file",
      uploadedFileId: ".refs/home-image-1-direction.png",
    }],
    ["p-sharingan", "Editorial reference / Landing page", {
      type: "project-reference",
      sourceProjectId: "p-reference",
      sourceWorkspaceId: "workspace-p-reference",
      sourceSnapshotId: "snapshot-p-reference",
      sourceArtifactId: "artifact-p-reference",
      sourceArtifactRevisionId: "revision-p-reference",
    }],
  ]);
  const firstWorkspaceTurn = workspaceAgentTurn.mock.calls[0];
  expect(firstWorkspaceTurn).toBeDefined();
  if (!firstWorkspaceTurn) throw new Error("expected the Sharingan Workspace Agent turn");
  expect(firstWorkspaceTurn[0]).toBe("p-sharingan");
  expect(firstWorkspaceTurn[1].turnId)
    .toBe(createProject.mock.calls[0]![0].initialTurnId);
  expect(firstWorkspaceTurn[1]).toEqual(expect.objectContaining({
    message: "https://source.example",
    agentCommand: "codex",
    model: "gpt-5.1-codex-mini",
    explicitContext: [
      {
        kind: "resource",
        id: "resource-sharingan-1",
        resourceKind: "file",
        revisionId: "revision-sharingan-1",
      },
      {
        kind: "resource",
        id: "resource-sharingan-2",
        resourceKind: "file",
        revisionId: "revision-sharingan-2",
      },
    ],
  }));
  expect(peekPendingDesignWorkspaceTurn("p-sharingan")).toBeNull();
  expect(takePendingBrief()).toBeNull();
  expect(takePendingImages()).toEqual([]);
  expect(takePendingRefs()).toEqual([]);
  expect(takePendingAgent()).toBeNull();
  expect(takePendingModel()).toBeNull();
});
