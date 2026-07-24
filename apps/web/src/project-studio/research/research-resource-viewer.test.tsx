import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ApiProvider } from "../../lib/api-context.tsx";
import { decodeResearchResourceRevision } from "../../lib/api.ts";
import type {
  ApprovedResearchDirectionArtifactIntentResult,
  CreateResearchDirectionArtifactIntentInput,
  GraphCommandRequest,
  ReadyProjectWorkspacePayload,
  ResearchResourceRevisionView,
  Resource,
  ResourceRevision,
  WorkspaceGraphMutationResult,
} from "../../lib/api.ts";
import { makeFakeApi } from "../../test/fake-api.ts";
import { ResearchResourceViewer } from "./ResearchResourceViewer.tsx";

afterEach(cleanup);

const READY_AGENT_PROPS = {
  agentCommand: "codebuddy",
  model: "gpt-5.6-sol",
  agentSettingsReady: true,
  afterContextSettings: async (action: () => void | Promise<void>): Promise<void> => {
    await action();
  },
} as const;

const resource: Resource = {
  id: "resource-research",
  workspaceId: "workspace-1",
  kind: "research",
  title: "Checkout decision research",
  headRevisionId: "research-revision-1",
  defaultPinPolicy: "pin-current",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
};

const STUDY_RECEIPT_ID = `research-evidence-${"a".repeat(64)}`;
const NOTE_RECEIPT_ID = `research-evidence-${"b".repeat(64)}`;
const GROUNDED_SUPPORT_ID = `research-support-${"c".repeat(64)}`;
const HYPOTHESIS_SUPPORT_ID = `research-support-${"d".repeat(64)}`;
const SUMMARY_SUPPORT_ID = `research-support-${"e".repeat(64)}`;

const revision: ResourceRevision = {
  id: "research-revision-1",
  workspaceId: "workspace-1",
  resourceId: resource.id,
  sequence: 1,
  parentRevisionId: null,
  manifestPath: "resource-revisions/research-revision-1/manifest.json",
  summary: "One grounded and one hypothesis direction",
  metadata: { qualityState: "grounded", evidenceDirectionCount: 1, hypothesisDirectionCount: 1 },
  checksum: "a".repeat(64),
  provenance: {},
  createdByRunId: null,
  createdAt: 2,
};

