import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiProvider } from "../../lib/api-context.tsx";
import type { PreviewTarget, ResolvedPreviewTarget } from "../../lib/api.ts";
import { makeFakeApi } from "../../test/fake-api.ts";
import { createPrototypeFlowSession } from "./prototype-flow.ts";
import { PrototypeFlowViewer } from "./PrototypeFlowViewer.tsx";
import { flowRevisions, flowSnapshot } from "./prototype-flow-test-fixtures.ts";

const NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function resolved(target: Extract<PreviewTarget, { kind: "workspace-flow" }>): ResolvedPreviewTarget {
  const revisionId = target.startArtifactId === "page-a" ? "revision-a" : "revision-b";
  const renderSpec = flowRevisions().find((revision) => revision.id === revisionId)?.renderSpec ?? {};
  return {
    version: 1,
    targetKey: `${target.snapshotId}:${target.startArtifactId}:${revisionId}`,
    requestedKind: "workspace-flow",
    projectId: target.projectId,
    workspaceId: "workspace-flow",
    artifactId: target.startArtifactId,
    artifactKind: "page",
    revisionId,
    trackId: `track-${target.startArtifactId}`,
    snapshotId: target.snapshotId,
    sourceCommitHash: `commit-${revisionId}`,
    sourceTreeHash: `tree-${revisionId}`,
    dependencyLockHash: `deps-${revisionId}`,
    assemblyHash: `assembly-${revisionId}`,
    artifactRoot: `artifacts/${target.startArtifactId}`,
    renderSpec,
    variantKey: null,
    stateKey: target.stateKey ?? null,
    runId: null,
  };
}

