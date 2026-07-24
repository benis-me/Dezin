import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App.tsx";
import { Shell } from "../components/Shell.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type {
  ArtifactRevision,
  GenerationPlanDetail,
  PreviewTarget,
  Project,
  ProjectWorkspacePayload,
  Resource,
  ResolvedPreviewTarget,
} from "../lib/api.ts";
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

const PREVIEW_BRIDGE_NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

function revisionWorkspace(projectId: string): ProjectWorkspacePayload {
  const current = readyWorkspace(projectId);
  if (current.status !== "ready") throw new Error("revision workspace must be ready");
  const artifact = current.artifacts[0]!;
  const revision = (id: string, sequence: number): ArtifactRevision => ({
    id,
    workspaceId: current.workspace.id,
    artifactId: artifact.id,
    trackId: "track-main",
    sequence,
    parentRevisionId: sequence > 1 ? `revision-${sequence - 1}` : null,
    sourceCommitHash: `commit-${id}`,
    sourceTreeHash: `tree-${id}`,
    artifactRoot: `artifacts/${artifact.id}`,
    kernelRevisionId: current.activeKernelRevision.id,
    renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100 },
    contextPackHash: null,
    producedByRunId: null,
    legacyRunId: null,
    createdAt: sequence,
  });
  const revisions = [revision("revision-1", 1), revision("revision-2", 2), revision("revision-head", 3)];
  return {
    ...current,
    artifacts: [{ ...artifact, activeTrackId: "track-main", sourceRoot: `artifacts/${artifact.id}` }],
    tracks: [{
      id: "track-main",
      artifactId: artifact.id,
      name: "Main",
      headRevisionId: "revision-head",
      legacyVariantId: null,
      createdAt: 1,
    }],
    revisions,
    activeSnapshot: {
      ...current.activeSnapshot,
      artifactTracks: { [artifact.id]: "track-main" },
      artifactRevisions: { [artifact.id]: "revision-head" },
    },
  };
}

function resolvedRevision(target: PreviewTarget, revisionId: string): ResolvedPreviewTarget {
  return {
    version: 1,
    targetKey: `artifact-revision:${revisionId}`,
    requestedKind: target.kind,
    projectId: "p-1",
    workspaceId: "workspace-p-1",
    artifactId: "artifact-p-1",
    artifactKind: "page",
    revisionId,
    trackId: "track-main",
    snapshotId: null,
    sourceCommitHash: `commit-${revisionId}`,
    sourceTreeHash: `tree-${revisionId}`,
    dependencyLockHash: `dependencies-${revisionId}`,
    assemblyHash: `assembly-${revisionId}`,
    artifactRoot: "artifacts/artifact-p-1",
    renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }] },
    variantKey: null,
    stateKey: null,
    runId: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/projects/p-1/canvas");
});

afterEach(cleanup);