const researchView: ResearchResourceRevisionView = {
  protocol: "dezin.research-resource-revision-view.v1",
  resource,
  revision,
  observed: { headRevisionId: revision.id, snapshotId: "snapshot-3" },
  qualityState: "grounded",
  evidenceDirectionCount: 1,
  hypothesisDirectionCount: 1,
  executiveSummary: "Checkout confidence should be quiet, explicit, and easy to verify.",
  sources: [
    {
      id: "source-study",
      kind: "web",
      title: "Verified checkout study",
      locator: "https://example.test/study",
      excerpt: "People compare delivery and total cost before payment.",
      notes: "",
      verification: "verified",
      receiptId: STUDY_RECEIPT_ID,
    },
    {
      id: "source-note",
      kind: "user",
      title: "Interview hypothesis",
      locator: "interview-7",
      excerpt: "A richer confirmation may feel more rewarding.",
      notes: "Needs a broader sample.",
      verification: "unverified",
      receiptId: NOTE_RECEIPT_ID,
    },
  ],
  findings: [
    {
      id: "finding-grounded",
      statement: "People compare delivery and total cost before payment.",
      implication: "Keep both values beside the primary action.",
      confidence: "high",
      evidenceStatus: "evidence",
      sourceIds: ["source-study"],
      verifiedSourceIds: ["source-study"],
      unverifiedSourceIds: [],
      supportReceiptIds: [GROUNDED_SUPPORT_ID],
      groundedness: {
        verified: true,
        verifier: { id: "verifier-1" },
        rationale: "Directly supported by a verified study.",
        supportReceiptIds: [GROUNDED_SUPPORT_ID],
      },
    },
    {
      id: "finding-hypothesis",
      statement: "A richer confirmation may feel more rewarding.",
      implication: "Explore celebration without delaying completion.",
      confidence: "low",
      evidenceStatus: "hypothesis",
      sourceIds: ["source-note"],
      verifiedSourceIds: [],
      unverifiedSourceIds: ["source-note"],
      supportReceiptIds: [HYPOTHESIS_SUPPORT_ID],
      groundedness: {
        verified: false,
        verifier: { id: "verifier-1" },
        rationale: "Only one unverified note supports this claim.",
        supportReceiptIds: [],
      },
    },
    {
      id: "finding-summary",
      statement: "A persistent order summary reduces comparison effort.",
      implication: "Keep the summary visible through commitment.",
      confidence: "medium",
      evidenceStatus: "evidence",
      sourceIds: ["source-study"],
      verifiedSourceIds: ["source-study"],
      unverifiedSourceIds: [],
      supportReceiptIds: [SUMMARY_SUPPORT_ID],
      groundedness: {
        verified: true,
        verifier: { id: "verifier-1" },
        rationale: "The verified study directly supports the persistent summary.",
        supportReceiptIds: [SUMMARY_SUPPORT_ID],
      },
    },
  ],
  designPrinciples: [
    {
      id: "principle-total",
      title: "Keep the total visible",
      rationale: "Reduce comparison effort.",
      findingIds: ["finding-grounded"],
      evidenceFindingIds: ["finding-grounded"],
      hypothesisFindingIds: [],
      evidenceStatus: "evidence",
    },
    {
      id: "principle-summary",
      title: "Keep the summary stable",
      rationale: "Preserve context through commitment.",
      findingIds: ["finding-summary"],
      evidenceFindingIds: ["finding-summary"],
      hypothesisFindingIds: [],
      evidenceStatus: "evidence",
    },
    {
      id: "principle-hypothesis",
      title: "Test celebration separately",
      rationale: "Treat expressive confirmation as a hypothesis.",
      findingIds: ["finding-hypothesis"],
      evidenceFindingIds: [],
      hypothesisFindingIds: ["finding-hypothesis"],
      evidenceStatus: "hypothesis",
    },
  ],
  directions: [
    {
      id: "quiet-confidence",
      title: "Quiet confidence",
      thesis: "Use restrained hierarchy and a persistent order rail.",
      visualLanguage: ["warm neutrals", "precise hierarchy"],
      interactionPrinciples: ["keep totals persistent"],
      risks: ["Restraint can hide urgency"],
      findingIds: ["finding-grounded", "finding-summary"],
      evidenceFindingIds: ["finding-grounded", "finding-summary"],
      hypothesisFindingIds: [],
      evidenceStatus: "evidence",
    },
    {
      id: "expressive-confirmation",
      title: "Expressive confirmation",
      thesis: "Make completion feel more rewarding.",
      visualLanguage: ["bold success color", "kinetic confirmation"],
      interactionPrinciples: ["celebrate after commitment"],
      risks: ["Celebration may distract from the receipt"],
      findingIds: ["finding-hypothesis"],
      evidenceFindingIds: [],
      hypothesisFindingIds: ["finding-hypothesis"],
      evidenceStatus: "hypothesis",
    },
  ],
  openQuestions: ["Does expressive confirmation hold across a broader sample?"],
};