test("viewer keeps the exact Snapshot across navigation and releases the old and final leases", async () => {
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "workspace-flow") throw new Error("mutable preview target is forbidden");
    return resolved(target);
  });
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  const onClose = vi.fn();
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"]);
  const view = render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget,
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-${exact.artifactId}`,
        url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={onClose} />
    </ApiProvider>,
  );

  const firstFrame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  expect(firstFrame.getAttribute("src")).not.toContain("dezin-bridge");
  const postMessage = vi.spyOn(firstFrame.contentWindow!, "postMessage");
  fireEvent.load(firstFrame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort | undefined;
  expect(port).toBeDefined();
  const received: Array<Record<string, unknown>> = [];
  port!.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port!.start();
  port!.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: "set-prototype-bindings" })));
  const command = received.find((message) => message.type === "set-prototype-bindings")!;
  const binding = (command.bindings as Array<{ bindingId: string; locator: object; trigger: string }>)[0]!;
  expect(command).not.toHaveProperty("targetUrl");

  port!.postMessage({
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    ...binding,
  });

  const betaFrame = await screen.findByTitle("Beta flow preview") as HTMLIFrameElement;
  expect(screen.getByTitle("Alpha flow preview")).toBe(firstFrame);
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a");
  const betaPostMessage = vi.spyOn(betaFrame.contentWindow!, "postMessage");
  fireEvent.load(betaFrame);
  const betaBootstrap = (betaPostMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const betaPort = betaBootstrap?.[2]?.[0] as MessagePort;
  betaPort.start();
  betaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(screen.queryByTitle("Alpha flow preview")).not.toBeInTheDocument());
  expect(resolvePreviewTarget).toHaveBeenLastCalledWith("project-flow", {
    kind: "workspace-flow",
    projectId: "project-flow",
    snapshotId: "snapshot-exact",
    startArtifactId: "page-b",
  }, expect.any(AbortSignal));
  await waitFor(() => expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-page-a"));
  expect(screen.getByText(/revision-b/i)).toBeInTheDocument();
  expect(screen.getAllByText(/snapshot-exact/i)).not.toHaveLength(0);

  const back = screen.getByRole("button", { name: "Back in prototype flow" });
  expect(back).toBeEnabled();
  fireEvent.click(back);
  const backFrame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  expect(screen.getByTitle("Beta flow preview")).toBe(betaFrame);
  const backPostMessage = vi.spyOn(backFrame.contentWindow!, "postMessage");
  fireEvent.load(backFrame);
  const backBootstrap = (backPostMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const backPort = backBootstrap?.[2]?.[0] as MessagePort;
  backPort.start();
  backPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(screen.queryByTitle("Beta flow preview")).not.toBeInTheDocument());
  await waitFor(() => expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-page-b"));

  fireEvent.change(screen.getByRole("combobox", { name: "Prototype flow start Page" }), {
    target: { value: "page-b" },
  });
  const selectedBetaFrame = await screen.findByTitle("Beta flow preview") as HTMLIFrameElement;
  expect(screen.getByTitle("Alpha flow preview")).toBe(backFrame);
  const selectedBetaPostMessage = vi.spyOn(selectedBetaFrame.contentWindow!, "postMessage");
  fireEvent.load(selectedBetaFrame);
  const selectedBetaBootstrap = (selectedBetaPostMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const selectedBetaPort = selectedBetaBootstrap?.[2]?.[0] as MessagePort;
  selectedBetaPort.start();
  selectedBetaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(screen.queryByTitle("Alpha flow preview")).not.toBeInTheDocument());
  expect(resolvePreviewTarget).toHaveBeenLastCalledWith("project-flow", {
    kind: "workspace-flow",
    projectId: "project-flow",
    snapshotId: "snapshot-exact",
    startArtifactId: "page-b",
  }, expect.any(AbortSignal));
  await waitFor(() => expect(releasePreviewTargetLease.mock.calls.filter(([leaseId]) => leaseId === "lease-page-a")).toHaveLength(2));

  fireEvent.click(screen.getByRole("button", { name: "Close prototype flow" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  await waitFor(() => expect(releasePreviewTargetLease.mock.calls.filter(([leaseId]) => leaseId === "lease-page-b")).toHaveLength(2));
  port!.close();
  betaPort.close();
  backPort.close();
  selectedBetaPort.close();
});

test("applies and acknowledges the frozen default RenderSpec frame before declaring a Page prepared", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-page-a-default-frame",
        url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });

  await waitFor(() => expect(received.some((message) => message.type === "set-frame" && message.frameId === "desktop")).toBe(true));
  const command = received.find((message) => message.type === "set-frame" && message.frameId === "desktop")!;
  expect(command.frameAttemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  port.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: command.frameId,
    frameAttemptId: command.frameAttemptId,
  });
  port.close();
});

test("surfaces an initial bridge-readiness deadline instead of leaving the first Page silently unprepared", async () => {
  vi.useFakeTimers();
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-initial-unready",
        url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByTitle("Alpha flow preview")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  expect(screen.getByRole("alert")).toHaveTextContent("did not become ready");
  expect(screen.getByRole("button", { name: "Retry exact Page preparation" })).toBeEnabled();
});

test("surfaces one actionable failure when the initial exact Page resolves outside the frozen workspace", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => ({
        ...resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
        workspaceId: "workspace-drifted",
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("frozen Snapshot workspace");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Retry exact Page preparation" })).toBeEnabled();
});

test("surfaces a rejected initial RenderSpec frame and retries with a fresh exact Page", async () => {
  let leaseNumber = 0;
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-initial-reject-${++leaseNumber}`,
        url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const firstFrame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const firstPost = vi.spyOn(firstFrame.contentWindow!, "postMessage");
  fireEvent.load(firstFrame);
  const firstBootstrap = (firstPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const firstPort = firstBootstrap?.[2]?.[0] as MessagePort;
  const firstReceived: Array<Record<string, unknown>> = [];
  firstPort.onmessage = (event) => firstReceived.push(event.data as Record<string, unknown>);
  firstPort.start();
  firstPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(firstReceived.some((message) => message.type === "set-frame")).toBe(true));
  const rejected = firstReceived.find((message) => message.type === "set-frame")!;
  firstPort.postMessage({
    source: "dezin",
    type: "frame-rejected",
    nonce: NONCE,
    protocol: 1,
    frameId: rejected.frameId,
    frameAttemptId: rejected.frameAttemptId,
    reason: "fixture-contract-mismatch",
  });

  expect(await screen.findByRole("alert")).toHaveTextContent("fixture-contract-mismatch");
  fireEvent.click(screen.getByRole("button", { name: "Retry exact Page preparation" }));
  await waitFor(() => expect(screen.getByTitle("Alpha flow preview")).not.toBe(firstFrame));
  const retryFrame = screen.getByTitle("Alpha flow preview") as HTMLIFrameElement;
  const retryPost = vi.spyOn(retryFrame.contentWindow!, "postMessage");
  fireEvent.load(retryFrame);
  const retryBootstrap = (retryPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const retryPort = retryBootstrap?.[2]?.[0] as MessagePort;
  const retryReceived: Array<Record<string, unknown>> = [];
  retryPort.onmessage = (event) => retryReceived.push(event.data as Record<string, unknown>);
  retryPort.start();
  retryPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(retryReceived.some((message) => message.type === "set-frame")).toBe(true));
  const applied = retryReceived.find((message) => message.type === "set-frame")!;
  retryPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: applied.frameId,
    frameAttemptId: applied.frameAttemptId,
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  firstPort.close();
  retryPort.close();
});

