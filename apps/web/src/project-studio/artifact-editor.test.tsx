import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type {
  ArtifactMutationResult,
  ArtifactRevision,
  ArtifactVersionActionResult,
  GenerationPlanDetail,
  GenerationTask,
  PreviewTarget,
  Project,
  ProjectWorkspacePayload,
  PreviewTargetLease,
  ReadyProjectWorkspacePayload,
  ResolvedPreviewTarget,
  ScopedAgentTurnReceipt,
  WorkspaceArtifact,
} from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { ArtifactInspector } from "./artifact/ArtifactInspector.tsx";
import { ArtifactPreviewSurface } from "./artifact/ArtifactPreviewSurface.tsx";
import {
  ArtifactEditorSurface,
  fitArtifactPreviewZoom,
  parseFrames,
  useArtifactEditorController,
} from "./artifact/ArtifactEditorSurface.tsx";
import { selectVersionComparisonFrame } from "./artifact/ArtifactVersions.tsx";
import type { ArtifactPreviewController } from "./artifact/useArtifactPreview.ts";
import { buildPreviewFrameCommand, PREVIEW_FRAME_ACK_TIMEOUT_MS } from "./artifact/usePreviewBridge.ts";
import { useProjectStudio } from "./useProjectStudio.ts";

const project: Project = {
  id: "project-1",
  name: "Northstar workspace",
  skillId: null,
  designSystemId: "modern-minimal",
  mode: "standard",
  createdAt: 1,
  updatedAt: 1,
};

const BRIDGE_NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

type PreviewBridgeTestMessage = { type?: string } & Record<string, unknown>;
type FramePostMessageMock = typeof window.postMessage & {
  mock: { calls: Array<[unknown, string, Transferable[]?]> };
};

interface PreviewBridgeTestHarness {
  frame: HTMLIFrameElement;
  port: MessagePort;
  commands: PreviewBridgeTestMessage[];
}

const previewBridgeHarnesses = new Set<PreviewBridgeTestHarness>();
const previewBridgeHarnessesByFrame = new WeakMap<HTMLIFrameElement, PreviewBridgeTestHarness[]>();
const previewBridgeCommandWaitersByFrame = new WeakMap<HTMLIFrameElement, Set<() => void>>();

function framePostMessageMock(frame: HTMLIFrameElement): FramePostMessageMock {
  const frameWindow = frame.contentWindow!;
  if (!vi.isMockFunction(frameWindow.postMessage)) vi.spyOn(frameWindow, "postMessage");
  return frameWindow.postMessage as FramePostMessageMock;
}

function previewBridgeCommands(frame: HTMLIFrameElement): PreviewBridgeTestMessage[] {
  return (previewBridgeHarnessesByFrame.get(frame) ?? []).flatMap((harness) => harness.commands);
}

function previewBridgeCommandCount(frame: HTMLIFrameElement, type: string): number {
  return previewBridgeCommands(frame).filter((message) => message.type === type).length;
}

function waitForPreviewBridgeCommandCount(
  frame: HTMLIFrameElement,
  type: string,
  count: number,
): Promise<void> {
  if (previewBridgeCommandCount(frame, type) >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = previewBridgeCommandWaitersByFrame.get(frame) ?? new Set<() => void>();
    const check = () => {
      if (previewBridgeCommandCount(frame, type) < count) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    previewBridgeCommandWaitersByFrame.set(frame, waiters);
  });
}

function latestPreviewBridgeHarness(frame: HTMLIFrameElement): PreviewBridgeTestHarness {
  const harnesses = previewBridgeHarnessesByFrame.get(frame) ?? [];
  const harness = harnesses.at(-1);
  if (!harness) throw new Error("Preview bridge is not connected.");
  return harness;
}

function latestPreviewBridgeCommand(
  frame: HTMLIFrameElement,
  predicate: (message: PreviewBridgeTestMessage) => boolean,
): PreviewBridgeTestMessage | undefined {
  return [...previewBridgeCommands(frame)].reverse().find(predicate);
}

async function acceptLatestPreviewBridge(frame: HTMLIFrameElement): Promise<PreviewBridgeTestHarness> {
  const initCall = [...framePostMessageMock(frame).mock.calls].reverse().find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = initCall?.[2]?.[0] as MessagePort | undefined;
  expect(port).toBeDefined();
  const existing = (previewBridgeHarnessesByFrame.get(frame) ?? []).find((harness) => harness.port === port);
  if (existing) return existing;

  const harness: PreviewBridgeTestHarness = { frame, port: port!, commands: [] };
  port!.onmessage = (event) => {
    harness.commands.push(event.data as PreviewBridgeTestMessage);
    for (const waiter of previewBridgeCommandWaitersByFrame.get(frame) ?? []) waiter();
  };
  port!.start();
  previewBridgeHarnesses.add(harness);
  previewBridgeHarnessesByFrame.set(frame, [...(previewBridgeHarnessesByFrame.get(frame) ?? []), harness]);
  await act(async () => {
    port!.postMessage({ source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 });
    await Promise.resolve();
    await Promise.resolve();
  });
  return harness;
}

async function connectPreviewBridge(frame: HTMLIFrameElement): Promise<PreviewBridgeTestHarness> {
  framePostMessageMock(frame);
  fireEvent.load(frame);
  return acceptLatestPreviewBridge(frame);
}

async function sendPreviewBridgeMessage(
  harness: PreviewBridgeTestHarness,
  message: PreviewBridgeTestMessage,
): Promise<void> {
  await act(async () => {
    harness.port.postMessage({ source: "dezin", nonce: BRIDGE_NONCE, protocol: 1, ...message });
    await Promise.resolve();
    await Promise.resolve();
  });
}

const artifact: WorkspaceArtifact = {
  id: "artifact-1",
  workspaceId: "workspace-1",
  kind: "page",
  name: "Storefront home",
  sourceRoot: "artifacts/artifact-1",
  legacyWrapped: false,
  activeTrackId: "track-1",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const revision: ArtifactRevision = {
  id: "revision-1",
  workspaceId: "workspace-1",
  artifactId: "artifact-1",
  trackId: "track-1",
  sequence: 4,
  parentRevisionId: "revision-0",
  sourceCommitHash: "commit-1",
  sourceTreeHash: "tree-1",
  artifactRoot: "artifacts/artifact-1",
  kernelRevisionId: "kernel-1",
  renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }] },
  quality: { state: "passed", score: 96 },
  contextPackHash: "context-1",
  producedByRunId: null,
  legacyRunId: null,
  createdAt: 2,
};

