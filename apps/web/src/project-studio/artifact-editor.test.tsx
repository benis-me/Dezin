import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../App.tsx";
import { ApiProvider } from "../lib/api-context.tsx";
import type {
  ArtifactMutationResult,
  ArtifactRevision,
  PreviewTarget,
  Project,
  ProjectWorkspacePayload,
  ResolvedPreviewTarget,
  WorkspaceArtifact,
} from "../lib/api.ts";
import { navigate } from "../router.tsx";
import { makeFakeApi } from "../test/fake-api.ts";
import { ArtifactInspector } from "./artifact/ArtifactInspector.tsx";
import {
  ArtifactEditorSurface,
  fitArtifactPreviewZoom,
  parseFrames,
  useArtifactEditorController,
} from "./artifact/ArtifactEditorSurface.tsx";
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

function RoutedArtifactEditor({
  artifactValue,
  revisionValue,
  snapshotId,
  onArtifactPublished,
}: {
  artifactValue: WorkspaceArtifact;
  revisionValue: ArtifactRevision;
  snapshotId: string;
  onArtifactPublished: (result: ArtifactMutationResult) => void;
}) {
  const editor = useArtifactEditorController({
    projectId: project.id,
    artifactId: artifactValue.id,
    artifact: artifactValue,
    tracks: [{
      id: revisionValue.trackId,
      artifactId: artifactValue.id,
      name: "Main",
      headRevisionId: revisionValue.id,
      legacyVariantId: null,
      createdAt: 1,
    }],
    revisions: [revisionValue],
    activeRevisionId: revisionValue.id,
    activeSnapshotId: snapshotId,
    onArtifactPublished,
  });
  return (
    <div className="grid h-[800px] grid-cols-[1fr_280px]">
      <ArtifactEditorSurface editor={editor} onBack={() => {}} />
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
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  await act(async () => {
    fireEvent.load(frame);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "bridge-ready",
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameAttemptId: expect.any(String),
  }), "http://preview.local"));
  const frameAttemptId = [...postMessage.mock.calls]
    .reverse()
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  const frameId = (screen.getByLabelText("Preview frame") as HTMLSelectElement).value;
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId,
        frameAttemptId,
        reason: "applied",
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "element-selected",
        nonce: BRIDGE_NONCE,
        protocol: 1,
        locator,
        tag: "h1",
        ...(textComplete ? { text } : {}),
        textPreview: text.replace(/\s+/g, " ").trim().slice(0, 160),
        textComplete,
        rect: { x: 96, y: 120, w: 640, h: 72 },
      },
    }));
  });
  return frameAttemptId!;
}

async function dispatchLegacySelection(): Promise<void> {
  const frame = screen.getByTitle<HTMLIFrameElement>("Storefront home preview");
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  await act(async () => {
    fireEvent.load(frame);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "bridge-ready",
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameAttemptId: expect.any(String),
  }), "http://preview.local"));
  const frameAttemptId = [...postMessage.mock.calls]
    .reverse()
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  const frameId = (screen.getByLabelText("Preview frame") as HTMLSelectElement).value;
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId,
        frameAttemptId,
        reason: "applied",
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "selected",
        nonce: BRIDGE_NONCE,
        protocol: 1,
        selector: "main > section.hero:nth-of-type(1) > h1:nth-of-type(1)",
        tag: "h1",
        text: "Legacy selected headline",
        rect: { x: 96, y: 120, w: 640, h: 72 },
        attrs: { id: "legacy-hero-title" },
      },
    }));
  });
}

beforeEach(() => {
  localStorage.setItem("dezin.onboarded", "1");
  window.history.pushState({}, "", "/projects/project-1/artifacts/artifact-1");
});

afterEach(cleanup);

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
  )).toBe(0.25);
});

