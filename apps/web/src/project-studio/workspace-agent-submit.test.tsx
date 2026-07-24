import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../App.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type {
  AgentInfo,
  Project,
  ProjectWorkspacePayload,
  Resource,
  ResourceRevision,
  ResourceRevisionView,
  ScopedAgentTurnInput,
  ScopedAgentTurnReceipt,
  WorkspaceAgentTurnInput,
  WorkspaceProposal,
} from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const CANONICAL_TURN_ID = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    skillId: null,
    designSystemId: "modern-minimal",
    mode: "standard",
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyWorkspace(projectId: string): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const workspaceId = `workspace-${projectId}`;
  const snapshotId = `snapshot-${projectId}`;
  const kernelRevisionId = `kernel-${projectId}`;
  const graph = { workspaceId, revision: 1, nodes: [], edges: [] };
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
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [snapshot],
    layout: {
      workspaceId,
      layoutId: "default",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: `layout-${projectId}`,
    },
  };
}

function readyWorkspaceWithResources(projectId: string): Extract<ProjectWorkspacePayload, { status: "ready" }> {
  const ready = readyWorkspace(projectId);
  const resources: Resource[] = ["resource-1", "resource-2"].map((id, index) => ({
    id,
    workspaceId: ready.workspace.id,
    kind: "file",
    title: `Reference ${index + 1}`,
    headRevisionId: `${id}-revision-1`,
    defaultPinPolicy: "follow-head",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  const resourceRevisions: ResourceRevision[] = resources.map((resource) => ({
    id: resource.headRevisionId!,
    workspaceId: ready.workspace.id,
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: `resource-revisions/${resource.id}/manifest.json`,
    summary: `${resource.title} snapshot`,
    metadata: {},
    checksum: resource.id === "resource-1" ? "a".repeat(64) : "b".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 1,
  }));
  const graph = {
    ...ready.graph,
    nodes: resources.map((resource) => ({
      id: `node-${resource.id}`,
      workspaceId: ready.workspace.id,
      kind: "resource" as const,
      name: resource.title,
      resourceId: resource.id,
    })),
  };
  const activeSnapshot = {
    ...ready.activeSnapshot,
    graph,
    resourceRevisions: Object.fromEntries(resourceRevisions.map((revision) => [revision.resourceId, revision.id])),
  };
  return {
    ...ready,
    graph,
    activeSnapshot,
    snapshots: [activeSnapshot],
    resources,
    resourceRevisions,
  };
}

function resourceRevisionView(
  ready: Extract<ProjectWorkspacePayload, { status: "ready" }>,
  resourceId: string,
): ResourceRevisionView {
  const resource = ready.resources!.find((candidate) => candidate.id === resourceId)!;
  const revision = ready.resourceRevisions!.find((candidate) => candidate.resourceId === resourceId)!;
  return {
    protocol: "dezin.resource-revision-view.v1",
    kind: "file",
    resource,
    revision,
    observed: { headRevisionId: revision.id, snapshotId: ready.activeSnapshot.id },
    payload: {
      mimeType: "text/plain",
      byteLength: 12,
      checksum: revision.checksum,
      previewKind: "text",
      url: null,
      downloadUrl: `/resources/${resourceId}/${revision.id}`,
    },
    content: {
      fileName: `${resourceId}.txt`,
      previewKind: "text",
      text: resource.title,
      textTruncated: false,
    },
  };
}

function draftProposal(ready: Extract<ProjectWorkspacePayload, { status: "ready" }>): WorkspaceProposal {
  return {
    id: "proposal-agent-1",
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
      agent: { providerId: "codebuddy", command: "codebuddy", model: "gpt-5.6-sol" },
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
    rationale: "Create a focused checkout flow",
    assumptions: ["Reuse the current visual language"],
    review: { kind: "none" },
    createdByRunId: null,
    createdAt: 2,
    updatedAt: 2,
  };
}

function artifactReceipt(): ScopedAgentTurnReceipt {
  return {
    task: {
      id: "task-artifact-agent",
      ordinal: 0,
      workspaceId: "workspace-p-1",
      planId: "plan-artifact-agent",
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: "workspace-p-1",
        id: "artifact-1",
        trackId: "track-1",
      },
      dependencyIds: [],
      capabilities: [],
      status: "materialization-pending",
      blockedReason: null,
      blockedByTaskId: null,
      pendingContextPolicy: null,
      currentAttempt: 0,
      materializationFailures: 0,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: null,
      createdAt: 2,
      finishedAt: null,
    },
    contextPackId: `context-pack-${"c".repeat(64)}`,
  };
}

function resourceReceipt(resourceId = "resource-1"): ScopedAgentTurnReceipt {
  const receipt = artifactReceipt();
  return {
    ...receipt,
    task: {
      ...receipt.task,
      id: "task-resource-agent",
      planId: "plan-resource-agent",
      kind: "resource",
      target: {
        type: "resource",
        workspaceId: "workspace-p-1",
        id: resourceId,
      },
    },
  };
}

function ArtifactAgentProbe({
  targetId,
  baseRevisionId = "revision-1",
  selection = [{ kind: "element" as const, id: "hero-cta", revisionId: baseRevisionId }],
  intent = "edit",
  agentCommand,
  model,
  refreshable = false,
}: {
  targetId: string;
  baseRevisionId?: string;
  selection?: ScopedAgentTurnInput["selection"];
  intent?: ScopedAgentTurnInput["intent"];
  agentCommand?: string;
  model?: string;
  refreshable?: boolean;
}) {
  const studio = useProjectStudio("p-1", targetId);
  if (studio.load.status !== "ready") return <output aria-label="Artifact Agent load">{studio.load.status}</output>;
  return (
    <section>
      <label>
        Artifact Agent prompt
        <textarea
          value={studio.workspaceAgentDraft}
          onChange={(event) => studio.setWorkspaceAgentDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => void studio.submitArtifactAgentPrompt({
          artifactId: targetId,
          baseRevisionId,
          selection,
          intent,
          agentCommand,
          model,
        })}
      >
        Queue artifact edit
      </button>
      {refreshable ? <button type="button" onClick={studio.retry}>Refresh project</button> : null}
      <output aria-label="Artifact Agent busy">{studio.artifactAgentSubmitting ? "busy" : "idle"}</output>
      <output aria-label="Artifact Agent error">{studio.artifactAgentError ?? "none"}</output>
      <output aria-label="Artifact Agent receipt">
        {studio.artifactAgentReceipt === null
          ? "none"
          : `Queued ${studio.artifactAgentReceipt.task.planId}`}
      </output>
    </section>
  );
}

function ResourceAgentProbe({
  targetId = "resource-1",
  agentCommand,
  model,
}: {
  targetId?: string;
  agentCommand?: string;
  model?: string;
}) {
  const studio = useProjectStudio("p-1", null, targetId);
  if (studio.load.status !== "ready") return <output aria-label="Resource Agent load">{studio.load.status}</output>;
  return (
    <section>
      <label>
        Resource Agent prompt
        <textarea
          value={studio.workspaceAgentDraft}
          onChange={(event) => studio.setWorkspaceAgentDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => studio.addAgentContextItems([{
          id: "artifact:artifact-context:revision-context",
          type: "context-ref",
          title: "Checkout context",
          ref: { kind: "artifact", id: "artifact-context", revisionId: "revision-context" },
        }])}
      >
        Add exact context
      </button>
      <button
        type="button"
        onClick={() => studio.addAgentContextItems([{
          id: "artifact:artifact-moving:head",
          type: "context-ref",
          title: "Moving artifact Head",
          ref: { kind: "artifact", id: "artifact-moving" },
        }])}
      >
        Add moving context
      </button>
      <button
        type="button"
        onClick={() => void studio.submitResourceAgentPrompt({
          resourceId: targetId,
          baseRevisionId: "resource-revision-1",
          agentCommand,
          model,
        })}
      >
        Queue resource task
      </button>
      <output aria-label="Resource Agent busy">{studio.resourceAgentSubmitting ? "busy" : "idle"}</output>
      <output aria-label="Resource Agent error">{studio.resourceAgentError ?? "none"}</output>
      <output aria-label="Resource Agent receipt">
        {studio.resourceAgentReceipt === null ? "none" : `Queued ${studio.resourceAgentReceipt.task.planId}`}
      </output>
      <output aria-label="Resource Agent transcript">{studio.agentTranscript.map((entry) => entry.content).join(" | ") || "none"}</output>
    </section>
  );
}

function MaterializeAgentContextProbe() {
  const studio = useProjectStudio("p-1");
  if (studio.load.status !== "ready") return <output aria-label="Agent attachment load">{studio.load.status}</output>;
  return (
    <section>
      <button
        type="button"
        onClick={() => void studio.materializeAgentResourceContext({
          title: "Product brief",
          kind: "file",
          source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
        })}
      >
        Materialize attachment
      </button>
      <output aria-label="Agent attachment context">
        {studio.agentContextItems.map(({ title }) => title).join(" | ") || "none"}
      </output>
    </section>
  );
}

function AgentScopeProbe({ targetId }: { targetId: string | null }) {
  const studio = useProjectStudio("p-1", targetId);
  if (studio.load.status !== "ready") return <output aria-label="Agent load">{studio.load.status}</output>;
  return (
    <section>
      <label>
        Current Agent prompt
        <textarea
          value={studio.workspaceAgentDraft}
          onChange={(event) => studio.setWorkspaceAgentDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => void (targetId === null
          ? studio.submitWorkspaceAgentPrompt()
          : studio.submitArtifactAgentPrompt({ artifactId: targetId, baseRevisionId: "revision-1" }))}
      >
        Submit current scope
      </button>
      {targetId === null ? (
        <>
          <button type="button" onClick={() => studio.setSelectedGraphObjectIds(["node-selected"])}>
            Select workspace node
          </button>
          <button type="button" onClick={studio.retry}>Refresh workspace</button>
          <button
            type="button"
            onClick={() => void studio.applyGraphCommands([{
              id: "rename-during-agent-turn",
              type: "rename-node",
              nodeId: "node-checkout",
              name: "Checkout advanced",
            }])}
          >
            Advance workspace canvas
          </button>
          <output aria-label="Workspace Agent error">{studio.workspaceAgentError ?? "none"}</output>
          <output aria-label="Workspace graph revision">{studio.load.workspace.graph.revision}</output>
        </>
      ) : null}
      <output aria-label="Current Agent busy">{studio.agentTurnSubmitting ? "busy" : "idle"}</output>
      <output aria-label="Proposal review state">{studio.proposalReview.status}</output>
    </section>
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/projects/p-1/canvas");
});

afterEach(cleanup);

test("Agent attachment materialization uses one atomic API instead of exposing an empty Resource", async () => {
  const ready = readyWorkspace("p-1");
  const resource = {
    id: "resource-attachment",
    workspaceId: ready.workspace.id,
    kind: "file" as const,
    title: "Product brief",
    headRevisionId: "revision-attachment",
    defaultPinPolicy: "pin-current" as const,
    archivedAt: null,
    createdAt: 2,
    updatedAt: 3,
  };
  const revision = {
    id: "revision-attachment",
    workspaceId: ready.workspace.id,
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resource-revisions/a/b/manifest.json",
    summary: "Uploaded file: brief.txt",
    metadata: {},
    checksum: "a".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 3,
  };
  const node = {
    id: "node-attachment",
    workspaceId: ready.workspace.id,
    kind: "resource" as const,
    name: resource.title,
    resourceId: resource.id,
  };
  const materializeResource = vi.fn(async () => ({
    resource,
    revision,
    node,
    graph: { ...ready.graph, revision: 2, nodes: [node] },
    snapshot: {
      ...ready.activeSnapshot,
      id: "snapshot-attachment",
      sequence: 3,
      graphRevision: 2,
      graph: { ...ready.graph, revision: 2, nodes: [node] },
      resourceRevisions: { [resource.id]: revision.id },
    },
  }));
  const createResource = vi.fn(async () => ({
    resource: { ...resource, headRevisionId: null },
    node,
    graph: { ...ready.graph, revision: 2, nodes: [node] },
    snapshot: { ...ready.activeSnapshot, id: "legacy-empty-snapshot" },
  }));
  const createResourceRevision = vi.fn(async () => revision);
  const publishResourceRevision = vi.fn(async () => ready.activeSnapshot);

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      materializeResource,
      createResource,
      createResourceRevision,
      publishResourceRevision,
    })}>
      <MaterializeAgentContextProbe />
    </ApiProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Materialize attachment" }));
  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  expect(createResource).not.toHaveBeenCalled();
  expect(createResourceRevision).not.toHaveBeenCalled();
  expect(publishResourceRevision).not.toHaveBeenCalled();
  expect(materializeResource).toHaveBeenCalledWith("p-1", {
    kind: "file",
    title: "Product brief",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: ready.graph.revision,
    expectedSnapshotId: ready.activeSnapshot.id,
    source: { type: "uploaded-file", uploadedFileId: ".refs/brief.txt" },
    reason: "Attached to scoped Agent Context",
  });
  expect(await screen.findByRole("status", { name: "Agent attachment context" })).toHaveTextContent("Product brief");
});

