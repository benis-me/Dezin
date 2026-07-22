import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ApiProvider } from "../../lib/api-context.tsx";
import type { Resource, ResourceRevision, ResourceRevisionView } from "../../lib/api.ts";
import { makeFakeApi } from "../../test/fake-api.ts";
import {
  ResourceEditorSurface,
  ResourceRevisionBody,
  useResourceEditorController,
} from "./ResourceEditorSurface.tsx";
import { ResourceRevisionHistory } from "./ResourceRevisionHistory.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const resource: Resource = {
  id: "resource-file",
  workspaceId: "workspace-1",
  kind: "file",
  title: "Voice and tone notes",
  headRevisionId: "revision-2",
  defaultPinPolicy: "follow-head",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
};

const identity = {
  id: "revision-2",
  workspaceId: resource.workspaceId,
  resourceId: resource.id,
  sequence: 2,
  parentRevisionId: "revision-1",
  summary: "Frozen content reference",
  checksum: "a".repeat(64),
  createdAt: 2,
};

const payload = {
  mimeType: "text/plain",
  byteLength: 42,
  checksum: "a".repeat(64),
  previewKind: "text" as const,
  url: null,
  downloadUrl: "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload",
};

const fileView: ResourceRevisionView = {
  protocol: "dezin.resource-revision-view.v1",
  kind: "file",
  resource,
  revision: identity,
  observed: { headRevisionId: resource.headRevisionId, snapshotId: "snapshot-2" },
  payload,
  content: {
    fileName: "voice.txt",
    previewKind: "text",
    text: "Make every decision legible.",
    textTruncated: false,
  },
};

function Harness({
  requestedRevisionId,
  activeRevisionId = resource.headRevisionId,
  activeSnapshotId = "snapshot-2",
  onReturnToHead = () => {},
}: {
  requestedRevisionId: string | null;
  activeRevisionId?: string | null;
  activeSnapshotId?: string | null;
  onReturnToHead?: () => void;
}) {
  const editor = useResourceEditorController({
    projectId: "project-1",
    workspaceId: resource.workspaceId,
    resourceId: resource.id,
    requestedRevisionId,
    activeRevisionId,
    activeSnapshotId,
  });
  return (
    <ResourceEditorSurface
      editor={editor}
      projectId="project-1"
      onBack={() => {}}
      onOpenRevision={() => {}}
      onReturnToHead={onReturnToHead}
    />
  );
}

test("a top-level Resource load failure retries in place and preserves the exact route", async () => {
  const user = userEvent.setup();
  const getResource = vi.fn()
    .mockRejectedValueOnce(new Error("Resource service is temporarily unavailable"))
    .mockResolvedValueOnce(resource);
  render(
    <ApiProvider client={makeFakeApi({
      getResource,
      getResourceRevisionView: async () => fileView,
    })}>
      <Harness requestedRevisionId={identity.id} />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByText("Make every decision legible.")).toBeInTheDocument();
  expect(getResource).toHaveBeenCalledTimes(2);
});

test("the exact Resource body is ready before lazy history, and history failure stays local", async () => {
  const user = userEvent.setup();
  const listHistory = vi.fn(async () => { throw new Error("History index is offline"); });
  render(
    <ApiProvider client={makeFakeApi({
      getResource: async () => resource,
      getResourceRevisionView: async () => fileView,
      listResourceRevisionHistory: listHistory,
    })}>
      <Harness requestedRevisionId={null} />
    </ApiProvider>,
  );

  expect(await screen.findByText("Make every decision legible.")).toBeInTheDocument();
  expect(listHistory).not.toHaveBeenCalled();
  await user.click(screen.getByLabelText("Open Resource Revision history"));
  expect(await screen.findByRole("alert")).toHaveTextContent("History index is offline");
  expect(screen.getByText("Make every decision legible.")).toBeInTheDocument();
  expect(listHistory).toHaveBeenCalledWith("project-1", resource.id, { limit: 20 });
});