function workspace(): ProjectWorkspacePayload {
  const graph = {
    workspaceId: "workspace-1",
    revision: 2,
    nodes: [{ id: "node-1", workspaceId: "workspace-1", name: artifact.name, kind: "page" as const, artifactId: artifact.id }],
    edges: [],
  };
  const snapshot = {
    id: "snapshot-1",
    workspaceId: "workspace-1",
    sequence: 2,
    parentSnapshotId: "snapshot-0",
    graphRevision: 2,
    kernelRevisionId: "kernel-1",
    reason: "artifact-publication",
    provenance: { kind: "artifact-publication" as const, revisionId: revision.id },
    createdByRunId: null,
    createdAt: 2,
    graph,
    artifactTracks: { [artifact.id]: "track-1" },
    artifactRevisions: { [artifact.id]: revision.id },
    resourceRevisions: {},
  };
  return {
    status: "ready",
    workspace: {
      id: "workspace-1",
      projectId: project.id,
      mode: "standard",
      graphRevision: 2,
      activeSnapshotId: snapshot.id,
      activeKernelRevisionId: "kernel-1",
      createdAt: 1,
      updatedAt: 2,
    },
    graph,
    activeSnapshot: snapshot,
    activeKernelRevision: {
      id: "kernel-1",
      workspaceId: "workspace-1",
      sequence: 1,
      parentRevisionId: null,
      tokens: { "surface.canvas": "#e6e3dc" },
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "A precise retail design system",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: ["desktop"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
      checksum: "kernel-checksum",
      createdAt: 1,
    },
    artifacts: [artifact],
    tracks: [{ id: "track-1", artifactId: artifact.id, name: "Main", headRevisionId: revision.id, legacyVariantId: null, createdAt: 1 }],
    revisions: [revision],
    snapshots: [snapshot],
    layout: {
      workspaceId: "workspace-1",
      layoutId: "default",
      objects: [{ id: "node-1", kind: "node", x: 0, y: 0, parentGroupId: null }],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-1",
    },
  };
}

function readyWorkspace(): ReadyProjectWorkspacePayload {
  const payload = workspace();
  if (payload.status !== "ready") throw new Error("fixture must be ready");
  return payload;
}

function publishedWorkspace(
  current: ReadyProjectWorkspacePayload,
  nextRevision: ArtifactRevision,
  {
    snapshotId,
    snapshotSequence,
    createdAt,
  }: {
    snapshotId: string;
    snapshotSequence: number;
    createdAt: number;
  },
): ReadyProjectWorkspacePayload {
  const nextSnapshot = {
    ...current.activeSnapshot,
    id: snapshotId,
    sequence: snapshotSequence,
    parentSnapshotId: current.activeSnapshot.id,
    graphRevision: current.graph.revision,
    graph: current.graph,
    artifactRevisions: {
      ...current.activeSnapshot.artifactRevisions,
      [nextRevision.artifactId]: nextRevision.id,
    },
    provenance: { kind: "artifact-publication" as const, revisionId: nextRevision.id },
    createdAt,
  };
  return {
    ...current,
    workspace: {
      ...current.workspace,
      graphRevision: current.graph.revision,
      activeSnapshotId: nextSnapshot.id,
      updatedAt: createdAt,
    },
    activeSnapshot: nextSnapshot,
    artifacts: current.artifacts.map((candidate) => candidate.id === nextRevision.artifactId
      ? { ...candidate, updatedAt: createdAt }
      : candidate),
    tracks: current.tracks.map((candidate) => candidate.id === nextRevision.trackId
      ? { ...candidate, headRevisionId: nextRevision.id }
      : candidate),
    revisions: [...current.revisions.filter((candidate) => candidate.id !== nextRevision.id), nextRevision],
    snapshots: [...current.snapshots.filter((candidate) => candidate.id !== nextSnapshot.id), nextSnapshot],
  };
}

function completedGenerationDetail(
  resultRevisionId: string,
  resultSnapshotId: string,
): GenerationPlanDetail {
  const plan = {
    id: "plan-publication",
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    proposalRevision: 1,
    baseSnapshotId: "snapshot-1",
    status: "succeeded" as const,
    constructionSealed: true,
    compileError: null,
    createdAt: 4,
    finishedAt: 5,
  };
  const task: GenerationTask = {
    id: "task-page-publication",
    ordinal: 0,
    workspaceId: "workspace-1",
    planId: plan.id,
    kind: "page",
    target: { type: "artifact", workspaceId: "workspace-1", id: artifact.id, trackId: revision.trackId },
    dependencyIds: [],
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
    resultRevisionId,
    resultResourceRevisionId: null,
    resultSnapshotId,
    createdAt: 4,
    finishedAt: 5,
  };
  return { plan, tasks: [task], dependencies: [], currentAttempts: [] };
}

function queuedArtifactAgentWork(): {
  receipt: ScopedAgentTurnReceipt;
  detail: GenerationPlanDetail;
} {
  const plan = {
    id: "plan-artifact-agent",
    workspaceId: "workspace-1",
    proposalId: "proposal-artifact-agent",
    proposalRevision: 1,
    baseSnapshotId: "snapshot-1",
    status: "queued" as const,
    constructionSealed: true,
    compileError: null,
    createdAt: 4,
    finishedAt: null,
  };
  const task: GenerationTask = {
    id: "task-artifact-agent",
    ordinal: 0,
    workspaceId: "workspace-1",
    planId: plan.id,
    kind: "page",
    target: { type: "artifact", workspaceId: "workspace-1", id: artifact.id, trackId: revision.trackId },
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
    createdAt: 4,
    finishedAt: null,
  };
  return {
    receipt: { task, contextPackId: `context-pack-${"c".repeat(64)}` },
    detail: { plan, tasks: [task], dependencies: [], currentAttempts: [] },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function immutable(requestedKind: ResolvedPreviewTarget["requestedKind"] = "artifact-current"): ResolvedPreviewTarget {
  return {
    version: 1,
    targetKey: `${requestedKind}:revision-1`,
    requestedKind,
    projectId: project.id,
    workspaceId: "workspace-1",
    artifactId: artifact.id,
    artifactKind: "page",
    revisionId: revision.id,
    trackId: "track-1",
    snapshotId: "snapshot-1",
    sourceCommitHash: revision.sourceCommitHash,
    sourceTreeHash: revision.sourceTreeHash,
    dependencyLockHash: "dependencies-1",
    assemblyHash: "assembly-1",
    artifactRoot: revision.artifactRoot,
    renderSpec: revision.renderSpec,
    variantKey: null,
    stateKey: null,
    runId: null,
  };
}

function editorApi(overrides = {}) {
  return makeFakeApi({
    getProject: async () => project,
    getWorkspace: async () => workspace(),
    resolvePreviewTarget: async (_projectId, target) => immutable(target.kind),
    acquirePreviewTargetLease: async (_projectId, target) => ({
      leaseId: "lease-1",
      url: `http://preview.local/artifact-1#dezin-bridge=${BRIDGE_NONCE}`,
      bridgeNonce: BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
      resolved: target,
    }),
    ...overrides,
  });
}

function PublicationReconcileProbe({ result }: { result: ArtifactMutationResult }) {
  const studio = useProjectStudio(project.id);
  if (studio.load.status !== "ready") return <output aria-label="Publication state">{studio.load.status}</output>;
  const payload = studio.load.workspace;
  return (
    <section>
      <button type="button" onClick={() => studio.reconcileArtifactPublication(result)}>Reconcile publication</button>
      <output aria-label="Publication state">
        {[
          payload.workspace.activeSnapshotId,
          payload.activeSnapshot.artifactRevisions[artifact.id],
          payload.tracks.find((track) => track.id === revision.trackId)?.headRevisionId,
          payload.revisions.filter((candidate) => candidate.id === result.revision.id).length,
          payload.snapshots.filter((candidate) => candidate.id === result.snapshot.id).length,
        ].join(":")}
      </output>
    </section>
  );
}

function GenerationPublicationReconcileProbe() {
  const studio = useProjectStudio(project.id);
  if (studio.load.status !== "ready") return <output aria-label="Generation publication state">{studio.load.status}</output>;
  const payload = studio.load.workspace;
  return (
    <section>
      <button type="button" onClick={studio.reconcileGenerationPublication}>Reconcile generation publication</button>
      <button
        type="button"
        onClick={() => void studio.applyGraphCommands([{
          id: "rename-generated-page",
          type: "rename-node",
          nodeId: "node-1",
          name: "Generated storefront",
        }])}
      >
        Apply concurrent graph mutation
      </button>
      <button
        type="button"
        onClick={() => void studio.saveLayout([{
          type: "set-viewport",
          viewport: { x: 64, y: 0, zoom: 1 },
        }])}
      >
        Save concurrent layout
      </button>
      <output aria-label="Generation publication state">
        {[
          payload.graph.revision,
          payload.activeSnapshot.id,
          payload.activeSnapshot.artifactRevisions[artifact.id],
          payload.layout.checksum,
        ].join(":")}
      </output>
    </section>
  );
}

function RoutedArtifactEditor({
  artifactValue,
  revisionValue,
  snapshotId,
  onArtifactPublished,
  onVersionPublished,
  pinnedRevisionId,
  headRevisionId = revisionValue.id,
}: {
  artifactValue: WorkspaceArtifact;
  revisionValue: ArtifactRevision;
  snapshotId: string;
  onArtifactPublished: (result: ArtifactMutationResult) => void;
  onVersionPublished?: (result: ArtifactVersionActionResult) => void;
  pinnedRevisionId?: string | null;
  headRevisionId?: string | null;
}) {
  const editor = useArtifactEditorController({
    projectId: project.id,
    artifactId: artifactValue.id,
    artifact: artifactValue,
    tracks: [{
      id: revisionValue.trackId,
      artifactId: artifactValue.id,
      name: "Main",
      headRevisionId,
      legacyVariantId: null,
      createdAt: 1,
    }],
    revisions: [revisionValue],
    activeRevisionId: headRevisionId,
    activeSnapshotId: snapshotId,
    target: pinnedRevisionId
      ? { kind: "artifact-revision", projectId: project.id, revisionId: pinnedRevisionId }
      : undefined,
    onArtifactPublished,
  });
  return (
    <div className="grid h-[800px] grid-cols-[1fr_280px]">
      <output hidden data-testid="picker-state">{editor.pickerActive ? "active" : "paused"}</output>
      <ArtifactEditorSurface
        editor={editor}
        onBack={() => {}}
        onReturnToHead={() => {}}
        onVersionPublished={onVersionPublished}
      />
      <aside aria-label="Inspector"><ArtifactInspector editor={editor} /></aside>
    </div>
  );
}

async function dispatchSelection(
  locator = { designNodeId: "hero-title", sourcePath: "src/Hero.tsx", selector: "[data-design-node-id='hero-title']" },
  previewTitle = "Storefront home preview",
  text = "Objects for a considered home",
  textComplete = true,
): Promise<string> {
  const frame = screen.getByTitle<HTMLIFrameElement>(previewTitle);
  const bridge = await connectPreviewBridge(frame);
  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameAttemptId: expect.any(String),
  })));
  const frameAttemptId = [...bridge.commands]
    .reverse()
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  const frameId = screen.getByLabelText("Preview frame").getAttribute("data-frame-id") ?? "";
  await sendPreviewBridgeMessage(bridge, {
    type: "frame-applied",
    frameId,
    frameAttemptId,
    reason: "applied",
  });
  await sendPreviewBridgeMessage(bridge, {
    type: "element-selected",
    locator,
    tag: "h1",
    ...(textComplete ? { text } : {}),
    textPreview: text.replace(/\s+/g, " ").trim().slice(0, 160),
    textComplete,
    rect: { x: 96, y: 120, w: 640, h: 72 },
  });
  return frameAttemptId as string;
}

async function dispatchLegacySelection(): Promise<void> {
  const frame = screen.getByTitle<HTMLIFrameElement>("Storefront home preview");
  const bridge = await connectPreviewBridge(frame);
  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameAttemptId: expect.any(String),
  })));
  const frameAttemptId = [...bridge.commands]
    .reverse()
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  const frameId = screen.getByLabelText("Preview frame").getAttribute("data-frame-id") ?? "";
  await sendPreviewBridgeMessage(bridge, {
    type: "frame-applied",
    frameId,
    frameAttemptId,
    reason: "applied",
  });
  await sendPreviewBridgeMessage(bridge, {
    type: "selected",
    selector: "main > section.hero:nth-of-type(1) > h1:nth-of-type(1)",
    tag: "h1",
    text: "Legacy selected headline",
    rect: { x: 96, y: 120, w: 640, h: 72 },
    attrs: { id: "legacy-hero-title" },
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/projects/project-1/artifacts/artifact-1");
});

afterEach(() => {
  cleanup();
  for (const harness of previewBridgeHarnesses) harness.port.close();
  previewBridgeHarnesses.clear();
});

test("fits the active render frame to the measured stage instead of using a fixed zoom", () => {
  expect(fitArtifactPreviewZoom(
    { id: "desktop", name: "Desktop", width: 1440, height: 900 },
    { width: 1000, height: 700, paddingLeft: 48, paddingRight: 48, paddingTop: 46, paddingBottom: 74 },
  )).toBeCloseTo(0.6278, 4);
  expect(fitArtifactPreviewZoom(
    { id: "compact", name: "Compact", width: 320, height: 568 },
    { width: 1280, height: 900 },
  )).toBe(1);
  expect(fitArtifactPreviewZoom(
    { id: "oversized", name: "Oversized", width: 6000, height: 4000 },
    { width: 100, height: 100 },
  )).toBeCloseTo(0.0167, 4);
});

test("automatic Fit can go below the manual zoom floor and keeps the stage in fitted overflow mode", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");
  const stage = document.querySelector<HTMLElement>(".artifact-stage");
  expect(stage).not.toBeNull();
  Object.defineProperties(stage!, {
    clientWidth: { configurable: true, value: 100 },
    clientHeight: { configurable: true, value: 100 },
  });
  const fit = screen.getByRole("button", { name: "Fit preview" });
  const zoom = screen.getByLabelText("Preview zoom");
  const zoomOut = screen.getByRole("button", { name: "Zoom out" });
  const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: "0px",
    paddingRight: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
  } as CSSStyleDeclaration);

  try {
    fireEvent.click(fit);
    expect(zoom).toHaveTextContent("7%");
    expect(stage).toHaveAttribute("data-preview-zoom-mode", "fitted");

    fireEvent.click(zoomOut);
    expect(zoom).toHaveTextContent("25%");
    expect(stage).toHaveAttribute("data-preview-zoom-mode", "manual");
  } finally {
    computedStyle.mockRestore();
  }
});

test("only manual previews activate stage scrolling; fitted and message stages cannot reserve a gutter", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const stageStart = css.indexOf(".artifact-stage {");
  const stageEnd = css.indexOf("}", stageStart);
  const stageRule = css.slice(stageStart, stageEnd);
  const stageOverflowRules = [...css.matchAll(/([^{}]*\.artifact-stage[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /overflow:\s*auto/.test(body ?? ""))
    .map(([, selector]) => selector?.trim());

  expect(stageRule).toMatch(/overflow:\s*hidden/);
  expect(stageRule).not.toMatch(/scrollbar-gutter/);
  expect(stageOverflowRules).toEqual(['.artifact-stage[data-preview-zoom-mode="manual"]']);
});

test("keeps empty, loading, and error preview stages in fitted non-scrolling mode", () => {
  const idlePreview = {
    status: "idle",
    resolved: null,
    lease: null,
    error: null,
    readOnly: false,
    retry: vi.fn(),
  } satisfies ArtifactPreviewController;
  const loadingPreview = {
    ...idlePreview,
    status: "loading",
  } satisfies ArtifactPreviewController;
  const errorPreview = {
    ...idlePreview,
    status: "error",
    error: "Preview failed",
  } satisfies ArtifactPreviewController;
  const surfaceProps = {
    frame: { id: "desktop", name: "Desktop", width: 1440, height: 900 },
    stageRef: { current: null },
    iframeRef: { current: null },
    zoom: 0.65,
    zoomMode: "manual",
    presentation: false,
    selection: null,
    pickerActive: false,
    frameState: { status: "idle", frameId: null },
    runtimeErrors: { fatal: null, nonFatal: [] },
    runtimeErrorIdentity: null,
    runtimeRepairContext: null,
    onDismissRuntimeFatal: vi.fn(),
    onDismissRuntimeNonFatal: vi.fn(),
    onRetryFrame: vi.fn(),
    onPreviewLoad: vi.fn(),
  } satisfies Omit<ComponentProps<typeof ArtifactPreviewSurface>, "artifact" | "preview">;
  const expectFittedStage = (message: HTMLElement) => {
    const stage = message.closest(".artifact-stage");
    expect(stage).toHaveAttribute("data-preview-zoom-mode", "fitted");
    expect(stage).not.toHaveAttribute("data-preview-zoom-mode", "manual");
  };

  const surface = render(
    <ArtifactPreviewSurface artifact={null} preview={idlePreview} {...surfaceProps} />,
  );
  expectFittedStage(screen.getByRole("alert"));

  surface.rerender(
    <ArtifactPreviewSurface artifact={artifact} preview={loadingPreview} {...surfaceProps} />,
  );
  expectFittedStage(screen.getByRole("status", { name: "Preparing artifact preview" }));

  surface.rerender(
    <ArtifactPreviewSurface artifact={artifact} preview={errorPreview} {...surfaceProps} />,
  );
  expectFittedStage(screen.getByRole("alert", { name: "Artifact preview unavailable" }));
});

test("long selection labels stay bounded by the artifact stage instead of the outer viewport", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const statusStart = css.indexOf(".artifact-stage__status {");
  const statusEnd = css.indexOf("}", statusStart);
  const statusRule = css.slice(statusStart, statusEnd);

  expect(statusRule).toMatch(/max-width:\s*min\(420px,\s*calc\(100%\s*-\s*36px\)\)/);
  expect(statusRule).toMatch(/min-width:\s*0/);
  expect(statusRule).toMatch(/overflow-wrap:\s*anywhere/);
  expect(statusRule).not.toContain("100vw");
});

test("keeps the preview frame selector available in the narrow editor toolbar", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const start = css.indexOf("@media (max-width: 640px)");
  const end = css.indexOf("@media (prefers-reduced-motion", start);
  const narrowRules = css.slice(start, end);
  expect(narrowRules).not.toContain(".artifact-frame-select,");
  expect(narrowRules).toMatch(/\.artifact-frame-select\s*\{[^}]*max-width:/s);
});