test("an attachment error from scope A does not invalidate the Agent composer in scope B", async () => {
  const ready = readyWorkspaceWithResources("p-1");
  const uploadRef = vi.fn(async () => {
    throw new Error("Scope A attachment failed");
  });
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      listResources: async () => ready.resources!,
      getResource: async (_projectId, resourceId) => ready.resources!.find((resource) => resource.id === resourceId)!,
      getResourceRevisionView: async (_projectId, resourceId) => resourceRevisionView(ready, resourceId),
      uploadRef,
    })}>
      <App />
    </ApiProvider>,
  );

  const scopeADraft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  const fileInput = rendered.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput!, {
    target: { files: [new File(["scope A"], "scope-a.txt", { type: "text/plain" })] },
  });

  await waitFor(() => expect(document.getElementById("workspace-agent-error")).toHaveTextContent(
    "Scope A attachment failed",
  ));
  expect(scopeADraft).toHaveAttribute("aria-invalid", "true");

  act(() => navigate("/projects/p-1/resources/resource-2"));

  const scopeBDraft = await screen.findByRole("textbox", { name: "Resource Agent draft" });
  expect(scopeBDraft).not.toHaveAttribute("aria-invalid");
  expect(scopeBDraft).not.toHaveAttribute("aria-describedby");
  expect(document.getElementById("workspace-agent-error")).toBeNull();
});

