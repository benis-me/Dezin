import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../App.tsx";
import { AgentsProvider } from "../lib/agents-context.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import { decodeWorkspaceAgentConversation } from "../../../../packages/core/src/workspace-agent-conversation.ts";
import { ApiError } from "../lib/api.ts";
import { workspaceAgentRequestFingerprint } from "../lib/workspace-agent-request-fingerprint.ts";
import { ToastProvider } from "../components/Toast.tsx";
import type {
  AgentInfo,
  MaterializeResourceInput,
  MaterializeResourceResult,
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
import { NO_DESIGN_SYSTEM_ID } from "../lib/design-system-selection.ts";
import { publishSettingsUpdated } from "../lib/settings-events.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { validPngFile } from "../test/image-fixtures.ts";
import {
  peekPendingDesignWorkspaceTurn,
  setPendingDesignWorkspaceTurn,
  takePendingImages,
  takePendingRefs,
} from "../lib/pending-brief.ts";
import {
  WORKSPACE_AGENT_SCOPE,
  writeAgentSession,
} from "./scoped-agent-session.ts";
import { claimPendingTurnReplacement } from "./pending-turn-supersession.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const CANONICAL_TURN_ID = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INITIAL_TURN_ID = "turn-00000000-0000-4000-8000-000000000001";

function pendingTurnStorageKey(projectId: string): string {
  return `dezin.pending.design-workspace-turn:${encodeURIComponent(projectId)}`;
}

function workspaceAgentSessionStorageKey(projectId: string): string {
  return `dezin.project-studio.agent.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(WORKSPACE_AGENT_SCOPE)}`;
}

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

function RecoveryReservationProbe() {
  const studio = useProjectStudio("p-1");
  if (studio.load.status !== "ready") return <output aria-label="Recovery reservation load">{studio.load.status}</output>;
  return (
    <section>
      <label>
        Recovery reservation prompt
        <textarea
          value={studio.workspaceAgentDraft}
          onChange={(event) => studio.setWorkspaceAgentDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => studio.setSelectedGraphObjectIds(["node-resource-1"])}
      >
        Select exact Resource
      </button>
      <button
        type="button"
        onClick={() => studio.setAgentContextItems([{
          id: "resource:context-latest:revision-context-latest",
          type: "context-ref",
          title: "Latest composer context",
          ref: {
            kind: "resource",
            id: "context-latest",
            resourceKind: "file",
            revisionId: "revision-context-latest",
          },
          projectId: "p-1",
          revisionId: "revision-context-latest",
        }])}
      >
        Replace composer Context
      </button>
      <button
        type="button"
        onClick={() => void studio.submitWorkspaceAgentPrompt({
          reserveTurn: async (facts) => {
            const current = peekPendingDesignWorkspaceTurn("p-1");
            if (current === null) return null;
            const expectedActiveTurnId = current.supersededByTurnId ?? current.turnId;
            const claim = await claimPendingTurnReplacement({
              projectId: "p-1",
              expectedActiveTurnId,
              reservation: {
                ...facts,
                contextItems: facts.contextItems.map(({ previewUrl: _previewUrl, type: _type, ...item }) => item),
              },
            });
            if (claim.status !== "claimed" && claim.status !== "reused") return null;
            return {
              turnId: claim.turnId,
              isCurrent: () => {
                const latest = peekPendingDesignWorkspaceTurn("p-1");
                return latest?.supersededByTurnId === claim.turnId
                  && latest.recoveryRequest?.fingerprint === facts.fingerprint;
              },
            };
          },
        })}
      >
        Reserve exact recovery
      </button>
      <output aria-label="Recovery reservation error">{studio.workspaceAgentError ?? "none"}</output>
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => project("p-1"),
        getWorkspace: async () => ready,
        listResources: async () => ready.resources!,
        getResource: async (_projectId, resourceId) => ready.resources!.find((resource) => resource.id === resourceId)!,
        getResourceRevisionView: async (_projectId, resourceId) => resourceRevisionView(ready, resourceId),
        uploadRef,
      })}>
        <App />
      </ApiProvider>
    </ToastProvider>,
  );

  const scopeADraft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  const fileInput = rendered.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput!, {
    target: { files: [new File(["scope A"], "scope-a.txt", { type: "text/plain" })] },
  });

  const scopeAError = await screen.findByRole("alert");
  expect(scopeAError).toHaveTextContent("Scope A attachment failed");
  expect(scopeAError.closest('[aria-label="Notifications"]')).not.toBeNull();
  expect(document.querySelector("[data-workspace-agent-error]")).toBeNull();
  expect(scopeADraft).not.toHaveAttribute("aria-invalid");

  act(() => navigate("/projects/p-1/resources/resource-2"));

  const scopeBDraft = await screen.findByRole("textbox", { name: "Resource Agent draft" });
  expect(scopeBDraft).not.toHaveAttribute("aria-invalid");
  expect(scopeBDraft).not.toHaveAttribute("aria-describedby");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

test("a successful scoped submission clears its attachment error and reveals queued status", async () => {
  const ready = readyWorkspaceWithResources("p-1");
  const resourceAgentTurn = vi.fn(async () => resourceReceipt("resource-1"));
  window.history.pushState({}, "", "/projects/p-1/resources/resource-1");
  const rendered = render(
    <ToastProvider>
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
      </ApiProvider>
    </ToastProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Resource Agent draft" });
  const fileInput = rendered.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput!, {
    target: { files: [new File(["failed"], "failed.txt", { type: "text/plain" })] },
  });

  const attachmentError = await screen.findByRole("alert");
  expect(attachmentError).toHaveTextContent("Attachment upload failed");
  expect(attachmentError.closest('[aria-label="Notifications"]')).not.toBeNull();
  expect(document.querySelector("[data-workspace-agent-error]")).toBeNull();
  expect(draft).not.toHaveAttribute("aria-invalid");

  fireEvent.change(draft, { target: { value: "Use this exact Resource revision" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue resource task" }));

  await waitFor(() => expect(resourceAgentTurn).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open build plan" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close build plan" }));
  const restorePlan = screen.getByRole("button", { name: "Open build plan" });
  expect(restorePlan).toHaveTextContent("Queued build plan");
  expect(restorePlan).not.toHaveTextContent("plan-resource-agent");
  expect(restorePlan).toHaveAttribute("title", "Build plan plan-resource-agent");
  expect(draft).not.toHaveAttribute("aria-invalid");
  expect(draft).not.toHaveAttribute("aria-describedby");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
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
  expect(screen.getByRole("heading", { name: "Proposal ready" })).toBeInTheDocument();
  expect(screen.getByText("0 changes")).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace Agent transcript")).not.toHaveTextContent(proposal.id);
  fireEvent.click(screen.getByRole("button", { name: "Review proposal" }));
  expect(screen.getByRole("heading", { name: "Workspace proposal" })).toHaveFocus();
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

test("Design Workspace keeps inherited Settings controls neutral while the Settings read is unresolved", async () => {
  const ready = readyWorkspace("p-1");
  const inheritedProject = { ...project("p-1"), designSystemId: null };
  const getSettings = vi.fn(() => new Promise<never>(() => {}));
  const updateSettings = vi.fn();
  const patchProject = vi.fn();

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => inheritedProject,
      getWorkspace: async () => ready,
      getSettings,
      updateSettings,
      patchProject,
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });
  expect(agentPicker).toHaveAccessibleDescription("Current Agent and model: No Agent selected");
  expect(designSystemPicker).toHaveAccessibleDescription("Design system settings are loading");
  expect(designSystemPicker).toBeDisabled();

  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Wait for the authoritative Settings read" },
  });
  expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();
  expect(updateSettings).not.toHaveBeenCalled();
  expect(patchProject).not.toHaveBeenCalled();
});