test("Canvas Present flow opens an exact Snapshot viewer without resolving mutable Head", async () => {
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "workspace-flow") throw new Error("prototype viewer must use workspace-flow");
    return {
      ...resolvedRevision(target, "revision-head"),
      requestedKind: "workspace-flow" as const,
      snapshotId: target.snapshotId,
    };
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async (id) => project(id),
      getWorkspace: async (id) => revisionWorkspace(id),
      resolvePreviewTarget,
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-flow-exact",
        url: `http://preview.local/flow#dezin-bridge=${PREVIEW_BRIDGE_NONCE}`,
        bridgeNonce: PREVIEW_BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <App />
    </ApiProvider>,
  );

  const present = await screen.findByRole("button", { name: "Present prototype flow" });
  fireEvent.click(present);
  const viewer = await screen.findByRole("region", { name: "Prototype flow viewer" });
  expect(viewer).toBeInTheDocument();
  expect(viewer).toHaveFocus();
  expect(screen.getByTestId("project-studio-shell")).toHaveAttribute("data-presentation", "true");
  expect(screen.queryByRole("complementary", { name: "Workspace Agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "Resize Workspace Agent" })).not.toBeInTheDocument();
  expect(document.getElementById("dezin-project-studio-layout")).toBeInTheDocument();
  expect(document.getElementById("workspace-agent")).toHaveAttribute("hidden");
  expect(await screen.findByTitle("Landing page flow preview")).toBeInTheDocument();
  expect(resolvePreviewTarget).toHaveBeenCalledWith("p-1", {
    kind: "workspace-flow",
    projectId: "p-1",
    snapshotId: "snapshot-p-1",
    startArtifactId: "artifact-p-1",
  }, expect.any(AbortSignal));
  expect(screen.getAllByText(/snapshot-p-1/i)).not.toHaveLength(0);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).not.toHaveAttribute("data-presentation");
  expect(screen.getByRole("complementary", { name: "Workspace Agent" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize Workspace Agent" })).toBeInTheDocument();
  expect(document.getElementById("dezin-project-studio-layout")).toBeInTheDocument();
  expect(document.getElementById("workspace-agent")).not.toHaveAttribute("hidden");
  expect(screen.getByRole("button", { name: "Present prototype flow" })).toHaveFocus();
});

test("Canvas and Artifact routes preserve only their own scope-keyed Agent drafts", async () => {
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
  expect(screen.getByRole("complementary", { name: "Artifact Agent" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Artifact Agent" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveAttribute(
    "placeholder",
    "Describe a focused change to this artifact or selected element…",
  );
  expect(canvas).not.toBeInTheDocument();
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByRole("textbox", { name: "Artifact Agent draft" }), {
    target: { value: "Refine the first artifact" },
  });

  act(() => navigate("/projects/p-1/artifacts/artifact-p-1-b"));
  expect(await screen.findByText("artifact-p-1-b")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("");
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(getProject).toHaveBeenCalledTimes(1);
  expect(getWorkspace).toHaveBeenCalledTimes(1);

  act(() => navigate("/projects/p-1/artifacts/artifact-p-1"));
  expect(await screen.findByText("artifact-p-1")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("Refine the first artifact");

  act(() => navigate("/projects/p-1/canvas"));
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("Create a checkout page");

  act(() => navigate("/projects/p-2/canvas"));

  await waitFor(() => expect(screen.getByTestId("project-studio-shell")).not.toBe(shell));
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("");
  expect(getProject).toHaveBeenCalledTimes(2);
  expect(getWorkspace).toHaveBeenCalledTimes(2);
});

function generationPlanDetail(
  planId: string,
  artifactId: string,
  createdAt: number,
  dispatchContextPackId?: string,
): GenerationPlanDetail {
  return {
    plan: {
      id: planId,
      workspaceId: "workspace-p-1",
      proposalId: `proposal-${planId}`,
      proposalRevision: 1,
      baseSnapshotId: "snapshot-p-1",
      status: "succeeded",
      constructionSealed: true,
      executionEpoch: 1,
      compileError: null,
      createdAt,
      finishedAt: createdAt + 1,
    },
    tasks: [{
      id: `task-${planId}`,
      ordinal: 0,
      workspaceId: "workspace-p-1",
      planId,
      kind: "page",
      target: { type: "artifact", workspaceId: "workspace-p-1", id: artifactId, trackId: "track-main" },
      dependencyIds: [],
      ...(dispatchContextPackId === undefined ? {} : {
        payload: { artifactPlan: { dispatchContextPackId } },
      }),
      capabilities: [],
      status: "succeeded",
      blockedReason: null,
      blockedByTaskId: null,
      pendingContextPolicy: null,
      currentAttempt: 1,
      materializationFailures: 0,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      resultRevisionId: `revision-${planId}`,
      resultResourceRevisionId: null,
      resultSnapshotId: null,
      createdAt,
      finishedAt: createdAt + 1,
    }],
    dependencies: [],
    currentAttempts: [],
  };
}

test("Workspace canvas keeps Plan history closed until a Plan is explicitly opened", async () => {
  const ordinary = generationPlanDetail("plan-history", "artifact-p-1", 2);
  const listGenerationPlans = vi.fn(async () => [ordinary.plan]);
  const getGenerationPlan = vi.fn(async () => ordinary);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      listGenerationPlans,
      getGenerationPlan,
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId("project-studio-shell")).toHaveAttribute("data-inspector-layout", "closed");
  expect(screen.queryByRole("heading", { name: "Build plan" })).not.toBeInTheDocument();
  expect(listGenerationPlans).not.toHaveBeenCalled();
  expect(getGenerationPlan).not.toHaveBeenCalled();
});

test("Artifact route restores the newest durable scoped Plan without displacing the Inspector", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  const exact = generationPlanDetail(
    "plan-exact",
    "artifact-p-1",
    2,
    `context-pack-${"a".repeat(64)}`,
  );
  const unrelated = generationPlanDetail("plan-unrelated", "artifact-other", 3);
  const details = new Map([[exact.plan.id, exact], [unrelated.plan.id, unrelated]]);
  const getWorkspace = vi.fn(async () => readyWorkspace("p-1"));
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace,
      getLatestScopedArtifactPlanId: async () => exact.plan.id,
      listGenerationPlans: async () => [unrelated.plan, exact.plan],
      getGenerationPlan: async (_projectId, planId) => details.get(planId)!,
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  const openPlan = await screen.findByRole("button", { name: "Open build plan" });
  expect(screen.getByLabelText("Artifact Agent task status")).toHaveTextContent(exact.plan.id);
  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  fireEvent.click(openPlan);
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Selected generation plan" })).toHaveValue("plan-exact");
});

test("Artifact route does not mistake an ordinary single-leaf Workspace Plan for scoped Agent work", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  const ordinary = generationPlanDetail("plan-ordinary", "artifact-p-1", 2);
  const getLatestScopedArtifactPlanId = vi.fn(async () => null);
  const getGenerationPlan = vi.fn(async () => ordinary);
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      getLatestScopedArtifactPlanId,
      listGenerationPlans: async () => [ordinary.plan],
      getGenerationPlan,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(getLatestScopedArtifactPlanId).toHaveBeenCalled());
  expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Build plan" })).not.toBeInTheDocument();
  expect(getGenerationPlan).not.toHaveBeenCalled();
});

test("Artifact route retries scoped Plan discovery after a transient lookup failure", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  const exact = generationPlanDetail(
    "plan-recovered",
    "artifact-p-1",
    2,
    `context-pack-${"d".repeat(64)}`,
  );
  let attempts = 0;
  const getLatestScopedArtifactPlanId = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary read failure");
    return exact.plan.id;
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      getLatestScopedArtifactPlanId,
      listGenerationPlans: async () => [exact.plan],
      getGenerationPlan: async () => exact,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(getLatestScopedArtifactPlanId).toHaveBeenCalledTimes(2), { timeout: 1_500 });
  expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  expect(screen.getByLabelText("Artifact Agent task status")).toHaveTextContent(exact.plan.id);
  fireEvent.click(screen.getByRole("button", { name: "Open build plan" }));
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();
});