test("cross-Page navigation keeps the current ready lease until the exact pending Page succeeds", async () => {
  let rejectPending!: (error: Error) => void;
  const pendingLease = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => exact.artifactId === "page-b"
        ? pendingLease
        : {
            leaseId: "lease-page-a",
            url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
            bridgeNonce: NONCE,
            expiresAt: Date.now() + 60_000,
            resolved: exact,
          },
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;
  port.postMessage({
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    ...binding,
  });

  await waitFor(() => expect(screen.getByRole("status", { name: "Preparing prototype navigation" })).toBeInTheDocument());
  expect(screen.getByTitle("Alpha flow preview")).toBeInTheDocument();
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a");

  rejectPending(new Error("Pending exact Page failed"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Pending exact Page failed");
  expect(screen.getByTitle("Alpha flow preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry prototype navigation" })).toBeEnabled();
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a");
  port.close();
});

test("cross-Page navigation times out an unready bridge, releases only the pending lease, and keeps the current Page", async () => {
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-${exact.artifactId}`,
        url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const bootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;

  vi.useFakeTimers();
  await act(async () => {
    port.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTitle("Beta flow preview")).toBeInTheDocument();
  expect(screen.getByTitle("Alpha flow preview")).toBe(alpha);

  await act(async () => {
    vi.advanceTimersByTime(5_001);
    await Promise.resolve();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("did not become ready");
  expect(screen.queryByTitle("Beta flow preview")).not.toBeInTheDocument();
  expect(screen.getByTitle("Alpha flow preview")).toBe(alpha);
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-page-b");
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a");
  port.close();
});

test("cross-Page navigation applies one five-second deadline across lease acquisition and bridge readiness", async () => {
  let resolvePendingLease!: (lease: {
    leaseId: string;
    url: string;
    bridgeNonce: string;
    expiresAt: number;
    resolved: ResolvedPreviewTarget;
  }) => void;
  const pendingLease = new Promise<{
    leaseId: string;
    url: string;
    bridgeNonce: string;
    expiresAt: number;
    resolved: ResolvedPreviewTarget;
  }>((resolve) => { resolvePendingLease = resolve; });
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => exact.artifactId === "page-b"
        ? pendingLease
        : {
            leaseId: "lease-page-a",
            url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
            bridgeNonce: NONCE,
            expiresAt: Date.now() + 60_000,
            resolved: exact,
          },
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const bootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;

  vi.useFakeTimers();
  await act(async () => {
    port.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("status", { name: "Preparing prototype navigation" })).toBeInTheDocument();

  await act(async () => {
    vi.advanceTimersByTime(4_000);
    await Promise.resolve();
  });
  resolvePendingLease({
    leaseId: "lease-page-b",
    url: `http://preview.local/page-b#dezin-bridge=${NONCE}`,
    bridgeNonce: NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: resolved({
      kind: "workspace-flow",
      projectId: "project-flow",
      snapshotId: session.snapshotId,
      startArtifactId: "page-b",
    }),
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTitle("Beta flow preview")).toBeInTheDocument();

  await act(async () => {
    vi.advanceTimersByTime(1_001);
    await Promise.resolve();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(/within 5 seconds|timed out/i);
  expect(screen.queryByTitle("Beta flow preview")).not.toBeInTheDocument();
  expect(screen.getByTitle("Alpha flow preview")).toBe(alpha);
  expect(screen.getByRole("button", { name: "Retry prototype navigation" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Prototype flow start Page" })).toBeEnabled();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-page-b");
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a");
  port.close();
});

test("same-Page targetState uses the exact target and acknowledged frame without reloading or releasing its lease", async () => {
  const snapshot = flowSnapshot();
  snapshot.graph.edges.unshift({
    id: "edge-same-page-state",
    workspaceId: snapshot.workspaceId,
    sourceNodeId: "node-a",
    targetNodeId: "node-a",
    kind: "prototype",
    prototype: {
      status: "interactive",
      binding: {
        sourceArtifactId: "page-a",
        sourceRevisionId: "revision-a",
        sourceLocator: { designNodeId: "show-confirmation" },
        trigger: "click",
        targetArtifactId: "page-a",
        targetState: "confirmed",
      },
    },
  });
  const session = createPrototypeFlowSession(snapshot, ["node-a"], flowRevisions());
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => (
    resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>)
  ));
  const acquirePreviewTargetLease = vi.fn(async (_projectId, exact) => ({
    leaseId: "lease-page-a",
    url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
    bridgeNonce: NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: exact,
  }));
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget,
      acquirePreviewTargetLease,
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const defaultFrame = received.find((message) => message.type === "set-frame" && message.frameId === "desktop")!;
  port.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: defaultFrame.frameId,
    frameAttemptId: defaultFrame.frameAttemptId,
  });
  const descriptor = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<{
    bindingId: string;
    locator: { designNodeId: string };
    trigger: "click";
  }>).find((binding) => binding.locator.designNodeId === "show-confirmation")!;
  port.postMessage({
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    ...descriptor,
  });

  await waitFor(() => expect(resolvePreviewTarget).toHaveBeenLastCalledWith("project-flow", {
    kind: "workspace-flow",
    projectId: "project-flow",
    snapshotId: "snapshot-exact",
    startArtifactId: "page-a",
    stateKey: "confirmed",
  }, expect.any(AbortSignal)));
  await waitFor(() => expect(received.some((message) => message.type === "set-frame" && message.initialState === "confirmed")).toBe(true));
  const confirmed = received.find((message) => message.type === "set-frame" && message.initialState === "confirmed")!;
  expect(confirmed.frameAttemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(screen.queryByText("State confirmed")).not.toBeInTheDocument();
  port.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: confirmed.frameId,
    frameAttemptId: confirmed.frameAttemptId,
  });
  expect(await screen.findByText("State confirmed")).toBeInTheDocument();
  expect(screen.getByTitle("Alpha flow preview")).toBe(frame);
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(releasePreviewTargetLease).not.toHaveBeenCalled();

  fireEvent.load(frame);
  const reconnectBootstrap = [...(postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>)].reverse().find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const reconnectPort = reconnectBootstrap?.[2]?.[0] as MessagePort;
  const reconnectReceived: Array<Record<string, unknown>> = [];
  reconnectPort.onmessage = (event) => reconnectReceived.push(event.data as Record<string, unknown>);
  reconnectPort.start();
  reconnectPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(reconnectReceived.some((message) => (
    message.type === "set-frame" && message.initialState === "confirmed"
  ))).toBe(true));
  const reapplied = reconnectReceived.find((message) => message.type === "set-frame" && message.initialState === "confirmed")!;
  expect(screen.getByText("State confirmed")).toBeInTheDocument();
  await act(async () => {
    reconnectPort.postMessage({
      source: "dezin",
      type: "frame-applied",
      nonce: NONCE,
      protocol: 1,
      frameId: reapplied.frameId,
      frameAttemptId: reapplied.frameAttemptId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  fireEvent.click(screen.getByRole("button", { name: "Back in prototype flow" }));
  await waitFor(() => expect(reconnectReceived.some((message) => message.type === "set-frame" && message.frameId === "desktop")).toBe(true));
  const reset = [...reconnectReceived].reverse().find((message) => message.type === "set-frame" && message.frameId === "desktop")!;
  reconnectPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: reset.frameId,
    frameAttemptId: reset.frameAttemptId,
  });
  await waitFor(() => expect(screen.queryByText("State confirmed")).not.toBeInTheDocument());
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(releasePreviewTargetLease).not.toHaveBeenCalled();
  port.close();
  reconnectPort.close();
});