test("native media uses an authenticated Blob URL and revokes it on unmount", async () => {
  const createObjectURL = vi.fn(() => "blob:exact-resource-media");
  const revokeObjectURL = vi.fn();
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
  const getResourceRevisionBlob = vi.fn(async () => new Blob(["exact-image"], { type: "image/png" }));
  const mediaView: ResourceRevisionView = {
    ...fileView,
    payload: {
      ...fileView.payload,
      mimeType: "image/png",
      previewKind: "image",
      url: "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload",
    },
    content: { ...fileView.content, fileName: "exact.png", previewKind: "image", text: null },
  };
  const rendered = render(
    <ApiProvider client={makeFakeApi({ getResourceRevisionBlob })}>
      <ResourceRevisionBody view={mediaView} />
    </ApiProvider>,
  );

  const image = await screen.findByRole("img", { name: "exact.png" });
  expect(image).toHaveAttribute("src", "blob:exact-resource-media");
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("decoding", "async");
  expect(getResourceRevisionBlob).toHaveBeenCalledWith(mediaView.payload.url, expect.any(AbortSignal));
  expect(image.getAttribute("src")).not.toContain("/api/");
  rendered.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:exact-resource-media");
});

test("replacing or unmounting authenticated media aborts obsolete Blob requests", async () => {
  const signals: AbortSignal[] = [];
  const getResourceRevisionBlob = vi.fn((_path: string, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return new Promise<Blob>(() => {});
  });
  const mediaView = (url: string): ResourceRevisionView => ({
    ...fileView,
    payload: {
      ...fileView.payload,
      mimeType: "image/png",
      previewKind: "image",
      url,
    },
    content: { ...fileView.content, fileName: "exact.png", previewKind: "image", text: null },
  });
  const firstUrl = "/api/projects/project-1/resources/resource-file/revisions/revision-1/payload";
  const secondUrl = "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload";
  const api = makeFakeApi({ getResourceRevisionBlob });
  const rendered = render(
    <ApiProvider client={api}>
      <ResourceRevisionBody view={mediaView(firstUrl)} />
    </ApiProvider>,
  );

  await waitFor(() => expect(getResourceRevisionBlob).toHaveBeenCalledOnce());
  expect(signals[0]?.aborted).toBe(false);
  rendered.rerender(
    <ApiProvider client={api}>
      <ResourceRevisionBody view={mediaView(secondUrl)} />
    </ApiProvider>,
  );
  await waitFor(() => expect(getResourceRevisionBlob).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  rendered.unmount();
  expect(signals[1]?.aborted).toBe(true);
});

test("repeated exact images wait for the viewport, share one Blob fetch, and release it once", async () => {
  const observers: FakeIntersectionObserver[] = [];
  class FakeIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "240px";
    readonly thresholds = [0];
    readonly targets = new Set<Element>();

    constructor(readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }

    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    reveal() {
      this.callback([...this.targets].map((target) => ({
        isIntersecting: true,
        intersectionRatio: 1,
        target,
      } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const createObjectURL = vi.fn(() => "blob:shared-moodboard-image");
  const revokeObjectURL = vi.fn();
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
  const getResourceRevisionBlob = vi.fn(async () => new Blob(["shared-image"], { type: "image/png" }));
  const assetUrl = "/api/projects/project-1/resources/resource-file/revisions/revision-2/embedded-assets/asset-1";
  const moodboardView: ResourceRevisionView = {
    ...fileView,
    kind: "moodboard",
    resource: { ...resource, kind: "moodboard" },
    content: {
      board: { id: "board-shared", name: "Shared image study", coverAssetId: "asset-1" },
      nodes: [
        { id: "node-a", type: "image", label: "Crop A", text: "", x: 0, y: 0, width: 200, height: 120, assetId: "asset-1" },
        { id: "node-b", type: "image", label: "Crop B", text: "", x: 220, y: 0, width: 200, height: 120, assetId: "asset-1" },
      ],
      assets: [{
        id: "asset-1",
        kind: "image",
        fileName: "shared.png",
        mimeType: "image/png",
        width: 800,
        height: 480,
        byteLength: 12,
        checksum: "f".repeat(64),
        url: assetUrl,
        downloadUrl: `${assetUrl}?download=1`,
      }],
      totalNodeCount: 2,
      totalAssetCount: 1,
      nodesTruncated: false,
      assetsTruncated: false,
    },
  };
  const rendered = render(
    <ApiProvider client={makeFakeApi({ getResourceRevisionBlob })}>
      <ResourceRevisionBody view={moodboardView} />
    </ApiProvider>,
  );

  expect(getResourceRevisionBlob).not.toHaveBeenCalled();
  await waitFor(() => expect(observers).toHaveLength(2));
  act(() => observers.forEach((observer) => observer.reveal()));
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(getResourceRevisionBlob).toHaveBeenCalledTimes(1);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  rendered.unmount();
  expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:shared-moodboard-image");
});

test("authenticated media failures stay visible instead of leaking a daemon URL", async () => {
  const mediaView: ResourceRevisionView = {
    ...fileView,
    payload: {
      ...fileView.payload,
      mimeType: "image/png",
      previewKind: "image",
      url: "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload",
    },
    content: { ...fileView.content, fileName: "exact.png", previewKind: "image", text: null },
  };
  render(
    <ApiProvider client={makeFakeApi({
      getResourceRevisionBlob: async () => { throw new Error("authentication expired"); },
    })}>
      <ResourceRevisionBody view={mediaView} />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("authentication expired");
  expect(document.querySelector('img[src^="/api/"]')).toBeNull();
});

test("authenticated media can retry a transient failure without reopening the Revision", async () => {
  const user = userEvent.setup();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried-resource-media");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let attempt = 0;
  const getResourceRevisionBlob = vi.fn(async () => {
    if (attempt++ === 0) throw new Error("authentication temporarily unavailable");
    return new Blob(["retried-image"], { type: "image/png" });
  });
  const mediaView: ResourceRevisionView = {
    ...fileView,
    payload: {
      ...fileView.payload,
      mimeType: "image/png",
      previewKind: "image",
      url: "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload",
    },
    content: { ...fileView.content, fileName: "retry.png", previewKind: "image", text: null },
  };
  render(
    <ApiProvider client={makeFakeApi({ getResourceRevisionBlob })}>
      <ResourceRevisionBody view={mediaView} />
    </ApiProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("authentication temporarily unavailable");
  await user.click(screen.getByRole("button", { name: "Retry exact media" }));
  expect(await screen.findByRole("img", { name: "retry.png" })).toHaveAttribute("src", "blob:retried-resource-media");
  expect(getResourceRevisionBlob).toHaveBeenCalledTimes(2);
});

test("Download exact payload completes from the first click after its authenticated Blob is ready", async () => {
  const user = userEvent.setup();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:single-click-download");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const getResourceRevisionBlob = vi.fn(async () => new Blob(["exact-download"], { type: "text/plain" }));
  render(
    <ApiProvider client={makeFakeApi({ getResourceRevisionBlob })}>
      <ResourceRevisionBody view={fileView} />
    </ApiProvider>,
  );

  await user.click(screen.getByRole("button", { name: "Download exact payload" }));
  await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
  const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
  expect(anchor).toHaveAttribute("href", "blob:single-click-download");
  expect(anchor).toHaveAttribute("download", `resource-revision-${fileView.revision.id}`);
  expect(getResourceRevisionBlob).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Download again" })).toBeInTheDocument();
});

test("a historical route is explicitly Pinned and can return to Head", async () => {
  const user = userEvent.setup();
  const onReturnToHead = vi.fn();
  const pinnedView: ResourceRevisionView = {
    ...fileView,
    revision: { ...identity, id: "revision-1", sequence: 1, parentRevisionId: null },
  };
  render(
    <ApiProvider client={makeFakeApi({
      getResource: async () => resource,
      getResourceRevisionView: async () => pinnedView,
      listResourceRevisionHistory: async () => ({ items: [], nextCursor: null }),
    })}>
      <Harness requestedRevisionId="revision-1" onReturnToHead={onReturnToHead} />
    </ApiProvider>,
  );

  expect(await screen.findByText("Pinned · Revision 1")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Open Resource Revision history"));
  await user.click(screen.getByRole("button", { name: "Return to Head" }));
  expect(onReturnToHead).toHaveBeenCalledOnce();
});

test("history loads twenty-at-a-time and appends older keyset pages", async () => {
  const user = userEvent.setup();
  const revision = (id: string, sequence: number, createdAt: number): ResourceRevision => ({
    id,
    workspaceId: resource.workspaceId,
    resourceId: resource.id,
    sequence,
    parentRevisionId: null,
    manifestPath: `resource-revisions/${id}/manifest.json`,
    summary: `Frozen revision ${sequence}`,
    metadata: {},
    checksum: String(sequence % 10).repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt,
  });
  const newest = revision("history-new", 55, 55);
  const older = revision("history-old", 35, 35);
  const listHistory = vi.fn(async (_projectId: string, _resourceId: string, options?: { cursor?: string }) => (
    options?.cursor === "next-20"
      ? { items: [older], nextCursor: null }
      : { items: [newest], nextCursor: "next-20" }
  ));
  render(
    <ApiProvider client={makeFakeApi({
      getResource: async () => resource,
      getResourceRevisionView: async () => fileView,
      listResourceRevisionHistory: listHistory,
    })}>
      <Harness requestedRevisionId={null} />
    </ApiProvider>,
  );

  await screen.findByText("Make every decision legible.");
  await user.click(screen.getByLabelText("Open Resource Revision history"));
  expect(await screen.findByText("Frozen revision 55")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Load older Revisions" }));
  expect(await screen.findByText("Frozen revision 35")).toBeInTheDocument();
  expect(screen.getByText("Frozen revision 55")).toBeInTheDocument();
  expect(listHistory).toHaveBeenNthCalledWith(2, "project-1", resource.id, { limit: 20, cursor: "next-20" });
});

test("an open Resource history refreshes when its exact Head observation advances", async () => {
  const user = userEvent.setup();
  const revision = (id: string, sequence: number): ResourceRevision => ({
    id,
    workspaceId: resource.workspaceId,
    resourceId: resource.id,
    sequence,
    parentRevisionId: sequence === 1 ? null : `revision-${sequence - 1}`,
    manifestPath: `resource-revisions/${id}/manifest.json`,
    summary: `Frozen revision ${sequence}`,
    metadata: {},
    checksum: String(sequence).repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: sequence,
  });
  const v2 = revision("revision-2", 2);
  const v3 = revision("revision-3", 3);
  let observedHead = v2;
  const listHistory = vi.fn(async () => ({ items: [observedHead], nextCursor: null }));
  const api = makeFakeApi({ listResourceRevisionHistory: listHistory });
  const rendered = render(
    <ApiProvider client={api}>
      <ResourceRevisionHistory
        projectId="project-1"
        resourceId={resource.id}
        current={identity}
        headRevisionId={v2.id}
        pinned={false}
        onOpenRevision={() => {}}
        onReturnToHead={() => {}}
      />
    </ApiProvider>,
  );

  await user.click(screen.getByLabelText("Open Resource Revision history"));
  expect(await screen.findByText("Frozen revision 2")).toBeInTheDocument();
  observedHead = v3;
  rendered.rerender(
    <ApiProvider client={api}>
      <ResourceRevisionHistory
        projectId="project-1"
        resourceId={resource.id}
        current={{ ...identity, id: v3.id, sequence: 3 }}
        headRevisionId={v3.id}
        pinned={false}
        onOpenRevision={() => {}}
        onReturnToHead={() => {}}
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Frozen revision 3")).toBeInTheDocument();
  expect(screen.queryByText("Frozen revision 2")).not.toBeInTheDocument();
  expect(listHistory).toHaveBeenCalledTimes(2);
});

test("late exact Revision responses cannot overwrite a newer route", async () => {
  let releaseOld!: (view: ResourceRevisionView) => void;
  const old = new Promise<ResourceRevisionView>((resolve) => { releaseOld = resolve; });
  const currentView: ResourceRevisionView = {
    ...fileView,
    revision: { ...identity, id: "revision-current", sequence: 3 },
    content: { ...fileView.content, text: "Current exact body." },
  };
  const api = makeFakeApi({
    getResource: async () => resource,
    getResourceRevisionView: async (_projectId, _resourceId, revisionId) => (
      revisionId === "revision-old" ? old : currentView
    ),
  });
  const rendered = render(
    <ApiProvider client={api}><Harness requestedRevisionId="revision-old" /></ApiProvider>,
  );
  rendered.rerender(
    <ApiProvider client={api}><Harness requestedRevisionId="revision-current" /></ApiProvider>,
  );

  expect(await screen.findByText("Current exact body.")).toBeInTheDocument();
  releaseOld({
    ...fileView,
    revision: { ...identity, id: "revision-old", sequence: 1 },
    content: { ...fileView.content, text: "Stale exact body." },
  });
  await waitFor(() => expect(screen.queryByText("Stale exact body.")).not.toBeInTheDocument());
});

test("Current Head retries when the atomic view observes a newer Head", async () => {
  const staleResource = { ...resource, headRevisionId: "revision-1" };
  const staleView: ResourceRevisionView = {
    ...fileView,
    resource: staleResource,
    revision: { ...identity, id: "revision-1", sequence: 1 },
    observed: { headRevisionId: "revision-2", snapshotId: "snapshot-2" },
    content: { ...fileView.content, text: "Stale Head body." },
  };
  const currentView: ResourceRevisionView = {
    ...fileView,
    observed: { headRevisionId: "revision-2", snapshotId: "snapshot-2" },
    content: { ...fileView.content, text: "Retried current Head body." },
  };
  let resourceRead = 0;
  const getResource = vi.fn(async () => (resourceRead++ === 0 ? staleResource : resource));
  const getResourceRevisionView = vi.fn(async (_projectId, _resourceId, revisionId) => (
    revisionId === "revision-1" ? staleView : currentView
  ));
  render(
    <ApiProvider client={makeFakeApi({ getResource, getResourceRevisionView })}>
      <Harness requestedRevisionId={null} />
    </ApiProvider>,
  );

  expect(await screen.findByText("Retried current Head body.")).toBeInTheDocument();
  expect(screen.queryByText("Stale Head body.")).not.toBeInTheDocument();
  expect(getResource).toHaveBeenCalledTimes(2);
  expect(getResourceRevisionView).toHaveBeenNthCalledWith(2, "project-1", resource.id, "revision-2");
});

test("Current Head invalidates immediately when the active Resource pin and Snapshot advance", async () => {
  const nextResource: Resource = { ...resource, headRevisionId: "revision-3", updatedAt: 3 };
  const nextView: ResourceRevisionView = {
    ...fileView,
    resource: nextResource,
    revision: { ...identity, id: "revision-3", sequence: 3, parentRevisionId: "revision-2", createdAt: 3 },
    observed: { headRevisionId: "revision-3", snapshotId: "snapshot-3" },
    content: { ...fileView.content, text: "Published current Head body." },
  };
  let currentResource = resource;
  const getResource = vi.fn(async () => currentResource);
  const getResourceRevisionView = vi.fn(async (_projectId, _resourceId, revisionId) => (
    revisionId === nextView.revision.id ? nextView : fileView
  ));
  const api = makeFakeApi({ getResource, getResourceRevisionView });
  const rendered = render(
    <ApiProvider client={api}>
      <Harness
        requestedRevisionId={null}
        activeRevisionId="revision-2"
        activeSnapshotId="snapshot-2"
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Make every decision legible.")).toBeInTheDocument();
  currentResource = nextResource;
  rendered.rerender(
    <ApiProvider client={api}>
      <Harness
        requestedRevisionId={null}
        activeRevisionId="revision-3"
        activeSnapshotId="snapshot-3"
      />
    </ApiProvider>,
  );

  expect(await screen.findByText("Published current Head body.")).toBeInTheDocument();
  expect(screen.queryByText("Make every decision legible.")).not.toBeInTheDocument();
  expect(screen.getByText("Current Head · Revision 3")).toBeInTheDocument();
  expect(getResourceRevisionView).toHaveBeenCalledTimes(2);
});

test("extreme Moodboard geometry stays inside a bounded viewport without distorting authored coordinates", () => {
  const extremeView: ResourceRevisionView = {
    ...fileView,
    kind: "moodboard",
    resource: { ...resource, kind: "moodboard" },
    content: {
      board: { id: "board-extreme", name: "Tall composition", coverAssetId: null },
      nodes: [{
        id: "node-extreme",
        type: "note",
        label: "Tall authored frame",
        text: "Keep the original coordinate system.",
        x: 0,
        y: 0,
        width: 1,
        height: 1_000_000,
        assetId: null,
      }],
      assets: [],
      totalNodeCount: 1,
      totalAssetCount: 0,
      nodesTruncated: false,
      assetsTruncated: false,
    },
  };
  const rendered = render(
    <ApiProvider client={makeFakeApi()}>
      <ResourceRevisionBody view={extremeView} />
    </ApiProvider>,
  );

  const canvas = rendered.container.querySelector(".dezin-moodboard__canvas");
  expect(canvas?.tagName.toLowerCase()).toBe("svg");
  expect(canvas).toHaveAttribute("viewBox", "0 0 1 1000000");
  expect(canvas).not.toHaveStyle({ aspectRatio: "1 / 1000000" });
  expect(rendered.container.querySelector('foreignObject[data-node-id="node-extreme"]')).toHaveAttribute("height", "1000000");
});

test("all non-Research Resource kinds render from bounded frozen projections", () => {
  const views: ResourceRevisionView[] = [
    fileView,
    {
      ...fileView,
      kind: "asset",
      resource: { ...resource, kind: "asset" },
      content: {
        fileName: "mark.png",
        mediaKind: "image",
        text: null,
        textTruncated: false,
        width: 300,
        height: 200,
        sourceType: "asset",
        sourceId: "asset-1",
      },
      payload: {
        ...payload,
        mimeType: "image/png",
        previewKind: "image",
        url: "/api/projects/project-1/resources/resource-file/revisions/revision-2/payload",
      },
    },
    {
      ...fileView,
      kind: "moodboard",
      resource: { ...resource, kind: "moodboard" },
      content: {
        board: { id: "board-1", name: "Material restraint", coverAssetId: null },
        nodes: [
          { id: "node-1", type: "note", label: "Quiet confidence", text: "Warm, precise, useful.", x: 10, y: 20, width: 200, height: 120, assetId: null },
          { id: "node-2", type: "note", label: "Measured contrast", text: "Preserve the authored spacing.", x: 310, y: 70, width: 100, height: 80, assetId: null },
        ],
        assets: [], totalNodeCount: 2, totalAssetCount: 0, nodesTruncated: false, assetsTruncated: false,
      },
    },
    {
      ...fileView,
      kind: "sharingan-capture",
      resource: { ...resource, kind: "sharingan-capture" },
      content: {
        source: { requestedUrl: "https://example.test/", finalUrl: "https://example.test/", capturedAt: 2 },
        exporter: { id: "sharingan", version: 1 },
        pages: [{
          title: "Reference checkout", requestedUrl: "https://example.test/", finalUrl: "https://example.test/",
          viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 1800 }, screenshots: [],
          dom: { nodeCount: 90, tags: ["main", "button"] },
          styleTokens: { colors: ["#112233"], fontFamilies: ["Georgia"], fontSizes: ["16px"], radii: ["8px"], shadows: [] },
          links: ["https://example.test/help"],
        }],
      },
    },
    {
      ...fileView,
      kind: "effect",
      resource: { ...resource, kind: "effect" },
      content: {
        definition: {
          id: "effect-1", name: "Soft reveal", origin: "custom", category: "transition", summary: "A restrained reveal.",
          parameters: [
            { id: "strength", label: "Strength", type: "number", defaultValue: 0.5, options: [], description: "Opacity" },
            { id: "enabled", label: "Enabled", type: "boolean", defaultValue: true, options: [], description: "Frozen switch" },
          ],
          presets: [], code: "return opacity;",
        },
        fixture: { width: 640, height: 360, timesMs: [0, 500, 1_000], values: { strength: 0.5, enabled: true } },
      },
    },
    {
      ...fileView,
      kind: "external-reference",
      resource: { ...resource, kind: "external-reference" },
      content: {
        sourceUrl: "https://example.test/source", finalUrl: "https://example.test/frozen", status: 200,
        previewKind: "text", text: "Frozen external evidence.", textTruncated: false,
      },
    },
  ];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:renderer-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const rendered = render(
    <ApiProvider client={makeFakeApi({ getResourceRevisionBlob: async () => new Blob(["exact"]) })}>
      {views.map((view) => <div key={view.kind}><ResourceRevisionBody view={view} /></div>)}
    </ApiProvider>,
  );

  expect(screen.getByText("Make every decision legible.")).toBeInTheDocument();
  expect(screen.getByText("asset / asset-1")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Material restraint" })).toBeInTheDocument();
  expect(rendered.container.querySelector(".dezin-moodboard__canvas")).toHaveAttribute("viewBox", "10 20 400 130");
  expect(rendered.container.querySelector('foreignObject[data-node-id="node-2"]')).toHaveAttribute("x", "310");
  expect(rendered.container.querySelector('foreignObject[data-node-id="node-2"]')).toHaveAttribute("width", "100");
  expect(screen.getByRole("heading", { name: "Reference checkout" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Soft reveal" })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText("On")).toBeInTheDocument();
  expect(screen.getByText("Frozen external evidence.")).toBeInTheDocument();
});