test("a successful scoped submission clears its attachment error and reveals queued status", async () => {
  const ready = readyWorkspaceWithResources("p-1");
  const resourceAgentTurn = vi.fn(async () => resourceReceipt("resource-1"));
  window.history.pushState({}, "", "/projects/p-1/resources/resource-1");
  const rendered = render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      listResources: async () => ready.resources!,
      getResource: async (_projectId, resourceId) => ready.resources!.find((resource) => resource.id === resourceId)!,
      getResourceRevisionView: async (_projectId, resourceId) => resourceRevisionView(ready, resourceId),
      uploadRef: async () => {
        throw new Error("Attachment upload failed");
      },
      resourceAgentTurn,
    })}>
      <App />
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Resource Agent draft" });
  const fileInput = rendered.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput!, {
    target: { files: [new File(["failed"], "failed.txt", { type: "text/plain" })] },
  });

  await waitFor(() => expect(document.getElementById("workspace-agent-error")).toHaveTextContent(
    "Attachment upload failed",
  ));
  expect(draft).toHaveAttribute("aria-invalid", "true");

  fireEvent.change(draft, { target: { value: "Use this exact Resource revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("status", { name: "Resource Agent task status" })).toHaveTextContent(
    "Queued · Plan plan-resource-agent",
  );
  expect(draft).not.toHaveAttribute("aria-invalid");
  expect(draft).not.toHaveAttribute("aria-describedby");
  expect(document.getElementById("workspace-agent-error")).toBeNull();
});

test("Workspace Agent submission creates a scoped draft and focuses Proposal review without a reload", async () => {
  const ready = readyWorkspace("p-1");
  const proposal = draftProposal(ready);
  const workspaceAgentTurn = vi.fn(async () => proposal);
  const getWorkspace = vi.fn(async () => ready);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace,
      workspaceAgentTurn,
    })}>
      <App />
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "  Create a checkout flow  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn).toHaveBeenCalledWith("p-1", {
    turnId: expect.stringMatching(CANONICAL_TURN_ID),
    message: "Create a checkout flow",
    explicitContext: [],
    graphRevision: 1,
    selection: [],
  }, expect.any(AbortSignal));
  expect(await screen.findByRole("region", { name: "Proposal review" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Workspace proposal" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Proposal rationale" })).toHaveValue(
    "Create a focused checkout flow",
  );
  expect(draft).toHaveValue("");
  expect(getWorkspace).toHaveBeenCalledTimes(1);
});

test("Design Workspace preserves the saved ready CodeBuddy Agent and model without rewriting Settings", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const updateSettings = vi.fn(async () => ({
    ...currentSettings,
    agentCommand: "codebuddy",
    model: "hunyuan",
  }));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "hunyuan",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ],
      updateSettings,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const picker = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(picker).toHaveTextContent("CodeBuddy"));
  expect(picker).toHaveTextContent("hunyuan");

  await user.click(picker);
  expect(await screen.findByRole("button", { name: /CodeBuddy/ })).toBeEnabled();
  expect(updateSettings).not.toHaveBeenCalled();
});

test("Workspace Agent freezes the selected CodeBuddy Agent and model into its turn request", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "hunyuan",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("hunyuan"));
  fireEvent.change(draft, { target: { value: "Build with the selected provider" } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    agentCommand: "codebuddy",
    model: "hunyuan",
  }));
});

test("Design Workspace disables ready Codex while CodeBuddy remains usable", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const updateSettings = vi.fn(async () => ({
    ...currentSettings,
    agentCommand: "codebuddy",
    model: "",
  }));
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({ ...currentSettings, agentCommand: "codex", model: "gpt-5" }),
      listAgents: async () => [
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
      ],
      updateSettings,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Build a complete workspace" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Design Workspace generation requires Claude Code or CodeBuddy.",
  );
  const submit = screen.getByRole("button", { name: "Create proposal" });
  expect(submit).toBeDisabled();

  const picker = screen.getByRole("button", { name: "Agent and model" });
  await user.click(picker);
  const codex = await screen.findByRole("button", { name: /^Codex/ });
  expect(codex).toBeDisabled();
  expect(codex).toHaveTextContent("Design Workspace generation requires Claude Code or CodeBuddy.");
  const codebuddy = screen.getByRole("button", { name: /^CodeBuddy/ });
  expect(codebuddy).toBeEnabled();
  await user.click(codebuddy);
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agentCommand: "codebuddy", model: "" }));
  await user.keyboard("{Escape}");

  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: "Build a complete workspace",
    agentCommand: "codebuddy",
  }));
});