test("replays an unacknowledged targetState after a bridge reconnect instead of failing the navigation", async () => {
  const snapshot = flowSnapshot();
  snapshot.graph.edges.unshift({
    id: "edge-reconnect-state",
    workspaceId: snapshot.workspaceId,
    sourceNodeId: "node-a",
    targetNodeId: "node-a",
    kind: "prototype",
    prototype: {
      status: "interactive",
      binding: {
        sourceArtifactId: "page-a",
        sourceRevisionId: "revision-a",
        sourceLocator: { designNodeId: "show-confirmation" },
        trigger: "click",
        targetArtifactId: "page-a",
        targetState: "confirmed",
      },
    },
  });
  const session = createPrototypeFlowSession(snapshot, ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-reconnect-state",
        url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const firstBootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const firstPort = firstBootstrap?.[2]?.[0] as MessagePort;
  const firstReceived: Array<Record<string, unknown>> = [];
  firstPort.onmessage = (event) => firstReceived.push(event.data as Record<string, unknown>);
  firstPort.start();
  firstPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(firstReceived.some((message) => message.type === "set-prototype-bindings")).toBe(true));

  const initialFrame = firstReceived.find((message) => message.type === "set-frame" && message.frameId === "desktop");
  if (initialFrame !== undefined) {
    firstPort.postMessage({
      source: "dezin",
      type: "frame-applied",
      nonce: NONCE,
      protocol: 1,
      frameId: initialFrame.frameId,
      frameAttemptId: initialFrame.frameAttemptId,
    });
  }
  const descriptor = (firstReceived.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<{
    locator: { designNodeId: string };
  }>).find((binding) => binding.locator.designNodeId === "show-confirmation")!;
  firstPort.postMessage({
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    ...descriptor,
  });
  await waitFor(() => expect(firstReceived.some((message) => message.type === "set-frame" && message.initialState === "confirmed")).toBe(true));

  fireEvent.load(frame);
  const reconnectBootstrap = [...(postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>)].reverse().find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const reconnectPort = reconnectBootstrap?.[2]?.[0] as MessagePort;
  const reconnectReceived: Array<Record<string, unknown>> = [];
  reconnectPort.onmessage = (event) => reconnectReceived.push(event.data as Record<string, unknown>);
  reconnectPort.start();
  reconnectPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });

  await waitFor(() => expect(reconnectReceived.some((message) => (
    message.type === "set-frame" && message.initialState === "confirmed"
  ))).toBe(true));
  expect(screen.queryByRole("alert")).toBeNull();
  const replay = reconnectReceived.find((message) => message.type === "set-frame" && message.initialState === "confirmed")!;
  reconnectPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: replay.frameId,
    frameAttemptId: replay.frameAttemptId,
  });
  expect(await screen.findByText("State confirmed")).toBeInTheDocument();
  firstPort.close();
  reconnectPort.close();
});