test("sizes compact header actions from the editor surface instead of the outer viewport", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  expect(css).toMatch(/\.artifact-editor\s*\{[^}]*container:\s*artifact-editor\s*\/\s*inline-size;/s);

  const start = css.indexOf("@container artifact-editor (max-width: 900px)");
  const end = css.indexOf("@media (max-width: 640px)", start);
  const compactDesktopRules = css.slice(start, end);

  expect(compactDesktopRules).not.toMatch(/\.artifact-header__controls\s*\{[^}]*overflow-x:\s*auto/s);
  expect(compactDesktopRules).toMatch(/\.artifact-header__controls\s*\{[^}]*overflow:\s*hidden/s);
  expect(compactDesktopRules).toMatch(/\.artifact-action__label\s*\{[^}]*display:\s*none/s);
});

test("keeps priority artifact controls visible and moves secondary tools into More at 420px", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const start = css.indexOf("@container artifact-editor (max-width: 420px)");
  const end = css.indexOf("@media (max-width: 640px)", start);
  const narrowRules = css.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(narrowRules).toMatch(/\.artifact-tool-group--desktop,\s*\.artifact-action--secondary\s*\{[^}]*display:\s*none/s);
  expect(narrowRules).toMatch(/\.artifact-header\s+\.artifact-more\s*\{[^}]*display:\s*flex/s);
  expect(narrowRules).toMatch(/\.artifact-header__metadata\s*\{[^}]*display:\s*none/s);
  expect(narrowRules).not.toMatch(/\.artifact-header__title\s*\{[^}]*display:\s*none/s);
  expect(narrowRules).not.toMatch(/\.artifact-frame-select\s*\{[^}]*display:\s*none/s);
  expect(narrowRules).not.toMatch(/\.artifact-action--return\s*\{[^}]*display:\s*none/s);
  expect(narrowRules).not.toMatch(/\.artifact-action--primary\s*\{[^}]*display:\s*none/s);
});

test("keeps the decorative frame stroke out of the declared iframe viewport dimensions", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const start = css.indexOf(".artifact-preview-frame {");
  const end = css.indexOf("}", start);
  const frameRule = css.slice(start, end);

  expect(frameRule).toMatch(/\bborder:\s*0;/);
  expect(frameRule).toMatch(/\binset 0 0 0 1px\b/);
});

test("keeps the preview bridge capability in the parent channel and out of the artifact iframe URL", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  const iframe = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  expect(iframe.getAttribute("src")).toBe("http://preview.local/artifact-1");

  const postMessage = framePostMessageMock(iframe);
  fireEvent.load(iframe);
  const bootstrap = postMessage.mock.calls.find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  expect(bootstrap?.[0]).toEqual(expect.objectContaining({
    nonce: BRIDGE_NONCE,
    protocol: 1,
  }));
});

test("frame commands fail closed before crossing the preview capability boundary", () => {
  expect(buildPreviewFrameCommand({
    id: "compact",
    name: "Compact",
    width: 390,
    height: 844,
    background: "linear-gradient(#fff, #f3f1eb)",
    fixture: { menu: { open: true }, count: 2 },
  })).toEqual({
    ok: true,
    command: {
      type: "set-frame",
      frameId: "compact",
      background: "linear-gradient(#fff, #f3f1eb)",
      fixture: { menu: { open: true }, count: 2 },
    },
  });
  expect(buildPreviewFrameCommand({
    id: "tracked",
    name: "Tracked",
    width: 390,
    height: 844,
    background: "url(https://tracker.example/pixel.png)",
  })).toEqual({ ok: false, message: "Frame background cannot load or reference external resources." });
  expect(buildPreviewFrameCommand({
    id: "unsafe-fixture",
    name: "Unsafe fixture",
    width: 390,
    height: 844,
    fixture: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
  })).toEqual({ ok: false, message: "Frame fixture contains an unsafe object key." });

  expect(parseFrames({ frames: [
    { id: "compact", name: " Compact ", width: 390, height: 844 },
    { id: "compact", name: "Duplicate", width: 400, height: 800 },
    { id: "too-large", name: "Too large", width: 99_999, height: 800 },
  ] }, "page")).toEqual([{ id: "compact", name: "Compact", width: 390, height: 844 }]);
});

test("selects the current exact viewport when comparing immutable Revisions", () => {
  const mobile = {
    id: "checkout-mobile",
    name: "Checkout mobile",
    width: 390,
    height: 844,
    initialState: "checkout-ready",
    fixture: { cartCount: 2 },
    background: "#f4f1eb",
  };
  const comparedRevision: ArtifactRevision = {
    ...revision,
    id: "revision-compared",
    renderSpec: {
      frames: [
        { id: "checkout-desktop", name: "Checkout desktop", width: 1280, height: 800, initialState: "checkout-ready" },
        mobile,
      ],
    },
  };

  expect(selectVersionComparisonFrame(comparedRevision, mobile)).toEqual(mobile);
});

test("the Fit preview control applies the measured zoom to the active frame", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");
  const stage = document.querySelector<HTMLElement>(".artifact-stage");
  expect(stage).not.toBeNull();
  Object.defineProperties(stage!, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 700 },
  });
  const fit = screen.getByRole("button", { name: "Fit preview" });
  const zoom = screen.getByLabelText("Preview zoom");
  const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: "48px",
    paddingRight: "48px",
    paddingTop: "46px",
    paddingBottom: "74px",
  } as CSSStyleDeclaration);

  try {
    fireEvent.click(fit);
    expect(zoom).toHaveTextContent("63%");
  } finally {
    computedStyle.mockRestore();
  }
});

test("switching render frames applies fixture state and background through the authenticated preview bridge", async () => {
  const user = userEvent.setup();
  const framedRevision: ArtifactRevision = {
    ...revision,
    renderSpec: {
      frames: [
        {
          id: "desktop",
          name: "Desktop",
          width: 1440,
          height: 900,
          initialState: "default",
          background: "#f7f5ef",
          fixture: { navigation: { open: false } },
        },
        {
          id: "compact-menu",
          name: "Compact · menu open",
          width: 390,
          height: 844,
          initialState: "menu-open",
          background: "rgb(12, 18, 24)",
          fixture: { navigation: { open: true }, cartCount: 2 },
        },
      ],
    },
  };
  render(
    <ApiProvider client={editorApi({
      resolvePreviewTarget: async (_projectId: string, target: PreviewTarget) => ({
        ...immutable(target.kind),
        renderSpec: framedRevision.renderSpec,
      }),
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={framedRevision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  const iframe = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const bridge = await connectPreviewBridge(iframe);

  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    initialState: "default",
    fixture: { navigation: { open: false } },
    background: "#f7f5ef",
    nonce: BRIDGE_NONCE,
    protocol: 1,
  })));

  await user.click(screen.getByLabelText("Preview frame"));
  await user.click(await screen.findByRole("option", { name: "Compact · menu open" }));

  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "compact-menu",
    initialState: "menu-open",
    fixture: { navigation: { open: true }, cartCount: 2 },
    background: "rgb(12, 18, 24)",
    nonce: BRIDGE_NONCE,
    protocol: 1,
  })));
  expect(bridge.commands).not.toContainEqual(expect.objectContaining({ type: "select-mode", on: true }));
  expect(document.querySelector(".artifact-preview-frame")).toHaveStyle({ background: "rgb(12, 18, 24)" });
  const compactFrameAttemptId = [...bridge.commands]
    .reverse()
    .find((message) => message.type === "set-frame" && message.frameId === "compact-menu")?.frameAttemptId;
  expect(compactFrameAttemptId).toBeTruthy();

  await sendPreviewBridgeMessage(bridge, {
    type: "frame-applied",
    frameId: "compact-menu",
    frameAttemptId: compactFrameAttemptId,
  });
  expect(await screen.findByRole("status", { name: "Preview frame state" })).toHaveTextContent("State applied");
  expect(bridge.commands).toContainEqual(expect.objectContaining({ type: "select-mode", on: true }));

  await sendPreviewBridgeMessage(bridge, {
    type: "frame-rejected",
    frameId: "compact-menu",
    frameAttemptId: compactFrameAttemptId,
    reason: "unsafe-background",
  });
  expect(await screen.findByRole("status", { name: "Preview frame state" })).toHaveTextContent("State applied");
  expect(screen.getByRole("status", { name: "Preview frame state" })).not.toHaveAttribute("title");
  expect(screen.getByRole("button", { name: "Select an element in the preview" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the first terminal frame result wins when an applied event arrives after rejection", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  const iframe = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const bridge = await connectPreviewBridge(iframe);
  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  })));
  const frameAttemptId = bridge.commands
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();

  const terminal = (type: "frame-applied" | "frame-rejected") => sendPreviewBridgeMessage(bridge, {
    type,
    frameId: "desktop",
    frameAttemptId,
    ...(type === "frame-rejected" ? { reason: "unsafe-background" } : {}),
  });
  await terminal("frame-rejected");
  expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State rejected");

  await terminal("frame-applied");
  expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State rejected");
  const picker = screen.getByRole("button", { name: "Select an element in the preview" });
  expect(picker).toHaveAttribute("aria-pressed", "false");
  expect(picker).toBeDisabled();
});