test("Design Workspace recovers its saved Agent and inherited Design System after a transient Settings read failure", async () => {
  const ready = readyWorkspace("p-1");
  const inheritedProject = { ...project("p-1"), designSystemId: null };
  const currentSettings = await makeFakeApi().getSettings();
  let rejectInitialSettings!: (error: Error) => void;
  const initialSettings = new Promise<typeof currentSettings>((_resolve, reject) => {
    rejectInitialSettings = reject;
  });
  const getSettings = vi.fn()
    .mockImplementationOnce(() => initialSettings)
    .mockResolvedValue({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "modern-minimal",
    });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => inheritedProject,
      getWorkspace: async () => ready,
      getSettings,
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });
  vi.useFakeTimers();
  await act(async () => {
    rejectInitialSettings(new Error("daemon restarting"));
    await initialSettings.catch(() => {});
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(agentPicker).toHaveTextContent("Codex");
  expect(agentPicker).toHaveTextContent("gpt-5.4-mini");
  expect(designSystemPicker)
    .toHaveAccessibleDescription("Current Design system: Org default · Modern Minimal");
});

test("a late Settings read cannot replace a newer Agent and model selection", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveSettings!: (settings: typeof currentSettings) => void;
  const pendingSettings = new Promise<typeof currentSettings>((resolve) => {
    resolveSettings = resolve;
  });
  const updateSettings = vi.fn(async (patch: Partial<typeof currentSettings>) => ({
    ...currentSettings,
    ...patch,
  }));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => ({ ...project("p-1"), designSystemId: null }),
      getWorkspace: async () => ready,
      getSettings: async () => pendingSettings,
      updateSettings,
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const picker = screen.getByRole("button", { name: "Agent and model" });
  await user.click(picker);
  await user.click(await screen.findByRole("button", { name: /^Codex/ }));
  await user.click(await screen.findByRole("button", { name: "gpt-5.4-mini" }));
  await waitFor(() => expect(picker).toHaveTextContent("Codex"));
  await waitFor(() => expect(picker).toHaveTextContent("gpt-5.4-mini"));

  await act(async () => {
    resolveSettings({
      ...currentSettings,
      agentCommand: "claude",
      model: "sonnet",
      defaultDesignSystemId: "modern-minimal",
    });
    await pendingSettings;
  });

  expect(picker).toHaveTextContent("Codex");
  expect(picker).toHaveTextContent("gpt-5.4-mini");
});

test("Design Workspace applies Settings dialog updates while its composer stays mounted", async () => {
  const ready = readyWorkspace("p-1");
  const inheritedProject = { ...project("p-1"), designSystemId: null };
  const currentSettings = await makeFakeApi().getSettings();

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => inheritedProject,
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "claude",
        model: "sonnet",
        defaultDesignSystemId: "modern-minimal",
      }),
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "editorial", name: "Editorial", category: "Editorial", summary: "", origin: "built-in" },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const composer = document.querySelector("[data-workspace-agent-composer]");
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });
  await waitFor(() => expect(agentPicker).toHaveTextContent("Claude"));
  expect(designSystemPicker)
    .toHaveAccessibleDescription("Current Design system: Org default · Modern Minimal");

  fireEvent.keyDown(window, { key: ",", metaKey: true });
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(document.querySelector("[data-workspace-agent-composer]")).toBe(composer);

  act(() => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "editorial",
    });
  });

  await waitFor(() => expect(agentPicker).toHaveTextContent("Codex"));
  expect(agentPicker).toHaveTextContent("gpt-5.4-mini");
  expect(designSystemPicker)
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial");
  expect(document.querySelector("[data-workspace-agent-composer]")).toBe(composer);
});

test("a Settings event outranks an older in-flight Settings read for every composer default", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveInitialRead!: (settings: typeof currentSettings) => void;
  const initialRead = new Promise<typeof currentSettings>((resolve) => {
    resolveInitialRead = resolve;
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => ({ ...project("p-1"), designSystemId: null }),
      getWorkspace: async () => ready,
      getSettings: async () => initialRead,
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "editorial", name: "Editorial", category: "Editorial", summary: "", origin: "built-in" },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const agentPicker = screen.getByRole("button", { name: "Agent and model" });
  const designSystemPicker = screen.getByRole("button", { name: "Design system" });

  act(() => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "editorial",
    });
  });
  await waitFor(() => expect(agentPicker).toHaveTextContent("Codex"));
  expect(agentPicker).toHaveTextContent("gpt-5.4-mini");
  expect(designSystemPicker)
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial");

  await act(async () => {
    resolveInitialRead({
      ...currentSettings,
      agentCommand: "claude",
      model: "sonnet",
      defaultDesignSystemId: "modern-minimal",
    });
    await initialRead;
  });

  expect(agentPicker).toHaveTextContent("Codex");
  expect(agentPicker).toHaveTextContent("gpt-5.4-mini");
  expect(designSystemPicker)
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial");
});

test("a Settings event retires an older failed read without starting another retry chain", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let rejectInitialRead!: (error: Error) => void;
  const initialRead = new Promise<typeof currentSettings>((_resolve, reject) => {
    rejectInitialRead = reject;
  });
  const getSettings = vi.fn()
    .mockImplementationOnce(() => initialRead)
    .mockRejectedValue(new Error("stale daemon restart failure"));

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => ({ ...project("p-1"), designSystemId: null }),
        getWorkspace: async () => ready,
        getSettings,
        listAgents: async () => [
          { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
        ],
        listDesignSystems: async () => [
          { id: "editorial", name: "Editorial", category: "Editorial", summary: "", origin: "built-in" },
        ],
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  vi.useFakeTimers();
  await act(async () => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "editorial",
    });
    await Promise.resolve();
    rejectInitialRead(new Error("superseded read failed"));
    await initialRead.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect(getSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Codex");
  expect(screen.getByRole("button", { name: "Design system" }))
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial");
});

test("a Settings event retires a retry timer that an older failed read already scheduled", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let rejectInitialRead!: (error: Error) => void;
  const initialRead = new Promise<typeof currentSettings>((_resolve, reject) => {
    rejectInitialRead = reject;
  });
  const getSettings = vi.fn()
    .mockImplementationOnce(() => initialRead)
    .mockRejectedValue(new Error("superseded retry must not run"));

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => ({ ...project("p-1"), designSystemId: null }),
        getWorkspace: async () => ready,
        getSettings,
        listAgents: async () => [
          { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
        ],
        listDesignSystems: async () => [
          { id: "editorial", name: "Editorial", category: "Editorial", summary: "", origin: "built-in" },
        ],
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  vi.useFakeTimers();
  await act(async () => {
    rejectInitialRead(new Error("daemon restart began"));
    await initialRead.catch(() => {});
  });
  await act(async () => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "editorial",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect(getSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Codex");
  expect(screen.getByRole("button", { name: "Design system" }))
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial");
});

test("an older Settings event cannot replace a newer local Agent write", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveWrite!: (settings: typeof currentSettings) => void;
  const pendingWrite = new Promise<typeof currentSettings>((resolve) => {
    resolveWrite = resolve;
  });
  const updateSettings = vi.fn(() => pendingWrite);

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => ({ ...project("p-1"), designSystemId: null }),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "claude",
        model: "sonnet",
        defaultDesignSystemId: "modern-minimal",
      }),
      updateSettings,
      listAgents: async () => [
        { id: "claude", command: "claude", available: true, version: "1", models: ["sonnet"] },
        { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
      ],
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const picker = screen.getByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(picker).toHaveTextContent("Claude"));
  await user.click(picker);
  await user.click(await screen.findByRole("button", { name: /^Codex/ }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
  expect(picker).toHaveTextContent("Codex");

  act(() => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "claude",
      model: "sonnet",
      defaultDesignSystemId: "modern-minimal",
    });
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(picker).toHaveTextContent("Codex");

  await act(async () => {
    resolveWrite({
      ...currentSettings,
      agentCommand: "codex",
      model: "",
      defaultDesignSystemId: "modern-minimal",
    });
    await pendingWrite;
  });
  await waitFor(() => expect(picker).toHaveTextContent("Codex"));

  act(() => {
    publishSettingsUpdated({
      ...currentSettings,
      agentCommand: "claude",
      model: "sonnet",
      defaultDesignSystemId: "modern-minimal",
    });
  });
  await waitFor(() => expect(picker).toHaveTextContent("Claude"));
  expect(picker).toHaveTextContent("sonnet");
});