test("a new Standard Design Workspace consumes the Home brief and CodeBuddy selection exactly once", async () => {
  const user = userEvent.setup();
  const createdProject = { ...project("p-new"), name: "Fresh workspace" };
  const ready = readyWorkspace("p-new");
  const currentSettings = await makeFakeApi().getSettings();
  const createProject = vi.fn(async () => createdProject);
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.home.composer", JSON.stringify({ mode: "standard" }));

  render(
    <StrictMode>
      <ApiProvider client={makeFakeApi({
        createProject,
        getProject: async () => createdProject,
        getWorkspace: async () => ready,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "hunyuan",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
        ],
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </StrictMode>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("hunyuan"));
  expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Standard");
  fireEvent.change(screen.getByLabelText("Describe your design"), {
    target: { value: "Create a complete music discovery workspace" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: "Create a complete music discovery workspace",
    agentCommand: "codebuddy",
    model: "hunyuan",
  }));

  act(() => navigate("/"));
  await screen.findByLabelText("Describe your design");
  act(() => navigate("/projects/p-new/canvas"));
  await screen.findByRole("region", { name: "Project canvas" });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);
});

test("Workspace Agent persists changed Agent and Design System context before creating a proposal", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentProject = project("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveSettings!: (settings: typeof currentSettings) => void;
  let resolveProject!: (project: Project) => void;
  let settingsWrite!: Promise<typeof currentSettings>;
  let projectWrite!: Promise<Project>;
  const updateSettings = vi.fn(() => (settingsWrite = new Promise<typeof currentSettings>((resolve) => {
    resolveSettings = resolve;
  })));
  const patchProject = vi.fn(() => (projectWrite = new Promise<Project>((resolve) => {
    resolveProject = resolve;
  })));
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => currentProject,
      getWorkspace: async () => ready,
      getSettings: async () => ({ ...currentSettings, agentCommand: "codex", model: "gpt-5" }),
      listAgents: async () => [
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "spotify", name: "Spotify", category: "Brand", summary: "", origin: "built-in" },
      ],
      updateSettings,
      patchProject,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  expect(await screen.findByRole("button", { name: "Back to projects" })).toHaveTextContent("Project p-1");
  const agentPicker = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(agentPicker).toHaveTextContent("Codex"));
  expect(agentPicker).toHaveTextContent("gpt-5");
  expect(updateSettings).not.toHaveBeenCalled();
  await user.click(agentPicker);
  const claude = await screen.findByRole("button", { name: /^Claude Code/ });
  expect(claude).toBeEnabled();
  await user.click(claude);
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agentCommand: "claude", model: "" }));
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /Spotify/ }));
  await waitFor(() => expect(patchProject).toHaveBeenCalledWith("p-1", { designSystemId: "spotify" }));

  const draft = screen.getByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Build a complete music workspace" } });
  expect(draft).toHaveValue("Build a complete music workspace");
  const submit = screen.getByRole("button", { name: "Create proposal" });
  expect(submit).toBeDisabled();

  await act(async () => {
    resolveSettings({ ...currentSettings, agentCommand: "claude", model: "" });
    await settingsWrite;
  });
  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  await act(async () => {
    resolveProject({ ...currentProject, designSystemId: "spotify" });
    await projectWrite;
  });

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1].message).toBe("Build a complete music workspace");
});

test("Workspace Agent blocks generation when a changed Agent selection cannot be persisted", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const workspaceAgentTurn = vi.fn(async () => draftProposal(ready));
  const updateSettings = vi.fn(async () => {
    throw new Error("Settings storage unavailable");
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({ ...currentSettings, agentCommand: "codex", model: "gpt-5" }),
      listAgents: async () => [
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5"] },
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ],
      updateSettings,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const agentPicker = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(agentPicker).toHaveTextContent("Codex"));
  await user.click(agentPicker);
  await user.click(await screen.findByRole("button", { name: /^Claude Code/ }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agentCommand: "claude", model: "" }));
  await user.keyboard("{Escape}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't save the selected Agent setting. Choose it again to retry.",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Build a safe workspace" },
  });
  expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
});

test("Workspace Agent stays blocked until Agent discovery and Settings initialization finish", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveAgents!: (value: AgentInfo[]) => void;
  let resolveSettings!: (value: typeof currentSettings) => void;
  const agents = new Promise<AgentInfo[]>((resolve) => {
    resolveAgents = resolve;
  });
  const settings = new Promise<typeof currentSettings>((resolve) => {
    resolveSettings = resolve;
  });
  const workspaceAgentTurn = vi.fn(async () => draftProposal(ready));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => settings,
      listAgents: async () => agents,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Wait for exact provider context" } });
  const submit = screen.getByRole("button", { name: "Create proposal" });
  expect(submit).toBeDisabled();
  expect(screen.getByText("Checking Agent availability…")).toBeInTheDocument();

  await act(async () => {
    resolveAgents([
      { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
    ]);
    await agents;
  });
  expect(submit).toBeDisabled();
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  await act(async () => {
    resolveSettings({ ...currentSettings, agentCommand: "claude", model: "" });
    await settings;
  });
  await waitFor(() => expect(submit).toBeEnabled());
});

test("Workspace Agent waits for the latest serialized Design System write before submitting", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentProject = project("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const pendingProjectWrites: Array<(value: Project) => void> = [];
  const patchProject = vi.fn(() => new Promise<Project>((resolve) => {
    pendingProjectWrites.push(resolve);
  }));
  const workspaceAgentTurn = vi.fn(async () => draftProposal(ready));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => currentProject,
      getWorkspace: async () => ready,
      getSettings: async () => ({ ...currentSettings, agentCommand: "claude", model: "" }),
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "spotify", name: "Spotify", category: "Brand", summary: "", origin: "built-in" },
      ],
      patchProject,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /Spotify/ }));
  await waitFor(() => expect(patchProject).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Build the latest selected direction" },
  });
  await user.click(screen.getByRole("button", { name: "Create proposal" }));
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /Modern Minimal/ }));
  expect(patchProject).toHaveBeenCalledTimes(1);

  await act(async () => {
    pendingProjectWrites[0]!({ ...currentProject, designSystemId: "spotify" });
  });
  await waitFor(() => expect(patchProject).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  await act(async () => {
    pendingProjectWrites[1]!({ ...currentProject, designSystemId: "modern-minimal" });
  });
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
});