test("a missing frame ACK retries, reconnects, and exposes an operable recovery state", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  const iframe = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const postMessage = framePostMessageMock(iframe);
  fireEvent.load(iframe);
  vi.useFakeTimers();
  try {
    await acceptLatestPreviewBridge(iframe);
    const initCalls = () => postMessage.mock.calls.filter(([message]) => (
      message as { type?: string }
    ).type === "bridge-init").length;
    expect(previewBridgeCommandCount(iframe, "set-frame")).toBe(1);

    const retryCommand = waitForPreviewBridgeCommandCount(iframe, "set-frame", 2);
    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    await act(async () => retryCommand);
    expect(previewBridgeCommandCount(iframe, "set-frame")).toBe(2);
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("Retrying state");

    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    expect(initCalls()).toBe(2);
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("Reconnecting state");

    await acceptLatestPreviewBridge(iframe);
    await act(async () => waitForPreviewBridgeCommandCount(iframe, "set-frame", 3));
    expect(previewBridgeCommandCount(iframe, "set-frame")).toBe(3);
    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State timed out");
    expect(screen.getByRole("button", { name: "Retry frame state" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry frame state" }));
    expect(initCalls()).toBe(3);
    const recoveredBridge = await acceptLatestPreviewBridge(iframe);
    await act(async () => waitForPreviewBridgeCommandCount(iframe, "set-frame", 4));
    const recoveredFrameAttemptId = latestPreviewBridgeCommand(
      iframe,
      (message) => message.type === "set-frame",
    )?.frameAttemptId;
    expect(recoveredFrameAttemptId).toBeTruthy();
    await sendPreviewBridgeMessage(recoveredBridge, {
      type: "frame-applied",
      frameId: "desktop",
      frameAttemptId: recoveredFrameAttemptId,
    });
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State applied");
  } finally {
    vi.useRealTimers();
  }
});

test("activating the picker from Inspector moves keyboard focus into the preview", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  await dispatchSelection();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  const activatePicker = screen.getByRole("button", { name: "Select an element in the preview" });
  activatePicker.focus();

  fireEvent.click(activatePicker);

  expect(frame).toHaveFocus();
});

test("renders a focused design-tool editor in the persistent Studio and bridges selected element Context", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <App />
    </ApiProvider>,
  );

  const shell = await screen.findByTestId("project-studio-shell");
  const editor = screen.getByRole("region", { name: "Artifact editor" });
  expect(screen.getByRole("complementary", { name: "Artifact Agent" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Artifact Agent" })).toBeInTheDocument();
  expect(within(editor).getByRole("heading", { name: "Storefront home" })).toBeInTheDocument();
  expect(await screen.findByTitle("Storefront home preview")).toHaveAttribute("sandbox");
  expect(screen.getByRole("button", { name: "Back to workspace canvas" })).toBeInTheDocument();
  expect(screen.getByText("Revision 4")).toBeInTheDocument();

  await dispatchSelection();

  expect(await screen.findByText("hero-title")).toBeInTheDocument();
  expect(screen.getByText("src/Hero.tsx")).toBeInTheDocument();
  const selectedContext = screen.getByLabelText("Selected Agent Context");
  expect(selectedContext).toHaveTextContent("Objects for a considered home");
  expect(within(selectedContext).getByRole("listitem")).toHaveAttribute("data-context-artifact-id", artifact.id);
  expect(within(selectedContext).getByRole("listitem")).toHaveAttribute("data-context-revision-id", revision.id);
  expect(within(selectedContext).getByRole("listitem")).toHaveAttribute("data-context-target-key", "artifact-current:revision-1");
  expect(within(selectedContext).getByRole("listitem")).toHaveAttribute("data-context-frame-id", "desktop");
  expect(within(selectedContext).getByRole("listitem")).toHaveAttribute("data-context-design-node-id", "hero-title");

  fireEvent.change(screen.getByRole("textbox", { name: "Artifact Agent draft" }), {
    target: { value: "Refine the selected headline rhythm" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace canvas" }));
  expect(await screen.findByRole("region", { name: "Project canvas" })).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("");
  expect(screen.queryByLabelText("Selected Agent Context")).not.toBeInTheDocument();

  act(() => navigate("/projects/project-1/artifacts/artifact-1"));
  expect(await screen.findByTitle("Storefront home preview")).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("Refine the selected headline rhythm");
  expect(screen.queryByLabelText("Selected Agent Context")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select an element in the preview" })).toBeInTheDocument();
});

test("Artifact Agent queues the active Head with exact element identity and opens the durable Plan", async () => {
  const work = queuedArtifactAgentWork();
  const artifactAgentTurn = vi.fn(async () => work.receipt);
  const view = render(
    <ApiProvider client={editorApi({
      artifactAgentTurn,
      listGenerationPlans: async () => [work.detail.plan],
      getGenerationPlan: async () => work.detail,
      streamGenerationPlanEvents: async function* (
        _projectId: string,
        _planId: string,
        signal?: AbortSignal,
      ) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  await dispatchSelection();
  const draft = screen.getByRole("textbox", { name: "Artifact Agent draft" });
  fireEvent.change(draft, { target: { value: "  Refine the selected CTA  " } });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));

  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));
  expect(artifactAgentTurn).toHaveBeenCalledWith(project.id, artifact.id, {
    turnId: expect.stringMatching(/^turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    intent: "edit",
    message: "Refine the selected CTA",
    explicitContext: [],
    graphRevision: 2,
    baseRevisionId: revision.id,
    selection: [{ kind: "element", id: "hero-title", revisionId: revision.id }],
  }, expect.any(AbortSignal));
  expect(await screen.findByRole("status", { name: "Artifact Agent task status" })).toHaveTextContent(
    "Queued · Plan plan-artifact-agent",
  );
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();
  expect(screen.getByText("Preparing")).toBeInTheDocument();
  expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  expect(draft).toHaveValue("");

  fireEvent.click(screen.getByRole("button", { name: "Close build plan" }));
  expect(await screen.findByRole("heading", { name: "Inspector" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open build plan" }));
  expect(await screen.findByRole("heading", { name: "Build plan" })).toBeInTheDocument();

  view.unmount();
  render(
    <ApiProvider client={editorApi({
      artifactAgentTurn,
      listGenerationPlans: async () => [work.detail.plan],
      getGenerationPlan: async () => work.detail,
    })}>
      <App />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");
  expect(screen.getByRole("heading", { name: "Inspector" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open build plan" })).toBeInTheDocument();
});

test("Artifact Agent does not open an older discovered Plan when the current submission fails", async () => {
  const work = queuedArtifactAgentWork();
  let resolveDiscoveredPlan!: (planId: string | null) => void;
  const discoveredPlan = new Promise<string | null>((resolve) => {
    resolveDiscoveredPlan = resolve;
  });
  let rejectTurn!: (error: Error) => void;
  const failedTurn = new Promise<ScopedAgentTurnReceipt>((_resolve, reject) => {
    rejectTurn = reject;
  });
  const artifactAgentTurn = vi.fn(() => failedTurn);
  render(
    <ApiProvider client={editorApi({
      artifactAgentTurn,
      getLatestScopedArtifactPlanId: async () => discoveredPlan,
      listGenerationPlans: async () => [work.detail.plan],
      getGenerationPlan: async () => work.detail,
    })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  fireEvent.change(screen.getByRole("textbox", { name: "Artifact Agent draft" }), {
    target: { value: "Refine this artifact" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue artifact edit" }));
  await waitFor(() => expect(artifactAgentTurn).toHaveBeenCalledTimes(1));

  await act(async () => {
    resolveDiscoveredPlan(work.detail.plan.id);
    await Promise.resolve();
  });
  expect(screen.getByLabelText("Artifact Agent activity")).toBeInTheDocument();
  act(() => rejectTurn(new Error("Queue connection failed")));

  expect(await screen.findByRole("alert")).toHaveTextContent("Queue connection failed");
  expect(screen.getByRole("heading", { name: "Inspector" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Build plan" })).not.toBeInTheDocument();
});

test("enables the preview picker on load and accepts both bridge protocols only from the leased frame", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <App />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const sendCurrentSelection = () => sendPreviewBridgeMessage(latestPreviewBridgeHarness(frame), {
    type: "element-selected",
    locator: {
      designNodeId: "hero-title",
      sourcePath: "src/Hero.tsx",
      selector: "[data-design-node-id='hero-title']",
    },
    tag: "h1",
    text: "Objects for a considered home",
    textPreview: "Objects for a considered home",
    textComplete: true,
    rect: { x: 96, y: 120, w: 640, h: 72 },
  });
  const postMessage = framePostMessageMock(frame);
  fireEvent.load(frame);
  expect(postMessage).toHaveBeenCalledWith(
    { source: "dezin-parent", type: "bridge-init", nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
    expect.any(Array),
  );

  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "select-mode" }),
    expect.anything(),
  );

  await dispatchLegacySelection();
  expect(previewBridgeCommands(frame)).toContainEqual(expect.objectContaining({ type: "select-mode", on: true }));
  expect(await screen.findByLabelText("Selected Agent Context")).toHaveTextContent("Legacy selected headline");
  expect(screen.getByText("main > section.hero:nth-of-type(1) > h1:nth-of-type(1)")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Direct editing unavailable" })).toHaveTextContent(
    "source-backed stable marker",
  );
  expect(screen.getByRole("textbox", { name: "Text content" })).toBeDisabled();

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "element-selected",
        nonce: BRIDGE_NONCE,
        protocol: 1,
        locator: { designNodeId: "untrusted-node", selector: "#untrusted" },
        text: "Untrusted selection",
      },
    }));
  });
  expect(screen.queryByText("Untrusted selection")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Selected Agent Context")).toHaveTextContent("Legacy selected headline");

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: null,
      data: {
        source: "dezin",
        type: "element-selected",
        nonce: BRIDGE_NONCE,
        protocol: 1,
        locator: { designNodeId: "wrong-frame", selector: "[data-dezin-id='wrong-frame']", sourcePath: "index.html" },
        text: "Wrong frame selection",
      },
    }));
  });
  expect(screen.queryByText("Wrong frame selection")).not.toBeInTheDocument();

  await dispatchSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();
  expect(screen.queryByText("Legacy selected headline")).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Direct editing unavailable" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Text content" })).toBeEnabled();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  expect(previewBridgeCommands(frame)).toContainEqual(expect.objectContaining({ type: "clear" }));
  expect(previewBridgeCommands(frame)).toContainEqual(expect.objectContaining({ type: "select-mode", on: false }));

  await sendCurrentSelection();
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Select an element in the preview" }));
  await sendCurrentSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();

  await sendPreviewBridgeMessage(latestPreviewBridgeHarness(frame), {
    type: "element-cleared",
  });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();

  await sendCurrentSelection();
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Select an element in the preview" }));
  await sendCurrentSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();

  await sendPreviewBridgeMessage(latestPreviewBridgeHarness(frame), {
    type: "cancel",
  });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  await sendCurrentSelection();
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Select an element in the preview" }));
  expect(latestPreviewBridgeCommand(frame, (message) => message.type === "select-mode")).toEqual(
    expect.objectContaining({ type: "select-mode", on: true }),
  );
});

test("keeps the preview picker active while consecutive selections replace the current element", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const bridge = await connectPreviewBridge(frame);
  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameAttemptId: expect.any(String),
  })));
  const frameAttemptId = [...bridge.commands]
    .reverse()
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  const frameId = screen.getByLabelText("Preview frame").getAttribute("data-frame-id") ?? "";
  await sendPreviewBridgeMessage(bridge, {
    type: "frame-applied",
    frameId,
    frameAttemptId,
    reason: "applied",
  });

  await waitFor(() => expect(screen.getByTestId("picker-state")).toHaveTextContent("active"));
  expect(bridge.commands.filter((message) => message.type === "select-mode" && message.on === true)).toHaveLength(1);

  await sendPreviewBridgeMessage(bridge, {
    type: "element-selected",
    locator: {
      designNodeId: "hero-title",
      sourcePath: "src/Hero.tsx",
      selector: "[data-design-node-id='hero-title']",
    },
    tag: "h1",
    text: "First selection",
    textPreview: "First selection",
    textComplete: true,
    rect: { x: 96, y: 120, w: 640, h: 72 },
  });
  expect(await screen.findByText("hero-title")).toBeInTheDocument();
  expect(screen.getByTestId("picker-state")).toHaveTextContent("active");

  await sendPreviewBridgeMessage(bridge, {
    type: "element-selected",
    locator: {
      designNodeId: "secondary-title",
      sourcePath: "src/Secondary.tsx",
      selector: "[data-design-node-id='secondary-title']",
    },
    tag: "h2",
    text: "Second selection",
    textPreview: "Second selection",
    textComplete: true,
    rect: { x: 96, y: 240, w: 480, h: 56 },
  });
  expect(await screen.findByText("secondary-title")).toBeInTheDocument();
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  expect(screen.getByTestId("picker-state")).toHaveTextContent("active");
  expect(bridge.commands.filter((message) => message.type === "select-mode" && message.on === true)).toHaveLength(1);

  const fixedNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
  for (let index = 0; index < 30; index += 1) {
    await sendPreviewBridgeMessage(bridge, {
      type: "element-selected",
      locator: {
        designNodeId: `flood-${index}`,
        sourcePath: "src/Flood.tsx",
        selector: `[data-design-node-id='flood-${index}']`,
      },
      tag: "div",
      text: `Flood ${index}`,
      textPreview: `Flood ${index}`,
      textComplete: true,
      rect: { x: 0, y: index, w: 100, h: 20 },
    });
  }
  clock.mockRestore();
  expect(await screen.findByText("flood-21")).toBeInTheDocument();
  expect(screen.queryByText("flood-29")).not.toBeInTheDocument();
});

test("presentation mode suspends editing overlays and the picker until its visible exit restores Studio", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <App />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  await dispatchSelection();
  const bridge = latestPreviewBridgeHarness(frame);
  const agent = screen.getByRole("complementary", { name: "Artifact Agent" });
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(screen.getByText("1440 × 900")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Preview frame state" })).toBeInTheDocument();
  expect(screen.getByText("Selected · Objects for a considered home")).toBeInTheDocument();
  expect(screen.getByText("hero-title")).toBeInTheDocument();

  const present = screen.getByRole("button", { name: "Present" });
  present.focus();
  fireEvent.click(present);

  expect(agent).toHaveAttribute("inert");
  expect(inspector).toHaveAttribute("inert");
  await waitFor(() => expect(latestPreviewBridgeCommand(
    frame,
    (message) => message.type === "select-mode",
  )).toEqual(expect.objectContaining({ type: "select-mode", on: false })));
  expect(screen.queryByText("1440 × 900")).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Preview frame state" })).not.toBeInTheDocument();
  expect(screen.queryByText("Selected · Objects for a considered home")).not.toBeInTheDocument();
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();

  const exitPresent = screen.getByRole("button", { name: "Exit present" });
  expect(exitPresent).toHaveFocus();
  fireEvent.click(exitPresent);

  await waitFor(() => expect(latestPreviewBridgeCommand(
    frame,
    (message) => message.type === "select-mode",
  )).toEqual(expect.objectContaining({ type: "select-mode", on: true })));
  expect(bridge.commands).toContainEqual(expect.objectContaining({ type: "select-mode", on: false }));
  expect(agent).not.toHaveAttribute("inert");
  expect(inspector).not.toHaveAttribute("inert");
  expect(screen.getByText("1440 × 900")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Preview frame state" })).toBeInTheDocument();
  expect(screen.getByText("Picker active · choose an element in the preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Present" })).toHaveFocus();
});

test("keeps preview failure isolated while the artifact, Inspector, and Agent remain usable", async () => {
  render(
    <ApiProvider client={editorApi({
      resolvePreviewTarget: async () => { throw new Error("Render assembly is unavailable"); },
    })}>
      <App />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert", { name: "Artifact preview unavailable" })).toHaveTextContent("Render assembly is unavailable");
  expect(screen.getByRole("region", { name: "Artifact editor" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Artifact Agent draft" }), { target: { value: "Keep working" } });
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("Keep working");
  expect(screen.getByRole("button", { name: "Retry artifact preview" })).toBeInTheDocument();
});

test("shows authenticated runtime diagnostics with immutable repair context", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const bridge = await connectPreviewBridge(frame);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "runtime-error",
        kind: "fatal",
        errorType: "error",
        message: "Untrusted runtime error",
        count: 1,
        at: 10,
        nonce: "x".repeat(43),
        protocol: 1,
      },
    }));
  });
  expect(screen.queryByText("Untrusted runtime error")).not.toBeInTheDocument();
  await waitFor(() => expect(bridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  })));
  const frameAttemptId = bridge.commands
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  await sendPreviewBridgeMessage(bridge, {
    type: "frame-applied",
    frameId: "desktop",
    frameAttemptId,
  });

  await sendPreviewBridgeMessage(bridge, {
    type: "runtime-error",
    kind: "fatal",
    errorType: "error",
    message: "ReferenceError: catalog is not defined",
    stack: "ReferenceError: catalog is not defined\n    at Hero.tsx:24:7",
    src: "src/Hero.tsx",
    line: 24,
    col: 7,
    count: 1,
    at: 20,
    frameId: "desktop",
    frameAttemptId,
  });

  expect(await screen.findByRole("alert", { name: "Artifact preview runtime error" })).toHaveTextContent(
    "ReferenceError: catalog is not defined",
  );
  expect(screen.getByText("Revision revision-1 · Frame desktop")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Repair context"));
  const repairContext = screen.getByLabelText("Runtime repair context");
  expect(repairContext).toHaveTextContent("Target: artifact-current:revision-1");
  expect(repairContext).toHaveTextContent("Assembly: assembly-1");
  expect(repairContext).toHaveTextContent("ReferenceError: catalog is not defined");
  expect(repairContext).not.toHaveTextContent(BRIDGE_NONCE);
});