test("persistent Settings read failures toast once and keep recovering without changing composer layout", async () => {
  const ready = readyWorkspace("p-1");
  const inheritedProject = { ...project("p-1"), designSystemId: null };
  const currentSettings = await makeFakeApi().getSettings();
  let rejectFirstSettings!: (error: Error) => void;
  const firstSettings = new Promise<typeof currentSettings>((_resolve, reject) => {
    rejectFirstSettings = reject;
  });
  const getSettings = vi.fn()
    .mockImplementationOnce(() => firstSettings)
    .mockRejectedValueOnce(new Error("daemon still restarting"))
    .mockRejectedValueOnce(new Error("daemon still restarting"))
    .mockRejectedValueOnce(new Error("daemon still restarting"))
    .mockRejectedValueOnce(new Error("daemon still restarting"))
    .mockResolvedValue({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "modern-minimal",
    });

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => inheritedProject,
        getWorkspace: async () => ready,
        getSettings,
        listAgents: async () => [
          { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
        ],
        listDesignSystems: async () => [
          { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        ],
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Recover without moving the composer" },
  });
  const composer = screen.getByRole("textbox", { name: "Workspace Agent draft" })
    .closest("[data-workspace-agent-composer]");
  expect(composer).not.toBeNull();
  expect(screen.getByRole("button", { name: "Create proposal" })).toBeDisabled();

  vi.useFakeTimers();
  await act(async () => {
    rejectFirstSettings(new Error("daemon restarting"));
    await firstSettings.catch(() => {});
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  const loadError = screen.getByRole("alert");
  expect(loadError).toHaveTextContent("Couldn't load Agent and Design System settings. Reconnecting…");
  expect(loadError.closest('[aria-label="Notifications"]')).not.toBeNull();
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })
    .closest("[data-workspace-agent-composer]")).toBe(composer);
  expect(screen.getByRole("button", { name: "Design system" }))
    .toHaveAccessibleDescription("Design system settings are unavailable; retrying");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(getSettings).toHaveBeenCalledTimes(6);
  expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Codex");
  expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("gpt-5.4-mini");
  expect(screen.getByRole("button", { name: "Design system" }))
    .toHaveAccessibleDescription("Current Design system: Org default · Modern Minimal");
  expect(screen.getByRole("button", { name: "Create proposal" })).toBeEnabled();
});