test("StrictMode navigation cancels a submission waiting for Design System persistence", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentProject = project("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveProject!: (value: Project) => void;
  const patchProject = vi.fn(() => new Promise<Project>((resolve) => {
    resolveProject = resolve;
  }));
  const workspaceAgentTurn = vi.fn(async () => draftProposal(ready));
  render(
    <StrictMode>
      <ApiProvider client={makeFakeApi({
        getProject: async () => currentProject,
        getWorkspace: async () => ready,
        getSettings: async () => ({ ...currentSettings, agentCommand: "claude", model: "" }),
        listAgents: async () => [
          { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        ],
        listDesignSystems: async () => [
          { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
          { id: "spotify", name: "Spotify", category: "Brand", summary: "", origin: "built-in" },
        ],
        patchProject,
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </StrictMode>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /Spotify/ }));
  await waitFor(() => expect(patchProject).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Do not submit after leaving" },
  });
  await user.click(screen.getByRole("button", { name: "Create proposal" }));
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Back to projects" }));
  await act(async () => {
    resolveProject({ ...currentProject, designSystemId: "spotify" });
  });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Project canvas" })).not.toBeInTheDocument());
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
});

test("opening a pinned Resource Revision cancels a Head submission waiting for context persistence", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspaceWithResources("p-1");
  const currentProject = project("p-1");
  let resolveProject!: (value: Project) => void;
  const patchProject = vi.fn(() => new Promise<Project>((resolve) => {
    resolveProject = resolve;
  }));
  const resourceAgentTurn = vi.fn(async () => resourceReceipt("resource-1"));
  window.history.pushState({}, "", "/projects/p-1/resources/resource-1");
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => currentProject,
      getWorkspace: async () => ready,
      listResources: async () => ready.resources!,
      getResource: async (_projectId, resourceId) => ready.resources!.find((resource) => resource.id === resourceId)!,
      getResourceRevisionView: async (_projectId, resourceId) => resourceRevisionView(ready, resourceId),
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "spotify", name: "Spotify", category: "Brand", summary: "", origin: "built-in" },
      ],
      patchProject,
      resourceAgentTurn,
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByRole("textbox", { name: "Resource Agent draft" });
  await user.click(screen.getByRole("button", { name: "Design system" }));
  await user.click(await screen.findByRole("button", { name: /Spotify/ }));
  await waitFor(() => expect(patchProject).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole("textbox", { name: "Resource Agent draft" }), {
    target: { value: "Only submit against Resource Head" },
  });
  await user.click(screen.getByRole("button", { name: "Queue resource task" }));
  expect(resourceAgentTurn).not.toHaveBeenCalled();

  act(() => navigate("/projects/p-1/resources/resource-1/revisions/resource-1-revision-1"));
  expect(await screen.findByText("Resource Agent is read-only while viewing a pinned Revision.")).toBeInTheDocument();
  await act(async () => {
    resolveProject({ ...currentProject, designSystemId: "spotify" });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.queryByRole("button", { name: "Queue resource task" })).not.toBeInTheDocument();
  expect(resourceAgentTurn).not.toHaveBeenCalled();
});

test("Workspace Agent reuses its turnId only for an unchanged failed request", async () => {
  let attempt = 0;
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return draftProposal(ready);
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      workspaceAgentTurn,
    })}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Keep the exact checkout direction" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  expect(await screen.findByRole("status", { name: "Workspace Agent error" })).toHaveTextContent("Failed to fetch");
  const firstTurnId = workspaceAgentTurn.mock.calls[0]![1].turnId;

  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).toBe(firstTurnId);
  expect(firstTurnId).toMatch(CANONICAL_TURN_ID);
});

test("Workspace Agent rotates turnId when message, selection, or graph identity changes", async () => {
  let workspace = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => { throw new TypeError("Failed to fetch"); });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => workspace,
      workspaceAgentTurn,
    })}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );
  let prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  const waitForFailure = async (count: number) => {
    await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(count));
    await screen.findByText("Failed to fetch");
    await act(async () => undefined);
  };

  fireEvent.change(prompt, { target: { value: "Plan the checkout" } });
  submit();
  await waitForFailure(1);
  const turnIds = [workspaceAgentTurn.mock.calls[0]![1].turnId];

  fireEvent.change(prompt, { target: { value: "Plan the checkout with reassurance" } });
  submit();
  await waitForFailure(2);
  turnIds.push(workspaceAgentTurn.mock.calls[1]![1].turnId);

  fireEvent.click(screen.getByRole("button", { name: "Select workspace node" }));
  submit();
  await waitForFailure(3);
  turnIds.push(workspaceAgentTurn.mock.calls[2]![1].turnId);
  expect(workspaceAgentTurn.mock.calls[2]![1].selection).toEqual([{ kind: "node", id: "node-selected" }]);

  const nextGraph = { ...workspace.graph, revision: 2 };
  const nextSnapshot = {
    ...workspace.activeSnapshot,
    id: "snapshot-p-1-2",
    graphRevision: 2,
    graph: nextGraph,
  };
  workspace = {
    ...workspace,
    workspace: { ...workspace.workspace, graphRevision: 2, activeSnapshotId: nextSnapshot.id },
    graph: nextGraph,
    activeSnapshot: nextSnapshot,
    snapshots: [nextSnapshot],
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Submit current scope" })).toBeEnabled());
  submit();
  await waitForFailure(4);
  turnIds.push(workspaceAgentTurn.mock.calls[3]![1].turnId);

  expect(new Set(turnIds)).toHaveLength(turnIds.length);
  expect(workspaceAgentTurn.mock.calls[3]![1].graphRevision).toBe(2);
  expect(prompt).toHaveValue("Plan the checkout with reassurance");
});

test("Workspace Agent clears its retry identity after success", async () => {
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      workspaceAgentTurn,
    })}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );
  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Plan the same checkout" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(prompt).toHaveValue(""));
  const firstTurnId = workspaceAgentTurn.mock.calls[0]![1].turnId;

  fireEvent.change(prompt, { target: { value: "Plan the same checkout" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).not.toBe(firstTurnId);
});