test("Artifact route discovers a scoped Plan created by another viewer after the initial null", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  const exact = generationPlanDetail(
    "plan-from-another-viewer",
    "artifact-p-1",
    2,
    `context-pack-${"e".repeat(64)}`,
  );
  let attempts = 0;
  const getLatestScopedArtifactPlanId = vi.fn(async () => {
    attempts += 1;
    return attempts === 1 ? null : exact.plan.id;
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      getLatestScopedArtifactPlanId,
      listGenerationPlans: async () => [exact.plan],
      getGenerationPlan: async () => exact,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(getLatestScopedArtifactPlanId).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("heading", { name: "Build plan" })).not.toBeInTheDocument();
  await waitFor(() => expect(getLatestScopedArtifactPlanId).toHaveBeenCalledTimes(2), { timeout: 3_000 });
  expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  expect(screen.getByLabelText("Artifact Agent task status")).toHaveTextContent(exact.plan.id);
  fireEvent.click(screen.getByRole("button", { name: "Open build plan" }));
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();
});

test("Artifact route aborts its scoped Plan lookup when the Artifact view closes", async () => {
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  let lookupSignal: AbortSignal | undefined;
  const getLatestScopedArtifactPlanId = vi.fn((
    _projectId: string,
    _artifactId: string,
    signal?: AbortSignal,
  ) => {
    lookupSignal = signal;
    return new Promise<null>((resolve) => signal?.addEventListener(
      "abort",
      () => resolve(null),
      { once: true },
    ));
  });
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => readyWorkspace("p-1"),
      getLatestScopedArtifactPlanId,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(getLatestScopedArtifactPlanId).toHaveBeenCalledTimes(1));
  act(() => navigate("/projects/p-1/canvas"));
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(lookupSignal).toBeInstanceOf(AbortSignal);
  expect(lookupSignal?.aborted).toBe(true);
});