test("StrictMode remounts share one in-flight Settings read", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const pendingSettings = new Promise<typeof currentSettings>(() => {});
  const getSettings = vi.fn(() => pendingSettings);

  render(
    <StrictMode>
      <ApiProvider client={makeFakeApi({
        getProject: async () => ({ ...project("p-1"), designSystemId: null }),
        getWorkspace: async () => ready,
        getSettings,
        listAgents: async () => [
          { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
        ],
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </StrictMode>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  expect(getSettings).toHaveBeenCalledTimes(1);
});

test("unmounting cancels the Settings retry chain after an in-flight read fails", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let rejectSettings!: (error: Error) => void;
  const pendingSettings = new Promise<typeof currentSettings>((_resolve, reject) => {
    rejectSettings = reject;
  });
  const getSettings = vi.fn(() => pendingSettings);
  const view = render(
    <StrictMode>
      <ApiProvider client={makeFakeApi({
        getProject: async () => ({ ...project("p-1"), designSystemId: null }),
        getWorkspace: async () => ready,
        getSettings,
        listAgents: async () => [
          { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
        ],
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </StrictMode>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  vi.useFakeTimers();
  view.unmount();
  await act(async () => {
    rejectSettings(new Error("daemon stopped after navigation"));
    await pendingSettings.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(getSettings).toHaveBeenCalledTimes(1);
});

test("remounting after an abandoned Settings read starts a fresh read", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const abandonedSettings = new Promise<typeof currentSettings>(() => {});
  const getSettings = vi.fn()
    .mockImplementationOnce(() => abandonedSettings)
    .mockResolvedValue({
      ...currentSettings,
      agentCommand: "codex",
      model: "gpt-5.4-mini",
      defaultDesignSystemId: "modern-minimal",
    });
  const api = makeFakeApi({
    getProject: async () => ({ ...project("p-1"), designSystemId: null }),
    getWorkspace: async () => ready,
    getSettings,
    listAgents: async () => [
      { id: "codex", command: "codex", available: true, version: "1", models: ["gpt-5.4-mini"] },
    ],
  });
  const renderApp = () => render(
    <ApiProvider client={api}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const firstView = renderApp();
  await screen.findByRole("region", { name: "Project canvas" });
  expect(getSettings).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  firstView.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();

  renderApp();
  await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Agent and model" })).toHaveTextContent("Codex"));
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

test("Design Workspace submits with a ready Codex selection without a brand restriction", async () => {
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
  const submit = screen.getByRole("button", { name: "Create proposal" });
  await waitFor(() => expect(submit).toBeEnabled());

  const picker = screen.getByRole("button", { name: "Agent and model" });
  await user.click(picker);
  const codex = await screen.findByRole("button", { name: /^Codex/ });
  expect(codex).toBeEnabled();
  expect(screen.getByRole("button", { name: /^CodeBuddy/ })).toBeEnabled();
  await user.keyboard("{Escape}");

  await user.click(submit);
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: "Build a complete workspace",
    agentCommand: "codex",
    model: "gpt-5",
  }));
  expect(updateSettings).not.toHaveBeenCalled();
});

test("Design Workspace preserves a registered Agent whose provider id differs from its CLI command", async () => {
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
        agentCommand: "trae-cli",
        model: "doubao-seed-1.6",
      }),
      listAgents: async () => [{
        id: "trae",
        command: "trae-cli",
        available: true,
        version: "1",
        models: ["doubao-seed-1.6"],
      }],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  fireEvent.change(draft, { target: { value: "Build a component library" } });
  const submit = screen.getByRole("button", { name: "Create proposal" });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: "Build a component library",
    agentCommand: "trae-cli",
    model: "doubao-seed-1.6",
  }));
});

test("a new Standard project stages Home attachments before navigation and never persists their bytes", async () => {
  const user = userEvent.setup();
  const createdProject = { ...project("p-staged"), name: "Staged workspace" };
  const ready = readyWorkspace("p-staged");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveUpload!: (value: { name: string; path: string }) => void;
  const uploadRef = vi.fn((_projectId: string, _name: string) => (
    new Promise<{ name: string; path: string }>((resolve) => {
      resolveUpload = resolve;
    })
  ));
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.home.composer", JSON.stringify({ mode: "standard" }));

  render(
    <ApiProvider client={makeFakeApi({
      createProject: async () => createdProject,
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
      uploadRef,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Standard"));
  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  expect(imageInput).not.toBeNull();
  fireEvent.change(imageInput!, {
    target: { files: [validPngFile("direction.jpeg")] },
  });
  await screen.findByLabelText("Remove direction.jpeg");
  fireEvent.change(screen.getByLabelText("Describe your design"), {
    target: { value: "Create from this direction" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(uploadRef).toHaveBeenCalledTimes(1));
  expect(uploadRef.mock.calls[0]?.[1]).toBe("home-image-1-direction.png");
  expect(window.location.pathname).toBe("/");
  const pendingDuringUpload = localStorage.getItem(pendingTurnStorageKey("p-staged"));
  expect(pendingDuringUpload).not.toBeNull();
  expect(JSON.parse(pendingDuringUpload!)).toEqual(expect.objectContaining({
    projectId: "p-staged",
    brief: "Create from this direction",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  }));
  expect(JSON.parse(pendingDuringUpload!).turnId).toMatch(CANONICAL_TURN_ID);

  resolveUpload({
    name: "home-image-1-direction.png",
    path: ".refs/home-image-1-direction.png",
  });

  await waitFor(() => expect(window.location.pathname).toBe("/projects/p-staged"));
  const stored = localStorage.getItem(pendingTurnStorageKey("p-staged"));
  expect(stored).not.toBeNull();
  expect(stored).not.toContain("base64");
  expect(stored).not.toContain("c3RhZ2VkLWltYWdlLWJ5dGVz");
  expect(stored).toContain(".refs/home-image-1-direction.png");
  expect(JSON.parse(stored!)).toEqual(expect.objectContaining({
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [expect.objectContaining({
      uploadedFileId: ".refs/home-image-1-direction.png",
    })],
  }));
});

test("a failed Home attachment stage removes the incomplete project and keeps the composer intact", async () => {
  const user = userEvent.setup();
  const createdProject = { ...project("p-incomplete"), name: "Incomplete workspace" };
  const currentSettings = await makeFakeApi().getSettings();
  const deleteProject = vi.fn(async () => {});
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.home.composer", JSON.stringify({ mode: "standard" }));

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        createProject: async () => createdProject,
        deleteProject,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "hunyuan",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
        ],
        uploadRef: async () => {
          throw new Error("Upload failed");
        },
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Standard"));
  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  fireEvent.change(imageInput!, {
    target: { files: [validPngFile("direction.png")] },
  });
  await screen.findByLabelText("Remove direction.png");
  fireEvent.change(screen.getByLabelText("Describe your design"), {
    target: { value: "Keep this draft recoverable" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p-incomplete"));
  expect(window.location.pathname).toBe("/");
  expect(screen.getByLabelText("Describe your design")).toHaveValue("Keep this draft recoverable");
  expect(screen.getByLabelText("Remove direction.png")).toBeInTheDocument();
  expect(peekPendingDesignWorkspaceTurn("p-incomplete")).toBeNull();
});

test("a failed incomplete-project cleanup preserves its project-scoped recovery handoff", async () => {
  const user = userEvent.setup();
  const createdProject = { ...project("p-cleanup-failed"), name: "Recoverable incomplete workspace" };
  const currentSettings = await makeFakeApi().getSettings();
  const deleteProject = vi.fn(async () => {
    throw new Error("Project deletion failed");
  });
  window.history.pushState({}, "", "/");
  localStorage.setItem("dezin.home.composer", JSON.stringify({ mode: "standard" }));

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        createProject: async () => createdProject,
        deleteProject,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "hunyuan",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: ["hunyuan"] },
        ],
        uploadRef: async () => {
          throw new Error("Upload failed");
        },
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  await waitFor(() => expect(screen.getByRole("button", { name: "Mode" })).toHaveTextContent("Standard"));
  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  fireEvent.change(imageInput!, {
    target: { files: [validPngFile("direction.png")] },
  });
  await screen.findByLabelText("Remove direction.png");
  fireEvent.change(screen.getByLabelText("Describe your design"), {
    target: { value: "Recover this incomplete workspace" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p-cleanup-failed"));
  expect(peekPendingDesignWorkspaceTurn("p-cleanup-failed")).toEqual(expect.objectContaining({
    brief: "Recover this incomplete workspace",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  }));
});

test("a new Standard Design Workspace materializes a Home screenshot as immutable Agent Context exactly once", async () => {
  const user = userEvent.setup();
  const createdProject = { ...project("p-new"), name: "Fresh workspace" };
  const ready = readyWorkspace("p-new");
  const currentSettings = await makeFakeApi().getSettings();
  const createProject = vi.fn(async () => createdProject);
  const uploadRef = vi.fn(async (_projectId: string, name: string) => ({
    name,
    path: `.refs/${name}`,
  }));
  let materialized = 0;
  const materializeResource = vi.fn(async (
    _projectId: string,
    input: MaterializeResourceInput,
  ): Promise<MaterializeResourceResult> => {
    const sequence = ++materialized;
    const resourceId = `resource-initial-${sequence}`;
    const revisionId = `revision-initial-${sequence}`;
    const node = {
      id: `node-initial-${sequence}`,
      workspaceId: ready.workspace.id,
      kind: "resource" as const,
      name: input.title,
      resourceId,
    };
    const graph = {
      ...ready.graph,
      revision: ready.graph.revision + sequence,
      nodes: [...ready.graph.nodes, node],
    };
    const resource = {
      id: resourceId,
      workspaceId: ready.workspace.id,
      kind: input.kind,
      title: input.title,
      headRevisionId: revisionId,
      defaultPinPolicy: input.defaultPinPolicy,
      archivedAt: null,
      createdAt: sequence + 1,
      updatedAt: sequence + 1,
    };
    const revision = {
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
    };
    return {
      resource,
      revision,
      node,
      graph,
      snapshot: {
        ...ready.activeSnapshot,
        id: `snapshot-initial-${sequence}`,
        sequence: ready.activeSnapshot.sequence + sequence,
        graphRevision: graph.revision,
        graph,
        resourceRevisions: { [resourceId]: revisionId },
      },
    };
  });
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
        uploadRef,
        materializeResource,
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
  const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]');
  expect(imageInput).not.toBeNull();
  fireEvent.change(imageInput!, {
    target: { files: [validPngFile("direction.png")] },
  });
  await screen.findByLabelText("Remove direction.png");
  fireEvent.change(screen.getByLabelText("Describe your design"), {
    target: { value: "Create a complete music discovery workspace" },
  });
  await user.click(screen.getByLabelText("Design"));

  await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(uploadRef.mock.calls.map(([projectId, name]) => [projectId, name])).toEqual([
    ["p-new", "home-image-1-direction.png"],
  ]);
  expect(materializeResource.mock.calls.map(([projectId, input]) => [projectId, {
    title: input.title,
    kind: input.kind,
    source: input.source,
  }])).toEqual([
    ["p-new", {
      title: "direction.png",
      kind: "file",
      source: { type: "uploaded-file", uploadedFileId: ".refs/home-image-1-direction.png" },
    }],
  ]);
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: "Create a complete music discovery workspace",
    agentCommand: "codebuddy",
    model: "hunyuan",
    explicitContext: [
      {
        kind: "resource",
        id: "resource-initial-1",
        resourceKind: "file",
        revisionId: "revision-initial-1",
      },
    ],
  }));
  expect(takePendingImages()).toEqual([]);
  expect(takePendingRefs()).toEqual([]);
  expect(peekPendingDesignWorkspaceTurn("p-new")).toBeNull();

  act(() => navigate("/"));
  await screen.findByLabelText("Describe your design");
  act(() => navigate("/projects/p-new/canvas"));
  await screen.findByRole("region", { name: "Project canvas" });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);
});

test("a pending initial turn is acknowledged only after its Workspace Agent request settles", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveTurn!: (proposal: WorkspaceProposal) => void;
  const workspaceAgentTurn = vi.fn(() => new Promise<WorkspaceProposal>((resolve) => {
    resolveTurn = resolve;
  }));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build a complete resilient workspace",
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(peekPendingDesignWorkspaceTurn("p-1")).not.toBeNull();

  resolveTurn(draftProposal(ready));

  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("a pending initial turn and its durable outbox replay share one fixed turn identity", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const request: WorkspaceAgentTurnInput = {
    turnId: INITIAL_TURN_ID,
    message: "Resume the exact initial workspace",
    agentCommand: "codebuddy",
    explicitContext: [],
    graphRevision: ready.graph.revision,
    selection: [],
  };
  const fingerprint = JSON.stringify({
    message: request.message,
    agentCommand: request.agentCommand,
    explicitContext: request.explicitContext,
    graphRevision: request.graphRevision,
    selection: request.selection,
  });
  expect(writeAgentSession("p-1", WORKSPACE_AGENT_SCOPE, {
    draft: "",
    contextItems: [],
    transcript: [{
      id: `user:${INITIAL_TURN_ID}`,
      turnId: INITIAL_TURN_ID,
      role: "user",
      content: request.message,
      createdAt: 1,
      state: "submitted",
    }],
    outbox: {
      kind: "workspace",
      turnId: INITIAL_TURN_ID,
      fingerprint,
      request,
      createdAt: 1,
      delivery: { status: "pending" },
    },
    receipt: null,
  })).toBe(true);
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: request.message,
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });
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
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId).toBe(INITIAL_TURN_ID);
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);
});

test("a definite initial Agent failure preserves the draft and a manual replacement retires the handoff", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let attempt = 0;
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    attempt += 1;
    if (attempt === 1) {
      throw new ApiError(500, "Workspace Planner is unavailable: structured Agent timed out");
    }
    return draftProposal(ready);
  });
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build the durable initial direction",
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue(
    "Build the durable initial direction",
  ));
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId).toBe(INITIAL_TURN_ID);
  expect(peekPendingDesignWorkspaceTurn("p-1")).not.toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "Build the revised durable initial direction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).not.toBe(INITIAL_TURN_ID);
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());

  act(() => navigate("/"));
  await screen.findByLabelText("Describe your design");
  act(() => navigate("/projects/p-1/canvas"));
  await screen.findByRole("region", { name: "Project canvas" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(2);
});