test("commits a pending cross-Page swap after its default frame is replayed on reconnect", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-cross-page-reconnect-${exact.artifactId}`,
        url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const alphaBootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const alphaPort = alphaBootstrap?.[2]?.[0] as MessagePort;
  const alphaReceived: Array<Record<string, unknown>> = [];
  alphaPort.onmessage = (event) => alphaReceived.push(event.data as Record<string, unknown>);
  alphaPort.start();
  alphaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(alphaReceived.some((message) => message.type === "set-frame")).toBe(true));
  const alphaFrame = alphaReceived.find((message) => message.type === "set-frame")!;
  alphaPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: alphaFrame.frameId,
    frameAttemptId: alphaFrame.frameAttemptId,
  });
  await waitFor(() => expect(alphaReceived.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (alphaReceived.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;
  alphaPort.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });

  const beta = await screen.findByTitle("Beta flow preview") as HTMLIFrameElement;
  const betaPost = vi.spyOn(beta.contentWindow!, "postMessage");
  fireEvent.load(beta);
  const firstBootstrap = (betaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const firstPort = firstBootstrap?.[2]?.[0] as MessagePort;
  const firstReceived: Array<Record<string, unknown>> = [];
  firstPort.onmessage = (event) => firstReceived.push(event.data as Record<string, unknown>);
  firstPort.start();
  firstPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(firstReceived.some((message) => message.type === "set-frame")).toBe(true));
  const firstAttempt = firstReceived.find((message) => message.type === "set-frame")!;

  fireEvent.load(beta);
  const reconnectBootstrap = [...(betaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>)].reverse().find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const reconnectPort = reconnectBootstrap?.[2]?.[0] as MessagePort;
  const reconnectReceived: Array<Record<string, unknown>> = [];
  reconnectPort.onmessage = (event) => reconnectReceived.push(event.data as Record<string, unknown>);
  reconnectPort.start();
  reconnectPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(reconnectReceived.some((message) => message.type === "set-frame")).toBe(true));
  const replay = reconnectReceived.find((message) => message.type === "set-frame")!;
  expect(replay.frameAttemptId).not.toBe(firstAttempt.frameAttemptId);
  reconnectPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: replay.frameId,
    frameAttemptId: replay.frameAttemptId,
  });

  await waitFor(() => expect(screen.getByLabelText("Frozen prototype identity")).toHaveTextContent("Beta"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTitle("Alpha flow preview")).not.toBeInTheDocument();
  alphaPort.close();
  firstPort.close();
  reconnectPort.close();
});

test("rejects a cross-Page resolution whose RenderSpec drifts from the frozen Snapshot", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  const acquirePreviewTargetLease = vi.fn(async (_projectId, exact: ResolvedPreviewTarget) => ({
    leaseId: `lease-render-spec-${exact.artifactId}`,
    url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
    bridgeNonce: NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: exact,
  }));
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => {
        const exact = resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>);
        return exact.artifactId === "page-b"
          ? {
              ...exact,
              renderSpec: {
                frames: [{ id: "desktop", name: "Tampered", width: 320, height: 200 }],
              },
            }
          : exact;
      },
      acquirePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-frame")).toBe(true));
  const initialFrame = received.find((message) => message.type === "set-frame")!;
  port.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: initialFrame.frameId,
    frameAttemptId: initialFrame.frameAttemptId,
  });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;
  port.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });

  expect(await screen.findByRole("alert")).toHaveTextContent("frozen Snapshot RenderSpec");
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(screen.getByTitle("Alpha flow preview")).toBeInTheDocument();
  expect(screen.queryByTitle("Beta flow preview")).toBeNull();
  port.close();
});

test("moves keyboard focus into the newly committed Page after an atomic cross-Page swap", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"]);
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-focus-${exact.artifactId}`,
        url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const alphaBootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const alphaPort = alphaBootstrap?.[2]?.[0] as MessagePort;
  const alphaReceived: Array<Record<string, unknown>> = [];
  alphaPort.onmessage = (event) => alphaReceived.push(event.data as Record<string, unknown>);
  alphaPort.start();
  alphaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(alphaReceived.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (alphaReceived.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;
  alphaPort.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });

  const beta = await screen.findByTitle("Beta flow preview") as HTMLIFrameElement;
  const betaPost = vi.spyOn(beta.contentWindow!, "postMessage");
  fireEvent.load(beta);
  const betaBootstrap = (betaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const betaPort = betaBootstrap?.[2]?.[0] as MessagePort;
  const focusBeta = beta.focus.bind(beta);
  vi.spyOn(beta, "focus").mockImplementation(() => {
    // Chromium drops focus when React moves the pending iframe ahead of the
    // outgoing iframe. A pre-commit focus therefore cannot survive the swap.
    if (screen.queryByTitle("Alpha flow preview") === null) focusBeta();
  });
  betaPort.start();
  betaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });

  await waitFor(() => expect(screen.getByLabelText("Frozen prototype identity")).toHaveTextContent("Beta"));
  await waitFor(() => expect(beta).toHaveFocus());
  alphaPort.close();
  betaPort.close();
});