test("closing a failed Proposal review restores the scoped Resource Inspector after same-project navigation", async () => {
  const resource: Resource = {
    id: "resource-1",
    workspaceId: "workspace-p-1",
    kind: "research",
    title: "Checkout research",
    headRevisionId: null,
    defaultPinPolicy: "follow-head",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const workspace = readyWorkspace("p-1");
  if (workspace.status !== "ready") throw new Error("workspace fixture must be ready");
  workspace.resources = [resource];
  window.history.pushState({}, "", "/projects/p-1/artifacts/artifact-p-1");
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async () => project("p-1"),
      getWorkspace: async () => workspace,
      listWorkspaceProposals: async () => { throw new Error("proposal index unavailable"); },
      listResources: async () => [resource],
      getResource: async () => resource,
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("heading", { name: "Proposal unavailable" })).toBeInTheDocument();
  act(() => navigate("/projects/p-1/resources/resource-1"));
  expect(screen.getByRole("heading", { name: "Proposal unavailable" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Resource" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close review" }));

  expect(await screen.findByRole("heading", { name: "Resource" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Proposal review" })).not.toBeInTheDocument();
});

test("revision routes stay pinned to the URL identity and ignore an older same-project resolution", async () => {
  let resolveFirst!: (value: ResolvedPreviewTarget) => void;
  const first = new Promise<ResolvedPreviewTarget>((resolve) => { resolveFirst = resolve; });
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "artifact-revision") throw new Error("mutable Head resolution is forbidden");
    if (target.revisionId === "revision-1") return first;
    return resolvedRevision(target, target.revisionId);
  });
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, resolved: ResolvedPreviewTarget) => ({
    leaseId: `lease-${resolved.revisionId}`,
    url: `http://preview.local/${resolved.revisionId}#dezin-bridge=${PREVIEW_BRIDGE_NONCE}`,
    bridgeNonce: PREVIEW_BRIDGE_NONCE,
    expiresAt: Date.now() + 60_000,
    resolved,
  }));
  window.history.pushState(
    {},
    "",
    "/projects/p-1/artifacts/artifact-p-1/revisions/revision-1",
  );
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async (id) => project(id),
      getWorkspace: async (id) => revisionWorkspace(id),
      resolvePreviewTarget,
      acquirePreviewTargetLease,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(resolvePreviewTarget).toHaveBeenCalledWith(
    "p-1",
    { kind: "artifact-revision", projectId: "p-1", revisionId: "revision-1" },
    expect.any(AbortSignal),
  ));

  act(() => navigate("/projects/p-1/artifacts/artifact-p-1/revisions/revision-2"));

  const stage = await waitFor(() => {
    const value = document.querySelector<HTMLElement>('[data-preview-revision="revision-2"]');
    expect(value).not.toBeNull();
    return value!;
  });
  expect(stage).toBeInTheDocument();
  expect(screen.getByText("Pinned Revision · read-only")).toBeInTheDocument();
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(acquirePreviewTargetLease.mock.calls[0]?.[1].revisionId).toBe("revision-2");

  await act(async () => {
    resolveFirst(resolvedRevision(
      { kind: "artifact-revision", projectId: "p-1", revisionId: "revision-1" },
      "revision-1",
    ));
    await first;
  });
  expect(document.querySelector('[data-preview-revision="revision-2"]')).toBeInTheDocument();
  expect(document.querySelector('[data-preview-revision="revision-1"]')).not.toBeInTheDocument();
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(resolvePreviewTarget.mock.calls.every(([, target]) => target.kind === "artifact-revision")).toBe(true);
});