test("binds runtime diagnostics to the acknowledged frame attempt", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const firstBridge = await connectPreviewBridge(frame);
  await sendPreviewBridgeMessage(firstBridge, {
    type: "runtime-error",
    kind: "fatal",
    errorType: "error",
    message: "Early bootstrap failure",
    count: 1,
    at: 19,
  });
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  await waitFor(() => expect(firstBridge.commands).toContainEqual(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  })));
  const setFrame = firstBridge.commands
    .find((message) => message.type === "set-frame");
  expect(setFrame?.frameAttemptId).toBeTruthy();
  const frameAttemptId = setFrame!.frameAttemptId as string;

  const runtimeError = (message: string, attemptId = frameAttemptId, frameId = "desktop") => (
    sendPreviewBridgeMessage(firstBridge, {
      type: "runtime-error",
      kind: "fatal",
      errorType: "error",
      message,
      frameId,
      frameAttemptId: attemptId,
      count: 1,
      at: 20,
    })
  );

  await runtimeError("Early bootstrap failure");
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  await runtimeError("A stale attempt failed", "frame-attempt-stale");

  await sendPreviewBridgeMessage(firstBridge, {
    type: "frame-applied",
    frameId: "desktop",
    frameAttemptId,
  });
  expect(await screen.findByRole("alert", { name: "Artifact preview runtime error" })).toHaveTextContent(
    "Early bootstrap failure",
  );
  expect(screen.queryByText("A stale attempt failed")).not.toBeInTheDocument();

  await runtimeError("A stale frame failed", frameAttemptId, "compact");
  expect(screen.queryByText("A stale frame failed")).not.toBeInTheDocument();

  fireEvent.load(frame);
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  const nextBridge = await acceptLatestPreviewBridge(frame);
  await waitFor(() => {
    const attempts = nextBridge.commands
      .filter((message) => message.type === "set-frame" && message.frameAttemptId !== frameAttemptId);
    expect(attempts.length).toBeGreaterThan(0);
  });
  const nextFrameAttemptId = [...nextBridge.commands]
    .reverse()
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(nextFrameAttemptId).toBeTruthy();
  expect(nextFrameAttemptId).not.toBe(frameAttemptId);
  await sendPreviewBridgeMessage(nextBridge, {
    type: "frame-applied",
    frameId: "desktop",
    frameAttemptId: nextFrameAttemptId,
  });
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
});

test("atomically reconciles a published revision, Track head, and active Snapshot without duplication", async () => {
  const nextRevision = { ...revision, id: "revision-2", sequence: 5, parentRevisionId: revision.id, createdAt: 3 };
  const nextWorkspace = workspace();
  if (nextWorkspace.status !== "ready") throw new Error("fixture must be ready");
  const nextSnapshot = {
    ...nextWorkspace.activeSnapshot,
    id: "snapshot-2",
    sequence: 3,
    parentSnapshotId: "snapshot-1",
    artifactRevisions: { [artifact.id]: nextRevision.id },
  };
  const result: ArtifactMutationResult = { revision: nextRevision, snapshot: nextSnapshot };

  render(
    <ApiProvider client={editorApi()}>
      <PublicationReconcileProbe result={result} />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Publication state")).toHaveTextContent(
    "snapshot-1:revision-1:revision-1:0:0",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Reconcile publication" }));
  expect(screen.getByLabelText("Publication state")).toHaveTextContent("snapshot-2:revision-2:revision-2:1:1");
  fireEvent.click(screen.getByRole("button", { name: "Reconcile publication" }));
  expect(screen.getByLabelText("Publication state")).toHaveTextContent("snapshot-2:revision-2:revision-2:1:1");
});

test("a discovered scoped Generation Plan refreshes the active Snapshot and Artifact revision", async () => {
  const initial = readyWorkspace();
  const nextRevision: ArtifactRevision = {
    ...revision,
    id: "updated-revision-2",
    sequence: revision.sequence + 1,
    parentRevisionId: revision.id,
    createdAt: 5,
  };
  const authoritative = publishedWorkspace(initial, nextRevision, {
    snapshotId: "snapshot-generation-2",
    snapshotSequence: initial.activeSnapshot.sequence + 1,
    createdAt: 5,
  });
  const detail = completedGenerationDetail(nextRevision.id, authoritative.activeSnapshot.id);
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(authoritative);
  const resolvedPublishedRevision: ResolvedPreviewTarget = {
    ...immutable(),
    targetKey: `artifact-current:${nextRevision.id}`,
    revisionId: nextRevision.id,
    snapshotId: authoritative.activeSnapshot.id,
    sourceCommitHash: nextRevision.sourceCommitHash,
    sourceTreeHash: nextRevision.sourceTreeHash,
    assemblyHash: "assembly-generation-2",
    artifactRoot: nextRevision.artifactRoot,
    renderSpec: nextRevision.renderSpec,
  };
  const resolvePreviewTarget = vi.fn()
    .mockResolvedValueOnce(immutable())
    .mockResolvedValue(resolvedPublishedRevision);

  render(
    <ApiProvider client={editorApi({
      getWorkspace,
      getLatestScopedArtifactPlanId: async () => detail.plan.id,
      resolvePreviewTarget,
    })}>
      <App />
    </ApiProvider>,
  );

  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Revision 5")).toBeInTheDocument();
  expect(resolvePreviewTarget).toHaveBeenCalledTimes(2);
});

test("generation publication reconciliation recovers from a transient authoritative workspace read failure", async () => {
  const initial = readyWorkspace();
  const nextRevision: ArtifactRevision = {
    ...revision,
    id: "updated-after-transient-read",
    sequence: revision.sequence + 1,
    parentRevisionId: revision.id,
    createdAt: 8,
  };
  const authoritative = publishedWorkspace(initial, nextRevision, {
    snapshotId: "snapshot-after-transient-read",
    snapshotSequence: initial.activeSnapshot.sequence + 1,
    createdAt: 8,
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("temporary workspace read failure"))
    .mockResolvedValueOnce(authoritative);

  render(
    <ApiProvider client={editorApi({ getWorkspace })}>
      <GenerationPublicationReconcileProbe />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "2:snapshot-1:revision-1:layout-1",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Reconcile generation publication" }));

  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "2:snapshot-after-transient-read:updated-after-transient-read:layout-1",
  ));
  expect(getWorkspace).toHaveBeenCalledTimes(3);
});

test("generation publication reconciliation keeps a dirty publication until repeated reads recover", async () => {
  const initial = readyWorkspace();
  const nextRevision: ArtifactRevision = {
    ...revision,
    id: "updated-after-retry-batch",
    sequence: revision.sequence + 1,
    parentRevisionId: revision.id,
    createdAt: 9,
  };
  const authoritative = publishedWorkspace(initial, nextRevision, {
    snapshotId: "snapshot-after-retry-batch",
    snapshotSequence: initial.activeSnapshot.sequence + 1,
    createdAt: 9,
  });
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("workspace read failure 1"))
    .mockRejectedValueOnce(new Error("workspace read failure 2"))
    .mockRejectedValueOnce(new Error("workspace read failure 3"))
    .mockResolvedValueOnce(authoritative);

  render(
    <ApiProvider client={editorApi({ getWorkspace })}>
      <GenerationPublicationReconcileProbe />
    </ApiProvider>,
  );

  await screen.findByLabelText("Generation publication state");
  fireEvent.click(screen.getByRole("button", { name: "Reconcile generation publication" }));
  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "2:snapshot-after-retry-batch:updated-after-retry-batch:layout-1",
  ), { timeout: 2_000 });
  expect(getWorkspace).toHaveBeenCalledTimes(5);
});