test("Workspace Agent safely restores the current terminal Proposal on replay", async () => {
  const ready = readyWorkspace("p-1");
  const rejected: WorkspaceProposal = {
    ...draftProposal(ready),
    status: "rejected",
    review: { kind: "rejected" },
  };
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      workspaceAgentTurn: async () => rejected,
    })}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );
  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Replay the reviewed checkout" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));

  expect(await screen.findByRole("status", { name: "Proposal review state" })).toHaveTextContent("rejected");
  expect(screen.getByRole("status", { name: "Workspace Agent error" })).toHaveTextContent("none");
  expect(prompt).toHaveValue("");
});

test("Workspace Agent restores an exact stale draft replay after the canvas advances", async () => {
  const initial = readyWorkspace("p-1");
  const originalGraph = {
    ...initial.graph,
    nodes: [{
      id: "node-checkout",
      workspaceId: initial.workspace.id,
      kind: "page" as const,
      name: "Checkout",
      artifactId: "artifact-checkout",
    }],
  };
  const originalSnapshot = { ...initial.activeSnapshot, graph: originalGraph };
  const original = {
    ...initial,
    graph: originalGraph,
    activeSnapshot: originalSnapshot,
    snapshots: [originalSnapshot],
  };
  const proposal = draftProposal(original);
  let resolveTurn!: (value: WorkspaceProposal) => void;
  const workspaceAgentTurn = vi.fn((
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => new Promise<WorkspaceProposal>((resolve) => { resolveTurn = resolve; }));
  const nextGraph = {
    ...original.graph,
    revision: 2,
    nodes: original.graph.nodes.map((node) => ({ ...node, name: "Checkout advanced" })),
  };
  const nextSnapshot = {
    ...original.activeSnapshot,
    id: "snapshot-p-1-advanced",
    sequence: 2,
    graphRevision: 2,
    graph: nextGraph,
  };
  const applyWorkspaceGraphCommands = vi.fn(async () => ({ graph: nextGraph, snapshot: nextSnapshot }));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => original,
      applyWorkspaceGraphCommands,
      workspaceAgentTurn,
    })}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );
  let prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Recover the original checkout draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Advance workspace canvas" }));
  await waitFor(() => expect(applyWorkspaceGraphCommands).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(
    screen.getByRole("status", { name: "Workspace graph revision" }),
  ).toHaveTextContent("2"));

  await act(async () => { resolveTurn(proposal); });

  await waitFor(() => expect(
    screen.getByRole("status", { name: "Proposal review state" }),
  ).toHaveTextContent("draft"));
  expect(screen.getByRole("status", { name: "Workspace Agent error" })).toHaveTextContent("none");
  expect(prompt).toHaveValue("");
  expect(workspaceAgentTurn.mock.calls[0]![1].graphRevision).toBe(1);
});

test("Workspace Agent aborts an in-flight turn when the Project changes", async () => {
  let observedSignal: AbortSignal | null = null;
  const workspaceAgentTurn = vi.fn((_projectId: string, _input: unknown, signal?: AbortSignal) => {
    observedSignal = signal ?? null;
    return new Promise<WorkspaceProposal>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async (id) => project(id),
      getWorkspace: async (id) => readyWorkspace(id),
      workspaceAgentTurn,
    })}>
      <App />
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Plan a checkout flow" } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));

  act(() => navigate("/projects/p-2/canvas"));

  await waitFor(() => expect(observedSignal?.aborted).toBe(true));
  expect(await screen.findByRole("heading", { name: "Project p-2" })).toBeInTheDocument();
  expect(screen.queryByRole("alert", { name: /Workspace Agent/i })).not.toBeInTheDocument();
});

test("Artifact Agent queues the exact active Revision and exposes a durable Plan receipt", async () => {
  const artifactAgentTurn = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    _input: ScopedAgentTurnInput,
  ) => artifactReceipt());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      artifactAgentTurn,
    })}>
      <ArtifactAgentProbe targetId="artifact-1" />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "  Refine the selected CTA  " } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));

  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));
  expect(artifactAgentTurn).toHaveBeenCalledWith("p-1", "artifact-1", {
    turnId: expect.stringMatching(CANONICAL_TURN_ID),
    intent: "edit",
    message: "Refine the selected CTA",
    explicitContext: [],
    graphRevision: 1,
    baseRevisionId: "revision-1",
    selection: [{ kind: "element", id: "hero-cta", revisionId: "revision-1" }],
  }, expect.any(AbortSignal));
  expect(await screen.findByRole("status", { name: "Artifact Agent receipt" })).toHaveTextContent(
    "Queued plan-artifact-agent",
  );
  expect(screen.getByRole("status", { name: "Artifact Agent busy" })).toHaveTextContent("idle");
  expect(screen.getByRole("status", { name: "Artifact Agent error" })).toHaveTextContent("none");
  expect(prompt).toHaveValue("");
});

test("Artifact Agent freezes the selected CodeBuddy Agent and model into its turn request", async () => {
  const artifactAgentTurn = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    _input: ScopedAgentTurnInput,
  ) => artifactReceipt());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      artifactAgentTurn,
    })}>
      <ArtifactAgentProbe
        targetId="artifact-1"
        agentCommand="codebuddy"
        model="hunyuan"
      />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByRole("textbox", { name: "Artifact Agent prompt" }), {
    target: { value: "Refine with the selected provider" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));

  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));
  expect(artifactAgentTurn.mock.calls[0]![2]).toEqual(expect.objectContaining({
    agentCommand: "codebuddy",
    model: "hunyuan",
  }));
});

test("Artifact Agent reuses its canonical turnId when the unchanged draft is retried", async () => {
  let attempt = 0;
  const artifactAgentTurn = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    _input: ScopedAgentTurnInput,
    _signal?: AbortSignal,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return artifactReceipt();
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      artifactAgentTurn,
    })}>
      <ArtifactAgentProbe targetId="artifact-1" />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Keep the visual hierarchy" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  expect(await screen.findByRole("status", { name: "Artifact Agent error" })).toHaveTextContent("Failed to fetch");
  const firstTurnId = artifactAgentTurn.mock.calls[0]![2].turnId;

  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(2));
  expect(artifactAgentTurn.mock.calls[1]![2].turnId).toBe(firstTurnId);
  expect(firstTurnId).toMatch(CANONICAL_TURN_ID);
});