test("same-Page resolution that ignores abort still fails within the shared five-second deadline", async () => {
  const snapshot = flowSnapshot();
  snapshot.graph.edges.unshift({
    id: "edge-same-page-timeout",
    workspaceId: snapshot.workspaceId,
    sourceNodeId: "node-a",
    targetNodeId: "node-a",
    kind: "prototype",
    prototype: {
      status: "interactive",
      binding: {
        sourceArtifactId: "page-a",
        sourceRevisionId: "revision-a",
        sourceLocator: { designNodeId: "show-confirmation" },
        trigger: "click",
        targetArtifactId: "page-a",
        targetState: "confirmed",
      },
    },
  });
  const session = createPrototypeFlowSession(snapshot, ["node-a"], flowRevisions());
  const hungResolution = new Promise<ResolvedPreviewTarget>(() => {});
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => {
    if (target.kind !== "workspace-flow") throw new Error("exact flow target required");
    return target.stateKey === "confirmed" ? hungResolution : resolved(target);
  });
  const acquirePreviewTargetLease = vi.fn(async (_projectId, exact) => ({
    leaseId: "lease-page-a",
    url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
    bridgeNonce: NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: exact,
  }));
  render(
    <ApiProvider client={makeFakeApi({ resolvePreviewTarget, acquirePreviewTargetLease })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const frame = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const descriptor = (received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<{
    locator: { designNodeId: string };
  }>).find((binding) => binding.locator.designNodeId === "show-confirmation")!;

  vi.useFakeTimers();
  await act(async () => {
    port.postMessage({
      source: "dezin",
      type: "prototype-binding-activated",
      nonce: NONCE,
      protocol: 1,
      ...descriptor,
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("status", { name: "Preparing prototype navigation" })).toBeInTheDocument();

  await act(async () => {
    vi.advanceTimersByTime(5_001);
    await Promise.resolve();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("within 5 seconds");
  expect(screen.getByTitle("Alpha flow preview")).toBe(frame);
  expect(screen.getByRole("button", { name: "Retry prototype navigation" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Prototype flow start Page" })).toBeEnabled();
  expect(acquirePreviewTargetLease).toHaveBeenCalledTimes(1);
  port.close();
});

test("cross-Page targetState swaps atomically only after the pending frame acknowledgement", async () => {
  const snapshot = flowSnapshot();
  const edge = snapshot.graph.edges.find((candidate) => candidate.id === "edge-click");
  if (edge?.kind !== "prototype" || edge.prototype.status !== "interactive") throw new Error("interactive fixture required");
  edge.prototype.binding.targetState = "receipt-ready";
  const session = createPrototypeFlowSession(snapshot, ["node-a"], flowRevisions());
  const releasePreviewTargetLease = vi.fn(async (_leaseId: string) => {});
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: `lease-${exact.artifactId}-${exact.stateKey ?? "default"}`,
        url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
      releasePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const alphaBootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const alphaPort = alphaBootstrap?.[2]?.[0] as MessagePort;
  const alphaReceived: Array<Record<string, unknown>> = [];
  alphaPort.onmessage = (event) => alphaReceived.push(event.data as Record<string, unknown>);
  alphaPort.start();
  alphaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(alphaReceived.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const binding = (alphaReceived.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<Record<string, unknown>>)[0]!;
  alphaPort.postMessage({ source: "dezin", type: "prototype-binding-activated", nonce: NONCE, protocol: 1, ...binding });

  const beta = await screen.findByTitle("Beta flow preview") as HTMLIFrameElement;
  expect(screen.getByLabelText("Frozen prototype identity")).toHaveTextContent("Alpha");
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a-default");
  const betaPost = vi.spyOn(beta.contentWindow!, "postMessage");
  fireEvent.load(beta);
  const betaBootstrap = (betaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const betaPort = betaBootstrap?.[2]?.[0] as MessagePort;
  const betaReceived: Array<Record<string, unknown>> = [];
  betaPort.onmessage = (event) => betaReceived.push(event.data as Record<string, unknown>);
  betaPort.start();
  betaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(betaReceived.some((message) => message.type === "set-frame" && message.initialState === "receipt-ready")).toBe(true));
  const stateCommand = betaReceived.find((message) => message.type === "set-frame" && message.initialState === "receipt-ready")!;
  expect(screen.getByLabelText("Frozen prototype identity")).toHaveTextContent("Alpha");
  expect(releasePreviewTargetLease).not.toHaveBeenCalledWith("lease-page-a-default");
  betaPort.postMessage({
    source: "dezin",
    type: "frame-applied",
    nonce: NONCE,
    protocol: 1,
    frameId: stateCommand.frameId,
    frameAttemptId: stateCommand.frameAttemptId,
  });

  expect(await screen.findByText("State receipt-ready")).toBeInTheDocument();
  await waitFor(() => expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-page-a-default"));
  expect(screen.getByLabelText("Frozen prototype identity")).toHaveTextContent("Beta");
  alphaPort.close();
  betaPort.close();
});

test("viewer blocks broken and malformed bridge activations and lists planned flow health", async () => {
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"]);
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-page-a",
        url: `http://preview.local/page-a#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  expect(await screen.findByText("Planned connection")).toBeInTheDocument();
  expect(screen.getByText("Missing destination binding.")).toBeInTheDocument();
  const frame = screen.getByTitle("Alpha flow preview") as HTMLIFrameElement;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  const bootstrap = (postMessage.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const port = bootstrap?.[2]?.[0] as MessagePort;
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  port.start();
  port.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(received.some((message) => message.type === "set-prototype-bindings")).toBe(true));
  const bindings = received.find((message) => message.type === "set-prototype-bindings")!.bindings as Array<{
    bindingId: string;
    locator: { designNodeId: string };
    trigger: "click" | "submit";
  }>;
  const brokenBindingId = Object.entries(session.bindingEdgeIds).find(([, edgeId]) => edgeId === "edge-broken")?.[0];
  expect(brokenBindingId).toBeDefined();

  port.postMessage({
    source: "dezin",
    type: "prototype-binding-activated",
    nonce: NONCE,
    protocol: 1,
    bindingId: brokenBindingId,
    locator: { designNodeId: "broken-action" },
    trigger: "click",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Missing destination binding.");

  await act(async () => {
    port.postMessage({
      source: "dezin",
      type: "prototype-binding-activated",
      nonce: NONCE,
      protocol: 1,
      ...bindings[0],
      targetUrl: "https://attacker.invalid",
    });
  });
  expect(screen.getByTitle("Alpha flow preview")).toBeInTheDocument();
  port.close();
});

test("viewer rejects a workspace-flow resolution that drifts from the frozen artifact Revision", async () => {
  const acquirePreviewTargetLease = vi.fn();
  const session = createPrototypeFlowSession(flowSnapshot(), ["node-a"]);
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => ({
        ...resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
        revisionId: "revision-head-drifted",
      }),
      acquirePreviewTargetLease,
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("frozen Snapshot Revision");
  expect(acquirePreviewTargetLease).not.toHaveBeenCalled();
});

test("viewer renders a controlled blocked state instead of crashing above the binding command limit", async () => {
  const oversized = flowSnapshot();
  const template = oversized.graph.edges[0];
  if (template?.kind !== "prototype" || template.prototype.status !== "interactive") {
    throw new Error("interactive fixture required");
  }
  const binding = template.prototype.binding;
  oversized.graph.edges = Array.from({ length: 65 }, (_, index) => ({
    id: `edge-${index}`,
    workspaceId: template.workspaceId,
    sourceNodeId: template.sourceNodeId,
    targetNodeId: template.targetNodeId,
    kind: "prototype" as const,
    prototype: {
      status: "interactive" as const,
      binding: {
        sourceArtifactId: binding.sourceArtifactId,
        sourceRevisionId: binding.sourceRevisionId,
        sourceLocator: { designNodeId: `action-${index}` },
        trigger: binding.trigger,
        targetArtifactId: binding.targetArtifactId,
        targetState: binding.targetState,
        transition: binding.transition,
      },
    },
  }));
  const session = createPrototypeFlowSession(oversized, ["node-a"]);

  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async (_projectId, target) => resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>),
      acquirePreviewTargetLease: async (_projectId, exact) => ({
        leaseId: "lease-oversized",
        url: `http://preview.local/oversized#dezin-bridge=${NONCE}`,
        bridgeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        resolved: exact,
      }),
    })}>
      <PrototypeFlowViewer projectId="project-flow" session={session} onClose={vi.fn()} />
    </ApiProvider>,
  );

  expect(await screen.findByTitle("Alpha flow preview")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("at most 64 bindings");
  expect(screen.getByText("0 live · 0 planned · 65 broken")).toBeInTheDocument();
  expect(screen.getAllByText("This Page exceeds the 64 interactive binding limit.")).toHaveLength(65);
});

test("viewer resets its Page history when its frozen session prop changes", async () => {
  const first = createPrototypeFlowSession(flowSnapshot(), ["node-a"], flowRevisions());
  const nextSnapshot = flowSnapshot();
  nextSnapshot.id = "snapshot-next";
  const next = createPrototypeFlowSession(nextSnapshot, ["node-b"], flowRevisions());
  const resolvePreviewTarget = vi.fn(async (_projectId: string, target: PreviewTarget) => (
    resolved(target as Extract<PreviewTarget, { kind: "workspace-flow" }>)
  ));
  const client = makeFakeApi({
    resolvePreviewTarget,
    acquirePreviewTargetLease: async (_projectId, exact) => ({
      leaseId: `lease-${exact.snapshotId}-${exact.artifactId}`,
      url: `http://preview.local/${exact.artifactId}#dezin-bridge=${NONCE}`,
      bridgeNonce: NONCE,
      expiresAt: Date.now() + 60_000,
      resolved: exact,
    }),
  });
  const view = render(
    <ApiProvider client={client}>
      <PrototypeFlowViewer projectId="project-flow" session={first} onClose={vi.fn()} />
    </ApiProvider>,
  );
  const alpha = await screen.findByTitle("Alpha flow preview") as HTMLIFrameElement;
  const alphaPost = vi.spyOn(alpha.contentWindow!, "postMessage");
  fireEvent.load(alpha);
  const alphaBootstrap = (alphaPost.mock.calls as unknown as Array<[unknown, unknown, Transferable[]?]>).find(
    ([message]) => (message as { type?: string }).type === "bridge-init",
  );
  const alphaPort = alphaBootstrap?.[2]?.[0] as MessagePort;
  const alphaReceived: Array<Record<string, unknown>> = [];
  alphaPort.onmessage = (event) => alphaReceived.push(event.data as Record<string, unknown>);
  alphaPort.start();
  alphaPort.postMessage({ source: "dezin", type: "bridge-ready", nonce: NONCE, protocol: 1 });
  await waitFor(() => expect(alphaReceived.some((message) => message.type === "set-frame")).toBe(true));
  const staleFrame = alphaReceived.find((message) => message.type === "set-frame")!;

  view.rerender(
    <ApiProvider client={client}>
      <PrototypeFlowViewer projectId="project-flow" session={next} onClose={vi.fn()} />
    </ApiProvider>,
  );

  expect(await screen.findByTitle("Beta flow preview")).toBeInTheDocument();
  expect(resolvePreviewTarget).toHaveBeenLastCalledWith("project-flow", {
    kind: "workspace-flow",
    projectId: "project-flow",
    snapshotId: "snapshot-next",
    startArtifactId: "page-b",
  }, expect.any(AbortSignal));
  expect(resolvePreviewTarget.mock.calls.some(([, target]) => (
    target.kind === "workspace-flow"
      && target.snapshotId === "snapshot-next"
      && target.startArtifactId === "page-a"
  ))).toBe(false);
  alphaPort.postMessage({
    source: "dezin",
    type: "frame-rejected",
    nonce: NONCE,
    protocol: 1,
    frameId: staleFrame.frameId,
    frameAttemptId: staleFrame.frameAttemptId,
    reason: "stale-session-error",
  });
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText("stale-session-error")).toBeNull();
  expect(screen.getByTitle("Beta flow preview")).toBeInTheDocument();
  alphaPort.close();
});

test("flow viewer keeps its toolbar bounded at 320px and disables motion when requested", () => {
  const css = readFileSync(`${process.cwd()}/src/project-studio/flow/prototype-flow-viewer.css`, "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 420px)"));
  expect(narrow).toContain(".prototype-flow-viewer__controls");
  expect(narrow).toMatch(/min-width:\s*0/);
  expect(narrow).toContain(".prototype-flow-viewer__back-label");
  expect(narrow).toMatch(/display:\s*none/);
  expect(narrow).toMatch(/select\s*\{[^}]*max-width:/s);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/);
  expect(css).toMatch(/:focus-visible[\s\S]*outline:/);
});