function workspace(withArtifact = true): ReadyProjectWorkspacePayload {
  const artifactNode = {
    id: "artifact-node",
    workspaceId: "workspace-1",
    kind: "page" as const,
    name: "Checkout page",
    artifactId: "artifact-checkout",
  };
  const resourceNode = {
    id: "resource-node",
    workspaceId: "workspace-1",
    kind: "resource" as const,
    name: resource.title,
    resourceId: resource.id,
  };
  const graph = {
    workspaceId: "workspace-1",
    revision: 3,
    nodes: withArtifact ? [resourceNode, artifactNode] : [resourceNode],
    edges: withArtifact ? [{
      id: "research-informs-checkout",
      workspaceId: "workspace-1",
      kind: "informs" as const,
      sourceNodeId: resourceNode.id,
      targetNodeId: artifactNode.id,
    }] : [],
  };
  const snapshot: ReadyProjectWorkspacePayload["activeSnapshot"] = {
    id: "snapshot-3",
    workspaceId: "workspace-1",
    sequence: 3,
    parentSnapshotId: "snapshot-2",
    graphRevision: 3,
    kernelRevisionId: "kernel-1",
    reason: "test",
    provenance: { kind: "graph-command" as const, commandIds: ["command-3"] },
    createdByRunId: null,
    createdAt: 3,
    graph,
    artifactTracks: withArtifact ? { "artifact-checkout": "track-checkout" } : {},
    artifactRevisions: withArtifact ? { "artifact-checkout": null } : {},
    resourceRevisions: { [resource.id]: revision.id },
  };
  return {
    status: "ready",
    workspace: {
      id: "workspace-1",
      projectId: "project-1",
      mode: "standard",
      graphRevision: 3,
      activeSnapshotId: snapshot.id,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: 3,
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
    artifacts: withArtifact ? [{
      id: "artifact-checkout",
      workspaceId: "workspace-1",
      kind: "page",
      name: "Checkout page",
      sourceRoot: "artifacts/checkout",
      legacyWrapped: false,
      activeTrackId: "track-checkout",
      archivedAt: null,
      createdAt: 2,
      updatedAt: 2,
    }] : [],
    tracks: withArtifact ? [{
      id: "track-checkout",
      artifactId: "artifact-checkout",
      name: "Main",
      headRevisionId: null,
      legacyVariantId: null,
      createdAt: 2,
    }] : [],
    revisions: [],
    snapshots: [snapshot],
    resources: [resource],
    resourceRevisions: [revision],
    layout: {
      workspaceId: "workspace-1",
      layoutId: "default",
      objects: graph.nodes.map((node, index) => ({
        id: node.id,
        kind: "node" as const,
        x: index * 360,
        y: 0,
        parentGroupId: null,
      })),
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "b".repeat(64),
    },
  };
}

function baseApi(overrides: Parameters<typeof makeFakeApi>[0] = {}) {
  return makeFakeApi({
    getResource: async () => resource,
    listResourceRevisions: async () => [revision],
    getResearchResourceRevision: async () => researchView,
    ...overrides,
  });
}

test("Research decoder rejects credential locators and forged grounded evidence", () => {
  expect(decodeResearchResourceRevision(researchView)).toEqual(researchView);

  const credentialLocator = structuredClone(researchView);
  credentialLocator.sources[0]!.locator = "https://example.test/study?access_token=not-for-the-viewer";
  expect(() => decodeResearchResourceRevision(credentialLocator)).toThrow(/credential-free/i);

  const forgedGroundedness = structuredClone(researchView);
  forgedGroundedness.findings[0]!.groundedness.verifier = null;
  expect(() => decodeResearchResourceRevision(forgedGroundedness)).toThrow(/evidence projection/i);
});

test("Current Head Research retries once when the atomic view observes a newer Head", async () => {
  const staleResource = { ...resource, headRevisionId: "research-revision-stale" };
  const staleView: ResearchResourceRevisionView = {
    ...researchView,
    resource: staleResource,
    revision: { ...revision, id: "research-revision-stale", sequence: 0 },
    observed: { headRevisionId: revision.id, snapshotId: "snapshot-3" },
    executiveSummary: "Stale Research body.",
  };
  let resourceRead = 0;
  const getResource = vi.fn(async () => (resourceRead++ === 0 ? staleResource : resource));
  const getResearchResourceRevision = vi.fn(async (_projectId, _resourceId, revisionId) => (
    revisionId === staleView.revision.id ? staleView : researchView
  ));
  render(
    <ApiProvider client={baseApi({ getResource, getResearchResourceRevision })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={null}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText(researchView.executiveSummary)).toBeInTheDocument();
  expect(screen.queryByText("Stale Research body.")).not.toBeInTheDocument();
  expect(getResource).toHaveBeenCalledTimes(2);
  expect(getResearchResourceRevision).toHaveBeenNthCalledWith(
    2,
    "project-1",
    resource.id,
    revision.id,
  );
});

test("a top-level Research load failure retries in place and preserves the exact Revision", async () => {
  const user = userEvent.setup();
  const getResource = vi.fn()
    .mockRejectedValueOnce(new Error("Research service is temporarily unavailable"))
    .mockResolvedValueOnce(resource);
  render(
    <ApiProvider client={baseApi({ getResource })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByText(researchView.executiveSummary)).toBeInTheDocument();
  expect(getResource).toHaveBeenCalledTimes(2);
});

test("an archived Research Resource has no writable Current Head surface", async () => {
  const archivedAt = 9_000;
  const archivedResource = { ...resource, archivedAt };
  const archivedView: ResearchResourceRevisionView = {
    ...researchView,
    resource: archivedResource,
  };
  const getResearchResourceRevision = vi.fn(async () => archivedView);
  render(
    <ApiProvider client={baseApi({
      getResource: async () => archivedResource,
      getResearchResourceRevision,
    })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={null}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(/archived/i);
  expect(screen.queryByRole("button", { name: "Create Artifact plan" })).not.toBeInTheDocument();
  expect(getResearchResourceRevision).not.toHaveBeenCalled();
});

test("an archived exact Research Revision remains readable without write controls", async () => {
  const archivedResource = { ...resource, archivedAt: 9_000 };
  const archivedView: ResearchResourceRevisionView = {
    ...researchView,
    resource: archivedResource,
  };
  const getResearchResourceRevision = vi.fn(async () => archivedView);
  render(
    <ApiProvider client={baseApi({
      getResource: async () => archivedResource,
      getResearchResourceRevision,
    })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText(researchView.executiveSummary)).toBeInTheDocument();
  expect(screen.getByLabelText("Archived Research Revision")).toHaveTextContent(/read.only/i);
  expect(screen.queryByRole("button", { name: "Create Artifact plan" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Return to Head/i })).not.toBeInTheDocument();
  expect(getResearchResourceRevision).toHaveBeenCalledWith(
    "project-1",
    resource.id,
    revision.id,
  );
});

test("Research directions use roving radio focus and arrow-key selection", async () => {
  const user = userEvent.setup();
  render(
    <ApiProvider client={baseApi()}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  const first = await screen.findByRole("radio", { name: /Quiet confidence/ });
  const second = screen.getByRole("radio", { name: /Expressive confirmation/ });
  expect(first).toHaveAttribute("tabindex", "0");
  expect(second).toHaveAttribute("tabindex", "-1");

  first.focus();
  await user.keyboard("{ArrowRight}");
  expect(second).toHaveFocus();
  expect(second).toHaveAttribute("aria-checked", "true");
  expect(first).toHaveAttribute("tabindex", "-1");
  expect(second).toHaveAttribute("tabindex", "0");

  await user.keyboard("{Home}");
  expect(first).toHaveFocus();
  expect(first).toHaveAttribute("aria-checked", "true");
});

test("Research viewer exposes evidence provenance and requires explicit confirmation for a hypothesis", async () => {
  const user = userEvent.setup();
  const createIntent = vi.fn(async () => ({
    plan: { id: "plan-successor" },
  } as unknown as ApprovedResearchDirectionArtifactIntentResult));
  const onPlanCreated = vi.fn();
  render(
    <ApiProvider client={baseApi({ createResearchDirectionArtifactIntent: createIntent })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={onPlanCreated}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByRole("heading", { name: resource.title })).toBeInTheDocument();
  expect(document.querySelector(".dezin-research-viewer__history")).toBeInTheDocument();
  expect(screen.getByText("Grounded")).toBeInTheDocument();
  expect(screen.getByText("1 evidence · 1 hypothesis")).toBeInTheDocument();
  expect(screen.getByText("Verified checkout study")).toBeInTheDocument();
  expect(screen.getByText(`Receipt · ${STUDY_RECEIPT_ID}`)).toBeInTheDocument();
  expect(screen.getByText("Does expressive confirmation hold across a broader sample?")).toBeInTheDocument();

  const evidenceChain = screen.getByText("Evidence chain · 2 findings · 1 source");
  await user.click(evidenceChain);
  expect(evidenceChain.closest("details")).toHaveAttribute("open");
  expect(screen.getByText("Verified checkout study · verified")).toBeInTheDocument();

  await user.click(screen.getByRole("radio", { name: /Expressive confirmation/ }));
  const createButton = screen.getByRole("button", { name: "Create Artifact plan" });
  expect(createButton).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  expect(createButton).toBeEnabled();
  await user.click(createButton);

  await waitFor(() => expect(createIntent).toHaveBeenCalledOnce());
  expect(createIntent).toHaveBeenCalledWith(
    "project-1",
    resource.id,
    revision.id,
    "expressive-confirmation",
    expect.objectContaining({
      artifactId: "artifact-checkout",
      confirmHypothesis: true,
      expectedResourceHeadRevisionId: revision.id,
      expectedGraphRevision: 3,
      expectedSnapshotId: "snapshot-3",
    }),
  );
  expect(onPlanCreated).toHaveBeenCalledWith("plan-successor");
});

test("Research direction generation waits for persisted Agent settings and freezes their exact selection", async () => {
  const user = userEvent.setup();
  let releaseSettings!: () => void;
  const settingsPersisted = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  const afterContextSettings = vi.fn(async (action: () => void | Promise<void>) => {
    await settingsPersisted;
    await action();
  });
  const createIntent = vi.fn(async (
    _projectId: string,
    _resourceId: string,
    _revisionId: string,
    _directionId: string,
    _input: CreateResearchDirectionArtifactIntentInput,
  ) => ({
    plan: { id: "plan-codebuddy" },
  } as unknown as ApprovedResearchDirectionArtifactIntentResult));
  const api = baseApi({ createResearchDirectionArtifactIntent: createIntent });
  const rendered = render(
    <ApiProvider client={api}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        agentCommand="codebuddy"
        model="gpt-5.6-sol"
        agentSettingsReady={false}
        afterContextSettings={afterContextSettings}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  const createButton = await screen.findByRole("button", { name: "Create Artifact plan" });
  expect(createButton).toBeDisabled();
  expect(afterContextSettings).not.toHaveBeenCalled();
  expect(createIntent).not.toHaveBeenCalled();

  rendered.rerender(
    <ApiProvider client={api}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace()}
        agentCommand="codebuddy"
        model="gpt-5.6-sol"
        agentSettingsReady
        afterContextSettings={afterContextSettings}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  expect(createButton).toBeEnabled();
  await user.click(createButton);
  expect(afterContextSettings).toHaveBeenCalledOnce();
  expect(createIntent).not.toHaveBeenCalled();

  releaseSettings();
  await waitFor(() => expect(createIntent).toHaveBeenCalledOnce());
  expect(createIntent.mock.calls[0]![4]).toEqual(expect.objectContaining({
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
  }));
  expect(createIntent.mock.calls[0]![4]).not.toHaveProperty("providerId");
});

test("Research viewer can create a direction-named Page target when the canvas has no Artifact", async () => {
  const user = userEvent.setup();
  const applyCommands = vi.fn(async (
    _projectId: string,
    _input: GraphCommandRequest,
  ): Promise<WorkspaceGraphMutationResult> => ({} as WorkspaceGraphMutationResult));
  const onWorkspaceChanged = vi.fn();
  render(
    <ApiProvider client={baseApi({ applyWorkspaceGraphCommands: applyCommands })}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={workspace(false)}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={onWorkspaceChanged}
      />
    </ApiProvider>,
  );

  await screen.findByRole("heading", { name: resource.title });
  await user.click(screen.getByRole("button", { name: "Create Page" }));
  await waitFor(() => expect(applyCommands).toHaveBeenCalledOnce());
  expect(applyCommands.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
    baseGraphRevision: 3,
    expectedSnapshotId: "snapshot-3",
    commands: [expect.objectContaining({
      type: "add-node",
      node: expect.objectContaining({
        kind: "page",
        name: "Quiet confidence page",
      }),
    })],
  }));
  expect(onWorkspaceChanged).toHaveBeenCalledOnce();
});

test("Research viewer refreshes its exact observation before creating a plan after the Workspace advances", async () => {
  const user = userEvent.setup();
  const applyCommands = vi.fn(async (
    _projectId: string,
    _input: GraphCommandRequest,
  ): Promise<WorkspaceGraphMutationResult> => ({} as WorkspaceGraphMutationResult));
  const createIntent = vi.fn(async () => ({
    plan: { id: "plan-after-target" },
  } as unknown as ApprovedResearchDirectionArtifactIntentResult));
  let observedSnapshotId = "snapshot-3";
  const getResearchResourceRevision = vi.fn(async () => ({
    ...researchView,
    observed: { ...researchView.observed, snapshotId: observedSnapshotId },
  }));
  const api = baseApi({
    applyWorkspaceGraphCommands: applyCommands,
    createResearchDirectionArtifactIntent: createIntent,
    getResearchResourceRevision,
  });
  const initialWorkspace = workspace(false);
  const rendered = render(
    <ApiProvider client={api}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={initialWorkspace}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  await screen.findByRole("heading", { name: resource.title });
  await user.click(screen.getByRole("button", { name: "Create Page" }));
  await waitFor(() => expect(applyCommands).toHaveBeenCalledOnce());

  const advancedWorkspace = structuredClone(workspace(true));
  advancedWorkspace.graph.revision = 4;
  advancedWorkspace.workspace.graphRevision = 4;
  advancedWorkspace.workspace.activeSnapshotId = "snapshot-4";
  advancedWorkspace.activeSnapshot.id = "snapshot-4";
  advancedWorkspace.activeSnapshot.parentSnapshotId = "snapshot-3";
  advancedWorkspace.activeSnapshot.graphRevision = 4;
  advancedWorkspace.activeSnapshot.graph = advancedWorkspace.graph;
  advancedWorkspace.layout.checksum = "c".repeat(64);
  observedSnapshotId = "snapshot-4";
  rendered.rerender(
    <ApiProvider client={api}>
      <ResearchResourceViewer
        projectId="project-1"
        resourceId={resource.id}
        requestedRevisionId={revision.id}
        workspace={advancedWorkspace}
        {...READY_AGENT_PROPS}
        onBack={() => {}}
        onOpenRevision={() => {}}
        onPlanCreated={() => {}}
        onWorkspaceChanged={() => {}}
      />
    </ApiProvider>,
  );

  await waitFor(() => expect(getResearchResourceRevision).toHaveBeenCalledTimes(2));
  await user.click(await screen.findByRole("button", { name: "Create Artifact plan" }));
  await waitFor(() => expect(createIntent).toHaveBeenCalledOnce());
  expect(createIntent).toHaveBeenCalledWith(
    "project-1",
    resource.id,
    revision.id,
    "quiet-confidence",
    expect.objectContaining({
      artifactId: "artifact-checkout",
      expectedResourceHeadRevisionId: revision.id,
      expectedGraphRevision: 4,
      expectedSnapshotId: "snapshot-4",
      expectedLayoutChecksum: "c".repeat(64),
    }),
  );
});