test("Artifact Agent rotates turnId after the user edits a failed draft", async () => {
  let attempt = 0;
  const artifactAgentTurn = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    _input: ScopedAgentTurnInput,
    _signal?: AbortSignal,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return artifactReceipt();
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      artifactAgentTurn,
    })}>
      <ArtifactAgentProbe targetId="artifact-1" />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Keep the visual hierarchy" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  expect(await screen.findByRole("status", { name: "Artifact Agent error" })).toHaveTextContent("Failed to fetch");
  const firstTurnId = artifactAgentTurn.mock.calls[0]![2].turnId;

  fireEvent.change(prompt, { target: { value: "Keep the visual hierarchy and tighten spacing" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(2));
  expect(artifactAgentTurn.mock.calls[1]![2].turnId).not.toBe(firstTurnId);
});

test("Artifact Agent rotates turnId whenever immutable request facts change without a draft edit", async () => {
  let workspace = readyWorkspace("p-1");
  const artifactAgentTurn = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    _input: ScopedAgentTurnInput,
    _signal?: AbortSignal,
  ) => { throw new TypeError("Failed to fetch"); });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => workspace,
    artifactAgentTurn,
  });
  const view = render(
    <ApiProvider client={api}>
      <ArtifactAgentProbe targetId="artifact-1" refreshable />
    </ApiProvider>,
  );
  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Keep the visual hierarchy" } });
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  const failed = async (count: number) => {
    await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(count));
    await screen.findByText("Failed to fetch");
  };

  submit();
  await failed(1);
  const turnIds = [artifactAgentTurn.mock.calls[0]![2].turnId];

  view.rerender(
    <ApiProvider client={api}>
      <ArtifactAgentProbe
        targetId="artifact-1"
        selection={[{ kind: "element", id: "secondary-cta", revisionId: "revision-1" }]}
        refreshable
      />
    </ApiProvider>,
  );
  submit();
  await failed(2);
  turnIds.push(artifactAgentTurn.mock.calls[1]![2].turnId);

  view.rerender(
    <ApiProvider client={api}>
      <ArtifactAgentProbe targetId="artifact-1" intent="repair" refreshable />
    </ApiProvider>,
  );
  submit();
  await failed(3);
  turnIds.push(artifactAgentTurn.mock.calls[2]![2].turnId);

  view.rerender(
    <ApiProvider client={api}>
      <ArtifactAgentProbe targetId="artifact-1" baseRevisionId="revision-2" refreshable />
    </ApiProvider>,
  );
  submit();
  await failed(4);
  turnIds.push(artifactAgentTurn.mock.calls[3]![2].turnId);

  const nextGraph = { ...workspace.graph, revision: 2 };
  const nextSnapshot = {
    ...workspace.activeSnapshot,
    id: "snapshot-p-1-2",
    graphRevision: 2,
    graph: nextGraph,
  };
  workspace = {
    ...workspace,
    workspace: {
      ...workspace.workspace,
      graphRevision: 2,
      activeSnapshotId: nextSnapshot.id,
    },
    graph: nextGraph,
    activeSnapshot: nextSnapshot,
    snapshots: [nextSnapshot],
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh project" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Queue artifact edit" })).toBeEnabled());
  submit();
  await failed(5);
  turnIds.push(artifactAgentTurn.mock.calls[4]![2].turnId);

  expect(new Set(turnIds)).toHaveLength(turnIds.length);
  expect(artifactAgentTurn.mock.calls[4]![2].graphRevision).toBe(2);
  expect(prompt).toHaveValue("Keep the visual hierarchy");
});

test("changing Agent scope aborts the old turn, releases submitting state, and rejects its late result", async () => {
  const ready = readyWorkspace("p-1");
  let observedSignal: AbortSignal | null = null;
  let resolveWorkspaceTurn!: (proposal: WorkspaceProposal) => void;
  const workspaceAgentTurn = vi.fn((_projectId: string, _input: unknown, signal?: AbortSignal) => {
    observedSignal = signal ?? null;
    return new Promise<WorkspaceProposal>((resolve) => { resolveWorkspaceTurn = resolve; });
  });
  const artifactAgentTurn = vi.fn(async () => artifactReceipt());
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => ready,
    workspaceAgentTurn,
    artifactAgentTurn,
  });
  const view = render(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );

  const workspaceDraft = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(workspaceDraft, { target: { value: "Plan a checkout system" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));

  view.rerender(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId="artifact-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(observedSignal?.aborted).toBe(true));
  expect(screen.getByRole("status", { name: "Current Agent busy" })).toHaveTextContent("idle");
  expect(screen.getByRole("textbox", { name: "Current Agent prompt" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Current Agent prompt" }), {
    target: { value: "Refine the active artifact" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));

  await act(async () => { resolveWorkspaceTurn(draftProposal(ready)); });
  expect(screen.getByRole("status", { name: "Proposal review state" })).toHaveTextContent("idle");
  expect(screen.getByRole("status", { name: "Current Agent busy" })).toHaveTextContent("idle");
});

test("Artifact Agent aborts and discards an in-flight receipt when its target changes", async () => {
  let observedSignal: AbortSignal | null = null;
  const artifactAgentTurn = vi.fn((_projectId: string, _artifactId: string, _input: unknown, signal?: AbortSignal) => {
    observedSignal = signal ?? null;
    return new Promise<ScopedAgentTurnReceipt>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => readyWorkspace("p-1"),
    artifactAgentTurn,
  });
  const view = render(
    <ApiProvider client={api}>
      <ArtifactAgentProbe targetId="artifact-1" />
    </ApiProvider>,
  );
  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Refine the CTA" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));

  view.rerender(
    <ApiProvider client={api}>
      <ArtifactAgentProbe targetId="artifact-2" />
    </ApiProvider>,
  );

  await waitFor(() => expect(observedSignal?.aborted).toBe(true));
  expect(screen.getByRole("status", { name: "Artifact Agent receipt" })).toHaveTextContent("none");
  expect(screen.getByRole("status", { name: "Artifact Agent error" })).toHaveTextContent("none");
});

test("Artifact Agent keeps scoped errors and the draft without disturbing Workspace Agent state", async () => {
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      artifactAgentTurn: async () => {
        throw new Error("The Artifact Head changed");
      },
    })}>
      <ArtifactAgentProbe targetId="artifact-1" />
    </ApiProvider>,
  );
  const prompt = await screen.findByRole("textbox", { name: "Artifact Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Keep this exact draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));

  expect(await screen.findByRole("status", { name: "Artifact Agent error" })).toHaveTextContent(
    "The Artifact Head changed",
  );
  expect(screen.getByRole("status", { name: "Artifact Agent receipt" })).toHaveTextContent("none");
  expect(prompt).toHaveValue("Keep this exact draft");
});

