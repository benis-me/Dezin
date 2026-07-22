import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiProvider } from "../lib/api-context.tsx";
import {
  createApiClient,
  type PreviewTarget,
  type PreviewTargetLease,
  type ResolvedPreviewTarget,
} from "../lib/api.ts";
import { makeFakeApi } from "../test/fake-api.ts";
import { useArtifactPreview } from "./artifact/useArtifactPreview.ts";

const BRIDGE_NONCE = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";

function resolved(artifactId: string, revisionId: string): ResolvedPreviewTarget {
  return {
    version: 1,
    targetKey: `artifact:${artifactId}:${revisionId}`,
    requestedKind: "artifact-current",
    projectId: "project-1",
    workspaceId: "workspace-1",
    artifactId,
    artifactKind: "page",
    revisionId,
    trackId: "track-1",
    snapshotId: "snapshot-1",
    sourceCommitHash: `commit-${revisionId}`,
    sourceTreeHash: `tree-${revisionId}`,
    dependencyLockHash: `dependencies-${revisionId}`,
    assemblyHash: `assembly-${revisionId}`,
    artifactRoot: `artifacts/${artifactId}`,
    renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }] },
    variantKey: null,
    stateKey: null,
    runId: null,
  };
}

function lease(value: ResolvedPreviewTarget, leaseId = `lease-${value.revisionId}`): PreviewTargetLease {
  return {
    leaseId,
    url: `http://preview.local/${value.revisionId}#dezin-bridge=${BRIDGE_NONCE}`,
    bridgeNonce: BRIDGE_NONCE,
    expiresAt: Date.now() + 60_000,
    resolved: value,
  };
}

function PreviewProbe({
  projectId,
  target,
  expectedArtifactId,
  expectedWorkspaceId,
  expectedRenderSpec,
}: {
  projectId: string;
  target: PreviewTarget;
  expectedArtifactId?: string;
  expectedWorkspaceId?: string;
  expectedRenderSpec?: Readonly<Record<string, unknown>>;
}) {
  const preview = useArtifactPreview({
    projectId,
    target,
    expectedArtifactId,
    expectedWorkspaceId,
    expectedRenderSpec,
  });
  return (
    <output aria-label="Preview state" data-status={preview.status}>
      {preview.status === "ready"
        ? `${preview.resolved.revisionId}:${preview.lease.leaseId}`
        : preview.status === "error"
          ? preview.error
          : preview.status}
    </output>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("resolves current before acquiring a lease for that exact immutable revision", async () => {
  const calls: string[] = [];
  const first = resolved("artifact-1", "revision-1");
  const api = makeFakeApi({
    resolvePreviewTarget: async (_projectId, target) => {
      calls.push(`resolve:${target.kind}`);
      return first;
    },
    acquirePreviewTargetLease: async (_projectId, target) => {
      calls.push(`acquire:${target.revisionId}`);
      return lease(target);
    },
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("revision-1:lease-revision-1")).toBeInTheDocument();
  expect(calls).toEqual(["resolve:artifact-current", "acquire:revision-1"]);
});

test("releases a stale acquired lease and never lets an older target replace the active preview", async () => {
  let finishFirstAcquire!: (value: PreviewTargetLease) => void;
  const firstAcquire = new Promise<PreviewTargetLease>((resolve) => { finishFirstAcquire = resolve; });
  let firstResolveSignal: AbortSignal | undefined;
  let firstAcquireSignal: AbortSignal | undefined;
  const first = resolved("artifact-1", "revision-1");
  const second = resolved("artifact-2", "revision-2");
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async (_projectId, target, signal) => {
      if (target.kind === "artifact-current" && target.artifactId === "artifact-1") {
        firstResolveSignal = signal;
        return first;
      }
      return second;
    },
    acquirePreviewTargetLease: async (_projectId, target, signal) => {
      if (target.revisionId === "revision-1") {
        firstAcquireSignal = signal;
        return firstAcquire;
      }
      return lease(second);
    },
    releasePreviewTargetLease,
  });

  const { rerender, unmount } = render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  await act(async () => { await Promise.resolve(); });
  expect(firstResolveSignal).toBeInstanceOf(AbortSignal);
  expect(firstAcquireSignal).toBe(firstResolveSignal);
  expect(firstAcquireSignal?.aborted).toBe(false);
  rerender(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-2" }}
      />
    </ApiProvider>,
  );
  expect(firstAcquireSignal?.aborted).toBe(true);
  expect(await screen.findByText("revision-2:lease-revision-2")).toBeInTheDocument();

  await act(async () => {
    finishFirstAcquire(lease(first, "lease-stale"));
    await firstAcquire;
  });
  expect(screen.getByText("revision-2:lease-revision-2")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-stale");

  unmount();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-2");
});

test("renews an owned target lease and releases it on project change", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
  const resolvedOne = resolved("artifact-1", "revision-1");
  const resolvedTwo = { ...resolved("artifact-2", "revision-2"), projectId: "project-2", workspaceId: "workspace-2" };
  const renewPreviewTargetLease = vi.fn(async (leaseId: string) => ({
    leaseId,
    url: `http://preview.local/revision-1#dezin-bridge=${BRIDGE_NONCE}`,
    bridgeNonce: BRIDGE_NONCE,
    expiresAt: Date.now() + 60_000,
  }));
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async (projectId) => projectId === "project-1" ? resolvedOne : resolvedTwo,
    acquirePreviewTargetLease: async (_projectId, target) => ({
      ...lease(target),
      expiresAt: Date.now() + 100,
    }),
    renewPreviewTargetLease,
    releasePreviewTargetLease,
  });

  const { rerender } = render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByLabelText("Preview state")).toHaveAttribute("data-status", "ready");

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(renewPreviewTargetLease).toHaveBeenCalledWith("lease-revision-1", expect.any(AbortSignal));

  rerender(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-2"
        target={{ kind: "artifact-current", projectId: "project-2", artifactId: "artifact-2" }}
      />
    </ApiProvider>,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-1");
  expect(screen.getByText("revision-2:lease-revision-2")).toBeInTheDocument();
});