test("a manual replacement durably supersedes the initial turn before its response and replays only that replacement", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const workspaceAgentTurn = vi.fn((
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ): Promise<WorkspaceProposal> => {
    if (workspaceAgentTurn.mock.calls.length === 1) {
      return new Promise<WorkspaceProposal>(() => {});
    }
    return Promise.resolve(draftProposal(ready));
  });
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build only after every reference is ready",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => ready,
    getSettings: async () => ({
      ...currentSettings,
      agentCommand: "codebuddy",
      model: "",
    }),
    listAgents: async () => [
      { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
    ],
    workspaceAgentTurn,
  });
  const renderApp = () => render(
    <ApiProvider client={api}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const firstRender = renderApp();
  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(draft).toHaveValue("Build only after every reference is ready"));
  fireEvent.change(draft, {
    target: { value: "Build the reviewed replacement direction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  const superseded = peekPendingDesignWorkspaceTurn("p-1");
  expect(superseded?.supersededByTurnId).toMatch(CANONICAL_TURN_ID);
  expect(superseded?.supersededByTurnId).not.toBe(INITIAL_TURN_ID);
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId).toBe(superseded?.supersededByTurnId);
  expect(JSON.parse(localStorage.getItem(pendingTurnStorageKey("p-1"))!)).toEqual(superseded);

  firstRender.unmount();
  renderApp();

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls.map((call) => call[1].turnId)).toEqual([
    superseded?.supersededByTurnId,
    superseded?.supersededByTurnId,
  ]);
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("an externally superseded recovery turn cannot surface its stale Proposal response for approval", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  let resolveTurn!: (proposal: WorkspaceProposal) => void;
  const workspaceAgentTurn = vi.fn(() => new Promise<WorkspaceProposal>((resolve) => {
    resolveTurn = resolve;
  }));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Original request awaiting a reviewed replacement",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(draft).toHaveValue("Original request awaiting a reviewed replacement"));
  fireEvent.change(draft, { target: { value: "First replacement now in flight" } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));

  const firstReplacement = peekPendingDesignWorkspaceTurn("p-1");
  const firstReplacementTurnId = firstReplacement?.supersededByTurnId;
  expect(firstReplacementTurnId).toMatch(CANONICAL_TURN_ID);
  const externalRequest = {
    message: "Replacement claimed by another window",
    agentCommand: "codebuddy",
    explicitContext: [],
    graphRevision: ready.graph.revision,
    selection: [],
  };
  const externalClaim = await claimPendingTurnReplacement({
    projectId: "p-1",
    expectedActiveTurnId: firstReplacementTurnId!,
    reservation: {
      fingerprint: workspaceAgentRequestFingerprint(externalRequest),
      request: externalRequest,
      contextItems: [],
    },
  });
  expect(externalClaim.status).toBe("claimed");

  resolveTurn(draftProposal(ready));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create proposal" })).toBeEnabled());

  expect(screen.queryByRole("region", { name: "Proposal review" })).not.toBeInTheDocument();
  expect(peekPendingDesignWorkspaceTurn("p-1")?.supersededByTurnId)
    .toBe(externalClaim.status === "claimed" ? externalClaim.turnId : "");
});

test("a recovery reservation persists the same composer Context snapshot used after async selection resolution", async () => {
  const ready = readyWorkspaceWithResources("p-1");
  let resolveResource!: (resource: Resource) => void;
  const getResource = vi.fn(() => new Promise<Resource>((resolve) => {
    resolveResource = resolve;
  }));
  const workspaceAgentTurn = vi.fn(() => new Promise<WorkspaceProposal>(() => {}));
  expect(writeAgentSession("p-1", WORKSPACE_AGENT_SCOPE, {
    draft: "Build from the exact resolved Context",
    contextItems: [{
      id: "resource:context-stale:revision-context-stale",
      type: "context-ref",
      title: "Stale composer context",
      ref: {
        kind: "resource",
        id: "context-stale",
        resourceKind: "file",
        revisionId: "revision-context-stale",
      },
      projectId: "p-1",
      revisionId: "revision-context-stale",
    }],
    transcript: [],
    outbox: null,
    receipt: null,
  })).toBe(true);
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Original Home request",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getResource,
      workspaceAgentTurn,
    })}>
      <RecoveryReservationProbe />
    </ApiProvider>,
  );

  await screen.findByRole("textbox", { name: "Recovery reservation prompt" });
  fireEvent.click(screen.getByRole("button", { name: "Select exact Resource" }));
  fireEvent.click(screen.getByRole("button", { name: "Reserve exact recovery" }));
  await waitFor(() => expect(getResource).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Replace composer Context" }));
  resolveResource(ready.resources!.find((resource) => resource.id === "resource-1")!);

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  const durable = peekPendingDesignWorkspaceTurn("p-1");
  expect(durable?.recoveryRequest?.request).toEqual(expect.objectContaining({
    explicitContext: [
      {
        kind: "resource",
        id: "context-latest",
        resourceKind: "file",
        revisionId: "revision-context-latest",
      },
      {
        kind: "resource",
        id: "resource-1",
        resourceKind: "file",
        revisionId: "resource-1-revision-1",
      },
    ],
    selection: [{ kind: "node", id: "node-resource-1" }],
  }));
  expect(durable?.recoveryRequest?.contextItems).toEqual([
    expect.objectContaining({
      title: "Latest composer context",
      ref: {
        kind: "resource",
        id: "context-latest",
        resourceKind: "file",
        revisionId: "revision-context-latest",
      },
    }),
  ]);
  expect(screen.getByRole("status", { name: "Recovery reservation error" })).toHaveTextContent("none");
});