test("Resource Agent submits its exact target Revision and daemon-owned Context refs", async () => {
  const resourceAgentTurn = vi.fn(async (
    _projectId: string,
    _resourceId: string,
    _input: ScopedAgentTurnInput,
  ) => resourceReceipt());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      resourceAgentTurn,
    })}>
      <ResourceAgentProbe />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Resource Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Use this research to sharpen the checkout direction" } });
  fireEvent.click(screen.getByRole("button", { name: "Add exact context" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(1));
  expect(resourceAgentTurn).toHaveBeenCalledWith("p-1", "resource-1", {
    turnId: expect.stringMatching(CANONICAL_TURN_ID),
    intent: "edit",
    message: "Use this research to sharpen the checkout direction",
    explicitContext: [{ kind: "artifact", id: "artifact-context", revisionId: "revision-context" }],
    graphRevision: 1,
    baseRevisionId: "resource-revision-1",
    selection: [],
  }, expect.any(AbortSignal));
  expect(await screen.findByRole("status", { name: "Resource Agent receipt" })).toHaveTextContent("plan-resource-agent");
  expect(prompt).toHaveValue("");
  expect(screen.getByRole("status", { name: "Resource Agent transcript" })).toHaveTextContent(
    "Use this research to sharpen the checkout direction",
  );
  expect(screen.getByRole("status", { name: "Resource Agent transcript" })).toHaveTextContent(
    "Queued Task task-resource-agent in Plan plan-resource-agent",
  );
});

test("Resource Agent freezes the selected CodeBuddy Agent and model into its turn request", async () => {
  const resourceAgentTurn = vi.fn(async (
    _projectId: string,
    _resourceId: string,
    _input: ScopedAgentTurnInput,
  ) => resourceReceipt());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      resourceAgentTurn,
    })}>
      <ResourceAgentProbe agentCommand="codebuddy" model="hunyuan" />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByRole("textbox", { name: "Resource Agent prompt" }), {
    target: { value: "Ground this resource task with the selected provider" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(1));
  expect(resourceAgentTurn.mock.calls[0]![2]).toEqual(expect.objectContaining({
    agentCommand: "codebuddy",
    model: "hunyuan",
  }));
});

test("Resource Agent reports moving Context identities before any request leaves the browser", async () => {
  const resourceAgentTurn = vi.fn(async () => resourceReceipt());
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      resourceAgentTurn,
    })}>
      <ResourceAgentProbe />
    </ApiProvider>,
  );

  fireEvent.change(await screen.findByRole("textbox", { name: "Resource Agent prompt" }), {
    target: { value: "Do not resolve a moving Head" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add moving context" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));

  expect(await screen.findByRole("status", { name: "Resource Agent error" })).toHaveTextContent("immutable Revision");
  expect(resourceAgentTurn).not.toHaveBeenCalled();
});

test("Resource Agent reconciles a persisted outbox with the same turnId after remount", async () => {
  let attempt = 0;
  const resourceAgentTurn = vi.fn(async (
    _projectId: string,
    _resourceId: string,
    _input: ScopedAgentTurnInput,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Response connection closed");
    return resourceReceipt();
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => readyWorkspace("p-1"),
    resourceAgentTurn,
  });
  const first = render(
    <ApiProvider client={api}>
      <ResourceAgentProbe />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Resource Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Preserve this exact lost-response request" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));
  expect(await screen.findByRole("status", { name: "Resource Agent error" })).toHaveTextContent("Response connection closed");
  const firstTurnId = resourceAgentTurn.mock.calls[0]![2].turnId;
  first.unmount();

  render(
    <ApiProvider client={api}>
      <ResourceAgentProbe />
    </ApiProvider>,
  );

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(2));
  expect(resourceAgentTurn.mock.calls[1]![2].turnId).toBe(firstTurnId);
  expect(resourceAgentTurn.mock.calls[1]![2].message).toBe("Preserve this exact lost-response request");
  expect(await screen.findByRole("status", { name: "Resource Agent receipt" })).toHaveTextContent("plan-resource-agent");
  expect(screen.getByRole("textbox", { name: "Resource Agent prompt" })).toHaveValue("");
  expect(screen.getByRole("status", { name: "Resource Agent transcript" })).toHaveTextContent(
    "Queued Task task-resource-agent in Plan plan-resource-agent",
  );
});

test("Resource Agent reconciles a persisted outbox after an A to B to A scope round trip", async () => {
  let attempt = 0;
  const resourceAgentTurn = vi.fn(async (
    _projectId: string,
    _resourceId: string,
    _input: ScopedAgentTurnInput,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Response connection closed during scope A");
    return resourceReceipt();
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => readyWorkspace("p-1"),
    resourceAgentTurn,
  });
  const rendered = render(
    <ApiProvider client={api}>
      <ResourceAgentProbe targetId="resource-1" />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Resource Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Replay this exact request when I return to scope A" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));
  expect(await screen.findByRole("status", { name: "Resource Agent error" })).toHaveTextContent(
    "Response connection closed during scope A",
  );
  const firstTurnId = resourceAgentTurn.mock.calls[0]![2].turnId;

  rendered.rerender(
    <ApiProvider client={api}>
      <ResourceAgentProbe targetId="resource-2" />
    </ApiProvider>,
  );
  rendered.rerender(
    <ApiProvider client={api}>
      <ResourceAgentProbe targetId="resource-1" />
    </ApiProvider>,
  );

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(2));
  expect(resourceAgentTurn.mock.calls[1]![2].turnId).toBe(firstTurnId);
  expect(resourceAgentTurn.mock.calls[1]![2].message).toBe(
    "Replay this exact request when I return to scope A",
  );
  expect(await screen.findByRole("status", { name: "Resource Agent receipt" })).toHaveTextContent(
    "plan-resource-agent",
  );
});