test("fails closed when renewal rotates the bridge capability", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
  const current = resolved("artifact-1", "revision-1");
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async () => current,
    acquirePreviewTargetLease: async (_projectId, target) => ({
      ...lease(target),
      expiresAt: Date.now() + 100,
    }),
    renewPreviewTargetLease: async (leaseId) => ({
      leaseId,
      url: "http://preview.local/revision-1#dezin-bridge=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789",
      bridgeNonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789",
      expiresAt: Date.now() + 60_000,
    }),
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(screen.getByText("Renewed preview lease changed its bridge capability.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-1");
});

test("expires an owned target lease even when renewal never settles", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
  const current = resolved("artifact-1", "revision-1");
  const releasePreviewTargetLease = vi.fn(async () => {});
  let renewalSignal: AbortSignal | undefined;
  const renewPreviewTargetLease = vi.fn((_leaseId: string, signal?: AbortSignal) => {
    renewalSignal = signal;
    return new Promise<never>(() => {});
  });
  const api = makeFakeApi({
    resolvePreviewTarget: async () => current,
    acquirePreviewTargetLease: async (_projectId, target) => ({
      ...lease(target),
      expiresAt: Date.now() + 100,
    }),
    renewPreviewTargetLease,
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByLabelText("Preview state")).toHaveAttribute("data-status", "ready");

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(renewPreviewTargetLease).toHaveBeenCalledWith("lease-revision-1", expect.any(AbortSignal));
  expect(screen.getByText("Preview lease expired before renewal completed.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-1");
  expect(renewalSignal?.aborted).toBe(true);
});

test("rejects an acquired lease whose explicit nonce does not match its URL fragment", async () => {
  const current = resolved("artifact-1", "revision-1");
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async () => current,
    acquirePreviewTargetLease: async (_projectId, target) => ({
      ...lease(target),
      bridgeNonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456789",
    }),
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Preview bridge capability does not match the leased URL.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-1");
});

test("rejects a structurally invalid acquired bridge capability instead of treating two missing nonces as equal", async () => {
  const current = resolved("artifact-1", "revision-1");
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async () => current,
    acquirePreviewTargetLease: async (_projectId, target) => ({
      ...lease(target),
      url: "http://preview.local/revision-1",
      bridgeNonce: null,
    } as unknown as PreviewTargetLease),
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Preview bridge capability is missing or invalid.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-revision-1");
});

test("rejects a resolved preview that does not belong to the Artifact route before acquire", async () => {
  const wrongArtifact = resolved("artifact-2", "revision-2");
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, value: ResolvedPreviewTarget) => lease(value));
  const api = makeFakeApi({
    resolvePreviewTarget: async () => wrongArtifact,
    acquirePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        expectedArtifactId="artifact-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Resolved preview belongs to a different artifact.")).toBeInTheDocument();
  expect(acquirePreviewTargetLease).not.toHaveBeenCalled();
});

test("rejects a resolved preview outside the frozen Snapshot workspace before acquire", async () => {
  const current = resolved("artifact-1", "revision-1");
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, value: ResolvedPreviewTarget) => lease(value));
  render(
    <ApiProvider client={makeFakeApi({
      resolvePreviewTarget: async () => current,
      acquirePreviewTargetLease,
    })}>
      <PreviewProbe
        projectId="project-1"
        expectedWorkspaceId="workspace-frozen"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Resolved preview does not match the frozen Snapshot workspace.")).toBeInTheDocument();
  expect(acquirePreviewTargetLease).not.toHaveBeenCalled();
});