test("generation publication reconciliation coalesces signals and never rolls back concurrent graph, Snapshot, or layout state", async () => {
  const initial = readyWorkspace();
  const concurrentGraph = {
    ...initial.graph,
    revision: initial.graph.revision + 1,
    nodes: initial.graph.nodes.map((node) => node.id === "node-1"
      ? { ...node, name: "Generated storefront" }
      : node),
  };
  const concurrentSnapshot = {
    ...initial.activeSnapshot,
    id: "snapshot-graph-3",
    sequence: initial.activeSnapshot.sequence + 1,
    parentSnapshotId: initial.activeSnapshot.id,
    graphRevision: concurrentGraph.revision,
    graph: concurrentGraph,
    reason: "graph-command" as const,
    provenance: { kind: "graph-command" as const, commandIds: ["rename-generated-page"] },
    createdAt: 6,
  };
  const concurrentLayout = {
    ...initial.layout,
    viewport: { x: 64, y: 0, zoom: 1 },
    checksum: "layout-concurrent",
  };
  const concurrentReady: ReadyProjectWorkspacePayload = {
    ...initial,
    workspace: {
      ...initial.workspace,
      graphRevision: concurrentGraph.revision,
      activeSnapshotId: concurrentSnapshot.id,
      updatedAt: 6,
    },
    graph: concurrentGraph,
    activeSnapshot: concurrentSnapshot,
    snapshots: [...initial.snapshots, concurrentSnapshot],
    layout: concurrentLayout,
  };
  const nextRevision: ArtifactRevision = {
    ...revision,
    id: "updated-concurrent-revision",
    sequence: revision.sequence + 1,
    parentRevisionId: revision.id,
    createdAt: 8,
  };
  const stalePublication = publishedWorkspace(initial, nextRevision, {
    snapshotId: "snapshot-generation-stale",
    snapshotSequence: initial.activeSnapshot.sequence + 1,
    createdAt: 7,
  });
  const authoritative = publishedWorkspace(concurrentReady, nextRevision, {
    snapshotId: "snapshot-generation-current",
    snapshotSequence: concurrentSnapshot.sequence + 1,
    createdAt: 8,
  });
  const staleRead = deferred<ProjectWorkspacePayload>();
  const currentRead = deferred<ProjectWorkspacePayload>();
  const getWorkspace = vi.fn()
    .mockResolvedValueOnce(initial)
    .mockReturnValueOnce(staleRead.promise)
    .mockReturnValueOnce(currentRead.promise);

  render(
    <ApiProvider client={editorApi({
      getWorkspace,
      applyWorkspaceGraphCommands: async () => ({ graph: concurrentGraph, snapshot: concurrentSnapshot }),
      saveWorkspaceLayout: async () => concurrentLayout,
    })}>
      <GenerationPublicationReconcileProbe />
    </ApiProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "2:snapshot-1:revision-1:layout-1",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Reconcile generation publication" }));
  fireEvent.click(screen.getByRole("button", { name: "Reconcile generation publication" }));
  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole("button", { name: "Apply concurrent graph mutation" }));
  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "3:snapshot-graph-3:revision-1:layout-1",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Save concurrent layout" }));
  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "3:snapshot-graph-3:revision-1:layout-concurrent",
  ));

  await act(async () => { staleRead.resolve(stalePublication); });
  await waitFor(() => expect(getWorkspace).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "3:snapshot-graph-3:revision-1:layout-concurrent",
  );

  await act(async () => { currentRead.resolve(authoritative); });
  await waitFor(() => expect(screen.getByLabelText("Generation publication state")).toHaveTextContent(
    "3:snapshot-generation-current:updated-concurrent-revision:layout-concurrent",
  ));
  expect(getWorkspace).toHaveBeenCalledTimes(3);
});

test("a late mutation publication reconciles its Artifact without overwriting the newly routed editor", async () => {
  const checkoutArtifact: WorkspaceArtifact = {
    ...artifact,
    id: "artifact-2",
    name: "Checkout",
    sourceRoot: "artifacts/artifact-2",
    activeTrackId: "track-2",
  };
  const checkoutRevision: ArtifactRevision = {
    ...revision,
    id: "revision-checkout-1",
    artifactId: checkoutArtifact.id,
    trackId: "track-2",
    sequence: 2,
    parentRevisionId: null,
    artifactRoot: checkoutArtifact.sourceRoot,
  };
  const publishedRevision = { ...revision, id: "revision-2", sequence: 5, parentRevisionId: revision.id, createdAt: 3 };
  const nextWorkspace = workspace();
  if (nextWorkspace.status !== "ready") throw new Error("fixture must be ready");
  const publishedSnapshot = {
    ...nextWorkspace.activeSnapshot,
    id: "snapshot-2",
    sequence: 3,
    parentSnapshotId: "snapshot-1",
    artifactRevisions: { [artifact.id]: publishedRevision.id, [checkoutArtifact.id]: checkoutRevision.id },
  };
  const publication: ArtifactMutationResult = { revision: publishedRevision, snapshot: publishedSnapshot };
  let finishMutation!: (value: ArtifactMutationResult) => void;
  const pendingMutation = new Promise<ArtifactMutationResult>((resolve) => { finishMutation = resolve; });
  const applyArtifactMutation = vi.fn(async () => pendingMutation);
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "artifact-current") throw new Error("artifact-current target required");
    const isCheckout = target.artifactId === checkoutArtifact.id;
    const targetArtifact = isCheckout ? checkoutArtifact : artifact;
    const targetRevision = isCheckout ? checkoutRevision : revision;
    return {
      ...immutable(),
      targetKey: `artifact-current:${targetArtifact.id}:${targetRevision.id}`,
      artifactId: targetArtifact.id,
      revisionId: targetRevision.id,
      trackId: targetRevision.trackId,
      sourceCommitHash: targetRevision.sourceCommitHash,
      sourceTreeHash: targetRevision.sourceTreeHash,
      dependencyLockHash: `dependencies-${targetRevision.id}`,
      assemblyHash: `assembly-${targetRevision.id}`,
      artifactRoot: targetRevision.artifactRoot,
      renderSpec: targetRevision.renderSpec,
    };
  });
  const api = editorApi({ applyArtifactMutation, resolvePreviewTarget });
  const onArtifactPublished = vi.fn();
  const view = render(
    <ApiProvider client={api}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={onArtifactPublished}
      />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  await dispatchSelection();
  const text = await screen.findByRole("textbox", { name: "Text content" });
  fireEvent.change(text, { target: { value: "Publish this after navigation" } });
  fireEvent.blur(text);
  await waitFor(() => expect(applyArtifactMutation).toHaveBeenCalledTimes(1));

  view.rerender(
    <ApiProvider client={api}>
      <RoutedArtifactEditor
        artifactValue={checkoutArtifact}
        revisionValue={checkoutRevision}
        snapshotId="snapshot-1"
        onArtifactPublished={onArtifactPublished}
      />
    </ApiProvider>,
  );
  await waitFor(() => expect(
    resolvePreviewTarget.mock.calls.filter(([, target]) => target.kind === "artifact-current" && target.artifactId === checkoutArtifact.id),
  ).toHaveLength(1));
  await screen.findByTitle("Checkout preview");
  await dispatchSelection(
    { designNodeId: "checkout-title", sourcePath: "src/Checkout.tsx", selector: "[data-design-node-id='checkout-title']" },
    "Checkout preview",
  );
  expect(await screen.findByText("checkout-title")).toBeInTheDocument();

  await act(async () => {
    finishMutation(publication);
    await pendingMutation;
  });

  expect(onArtifactPublished).toHaveBeenCalledTimes(1);
  expect(onArtifactPublished).toHaveBeenCalledWith(publication);
  expect(screen.getByRole("heading", { name: "Checkout" })).toBeInTheDocument();
  expect(screen.getByText("Revision 2")).toBeInTheDocument();
  expect(screen.queryByText("Saved as Revision 5")).not.toBeInTheDocument();
  expect(screen.getByText("checkout-title")).toBeInTheDocument();
  expect(
    resolvePreviewTarget.mock.calls.filter(([, target]) => target.kind === "artifact-current" && target.artifactId === checkoutArtifact.id),
  ).toHaveLength(1);
});