test("keeps the preview frame selector available in the narrow editor toolbar", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/artifact/artifact-editor.css`, "utf8");
  const start = css.indexOf("@media (max-width: 640px)");
  const end = css.indexOf("@media (prefers-reduced-motion", start);
  const narrowRules = css.slice(start, end);
  expect(narrowRules).not.toContain(".artifact-frame-select,");
  expect(narrowRules).toMatch(/\.artifact-frame-select\s*\{[^}]*max-width:/s);
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
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.load(iframe);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: iframe.contentWindow,
      data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
  });

  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    initialState: "default",
    fixture: { navigation: { open: false } },
    background: "#f7f5ef",
    nonce: BRIDGE_NONCE,
    protocol: 1,
  }), "http://preview.local"));

  fireEvent.change(screen.getByLabelText("Preview frame"), { target: { value: "compact-menu" } });

  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "compact-menu",
    initialState: "menu-open",
    fixture: { navigation: { open: true }, cartCount: 2 },
    background: "rgb(12, 18, 24)",
    nonce: BRIDGE_NONCE,
    protocol: 1,
  }), "http://preview.local"));
  expect(postMessage).not.toHaveBeenCalledWith(
    { source: "dezin-parent", type: "select-mode", on: true, nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );
  expect(document.querySelector(".artifact-preview-frame")).toHaveStyle({ background: "rgb(12, 18, 24)" });
  const compactFrameAttemptId = [...postMessage.mock.calls]
    .reverse()
    .map(([message]) => message as { type?: string; frameId?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame" && message.frameId === "compact-menu")?.frameAttemptId;
  expect(compactFrameAttemptId).toBeTruthy();

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: iframe.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId: "compact-menu",
        frameAttemptId: compactFrameAttemptId,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  expect(await screen.findByRole("status", { name: "Preview frame state" })).toHaveTextContent("State applied");
  expect(postMessage).toHaveBeenCalledWith(
    { source: "dezin-parent", type: "select-mode", on: true, nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: iframe.contentWindow,
      data: {
        source: "dezin",
        type: "frame-rejected",
        frameId: "compact-menu",
        frameAttemptId: compactFrameAttemptId,
        reason: "unsafe-background",
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
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
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  await act(async () => {
    fireEvent.load(iframe);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: iframe.contentWindow,
      data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
  });
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  }), "http://preview.local"));
  const frameAttemptId = postMessage.mock.calls
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();

  const terminal = (type: "frame-applied" | "frame-rejected") => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: iframe.contentWindow,
      data: {
        source: "dezin",
        type,
        frameId: "desktop",
        frameAttemptId,
        ...(type === "frame-rejected" ? { reason: "unsafe-background" } : {}),
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  };
  act(() => terminal("frame-rejected"));
  expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State rejected");

  act(() => terminal("frame-applied"));
  expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State rejected");
  expect(screen.getByRole("button", { name: "Select an element in the preview" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
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
  const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
  fireEvent.load(iframe);
  vi.useFakeTimers();
  try {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://preview.local",
        source: iframe.contentWindow,
        data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
      }));
    });
    const callsOf = (type: string) => postMessage.mock.calls.filter(([message]) => (
      message as { type?: string }
    ).type === type).length;
    expect(callsOf("set-frame")).toBe(1);

    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    expect(callsOf("set-frame")).toBe(2);
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("Retrying state");

    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    expect(callsOf("bridge-init")).toBe(2);
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("Reconnecting state");

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://preview.local",
        source: iframe.contentWindow,
        data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
      }));
    });
    expect(callsOf("set-frame")).toBe(3);
    act(() => vi.advanceTimersByTime(PREVIEW_FRAME_ACK_TIMEOUT_MS + 1));
    expect(screen.getByRole("status", { name: "Preview frame state" })).toHaveTextContent("State timed out");
    expect(screen.getByRole("button", { name: "Retry frame state" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry frame state" }));
    expect(callsOf("bridge-init")).toBe(3);
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://preview.local",
        source: iframe.contentWindow,
        data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
      }));
      await Promise.resolve();
    });
    const recoveredFrameAttemptId = [...postMessage.mock.calls]
      .reverse()
      .map(([message]) => message as { type?: string; frameAttemptId?: string })
      .find((message) => message.type === "set-frame")?.frameAttemptId;
    expect(recoveredFrameAttemptId).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://preview.local",
        source: iframe.contentWindow,
        data: {
          source: "dezin",
          type: "frame-applied",
          frameId: "desktop",
          frameAttemptId: recoveredFrameAttemptId,
          nonce: BRIDGE_NONCE,
          protocol: 1,
        },
      }));
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
  expect(screen.getByRole("textbox", { name: "Workspace Agent draft" })).toHaveValue("Refine the selected headline rhythm");
  expect(screen.queryByLabelText("Selected Agent Context")).not.toBeInTheDocument();

  act(() => navigate("/projects/project-1/artifacts/artifact-1"));
  expect(await screen.findByTitle("Storefront home preview")).toBeInTheDocument();
  expect(screen.getByTestId("project-studio-shell")).toBe(shell);
  expect(screen.getByRole("textbox", { name: "Artifact Agent draft" })).toHaveValue("Refine the selected headline rhythm");
  expect(screen.queryByLabelText("Selected Agent Context")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select an element in the preview" })).toBeInTheDocument();
});

test("enables the preview picker on load and accepts both bridge protocols only from the leased frame", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <App />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle<HTMLIFrameElement>("Storefront home preview");
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
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
  expect(postMessage).toHaveBeenCalledWith(
    { source: "dezin-parent", type: "select-mode", on: true, nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );
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
  expect(postMessage).toHaveBeenCalledWith(
    { source: "dezin-parent", type: "clear", nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );
  expect(postMessage).toHaveBeenCalledWith(
    { source: "dezin-parent", type: "select-mode", on: false, nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );

  await dispatchSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: { source: "dezin", type: "element-cleared", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
  });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();

  await dispatchSelection();
  expect(await screen.findByText("hero-title")).toBeInTheDocument();

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: { source: "dezin", type: "cancel", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
  });
  expect(screen.queryByText("hero-title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Select an element in the preview" }));
  expect(postMessage).toHaveBeenLastCalledWith(
    { source: "dezin-parent", type: "select-mode", on: true, nonce: BRIDGE_NONCE, protocol: 1 },
    "http://preview.local",
  );
});

test("presentation mode makes background Studio panels inert and restores the trigger on Escape", async () => {
  render(
    <ApiProvider client={editorApi()}>
      <App />
    </ApiProvider>,
  );

  await screen.findByTitle("Storefront home preview");
  const agent = screen.getByRole("complementary", { name: "Artifact Agent" });
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  const present = screen.getByRole("button", { name: "Present" });
  present.focus();
  fireEvent.click(present);

  expect(agent).toHaveAttribute("inert");
  expect(inspector).toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Exit present" })).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(agent).not.toHaveAttribute("inert");
  expect(inspector).not.toHaveAttribute("inert");
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
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  await act(async () => {
    fireEvent.load(frame);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
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
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  }), "http://preview.local"));
  const frameAttemptId = postMessage.mock.calls
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(frameAttemptId).toBeTruthy();
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId: "desktop",
        frameAttemptId,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
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
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
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
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  await act(async () => {
    fireEvent.load(frame);
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "runtime-error",
        kind: "fatal",
        errorType: "error",
        message: "Early bootstrap failure",
        count: 1,
        at: 19,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    source: "dezin-parent",
    type: "set-frame",
    frameId: "desktop",
    frameAttemptId: expect.any(String),
  }), "http://preview.local"));
  const setFrame = postMessage.mock.calls
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame");
  expect(setFrame?.frameAttemptId).toBeTruthy();
  const frameAttemptId = setFrame!.frameAttemptId!;

  const runtimeError = (message: string, attemptId = frameAttemptId, frameId = "desktop") => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "runtime-error",
        kind: "fatal",
        errorType: "error",
        message,
        frameId,
        frameAttemptId: attemptId,
        count: 1,
        at: 20,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  };

  act(() => runtimeError("Early bootstrap failure"));
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  act(() => runtimeError("A stale attempt failed", "frame-attempt-stale"));

  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId: "desktop",
        frameAttemptId,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
  });
  expect(await screen.findByRole("alert", { name: "Artifact preview runtime error" })).toHaveTextContent(
    "Early bootstrap failure",
  );
  expect(screen.queryByText("A stale attempt failed")).not.toBeInTheDocument();

  act(() => runtimeError("A stale frame failed", frameAttemptId, "compact"));
  expect(screen.queryByText("A stale frame failed")).not.toBeInTheDocument();

  fireEvent.load(frame);
  expect(screen.queryByText("Early bootstrap failure")).not.toBeInTheDocument();
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: { source: "dezin", type: "bridge-ready", nonce: BRIDGE_NONCE, protocol: 1 },
    }));
  });
  await waitFor(() => {
    const attempts = postMessage.mock.calls
      .map(([message]) => message as { type?: string; frameAttemptId?: string })
      .filter((message) => message.type === "set-frame" && message.frameAttemptId !== frameAttemptId);
    expect(attempts.length).toBeGreaterThan(0);
  });
  const nextFrameAttemptId = [...postMessage.mock.calls]
    .reverse()
    .map(([message]) => message as { type?: string; frameAttemptId?: string })
    .find((message) => message.type === "set-frame")?.frameAttemptId;
  expect(nextFrameAttemptId).toBeTruthy();
  expect(nextFrameAttemptId).not.toBe(frameAttemptId);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: frame.contentWindow,
      data: {
        source: "dezin",
        type: "frame-applied",
        frameId: "desktop",
        frameAttemptId: nextFrameAttemptId,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
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
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "http://preview.local",
      source: firstFrame.contentWindow,
      data: {
        source: "dezin",
        type: "runtime-error",
        kind: "fatal",
        errorType: "error",
        message: "Only the rest-state assembly failed",
        count: 1,
        at: 30,
        frameId: "desktop",
        frameAttemptId: firstFrameAttemptId,
        nonce: BRIDGE_NONCE,
        protocol: 1,
      },
    }));
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