test("a crash after superseding but before outbox persistence never replays the original turn", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const interruptedReplacement = "Build the replacement recovered from its durable draft";
  expect(writeAgentSession("p-1", WORKSPACE_AGENT_SCOPE, {
    draft: interruptedReplacement,
    contextItems: [],
    transcript: [],
    outbox: null,
    receipt: null,
  })).toBe(true);
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    supersededByTurnId: "turn-00000000-0000-4000-8000-000000000002",
    brief: "Build the original direction that must stay retired",
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => project("p-1"),
        getWorkspace: async () => ready,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
        ],
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(draft).toHaveValue(interruptedReplacement));
  expect(await screen.findByText(/replacement request was interrupted before delivery/i)).toBeInTheDocument();
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    message: interruptedReplacement,
  }));
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId).toMatch(CANONICAL_TURN_ID);
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId).not.toBe(INITIAL_TURN_ID);
  expect(workspaceAgentTurn.mock.calls[0]![1].turnId)
    .toBe("turn-00000000-0000-4000-8000-000000000002");
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("a session quota failure cannot lose a replacement prompt or immutable Context across reload", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  expect(writeAgentSession("p-1", WORKSPACE_AGENT_SCOPE, {
    draft: "Build the quota-safe replacement",
    contextItems: [{
      id: "resource:durable-reference:revision-durable-reference",
      type: "context-ref",
      title: "Durable exact context",
      ref: {
        kind: "resource",
        id: "durable-reference",
        resourceKind: "file",
        revisionId: "revision-durable-reference",
      },
      projectId: "p-1",
      revisionId: "revision-durable-reference",
    }],
    transcript: [],
    outbox: null,
    receipt: null,
  })).toBe(true);
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Original Home request",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  });
  const workspaceAgentTurn = vi.fn((
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ): Promise<WorkspaceProposal> => (
    workspaceAgentTurn.mock.calls.length === 1
      ? new Promise<WorkspaceProposal>(() => {})
      : Promise.resolve(draftProposal(ready))
  ));
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => ready,
    getSettings: async () => ({
      ...currentSettings,
      agentCommand: "codebuddy",
      model: "",
    }),
    listAgents: async () => [
      { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
    ],
    workspaceAgentTurn,
  });
  const availableStorage = localStorage;
  vi.stubGlobal("localStorage", {
    get length() { return availableStorage.length; },
    clear: availableStorage.clear.bind(availableStorage),
    getItem: availableStorage.getItem.bind(availableStorage),
    key: availableStorage.key.bind(availableStorage),
    removeItem: availableStorage.removeItem.bind(availableStorage),
    setItem: (key: string, value: string) => {
      if (key.startsWith("dezin.project-studio.agent.v1:")) {
        throw new DOMException("Session quota exceeded", "QuotaExceededError");
      }
      availableStorage.setItem(key, value);
    },
  });
  const renderApp = () => render(
    <ToastProvider>
      <ApiProvider client={api}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  const firstRender = renderApp();
  const firstDraft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(firstDraft).toHaveValue("Build the quota-safe replacement"));
  expect(await screen.findByText("Durable exact context")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  const durable = peekPendingDesignWorkspaceTurn("p-1");
  expect(durable?.recoveryRequest).toEqual(expect.objectContaining({
    turnId: durable?.supersededByTurnId,
    request: expect.objectContaining({
      message: "Build the quota-safe replacement",
      explicitContext: [{
        kind: "resource",
        id: "durable-reference",
        resourceKind: "file",
        revisionId: "revision-durable-reference",
      }],
    }),
    contextItems: [expect.objectContaining({ title: "Durable exact context" })],
  }));

  firstRender.unmount();
  vi.stubGlobal("localStorage", availableStorage);
  availableStorage.removeItem(workspaceAgentSessionStorageKey("p-1"));
  renderApp();

  const recoveredDraft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(recoveredDraft).toHaveValue("Build the quota-safe replacement"));
  expect(await screen.findByText("Durable exact context")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).toBe(workspaceAgentTurn.mock.calls[0]![1].turnId);
  expect(workspaceAgentTurn.mock.calls[1]![1].explicitContext).toEqual(
    workspaceAgentTurn.mock.calls[0]![1].explicitContext,
  );
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("editing after a committed response fails client validation creates a new CAS child turn", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const pendingAtSecondCalls: NonNullable<ReturnType<typeof peekPendingDesignWorkspaceTurn>>[] = [];
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    if (workspaceAgentTurn.mock.calls.length === 1) {
      return {
        ...draftProposal(ready),
        baseGraphRevision: ready.graph.revision + 1,
      };
    }
    const pending = peekPendingDesignWorkspaceTurn("p-1");
    if (pending !== null) pendingAtSecondCalls.push(structuredClone(pending));
    return draftProposal(ready);
  });
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Original request waiting for explicit recovery",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: false,
    attachments: [],
  });

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => project("p-1"),
        getWorkspace: async () => ready,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
        ],
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(draft).toHaveValue("Original request waiting for explicit recovery"));
  fireEvent.change(draft, { target: { value: "First replacement facts" } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(
    "Workspace Agent returned a Proposal outside the current canvas Revision.",
  )).toBeInTheDocument();
  const firstPending = structuredClone(peekPendingDesignWorkspaceTurn("p-1"));
  const firstReplacementId = firstPending?.supersededByTurnId;
  expect(firstReplacementId).toMatch(CANONICAL_TURN_ID);

  fireEvent.change(draft, { target: { value: "Second replacement facts after validation failure" } });
  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  const pendingAtSecondCall = pendingAtSecondCalls[0];
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).not.toBe(firstReplacementId);
  expect(pendingAtSecondCall?.supersessionLineage).toEqual([
    expect.objectContaining({
      turnId: firstReplacementId,
      parentTurnId: INITIAL_TURN_ID,
    }),
    expect.objectContaining({
      turnId: workspaceAgentTurn.mock.calls[1]![1].turnId,
      parentTurnId: firstReplacementId,
    }),
  ]);
  expect(pendingAtSecondCall?.recoveryRequest?.request.message)
    .toBe("Second replacement facts after validation failure");
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("an unavailable Home Agent restores the draft and can be replaced with an available Agent", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build with whichever Agent is currently ready",
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => project("p-1"),
        getWorkspace: async () => ready,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codex",
          model: "",
        }),
        listAgents: async () => [
          {
            id: "codebuddy",
            command: "codebuddy",
            available: false,
            availability: "authentication-required",
            models: [],
          },
          { id: "codex", command: "codex", available: true, version: "1", models: [] },
        ],
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  const draft = await screen.findByRole("textbox", { name: "Workspace Agent draft" });
  await waitFor(() => expect(draft).toHaveValue("Build with whichever Agent is currently ready"));
  expect(await screen.findByText(/codebuddy is unavailable/i)).toBeInTheDocument();
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(workspaceAgentTurn.mock.calls[0]![1]).toEqual(expect.objectContaining({
    agentCommand: "codex",
    message: "Build with whichever Agent is currently ready",
  }));
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());
});

test("a failed initial Resource materialization keeps the staged turn recoverable", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const materializeResource = vi.fn(async () => {
    throw new Error("Resource snapshot failed");
  });
  const workspaceAgentTurn = vi.fn();
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build from the durable reference",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [{
      title: "direction.png",
      uploadedFileId: ".refs/home-image-1-direction.png",
      preview: true,
    }],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      materializeResource,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  expect(materializeResource).toHaveBeenCalledWith("p-1", expect.objectContaining({
    idempotencyKey: "home-attachment:.refs/home-image-1-direction.png",
  }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue(
    "Build from the durable reference",
  ));
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
  expect(peekPendingDesignWorkspaceTurn("p-1")).toEqual(expect.objectContaining({
    attachments: [expect.objectContaining({
      uploadedFileId: ".refs/home-image-1-direction.png",
    })],
  }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(materializeResource).toHaveBeenCalledTimes(1);
});

test("initial attachment materialization blocks manual replacement and an external supersession cancels the old turn", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const resource = {
    id: "resource-interleaved",
    workspaceId: ready.workspace.id,
    kind: "file" as const,
    title: "interleaved.png",
    headRevisionId: "revision-interleaved",
    defaultPinPolicy: "pin-current" as const,
    archivedAt: null,
    createdAt: 2,
    updatedAt: 2,
  };
  const revision = {
    id: "revision-interleaved",
    workspaceId: ready.workspace.id,
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resource-revisions/resource-interleaved/manifest.json",
    summary: "Uploaded file: interleaved.png",
    metadata: {},
    checksum: "c".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 2,
  };
  const node = {
    id: "node-interleaved",
    workspaceId: ready.workspace.id,
    kind: "resource" as const,
    name: resource.title,
    resourceId: resource.id,
  };
  const graph = { ...ready.graph, revision: 2, nodes: [node] };
  let resolveMaterialization!: (result: MaterializeResourceResult) => void;
  const materializeResource = vi.fn(() => new Promise<MaterializeResourceResult>((resolve) => {
    resolveMaterialization = resolve;
  }));
  const workspaceAgentTurn = vi.fn();
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build from the exact immutable reference",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [{
      title: "interleaved.png",
      uploadedFileId: ".refs/interleaved.png",
      preview: true,
    }],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      materializeResource,
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  const submit = screen.getByRole("button", { name: "Create proposal" });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace Agent draft" }), {
    target: { value: "A user edit must not unlock this in-flight attachment" },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(submit).toBeDisabled();
  fireEvent.click(submit);
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
  expect(peekPendingDesignWorkspaceTurn("p-1")?.supersededByTurnId).toBeUndefined();

  setPendingDesignWorkspaceTurn({
    ...peekPendingDesignWorkspaceTurn("p-1")!,
    supersededByTurnId: "turn-00000000-0000-4000-8000-000000000002",
  });
  resolveMaterialization({
    resource,
    revision,
    node,
    graph,
    snapshot: {
      ...ready.activeSnapshot,
      id: "snapshot-interleaved",
      sequence: 2,
      graphRevision: graph.revision,
      graph,
      resourceRevisions: { [resource.id]: revision.id },
    },
  });

  await waitFor(() => expect(submit).not.toBeDisabled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
  expect(peekPendingDesignWorkspaceTurn("p-1")?.supersededByTurnId)
    .toBe("turn-00000000-0000-4000-8000-000000000002");
});