test("candidate Review routes resolve the exact Generation Attempt instead of a formal Revision", async () => {
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "generation-candidate") {
      throw new Error("candidate Review must use the Generation Attempt identity");
    }
    return {
      ...resolvedRevision(target, "revision-unpublished"),
      requestedKind: "generation-candidate" as const,
      generationCandidate: {
        planId: target.planId,
        taskId: target.taskId,
        attempt: target.attempt,
        evidenceHash: "e".repeat(64),
      },
    };
  });
  const getArtifactRevision = vi.fn(async () => {
    throw new Error("unpublished candidates are not formal Revisions");
  });
  window.history.pushState(
    {},
    "",
    "/projects/p-1/artifacts/artifact-p-1/candidates/plan%2F1/task%2F1/2",
  );
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async (id) => project(id),
      getWorkspace: async (id) => revisionWorkspace(id),
      getArtifactRevision,
      resolvePreviewTarget,
      acquirePreviewTargetLease: async (_projectId, resolved) => ({
        leaseId: "lease-generation-candidate",
        url: `http://preview.local/revision-unpublished#dezin-bridge=${PREVIEW_BRIDGE_NONCE}`,
        bridgeNonce: PREVIEW_BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved,
      }),
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByTitle("Landing page preview")).toBeInTheDocument();
  expect(resolvePreviewTarget).toHaveBeenCalledWith("p-1", {
    kind: "generation-candidate",
    projectId: "p-1",
    artifactId: "artifact-p-1",
    planId: "plan/1",
    taskId: "task/1",
    attempt: 2,
  }, expect.any(AbortSignal));
  expect(getArtifactRevision).not.toHaveBeenCalled();
  expect(screen.getByText("Read-only preview")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Artifact Agent task status" })).toHaveTextContent(
    "read-only while reviewing a Generation candidate",
  );
  expect(document.querySelector('[data-preview-revision="revision-unpublished"]')).toBeInTheDocument();
});

test("a Revision URL remains Agent-read-only even when it names the current Head", async () => {
  const artifactAgentTurn = vi.fn();
  window.history.pushState(
    {},
    "",
    "/projects/p-1/artifacts/artifact-p-1/revisions/revision-head",
  );
  render(
    <ApiProvider client={makeFakeApi({
      getProject: async (id) => project(id),
      getWorkspace: async (id) => revisionWorkspace(id),
      resolvePreviewTarget: async (_projectId, target) => resolvedRevision(target, "revision-head"),
      acquirePreviewTargetLease: async (_projectId, resolved) => ({
        leaseId: "lease-revision-head",
        url: `http://preview.local/revision-head#dezin-bridge=${PREVIEW_BRIDGE_NONCE}`,
        bridgeNonce: PREVIEW_BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved,
      }),
      artifactAgentTurn,
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByTitle("Landing page preview");
  const draft = screen.getByRole("textbox", { name: "Artifact Agent draft" });
  fireEvent.change(draft, { target: { value: "Try to mutate the pinned Head" } });
  fireEvent.keyDown(draft, { key: "Enter", metaKey: true });

  expect(screen.queryByRole("button", { name: "Queue artifact edit" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Artifact Agent task status" })).toHaveTextContent(
    "read-only while viewing a pinned Revision",
  );
  expect(artifactAgentTurn).not.toHaveBeenCalled();
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
  expect(await screen.findByRole("heading", { level: 1, name: "Project p-2" })).toBeInTheDocument();

  await act(async () => {
    resolveFirstProject(project("p-1"));
    resolveFirstWorkspace(readyWorkspace("p-1"));
    await firstProject;
    await firstWorkspace;
  });
  expect(screen.getByRole("heading", { level: 1, name: "Project p-2" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 1, name: "Project p-1" })).not.toBeInTheDocument();
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

test("Shell keeps every project Studio route full-bleed while Settings owns the URL", () => {
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

  rerender(
    <Shell
      dark={false}
      onToggleDark={() => {}}
      onOpenSettings={() => {}}
      routeOverride={{ name: "project-resource", id: "p-1", resourceId: "resource-1" }}
    >
      <div>Resource background</div>
    </Shell>,
  );
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
  expect(screen.queryByRole("separator", { name: "Resize app sidebar" })).not.toBeInTheDocument();

  rerender(
    <Shell
      dark={false}
      onToggleDark={() => {}}
      onOpenSettings={() => {}}
      routeOverride={{ name: "project-resource-revision", id: "p-1", resourceId: "resource-1", revisionId: "revision-1" }}
    >
      <div>Resource revision background</div>
    </Shell>,
  );
  expect(screen.getByTestId("app-shell")).toHaveAttribute("data-shell-layout", "project");
  expect(screen.queryByRole("separator", { name: "Resize app sidebar" })).not.toBeInTheDocument();
});