test("rejects a current preview resolved from a different requested track before acquire", async () => {
  const wrongTrack = { ...resolved("artifact-1", "revision-1"), trackId: "track-2" };
  const acquirePreviewTargetLease = vi.fn(async (_projectId: string, value: ResolvedPreviewTarget) => lease(value));
  const api = makeFakeApi({
    resolvePreviewTarget: async () => wrongTrack,
    acquirePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        expectedArtifactId="artifact-1"
        target={{
          kind: "artifact-current",
          projectId: "project-1",
          artifactId: "artifact-1",
          trackId: "track-1",
        }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Resolved preview track does not match the requested target.")).toBeInTheDocument();
  expect(acquirePreviewTargetLease).not.toHaveBeenCalled();
});

test("releases an acquired lease whose immutable identity differs from the resolved target", async () => {
  const first = resolved("artifact-1", "revision-1");
  const changed = { ...first, assemblyHash: "assembly-tampered" };
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async () => first,
    acquirePreviewTargetLease: async () => lease(changed, "lease-mismatched"),
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        expectedArtifactId="artifact-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Acquired preview identity does not match the resolved target.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-mismatched");
});

test("rejects an acquired lease whose render spec differs despite an unchanged assembly hash", async () => {
  const first = resolved("artifact-1", "revision-1");
  const changed = {
    ...first,
    renderSpec: {
      frames: [{ id: "desktop", name: "Desktop", width: 1024, height: 768 }],
    },
  };
  const releasePreviewTargetLease = vi.fn(async () => {});
  const api = makeFakeApi({
    resolvePreviewTarget: async () => first,
    acquirePreviewTargetLease: async () => lease(changed, "lease-render-spec-mismatched"),
    releasePreviewTargetLease,
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        expectedArtifactId="artifact-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Acquired preview identity does not match the resolved target.")).toBeInTheDocument();
  expect(releasePreviewTargetLease).toHaveBeenCalledTimes(1);
  expect(releasePreviewTargetLease).toHaveBeenCalledWith("lease-render-spec-mismatched");
});

test("accepts the same render spec when JSON object keys arrive in a different order", async () => {
  const first = {
    ...resolved("artifact-1", "revision-1"),
    renderSpec: {
      frames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
      options: { background: "#fff", mode: "fit" },
    },
  };
  const reordered = {
    ...first,
    renderSpec: {
      options: { mode: "fit", background: "#fff" },
      frames: [{ height: 900, width: 1440, name: "Desktop", id: "desktop" }],
    },
  };
  const api = makeFakeApi({
    resolvePreviewTarget: async () => first,
    acquirePreviewTargetLease: async () => lease(reordered, "lease-reordered-render-spec"),
  });

  render(
    <ApiProvider client={api}>
      <PreviewProbe
        projectId="project-1"
        expectedArtifactId="artifact-1"
        target={{ kind: "artifact-current", projectId: "project-1", artifactId: "artifact-1" }}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("revision-1:lease-reordered-render-spec")).toBeInTheDocument();
});

test("the typed client uses project-scoped resolve/acquire and exact lease lifecycle routes", async () => {
  const immutable = resolved("artifact / one", "revision-1");
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/resolve")) return new Response(JSON.stringify({ resolved: immutable }), { status: 200 });
    if (url.endsWith("/leases")) return new Response(JSON.stringify(lease(immutable)), { status: 201 });
    if ((init?.method ?? "GET") === "PATCH") {
      return new Response(JSON.stringify({
        leaseId: "lease-1",
        url: `http://preview.local/#dezin-bridge=${BRIDGE_NONCE}`,
        bridgeNonce: BRIDGE_NONCE,
        expiresAt: 2,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ released: true }), { status: 200 });
  });
  const client = createApiClient({ baseUrl: "http://daemon.local", fetchImpl });
  const target: PreviewTarget = { kind: "artifact-current", projectId: "project / one", artifactId: "artifact / one" };
  const acquisitionController = new AbortController();
  const renewController = new AbortController();

  expect(await client.resolvePreviewTarget("project / one", target, acquisitionController.signal)).toEqual(immutable);
  expect((await client.acquirePreviewTargetLease("project / one", immutable, acquisitionController.signal)).resolved).toEqual(immutable);
  await client.renewPreviewTargetLease("lease / one", renewController.signal);
  await client.releasePreviewTargetLease("lease / one");

  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://daemon.local/api/projects/project%20%2F%20one/preview-targets/resolve",
    expect.objectContaining({ method: "POST", signal: acquisitionController.signal }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://daemon.local/api/projects/project%20%2F%20one/preview-targets/leases",
    expect.objectContaining({ method: "POST", signal: acquisitionController.signal }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    3,
    "http://daemon.local/api/preview-leases/lease%20%2F%20one",
    expect.objectContaining({ method: "PATCH", signal: renewController.signal }),
  );

  expect(requests).toEqual([
    {
      url: "http://daemon.local/api/projects/project%20%2F%20one/preview-targets/resolve",
      method: "POST",
      body: { target },
    },
    {
      url: "http://daemon.local/api/projects/project%20%2F%20one/preview-targets/leases",
      method: "POST",
      body: { resolved: immutable },
    },
    {
      url: "http://daemon.local/api/preview-leases/lease%20%2F%20one",
      method: "PATCH",
      body: null,
    },
    {
      url: "http://daemon.local/api/preview-leases/lease%20%2F%20one",
      method: "DELETE",
      body: null,
    },
  ]);
});