test("a completed initial turn reports one cleanup failure without replaying or rerendering forever", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  expect(writeAgentSession("p-1", WORKSPACE_AGENT_SCOPE, {
    draft: "",
    contextItems: [],
    transcript: [{
      id: `assistant:${INITIAL_TURN_ID}`,
      turnId: INITIAL_TURN_ID,
      role: "assistant",
      content: "Workspace proposal is ready for review.",
      createdAt: 2,
      state: "proposal",
    }],
    outbox: null,
    receipt: {
      kind: "workspace",
      turnId: INITIAL_TURN_ID,
      proposalId: "proposal-initial",
      status: "draft",
      createdAt: 2,
    },
  })).toBe(true);
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Do not replay this completed request",
    agentCommand: "codebuddy",
    attachmentCount: 0,
    attachmentsStaged: true,
  });
  const availableStorage = localStorage;
  vi.stubGlobal("localStorage", {
    getItem: availableStorage.getItem.bind(availableStorage),
    removeItem: availableStorage.removeItem.bind(availableStorage),
    setItem: (key: string, value: string) => {
      if (key.startsWith("dezin.pending.design-workspace-turn-ack:")) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      availableStorage.setItem(key, value);
    },
  });
  const workspaceAgentTurn = vi.fn();

  render(
    <ToastProvider>
      <ApiProvider client={makeFakeApi({
        getProject: async () => project("p-1"),
        getWorkspace: async () => ready,
        getSettings: async () => ({
          ...currentSettings,
          agentCommand: "codebuddy",
          model: "",
        }),
        listAgents: async () => [
          { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
        ],
        workspaceAgentTurn,
      })}>
        <AgentsProvider>
          <App />
        </AgentsProvider>
      </ApiProvider>
    </ToastProvider>,
  );

  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("proposal is ready");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
  expect(peekPendingDesignWorkspaceTurn("p-1")).not.toBeNull();
  vi.stubGlobal("localStorage", availableStorage);
});

test("leaving the workspace releases a suspended initial materialization from the next scope", async () => {
  const ready = readyWorkspaceWithResources("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const materializeResource = vi.fn(() => new Promise<MaterializeResourceResult>(() => {}));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build from the suspended attachment",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [{
      title: "suspended.png",
      uploadedFileId: ".refs/suspended.png",
      preview: true,
    }],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      listResources: async () => ready.resources!,
      getResource: async (_projectId, resourceId) => ready.resources!.find((resource) => resource.id === resourceId)!,
      getResourceRevisionView: async (_projectId, resourceId) => resourceRevisionView(ready, resourceId),
      materializeResource,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  act(() => navigate("/projects/p-1/resources/resource-1"));
  const resourceDraft = await screen.findByRole("textbox", { name: "Resource Agent draft" });
  fireEvent.change(resourceDraft, { target: { value: "Revise this resource independently" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Queue resource task" })).not.toBeDisabled());
});

test("an interrupted Home attachment stage waits for an explicit replacement and then retires", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build only after every reference is ready",
    agentCommand: "codebuddy",
    attachmentCount: 2,
    attachmentsStaged: false,
    attachments: [],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
      ],
      workspaceAgentTurn,
    })}>
      <AgentsProvider>
        <App />
      </AgentsProvider>
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue(
    "Build only after every reference is ready",
  ));
  expect(workspaceAgentTurn).not.toHaveBeenCalled();
  expect(peekPendingDesignWorkspaceTurn("p-1")).toEqual(expect.objectContaining({
    attachmentCount: 2,
    attachmentsStaged: false,
  }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(peekPendingDesignWorkspaceTurn("p-1")).toBeNull());

  act(() => navigate("/"));
  await screen.findByLabelText("Describe your design");
  act(() => navigate("/projects/p-1/canvas"));
  await screen.findByRole("region", { name: "Project canvas" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);
});

test("a pending Home project reference becomes immutable Workspace Agent context before planning", async () => {
  const ready = readyWorkspace("p-1");
  const currentSettings = await makeFakeApi().getSettings();
  const uploadRef = vi.fn();
  const materializeResource = vi.fn(async (
    _projectId: string,
    input: MaterializeResourceInput,
  ): Promise<MaterializeResourceResult> => {
    const resourceId = "resource-project-reference";
    const revisionId = "revision-project-reference";
    const node = {
      id: "node-project-reference",
      workspaceId: ready.workspace.id,
      kind: "resource" as const,
      name: input.title,
      resourceId,
    };
    const graph = { ...ready.graph, revision: 2, nodes: [node] };
    return {
      resource: {
        id: resourceId,
        workspaceId: ready.workspace.id,
        kind: input.kind,
        title: input.title,
        headRevisionId: revisionId,
        defaultPinPolicy: input.defaultPinPolicy,
        archivedAt: null,
        createdAt: 2,
        updatedAt: 2,
      },
      revision: {
        id: revisionId,
        workspaceId: ready.workspace.id,
        resourceId,
        sequence: 1,
        parentRevisionId: null,
        manifestPath: "resource-revisions/project-reference/manifest.json",
        summary: "Uploaded project reference",
        metadata: {},
        checksum: "f".repeat(64),
        provenance: {},
        createdByRunId: null,
        createdAt: 2,
      },
      node,
      graph,
      snapshot: {
        ...ready.activeSnapshot,
        id: "snapshot-project-reference",
        sequence: 2,
        graphRevision: 2,
        graph,
        resourceRevisions: { [resourceId]: revisionId },
      },
    };
  });
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => draftProposal(ready));
  setPendingDesignWorkspaceTurn({
    projectId: "p-1",
    turnId: INITIAL_TURN_ID,
    brief: "Build from the existing editorial direction",
    agentCommand: "codebuddy",
    attachmentCount: 1,
    attachmentsStaged: true,
    attachments: [{
      title: "Reference source",
      uploadedFileId: ".refs/home-reference-1-reference-source.html",
    }],
  });

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        agentCommand: "codebuddy",
        model: "",
      }),
      listAgents: async () => [
        { id: "codebuddy", command: "codebuddy", available: true, version: "1", models: [] },
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

  await waitFor(() => expect(materializeResource).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  expect(uploadRef).not.toHaveBeenCalled();
  expect(materializeResource).toHaveBeenCalledWith("p-1", expect.objectContaining({
    title: "Reference source",
    kind: "file",
    source: {
      type: "uploaded-file",
      uploadedFileId: ".refs/home-reference-1-reference-source.html",
    },
  }));
  expect(workspaceAgentTurn.mock.calls[0]![1].explicitContext).toEqual([{
    kind: "resource",
    id: "resource-project-reference",
    resourceKind: "file",
    revisionId: "revision-project-reference",
  }]);
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

  expect(await screen.findByRole("button", { name: "Back to projects" }))
    .toHaveAttribute("title", "Back to projects · Project p-1");
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

test("Workspace Agent shows the inherited Design System default without pinning it and keeps explicit None distinct", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  const inheritedProject = { ...project("p-1"), designSystemId: null };
  const currentSettings = await makeFakeApi().getSettings();
  const patchProject = vi.fn(async (
    _projectId: string,
    patch: Partial<Project>,
  ): Promise<Project> => ({
    ...inheritedProject,
    ...patch,
  }));

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => inheritedProject,
      getWorkspace: async () => ready,
      getSettings: async () => ({
        ...currentSettings,
        defaultDesignSystemId: "modern-minimal",
      }),
      listDesignSystems: async () => [
        { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
        { id: "editorial", name: "Editorial", category: "Editorial", summary: "", origin: "built-in" },
      ],
      patchProject,
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  const picker = screen.getByRole("button", { name: "Design system" });
  await waitFor(() => expect(picker)
    .toHaveAccessibleDescription("Current Design system: Org default · Modern Minimal"));
  expect(patchProject).not.toHaveBeenCalled();

  await user.click(picker);
  const dialog = await screen.findByRole("dialog", { name: "Choose Design system" });
  expect(within(dialog).getByRole("button", { name: /Use org default/ }))
    .toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByRole("button", { name: /^Modern Minimal/ }))
    .toHaveAttribute("aria-pressed", "false");
  await user.click(within(dialog).getByRole("button", { name: /No design system/ }));

  await waitFor(() => expect(patchProject).toHaveBeenCalledWith("p-1", {
    designSystemId: NO_DESIGN_SYSTEM_ID,
  }));
  await waitFor(() => expect(picker).toHaveAccessibleDescription("Current Design system: None"));

  await user.click(picker);
  const explicitNoneDialog = await screen.findByRole("dialog", { name: "Choose Design system" });
  expect(within(explicitNoneDialog).getByRole("button", { name: /Use org default/ }))
    .toHaveAttribute("aria-pressed", "false");
  expect(within(explicitNoneDialog).getByRole("button", { name: /No design system/ }))
    .toHaveAttribute("aria-pressed", "true");
  await user.click(within(explicitNoneDialog).getByRole("button", { name: /Use org default/ }));

  await waitFor(() => expect(patchProject).toHaveBeenNthCalledWith(2, "p-1", {
    designSystemId: null,
  }));
  await waitFor(() => expect(picker)
    .toHaveAccessibleDescription("Current Design system: Org default · Modern Minimal"));

  act(() => {
    publishSettingsUpdated({
      ...currentSettings,
      defaultDesignSystemId: "editorial",
    });
  });
  await waitFor(() => expect(picker)
    .toHaveAccessibleDescription("Current Design system: Org default · Editorial"));
  expect(patchProject).toHaveBeenCalledTimes(2);
});

test("Workspace Agent distinguishes Design System loading, failure, and retry from an empty catalog", async () => {
  const user = userEvent.setup();
  const ready = readyWorkspace("p-1");
  let rejectInitialCatalog!: (error: Error) => void;
  const listDesignSystems = vi.fn()
    .mockImplementationOnce(() => new Promise((_, reject) => {
      rejectInitialCatalog = reject;
    }))
    .mockResolvedValueOnce([
      { id: "modern-minimal", name: "Modern Minimal", category: "Modern", summary: "", origin: "built-in" },
    ]);

  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => ready,
      listDesignSystems,
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByRole("region", { name: "Project canvas" });
  await user.click(screen.getByRole("button", { name: "Design system" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose Design system" });
  expect(within(dialog).getByRole("status")).toHaveTextContent("Loading design systems…");

  await act(async () => {
    rejectInitialCatalog(new Error("catalog unavailable"));
  });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't load design systems.");
  expect(within(dialog).queryByText("No matches")).not.toBeInTheDocument();

  await user.click(within(dialog).getByRole("button", { name: "Retry loading design systems" }));
  expect(await within(dialog).findByRole("button", { name: /^Modern Minimal/ })).toBeInTheDocument();
  expect(listDesignSystems).toHaveBeenCalledTimes(2);
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
    <ToastProvider>
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
      </ApiProvider>
    </ToastProvider>,
  );

  const agentPicker = await screen.findByRole("button", { name: "Agent and model" });
  await waitFor(() => expect(agentPicker).toHaveTextContent("Codex"));
  await user.click(agentPicker);
  await user.click(await screen.findByRole("button", { name: /^Claude Code/ }));
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agentCommand: "claude", model: "" }));
  await user.keyboard("{Escape}");
  const saveError = await screen.findByRole("alert");
  expect(saveError).toHaveTextContent(
    "Couldn't save the selected Agent setting. Choose it again to retry.",
  );
  expect(saveError.closest('[aria-label="Notifications"]')).not.toBeNull();
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
  const pendingStatus = screen.getByRole("status", { name: "Checking Agent availability…" });
  expect(pendingStatus).toHaveClass("sr-only");
  expect(pendingStatus).toHaveAttribute("aria-live", "polite");
  expect(pendingStatus).toHaveAttribute("aria-atomic", "true");
  expect(submit).toHaveAttribute("aria-describedby", pendingStatus.id);
  expect(submit).toHaveAttribute("aria-busy", "true");
  expect(submit.querySelector(".animate-spin")).not.toBeNull();
  expect(screen.queryByText("Checking Agent availability…", { selector: "p" })).not.toBeInTheDocument();

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
  expect(submit).not.toHaveAttribute("aria-busy");
  expect(submit).not.toHaveAttribute("aria-describedby");
  expect(screen.queryByRole("status", { name: "Checking Agent availability…" })).not.toBeInTheDocument();
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
  await user.click(await screen.findByRole("button", { name: /^Modern Minimal/ }));
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

test("Workspace Agent keeps an explicit Planner failure terminal across remount until the user retries", async () => {
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    throw new ApiError(500, "Workspace Planner is unavailable: structured Agent timed out");
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => ready,
    workspaceAgentTurn,
  });
  const first = render(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Build the exact twelve Page matrix" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  expect(await screen.findByRole("status", { name: "Workspace Agent error" })).toHaveTextContent(
    "Workspace Planner is unavailable",
  );
  const firstTurnId = workspaceAgentTurn.mock.calls[0]![1].turnId;
  first.unmount();

  render(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );
  await screen.findByRole("textbox", { name: "Current Agent prompt" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  expect(workspaceAgentTurn).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status", { name: "Workspace Agent error" })).toHaveTextContent(
    "Workspace Planner is unavailable",
  );

  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).toBe(firstTurnId);
});