test("coalesces a selected text edit on blur into a bounded CAS mutation", async () => {
  const nextRevision = { ...revision, id: "revision-2", sequence: 5, parentRevisionId: revision.id, createdAt: 3 };
  const nextWorkspace = workspace();
  if (nextWorkspace.status !== "ready") throw new Error("fixture must be ready");
  const nextSnapshot = {
    ...nextWorkspace.activeSnapshot,
    id: "snapshot-2",
    sequence: 3,
    parentSnapshotId: "snapshot-1",
    artifactRevisions: { [artifact.id]: nextRevision.id },
  };
  const result: ArtifactMutationResult = { revision: nextRevision, snapshot: nextSnapshot };
  const applyArtifactMutation = vi.fn(async () => result);
  render(
    <ApiProvider client={editorApi({ applyArtifactMutation })}>
      <App />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");
  await dispatchSelection();

  const text = await screen.findByRole("textbox", { name: "Text content" });
  fireEvent.change(text, { target: { value: "A quieter place for useful objects" } });
  expect(applyArtifactMutation).not.toHaveBeenCalled();
  fireEvent.blur(text);

  await waitFor(() => expect(applyArtifactMutation).toHaveBeenCalledWith(project.id, artifact.id, {
    expectedHeadRevisionId: revision.id,
    expectedSnapshotId: "snapshot-1",
    command: {
      type: "set-text",
      locator: {
        designNodeId: "hero-title",
        sourcePath: "src/Hero.tsx",
        selector: "[data-design-node-id='hero-title']",
      },
      expectedCurrentValue: "Objects for a considered home",
      value: "A quieter place for useful objects",
    },
  }));
  expect(applyArtifactMutation).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Saved as Revision 5")).toBeInTheDocument();
  expect(screen.queryByLabelText("Selected Agent Context")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Text content" })).not.toBeInTheDocument();
});

test("preserves exact selected text for CAS and disables only text mutation when the picker reports incomplete text", async () => {
  const nextRevision = { ...revision, id: "revision-2", sequence: 5, parentRevisionId: revision.id, createdAt: 3 };
  const nextWorkspace = workspace();
  if (nextWorkspace.status !== "ready") throw new Error("fixture must be ready");
  const result: ArtifactMutationResult = {
    revision: nextRevision,
    snapshot: {
      ...nextWorkspace.activeSnapshot,
      id: "snapshot-2",
      sequence: 3,
      parentSnapshotId: "snapshot-1",
      artifactRevisions: { [artifact.id]: nextRevision.id },
    },
  };
  const applyArtifactMutation = vi.fn(async () => result);
  render(
    <ApiProvider client={editorApi({ applyArtifactMutation })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  const exactText = "  Objects\n    for a considered\t home  ";
  await dispatchSelection(undefined, undefined, exactText);
  const text = await screen.findByRole("textbox", { name: "Text content" });
  expect(text).toHaveValue(exactText);
  fireEvent.change(text, { target: { value: "Replacement" } });
  fireEvent.blur(text);
  await waitFor(() => expect(applyArtifactMutation).toHaveBeenCalledWith(project.id, artifact.id, expect.objectContaining({
    command: expect.objectContaining({
      type: "set-text",
      expectedCurrentValue: exactText,
      value: "Replacement",
    }),
  })));

  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Text content" })).not.toBeInTheDocument());
  await dispatchSelection(undefined, undefined, "This selection exceeds the safe text transfer limit", false);
  expect(await screen.findByRole("textbox", { name: "Text content" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Accessible label" })).toBeEnabled();
  expect(screen.getByRole("status", { name: "Text editing unavailable" })).toHaveTextContent("complete text value");
});

function HistoricalEditor({ target }: { target: PreviewTarget }) {
  const payload = workspace();
  const editor = useArtifactEditorController({
    projectId: project.id,
    artifactId: artifact.id,
    artifact,
    tracks: payload.status === "ready" ? payload.tracks : [],
    revisions: [revision],
    activeRevisionId: revision.id,
    activeSnapshotId: "snapshot-1",
    target,
  });
  return (
    <div className="grid h-[800px] grid-cols-[1fr_280px]">
      <ArtifactEditorSurface editor={editor} onBack={() => {}} />
      <aside aria-label="Inspector"><ArtifactInspector editor={editor} /></aside>
    </div>
  );
}

test("clears selected Context when the immutable target changes at the same revision", async () => {
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "component-state") throw new Error("component-state target required");
    return {
      ...immutable("component-state"),
      targetKey: `component-state:${target.variantKey}:${target.stateKey}`,
      assemblyHash: `assembly:${target.variantKey}:${target.stateKey}`,
      variantKey: target.variantKey,
      stateKey: target.stateKey,
    };
  });
  const api = editorApi({ resolvePreviewTarget });
  const first: PreviewTarget = {
    kind: "component-state",
    projectId: project.id,
    revisionId: revision.id,
    variantKey: "default",
    stateKey: "rest",
  };
  const second: PreviewTarget = { ...first, stateKey: "hover" };
  const view = render(
    <ApiProvider client={api}>
      <HistoricalEditor target={first} />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  const firstFrameAttemptId = await dispatchSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();
  const firstFrame = screen.getByTitle<HTMLIFrameElement>("Storefront home preview");
  await sendPreviewBridgeMessage(latestPreviewBridgeHarness(firstFrame), {
    type: "runtime-error",
    kind: "fatal",
    errorType: "error",
    message: "Only the rest-state assembly failed",
    count: 1,
    at: 30,
    frameId: "desktop",
    frameAttemptId: firstFrameAttemptId,
  });
  expect(await screen.findByRole("alert", { name: "Artifact preview runtime error" })).toHaveTextContent(
    "Only the rest-state assembly failed",
  );

  view.rerender(
    <ApiProvider client={api}>
      <HistoricalEditor target={second} />
    </ApiProvider>,
  );

  await waitFor(() => expect(resolvePreviewTarget).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("hero-title")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("Only the rest-state assembly failed")).not.toBeInTheDocument());
});

test("historical targets are explicitly read-only and disable every mutation surface", async () => {
  const applyArtifactMutation = vi.fn();
  render(
    <ApiProvider client={editorApi({
      resolvePreviewTarget: async () => immutable("artifact-revision"),
      applyArtifactMutation,
    })}>
      <HistoricalEditor target={{ kind: "artifact-revision", projectId: project.id, revisionId: revision.id }} />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");
  await dispatchSelection();
  await screen.findByText("hero-title");

  expect(await screen.findByRole("status", { name: "Historical preview is read-only" })).toBeInTheDocument();
  const mutationControls = document.querySelectorAll<HTMLElement>("[data-artifact-mutation]");
  expect(mutationControls.length).toBeGreaterThan(2);
  for (const control of mutationControls) expect(control).toBeDisabled();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  expect(applyArtifactMutation).not.toHaveBeenCalled();
});

test("loads a pinned Revision outside the workspace overview and returns to Head explicitly", async () => {
  const pinned = {
    ...revision,
    id: "revision-pinned",
    sequence: 3,
    parentRevisionId: "revision-0",
    sourceCommitHash: "commit-pinned",
    sourceTreeHash: "tree-pinned",
    createdAt: 1,
  };
  const getArtifactRevision = vi.fn(async () => pinned);
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => ({
    ...immutable(target.kind),
    targetKey: `${target.kind}:${target.kind === "artifact-revision" ? target.revisionId : revision.id}`,
    revisionId: target.kind === "artifact-revision" ? target.revisionId : revision.id,
    sourceCommitHash: target.kind === "artifact-revision" ? pinned.sourceCommitHash : revision.sourceCommitHash,
    sourceTreeHash: target.kind === "artifact-revision" ? pinned.sourceTreeHash : revision.sourceTreeHash,
  }));
  window.history.pushState({}, "", `/projects/${project.id}/artifacts/${artifact.id}/revisions/${pinned.id}`);
  render(
    <ApiProvider client={editorApi({ getArtifactRevision, resolvePreviewTarget })}>
      <App />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  expect(await screen.findByText("Revision 3")).toBeInTheDocument();
  expect(screen.getByText("Pinned Revision · read-only")).toBeInTheDocument();
  expect(getArtifactRevision).toHaveBeenCalledWith(project.id, artifact.id, pinned.id);
  fireEvent.click(screen.getByRole("button", { name: "Return to Head" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/projects/${project.id}/artifacts/${artifact.id}`));
});

test("loads immutable Artifact history only when requested and pages older Revisions", async () => {
  const older = {
    ...revision,
    id: "revision-0",
    sequence: 3,
    parentRevisionId: null,
    sourceCommitHash: "commit-0",
    sourceTreeHash: "tree-0",
    createdAt: 1,
  };
  const listArtifactRevisionHistory = vi.fn(async (
    _projectId: string,
    _artifactId: string,
    options?: { limit?: number; cursor?: string },
  ) => options?.cursor
    ? { items: [older], nextCursor: null }
    : { items: [revision], nextCursor: "older-page" });
  render(
    <ApiProvider client={editorApi({ listArtifactRevisionHistory })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  expect(listArtifactRevisionHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Versions" }));

  expect(await screen.findByRole("dialog", { name: "Artifact versions" })).toBeInTheDocument();
  await waitFor(() => expect(listArtifactRevisionHistory).toHaveBeenCalledWith(
    project.id,
    artifact.id,
    { limit: 20 },
  ));
  const versionsDialog = screen.getByRole("dialog", { name: "Artifact versions" });
  expect(within(versionsDialog).getByText(/publish against the current Design Kernel/i)).toBeInTheDocument();
  expect(within(versionsDialog).getByText(/remain unassessed until validation runs again/i)).toBeInTheDocument();
  expect(within(versionsDialog).getByText("Revision 4")).toBeInTheDocument();
  expect(within(versionsDialog).getByText("Head")).toBeInTheDocument();
  expect(versionsDialog.querySelector(".artifact-versions")).toHaveAttribute("data-history-density", "compact");
  expect(within(versionsDialog).getByRole("list", {
    name: "Saved revision history, 1 revision",
  })).toBeInTheDocument();
  expect(within(versionsDialog).queryByRole("region", {
    name: "Scrollable revision history",
  })).not.toBeInTheDocument();
  expect(within(versionsDialog).getByRole("group", {
    name: "Actions for Revision 4 on Main",
  })).toContainElement(within(versionsDialog).getByRole("button", {
    name: "Fork a track from Revision 4 on Main",
  }));

  fireEvent.click(screen.getByRole("button", { name: "Load older revisions" }));
  await waitFor(() => expect(listArtifactRevisionHistory).toHaveBeenLastCalledWith(
    project.id,
    artifact.id,
    { limit: 20, cursor: "older-page" },
  ));
  expect(await screen.findByText("Revision 3")).toBeInTheDocument();
});

test("marks long Artifact history as a bounded keyboard-scrollable region", async () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    ...revision,
    id: index === 0 ? revision.id : `revision-history-${index}`,
    sequence: 8 - index,
    parentRevisionId: index === 7 ? null : `revision-history-${index + 1}`,
    createdAt: revision.createdAt - index,
  }));
  const listArtifactRevisionHistory = vi.fn(async () => ({ items, nextCursor: null }));
  render(
    <ApiProvider client={editorApi({ listArtifactRevisionHistory })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  fireEvent.click(screen.getByRole("button", { name: "Versions" }));

  const versionsDialog = await screen.findByRole("dialog", { name: "Artifact versions" });
  await waitFor(() => expect(within(versionsDialog).getByText("Revision 8")).toBeInTheDocument());
  expect(versionsDialog.querySelector(".artifact-versions")).toHaveAttribute("data-history-density", "scrolling");
  expect(within(versionsDialog).getByRole("list", {
    name: "Saved revision history, 8 revisions",
  })).toBeInTheDocument();
  expect(within(versionsDialog).getByRole("region", {
    name: "Scrollable revision history",
  })).toHaveAttribute("tabindex", "0");
});

test("hydrates a deeply paged pinned Revision by identity before comparing it with Head", async () => {
  const pinned = {
    ...revision,
    id: "revision-deep-pinned",
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: "commit-deep-pinned",
    sourceTreeHash: "tree-deep-pinned",
    createdAt: 1,
  };
  const getArtifactRevision = vi.fn(async () => pinned);
  const listArtifactRevisionHistory = vi.fn(async () => ({
    items: [revision],
    nextCursor: "twenty-older-revisions",
  }));
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    const targetRevision = target.kind === "artifact-revision" && target.revisionId === pinned.id ? pinned : revision;
    return {
      ...immutable(target.kind),
      targetKey: `${target.kind}:${targetRevision.id}`,
      revisionId: targetRevision.id,
      sourceCommitHash: targetRevision.sourceCommitHash,
      sourceTreeHash: targetRevision.sourceTreeHash,
      assemblyHash: `assembly:${targetRevision.id}`,
    };
  });
  let lease = 0;
  render(
    <ApiProvider client={editorApi({
      getArtifactRevision,
      listArtifactRevisionHistory,
      resolvePreviewTarget,
      acquirePreviewTargetLease: async (_projectId: string, resolved: ResolvedPreviewTarget) => ({
        leaseId: `lease-deep-${++lease}`,
        url: `http://preview.local/${resolved.revisionId}#dezin-bridge=${BRIDGE_NONCE}`,
        bridgeNonce: BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved,
      }),
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        pinnedRevisionId={pinned.id}
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  const versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  const compare = within(versions).getByRole("button", { name: "Compare selected revisions" });
  await waitFor(() => expect(compare).toBeEnabled());
  expect(within(versions).getByText("Revision 1")).toBeInTheDocument();
  expect(within(versions).getByText("Pinned")).toBeInTheDocument();
  expect(listArtifactRevisionHistory).toHaveBeenCalledTimes(1);
  expect(getArtifactRevision).toHaveBeenCalledWith(project.id, artifact.id, pinned.id);

  fireEvent.click(compare);
  expect(await screen.findByRole("dialog", { name: "Compare versions" })).toBeInTheDocument();
});

test("restores and forks saved history when the active Track has no Head", async () => {
  const payload = readyWorkspace();
  const restoredRevision = { ...revision, id: "revision-restored-empty-head", parentRevisionId: null, sequence: 1 };
  const restored: ArtifactVersionActionResult = {
    action: "restore-as-new-revision",
    artifact,
    track: { ...payload.tracks[0]!, headRevisionId: restoredRevision.id },
    revision: restoredRevision,
    snapshot: { ...payload.activeSnapshot, id: "snapshot-restored-empty-head" },
  };
  const forkedRevision = { ...revision, id: "revision-forked-empty-head", trackId: "track-forked-empty-head", parentRevisionId: null, sequence: 1 };
  const forked: ArtifactVersionActionResult = {
    action: "fork-track",
    artifact: { ...artifact, activeTrackId: "track-forked-empty-head" },
    track: { id: "track-forked-empty-head", artifactId: artifact.id, name: "Recovered direction", headRevisionId: forkedRevision.id, legacyVariantId: null, createdAt: 4 },
    revision: forkedRevision,
    snapshot: { ...payload.activeSnapshot, id: "snapshot-forked-empty-head" },
  };
  const restoreArtifactRevision = vi.fn(async () => restored);
  const forkArtifactTrack = vi.fn(async () => forked);
  render(
    <ApiProvider client={editorApi({
      getArtifactRevision: async () => revision,
      listArtifactRevisionHistory: async () => ({ items: [revision], nextCursor: null }),
      restoreArtifactRevision,
      forkArtifactTrack,
      resolvePreviewTarget: async () => immutable("artifact-revision"),
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        headRevisionId={null}
        pinnedRevisionId={revision.id}
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  let versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  const restore = within(versions).getByRole("button", { name: "Restore Revision 4 on Main as a new revision" });
  expect(restore).toBeEnabled();
  fireEvent.click(restore);
  await waitFor(() => expect(restoreArtifactRevision).toHaveBeenCalledWith(
    project.id,
    artifact.id,
    revision.id,
    { expectedHeadRevisionId: null, expectedSnapshotId: "snapshot-1" },
  ));

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  const fork = within(versions).getByRole("button", { name: "Fork a track from Revision 4 on Main" });
  expect(fork).toBeEnabled();
  fireEvent.click(fork);
  fireEvent.change(within(versions).getByRole("textbox", { name: "New track name" }), {
    target: { value: "Recovered direction" },
  });
  fireEvent.click(within(versions).getByRole("button", { name: "Create track" }));
  await waitFor(() => expect(forkArtifactTrack).toHaveBeenCalledWith(
    project.id,
    artifact.id,
    revision.id,
    { name: "Recovered direction", expectedHeadRevisionId: null, expectedSnapshotId: "snapshot-1" },
  ));
});

test("reloads immutable Artifact history after restore closes and reopens Versions", async () => {
  const older = {
    ...revision,
    id: "revision-before-restore",
    sequence: 3,
    parentRevisionId: null,
    sourceCommitHash: "commit-before-restore",
    sourceTreeHash: "tree-before-restore",
    createdAt: 1,
  };
  const payload = readyWorkspace();
  const restoredRevision = {
    ...revision,
    id: "revision-after-restore",
    sequence: 5,
    parentRevisionId: revision.id,
    createdAt: 5,
  };
  const restored: ArtifactVersionActionResult = {
    action: "restore-as-new-revision",
    artifact,
    track: { ...payload.tracks[0]!, headRevisionId: restoredRevision.id },
    revision: restoredRevision,
    snapshot: {
      ...payload.activeSnapshot,
      id: "snapshot-after-restore",
      artifactRevisions: { [artifact.id]: restoredRevision.id },
    },
  };
  let restorePublished = false;
  const listArtifactRevisionHistory = vi.fn(async () => ({
    items: restorePublished ? [restoredRevision, revision, older] : [revision, older],
    nextCursor: null,
  }));
  const restoreArtifactRevision = vi.fn(async () => {
    restorePublished = true;
    return restored;
  });
  render(
    <ApiProvider client={editorApi({
      listArtifactRevisionHistory,
      restoreArtifactRevision,
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  const firstDialog = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(firstDialog).getByRole("button", {
    name: "Restore Revision 3 on Main as a new revision",
  }));
  await waitFor(() => expect(restoreArtifactRevision).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Artifact versions" })).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  const reopened = await screen.findByRole("dialog", { name: "Artifact versions" });
  await waitFor(() => expect(listArtifactRevisionHistory).toHaveBeenCalledTimes(2));
  expect(within(reopened).getByText("Revision 5")).toBeInTheDocument();
});

test("keeps the Revision comparison slider selected while immutable previews acquire", async () => {
  const older = {
    ...revision,
    id: "revision-compare-loading",
    sequence: 3,
    parentRevisionId: null,
    sourceCommitHash: "commit-compare-loading",
    sourceTreeHash: "tree-compare-loading",
    createdAt: 1,
  };
  const resolvedFor = (candidate: ArtifactRevision): ResolvedPreviewTarget => ({
    ...immutable("artifact-revision"),
    targetKey: `artifact-revision:${candidate.id}`,
    revisionId: candidate.id,
    sourceCommitHash: candidate.sourceCommitHash,
    sourceTreeHash: candidate.sourceTreeHash,
    assemblyHash: `assembly:${candidate.id}`,
  });
  const pending = new Map([
    [revision.id, deferred<PreviewTargetLease>()],
    [older.id, deferred<PreviewTargetLease>()],
  ]);
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, resolved: ResolvedPreviewTarget) => {
    if (resolved.requestedKind !== "artifact-revision") {
      return {
        leaseId: "lease-current-loading-test",
        url: `http://preview.local/current#dezin-bridge=${BRIDGE_NONCE}`,
        bridgeNonce: BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved,
      };
    }
    const acquisition = pending.get(resolved.revisionId);
    if (!acquisition) throw new Error(`Unexpected Revision acquisition: ${resolved.revisionId}`);
    return acquisition.promise;
  });
  render(
    <ApiProvider client={editorApi({
      listArtifactRevisionHistory: async () => ({ items: [revision, older], nextCursor: null }),
      resolvePreviewTarget: async (_projectId: string, target: PreviewTarget) => {
        if (target.kind !== "artifact-revision") return immutable(target.kind);
        return resolvedFor(target.revisionId === older.id ? older : revision);
      },
      acquirePreviewTargetLease,
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  const versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 4 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 3 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("button", { name: "Compare selected revisions" }));

  expect(await screen.findByRole("dialog", { name: "Compare versions" })).toBeInTheDocument();
  expect(screen.queryAllByText("Preview unavailable")).toHaveLength(0);
  expect(screen.getAllByRole("status", { name: /preview loading$/ })).toHaveLength(2);

  await act(async () => {
    for (const candidate of [revision, older]) {
      pending.get(candidate.id)!.resolve({
        leaseId: `lease-${candidate.id}`,
        url: `http://preview.local/${candidate.id}#dezin-bridge=${BRIDGE_NONCE}`,
        bridgeNonce: BRIDGE_NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: resolvedFor(candidate),
      });
    }
    await Promise.resolve();
  });

  expect(await screen.findByRole("slider", { name: "Drag to compare" })).toHaveAttribute("aria-valuenow", "50");
});

test("retries a failed Revision preview acquisition and restores the comparison slider", async () => {
  const older = {
    ...revision,
    id: "revision-compare-retry",
    sequence: 3,
    parentRevisionId: null,
    sourceCommitHash: "commit-compare-retry",
    sourceTreeHash: "tree-compare-retry",
    createdAt: 1,
  };
  const resolvedFor = (candidate: ArtifactRevision): ResolvedPreviewTarget => ({
    ...immutable("artifact-revision"),
    targetKey: `artifact-revision:${candidate.id}`,
    revisionId: candidate.id,
    sourceCommitHash: candidate.sourceCommitHash,
    sourceTreeHash: candidate.sourceTreeHash,
    assemblyHash: `assembly:${candidate.id}`,
  });
  let olderAttempts = 0;
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, resolved: ResolvedPreviewTarget) => {
    if (resolved.requestedKind === "artifact-revision" && resolved.revisionId === older.id) {
      olderAttempts += 1;
      if (olderAttempts === 1) throw new Error("Revision preview worker failed");
    }
    return {
      leaseId: `lease-${resolved.revisionId}-${olderAttempts}`,
      url: `http://preview.local/${resolved.revisionId}#dezin-bridge=${BRIDGE_NONCE}`,
      bridgeNonce: BRIDGE_NONCE,
      expiresAt: Date.now() + 60_000,
      resolved,
    };
  });
  render(
    <ApiProvider client={editorApi({
      listArtifactRevisionHistory: async () => ({ items: [revision, older], nextCursor: null }),
      resolvePreviewTarget: async (_projectId: string, target: PreviewTarget) => {
        if (target.kind !== "artifact-revision") return immutable(target.kind);
        return resolvedFor(target.revisionId === older.id ? older : revision);
      },
      acquirePreviewTargetLease,
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  const versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 4 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 3 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("button", { name: "Compare selected revisions" }));

  expect(await screen.findByText("Revision preview worker failed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry Revision 3 · Main preview" }));

  await waitFor(() => expect(acquirePreviewTargetLease.mock.calls.filter(([, resolved]) => (
    resolved.requestedKind === "artifact-revision" && resolved.revisionId === older.id
  ))).toHaveLength(2));
  expect(await screen.findByRole("slider", { name: "Drag to compare" })).toBeInTheDocument();
  expect(screen.queryAllByText("Preview unavailable")).toHaveLength(0);
});

test("compares immutable Revisions and publishes restore and fork actions with exact fences", async () => {
  const older = {
    ...revision,
    id: "revision-0",
    sequence: 3,
    parentRevisionId: null,
    sourceCommitHash: "commit-0",
    sourceTreeHash: "tree-0",
    createdAt: 1,
  };
  const payload = readyWorkspace();
  const restoredRevision = { ...revision, id: "revision-restored", sequence: 5, parentRevisionId: revision.id, createdAt: 3 };
  const restored: ArtifactVersionActionResult = {
    action: "restore-as-new-revision",
    artifact,
    track: { ...payload.tracks[0]!, headRevisionId: restoredRevision.id },
    revision: restoredRevision,
    snapshot: { ...payload.activeSnapshot, id: "snapshot-restored", artifactRevisions: { [artifact.id]: restoredRevision.id } },
  };
  const forkedRevision = { ...older, id: "revision-forked", sequence: 1, trackId: "track-forked", createdAt: 4 };
  const forked: ArtifactVersionActionResult = {
    action: "fork-track",
    artifact: { ...artifact, activeTrackId: "track-forked" },
    track: { id: "track-forked", artifactId: artifact.id, name: "Quiet direction", headRevisionId: forkedRevision.id, legacyVariantId: null, createdAt: 4 },
    revision: forkedRevision,
    snapshot: { ...payload.activeSnapshot, id: "snapshot-forked", artifactTracks: { [artifact.id]: "track-forked" }, artifactRevisions: { [artifact.id]: forkedRevision.id } },
  };
  const restoreArtifactRevision = vi.fn(async () => restored);
  const forkArtifactTrack = vi.fn(async () => forked);
  const onVersionPublished = vi.fn();
  let lease = 0;
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    const resolvedRevision = target.kind === "artifact-revision" && target.revisionId === older.id ? older : revision;
    return {
      ...immutable(target.kind),
      targetKey: `${target.kind}:${resolvedRevision.id}`,
      revisionId: resolvedRevision.id,
      sourceCommitHash: resolvedRevision.sourceCommitHash,
      sourceTreeHash: resolvedRevision.sourceTreeHash,
      assemblyHash: `assembly:${resolvedRevision.id}`,
    };
  });
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, target: ResolvedPreviewTarget) => ({
    leaseId: `lease-${++lease}`,
    url: `http://preview.local/${target.revisionId}#dezin-bridge=${BRIDGE_NONCE}`,
    bridgeNonce: BRIDGE_NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: target,
  }));
  const releasePreviewTargetLease = vi.fn(async () => {});
  render(
    <ApiProvider client={editorApi({
      listArtifactRevisionHistory: async () => ({ items: [revision, older], nextCursor: null }),
      restoreArtifactRevision,
      forkArtifactTrack,
      resolvePreviewTarget,
      acquirePreviewTargetLease,
      releasePreviewTargetLease,
    })}>
      <RoutedArtifactEditor
        artifactValue={artifact}
        revisionValue={revision}
        snapshotId="snapshot-1"
        onArtifactPublished={() => {}}
        onVersionPublished={onVersionPublished}
      />
    </ApiProvider>,
  );
  await screen.findByTitle("Storefront home preview");

  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  const versions = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 4 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("checkbox", { name: "Select Revision 3 on Main for compare" }));
  fireEvent.click(within(versions).getByRole("button", { name: "Compare selected revisions" }));

  expect(await screen.findByRole("dialog", { name: "Compare versions" })).toBeInTheDocument();
  await waitFor(() => expect(resolvePreviewTarget).toHaveBeenCalledWith(
    project.id,
    { kind: "artifact-revision", projectId: project.id, revisionId: older.id },
    expect.any(AbortSignal),
  ));
  expect(await screen.findByTitle("Revision 3 · Main")).toBeInTheDocument();
  expect(await screen.findByTitle("Revision 4 · Main")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(releasePreviewTargetLease).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  const restoreDialog = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(restoreDialog).getByRole("button", { name: "Restore Revision 3 on Main as a new revision" }));
  await waitFor(() => expect(restoreArtifactRevision).toHaveBeenCalledWith(
    project.id,
    artifact.id,
    older.id,
    { expectedHeadRevisionId: revision.id, expectedSnapshotId: "snapshot-1" },
  ));
  expect(onVersionPublished).toHaveBeenCalledWith(restored);
  await waitFor(() => expect(
    screen.queryByRole("dialog", { name: "Artifact versions" }),
  ).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Versions" }));
  const forkDialog = await screen.findByRole("dialog", { name: "Artifact versions" });
  fireEvent.click(within(forkDialog).getByRole("button", { name: "Fork a track from Revision 3 on Main" }));
  fireEvent.change(within(forkDialog).getByRole("textbox", { name: "New track name" }), {
    target: { value: "Quiet direction" },
  });
  fireEvent.click(within(forkDialog).getByRole("button", { name: "Create track" }));
  await waitFor(() => expect(forkArtifactTrack).toHaveBeenCalledWith(
    project.id,
    artifact.id,
    older.id,
    { name: "Quiet direction", expectedHeadRevisionId: revision.id, expectedSnapshotId: "snapshot-1" },
  ));
  expect(onVersionPublished).toHaveBeenLastCalledWith(forked);
});