test("Workspace Agent resumes an uncertain lost network response after remount", async () => {
  const ready = readyWorkspace("p-1");
  let attempt = 0;
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return draftProposal(ready);
  });
  const api = makeFakeApi({
    getProject: async () => project("p-1"),
    getWorkspace: async () => ready,
    workspaceAgentTurn,
  });
  const first = render(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );

  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: "Recover only an uncertain delivery" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  expect(await screen.findByRole("status", { name: "Workspace Agent error" })).toHaveTextContent(
    "Failed to fetch",
  );
  const firstTurnId = workspaceAgentTurn.mock.calls[0]![1].turnId;
  first.unmount();

  render(
    <ApiProvider client={api}>
      <AgentScopeProbe targetId={null} />
    </ApiProvider>,
  );

  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));
  expect(workspaceAgentTurn.mock.calls[1]![1].turnId).toBe(firstTurnId);
  expect(await screen.findByRole("status", { name: "Proposal review state" })).toHaveTextContent("draft");
});

test("Workspace Agent carries the unresolved original brief into a changed retry", async () => {
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    throw new TypeError("Failed to fetch");
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

  const original = "3 directions: cinematic, paper, cobalt. Each has Home, Film, Schedule, Checkout.";
  const correction = "Retry all requested Pages as new items.";
  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: original } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  await screen.findByText("Failed to fetch");

  fireEvent.change(prompt, { target: { value: correction } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));

  const firstRequest = workspaceAgentTurn.mock.calls[0]![1];
  const retryRequest = workspaceAgentTurn.mock.calls[1]![1];
  expect(retryRequest.turnId).not.toBe(firstRequest.turnId);
  expect(decodeWorkspaceAgentConversation(retryRequest.message)).toEqual({
    priorRequests: [original],
    currentRequest: correction,
  });
  expect(new TextEncoder().encode(retryRequest.message).byteLength).toBeLessThanOrEqual(64 * 1024);
});

test("Workspace Agent starts an independent request without carrying a failed brief", async () => {
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async (
    _projectId: string,
    _input: WorkspaceAgentTurnInput,
  ) => {
    throw new TypeError("Failed to fetch");
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

  const original = "Create 3 visual directions. Each has Home, Film, Schedule, and Checkout.";
  const independent = "Create a settings page.";
  const prompt = await screen.findByRole("textbox", { name: "Current Agent prompt" });
  fireEvent.change(prompt, { target: { value: original } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(1));
  await screen.findByText("Failed to fetch");

  fireEvent.change(prompt, { target: { value: independent } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  await waitFor(() => expect(workspaceAgentTurn).toHaveBeenCalledTimes(2));

  const firstRequest = workspaceAgentTurn.mock.calls[0]![1];
  const independentRequest = workspaceAgentTurn.mock.calls[1]![1];
  expect(independentRequest.turnId).not.toBe(firstRequest.turnId);
  expect(independentRequest.message).toBe(independent);
  expect(decodeWorkspaceAgentConversation(independentRequest.message)).toEqual({
    priorRequests: [],
    currentRequest: independent,
  });
});

test("Workspace Agent clears a stale scope error as soon as its draft changes", async () => {
  const ready = readyWorkspace("p-1");
  const workspaceAgentTurn = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
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
  fireEvent.change(prompt, { target: { value: "Create a complete festival workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit current scope" }));
  expect(await screen.findByRole("status", { name: "Workspace Agent error" }))
    .toHaveTextContent("Failed to fetch");

  fireEvent.change(prompt, { target: { value: "Create a complete festival workspace with three directions" } });
  expect(screen.getByRole("status", { name: "Workspace Agent error" })).toHaveTextContent("none");
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
