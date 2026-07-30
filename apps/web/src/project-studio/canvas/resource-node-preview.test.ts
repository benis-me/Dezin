import { createElement, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ApiClient, ResourceRevisionView } from "../../lib/api.ts";
import { ApiProvider } from "../../lib/api-context.tsx";
import { makeFakeApi } from "../../test/fake-api.ts";
import {
  loadResourceNodeRevisionPreview,
  useResourceNodeRevisionPreviewController,
  useResourceNodeRevisionPreviews,
} from "./resource-node-preview.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function moodboardCoverBlob(): Blob {
  return new Blob([new Uint8Array(512)], { type: "image/webp" });
}

function makeResourcePreviewApi(
  overrides: Parameters<typeof makeFakeApi>[0] = {},
): ApiClient {
  return makeFakeApi({
    getResourceRevisionBlob: async () => moodboardCoverBlob(),
    ...overrides,
  });
}

function moodboardView(overrides: Partial<Extract<ResourceRevisionView, { kind: "moodboard" }>> = {}): Extract<ResourceRevisionView, { kind: "moodboard" }> {
  return {
    protocol: "dezin.resource-revision-view.v1",
    kind: "moodboard",
    resource: {
      id: "moodboard-1",
      workspaceId: "workspace-1",
      kind: "moodboard",
      title: "Festival visual directions",
      headRevisionId: "revision-1",
      defaultPinPolicy: "follow-head",
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    },
    revision: {
      id: "revision-1",
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      sequence: 1,
      parentRevisionId: null,
      summary: "Published visual directions",
      checksum: "a".repeat(64),
      createdAt: 2,
    },
    observed: {
      headRevisionId: "revision-1",
      snapshotId: "snapshot-1",
    },
    payload: {
      mimeType: "application/json",
      byteLength: 1024,
      checksum: "b".repeat(64),
      previewKind: "text",
      url: "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/payload",
      downloadUrl: "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/payload?download=1",
    },
    content: {
      board: {
        id: "board-1",
        name: "KITE / Direction A",
        coverAssetId: "asset-cover",
      },
      nodes: [],
      assets: [
        {
          id: "asset-cover",
          kind: "image",
          fileName: "cover.webp",
          mimeType: "image/webp",
          width: 1600,
          height: 900,
          byteLength: 512,
          checksum: "c".repeat(64),
          url: "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/assets/asset-cover",
          downloadUrl: "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/assets/asset-cover?download=1",
        },
      ],
      totalNodeCount: 0,
      totalAssetCount: 1,
      nodesTruncated: false,
      assetsTruncated: false,
    },
    ...overrides,
  };
}

function researchView(): Extract<ResourceRevisionView, { kind: "research" }> {
  return {
    protocol: "dezin.resource-revision-view.v1",
    kind: "research",
    resource: {
      id: "research-1",
      workspaceId: "workspace-1",
      kind: "research",
      title: "Festival audience research",
      headRevisionId: "research-revision-1",
      defaultPinPolicy: "follow-head",
      archivedAt: null,
      createdAt: 1,
      updatedAt: 2,
    },
    revision: {
      id: "research-revision-1",
      workspaceId: "workspace-1",
      resourceId: "research-1",
      sequence: 1,
      parentRevisionId: null,
      summary: "Audience decision brief",
      checksum: "d".repeat(64),
      createdAt: 2,
    },
    observed: {
      headRevisionId: "research-revision-1",
      snapshotId: "snapshot-1",
    },
    payload: {
      mimeType: "application/json",
      byteLength: 2048,
      checksum: "e".repeat(64),
      previewKind: "text",
      url: "/api/projects/project-1/resources/research-1/revisions/research-revision-1/payload",
      downloadUrl: "/api/projects/project-1/resources/research-1/revisions/research-revision-1/payload?download=1",
    },
    content: {
      qualityState: "grounded",
      evidenceDirectionCount: 2,
      hypothesisDirectionCount: 1,
      executiveSummary: "Young festival audiences decide quickly when programming feels curated, social, and easy to scan.",
      sources: [],
      findings: [
        {
          id: "finding-1",
          statement: "Programs need a strong first-glance hierarchy.",
          implication: "Lead with a compact editorial schedule.",
          confidence: "high",
          evidenceStatus: "evidence",
          sourceIds: [],
          verifiedSourceIds: [],
          unverifiedSourceIds: [],
          supportReceiptIds: [],
          groundedness: {
            verified: true,
            verifier: { id: "verifier-1" },
            rationale: "Supported",
            supportReceiptIds: [],
          },
        },
      ],
      designPrinciples: [],
      directions: [
        {
          id: "direction-1",
          title: "Cinematic urgency",
          thesis: "Make every screening feel imminent.",
          visualLanguage: [],
          interactionPrinciples: [],
          risks: [],
          findingIds: ["finding-1"],
          evidenceStatus: "evidence",
          evidenceFindingIds: ["finding-1"],
          hypothesisFindingIds: [],
        },
      ],
      openQuestions: [],
    },
  };
}

function moodboardRevisionView(
  revisionId: string,
  boardName: string,
): Extract<ResourceRevisionView, { kind: "moodboard" }> {
  const view = moodboardView();
  const revisionRoute = `/api/projects/project-1/resources/moodboard-1/revisions/${revisionId}`;
  return {
    ...view,
    resource: {
      ...view.resource,
      headRevisionId: revisionId,
    },
    revision: {
      ...view.revision,
      id: revisionId,
      sequence: revisionId === "revision-1" ? 1 : 2,
      parentRevisionId: revisionId === "revision-1" ? null : "revision-1",
    },
    observed: {
      ...view.observed,
      headRevisionId: revisionId,
    },
    payload: {
      ...view.payload,
      url: `${revisionRoute}/payload`,
      downloadUrl: `${revisionRoute}/payload?download=1`,
    },
    content: {
      ...view.content,
      board: {
        ...view.content.board,
        name: boardName,
      },
      assets: view.content.assets.map((asset) => ({
        ...asset,
        url: asset.url === null ? null : `${revisionRoute}/assets/${asset.id}`,
        downloadUrl: `${revisionRoute}/assets/${asset.id}?download=1`,
      })),
    },
  };
}

describe("loadResourceNodeRevisionPreview", () => {
  test("projects the explicit immutable Moodboard cover Asset into a canvas preview", async () => {
    const getResourceRevisionView = vi.fn(async () => moodboardView());
    const blob = moodboardCoverBlob();
    const getResourceRevisionBlob = vi.fn(async () => blob);
    const api = { getResourceRevisionView, getResourceRevisionBlob };

    await expect(loadResourceNodeRevisionPreview(api, "project-1", {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard",
    })).resolves.toEqual({
      kind: "moodboard",
      boardName: "KITE / Direction A",
      cover: {
        assetId: "asset-cover",
        path: "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/assets/asset-cover",
        blob,
        alt: "KITE / Direction A cover",
        width: 1600,
        height: 900,
      },
      assetCount: 1,
    });
    expect(getResourceRevisionView).toHaveBeenCalledWith(
      "project-1",
      "moodboard-1",
      "revision-1",
      expect.any(AbortSignal),
    );
    expect(getResourceRevisionBlob).toHaveBeenCalledWith(
      "/api/projects/project-1/resources/moodboard-1/revisions/revision-1/assets/asset-cover",
      expect.any(AbortSignal),
    );
  });

  test("rejects a Revision response whose immutable identity does not match the canvas binding", async () => {
    const view = moodboardView();
    const getResourceRevisionView = vi.fn(async () => ({
      ...view,
      resource: {
        ...view.resource,
        workspaceId: "workspace-from-another-project",
      },
    }));
    const api = {
      getResourceRevisionView,
      getResourceRevisionBlob: vi.fn(async () => moodboardCoverBlob()),
    };

    await expect(loadResourceNodeRevisionPreview(api, "project-1", {
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard",
      workspaceId: "workspace-1",
    })).rejects.toThrow("does not match the active canvas binding");
  });

  test("fails the whole exact-Revision preview when Moodboard cover bytes are unavailable", async () => {
    const api = {
      getResourceRevisionView: vi.fn(async () => moodboardView()),
      getResourceRevisionBlob: vi.fn(async () => {
        throw new Error("Embedded Asset temporarily unavailable");
      }),
    };

    await expect(loadResourceNodeRevisionPreview(api, "project-1", {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard",
    })).rejects.toThrow("Embedded Asset temporarily unavailable");
  });

  test("rejects Moodboard cover bytes whose size or MIME disagrees with the exact Revision", async () => {
    for (const [blob, message] of [
      [new Blob([new Uint8Array(511)], { type: "image/webp" }), /bytes do not match/i],
      [new Blob([new Uint8Array(512)], { type: "image/png" }), /MIME does not match/i],
    ] as const) {
      const api = {
        getResourceRevisionView: vi.fn(async () => moodboardView()),
        getResourceRevisionBlob: vi.fn(async () => blob),
      };
      await expect(loadResourceNodeRevisionPreview(api, "project-1", {
        workspaceId: "workspace-1",
        resourceId: "moodboard-1",
        revisionId: "revision-1",
        resourceKind: "moodboard",
      })).rejects.toThrow(message);
    }
  });

  test("projects bounded Research decision content for an editorial canvas preview", async () => {
    const api = {
      getResourceRevisionView: vi.fn(async () => researchView()),
      getResourceRevisionBlob: vi.fn(async () => moodboardCoverBlob()),
    };

    await expect(loadResourceNodeRevisionPreview(api, "project-1", {
      workspaceId: "workspace-1",
      resourceId: "research-1",
      revisionId: "research-revision-1",
      resourceKind: "research",
    })).resolves.toEqual({
      kind: "research",
      executiveSummary: "Young festival audiences decide quickly when programming feels curated, social, and easy to scan.",
      findingCount: 1,
      evidenceDirectionCount: 2,
      hypothesisDirectionCount: 1,
    });
  });

  test("does not project a Resource response after its preview request is cancelled", async () => {
    const response = deferred<ResourceRevisionView>();
    const api = {
      getResourceRevisionView: vi.fn(() => response.promise),
      getResourceRevisionBlob: vi.fn(async () => moodboardCoverBlob()),
    };
    const controller = new AbortController();
    const preview = loadResourceNodeRevisionPreview(api, "project-1", {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard",
    }, controller.signal);

    controller.abort();
    response.resolve(moodboardView());

    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
  });

  test("times out a stalled Resource preview and retries with a fresh abortable request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      _resourceId: string,
      _revisionId: string,
      signal?: AbortSignal,
    ) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise<ResourceRevisionView>(() => {});
    });
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const binding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard" as const,
    };
    const { result } = renderHook(
      () => useResourceNodeRevisionPreviewController("project-1", [binding]),
      { wrapper },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "error",
      error: { message: expect.stringMatching(/timed out/i) },
    });
    expect(signals[0]?.aborted).toBe(true);

    act(() => result.current.retry("moodboard-1"));
    await act(async () => { await Promise.resolve(); });

    expect(getResourceRevisionView).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    vi.useRealTimers();
  });

  test("times out stalled Moodboard cover bytes and retries the same exact Revision", async () => {
    vi.useFakeTimers();
    const coverSignals: AbortSignal[] = [];
    let coverAttempts = 0;
    const getResourceRevisionView = vi.fn(async () => moodboardView());
    const getResourceRevisionBlob = vi.fn((
      _path: string,
      signal?: AbortSignal,
    ) => {
      if (signal !== undefined) coverSignals.push(signal);
      coverAttempts += 1;
      return coverAttempts === 1
        ? new Promise<Blob>(() => {})
        : Promise.resolve(moodboardCoverBlob());
    });
    const client = makeResourcePreviewApi({
      getResourceRevisionView,
      getResourceRevisionBlob,
    });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const binding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard" as const,
    };
    const { result } = renderHook(
      () => useResourceNodeRevisionPreviewController("project-1", [binding]),
      { wrapper },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "error",
      preview: null,
      error: { message: expect.stringMatching(/cover preview timed out/i) },
    });
    expect(coverSignals[0]?.aborted).toBe(true);

    act(() => result.current.retry("moodboard-1"));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      preview: { kind: "moodboard", boardName: "KITE / Direction A" },
      error: null,
    });
    expect(getResourceRevisionView).toHaveBeenCalledTimes(2);
    expect(getResourceRevisionBlob).toHaveBeenCalledTimes(2);
    expect(coverSignals[1]).not.toBe(coverSignals[0]);
    expect(coverSignals[1]?.aborted).toBe(false);
    vi.useRealTimers();
  });

  test("loads each active immutable Resource Revision once for the canvas", async () => {
    const getResourceRevisionView = vi.fn(async (
      _projectId: string,
      resourceId: string,
    ) => resourceId === "research-1" ? researchView() : moodboardView());
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const bindings = [
      {
        workspaceId: "workspace-1",
        resourceId: "research-1",
        revisionId: "research-revision-1",
        resourceKind: "research" as const,
      },
      {
        workspaceId: "workspace-1",
        resourceId: "moodboard-1",
        revisionId: "revision-1",
        resourceKind: "moodboard" as const,
      },
    ];

    const { result, rerender } = renderHook(
      () => useResourceNodeRevisionPreviews("project-1", bindings),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current["research-1"]?.kind).toBe("research");
      expect(result.current["moodboard-1"]?.kind).toBe("moodboard");
    });
    rerender();
    expect(getResourceRevisionView).toHaveBeenCalledTimes(2);
  });

  test("publishes a fast Resource preview before an unrelated slow preview settles", async () => {
    const researchRequest = deferred<ResourceRevisionView>();
    const moodboardRequest = deferred<ResourceRevisionView>();
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      resourceId: string,
    ) => resourceId === "research-1" ? researchRequest.promise : moodboardRequest.promise);
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const bindings = [
      {
        workspaceId: "workspace-1",
        resourceId: "research-1",
        revisionId: "research-revision-1",
        resourceKind: "research" as const,
      },
      {
        workspaceId: "workspace-1",
        resourceId: "moodboard-1",
        revisionId: "revision-1",
        resourceKind: "moodboard" as const,
      },
    ];

    const { result } = renderHook(
      () => useResourceNodeRevisionPreviews("project-1", bindings),
      { wrapper },
    );

    researchRequest.resolve(researchView());
    await waitFor(() => expect(result.current["research-1"]?.kind).toBe("research"));
    expect(result.current["moodboard-1"]).toBeUndefined();

    moodboardRequest.resolve(moodboardView());
    await waitFor(() => expect(result.current["moodboard-1"]?.kind).toBe("moodboard"));
  });

  test("keeps unchanged Resources ready while a changed Revision starts fail-closed", async () => {
    const changedMoodboardRequest = deferred<ResourceRevisionView>();
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      resourceId: string,
      revisionId: string,
    ) => {
      if (resourceId === "research-1") return Promise.resolve(researchView());
      if (revisionId === "revision-1") return Promise.resolve(moodboardView());
      return changedMoodboardRequest.promise;
    });
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const researchBinding = {
      workspaceId: "workspace-1",
      resourceId: "research-1",
      revisionId: "research-revision-1",
      resourceKind: "research" as const,
    };
    const moodboardBinding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard" as const,
    };

    const { result, rerender } = renderHook(
      ({ bindings }) => useResourceNodeRevisionPreviews("project-1", bindings),
      {
        wrapper,
        initialProps: { bindings: [researchBinding, moodboardBinding] },
      },
    );
    await waitFor(() => {
      expect(result.current["research-1"]?.kind).toBe("research");
      expect(result.current["moodboard-1"]?.kind).toBe("moodboard");
    });

    rerender({
      bindings: [
        researchBinding,
        { ...moodboardBinding, revisionId: "revision-2" },
      ],
    });

    expect(result.current["research-1"]?.kind).toBe("research");
    expect(result.current["moodboard-1"]).toBeUndefined();
    expect(getResourceRevisionView).toHaveBeenCalledTimes(3);

    changedMoodboardRequest.resolve(moodboardRevisionView("revision-2", "KITE / Direction B"));
    await waitFor(() => {
      expect(result.current["moodboard-1"]).toMatchObject({
        kind: "moodboard",
        boardName: "KITE / Direction B",
      });
    });
  });

  test("masks the previous Revision during the first render before passive loading effects run", async () => {
    const changedMoodboardRequest = deferred<ResourceRevisionView>();
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      _resourceId: string,
      revisionId: string,
    ) => revisionId === "revision-1"
      ? Promise.resolve(moodboardView())
      : changedMoodboardRequest.promise);
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const binding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      resourceKind: "moodboard" as const,
    };
    const renderedStates: Array<ReturnType<
      typeof useResourceNodeRevisionPreviewController
    >["states"][string] | null> = [];
    const { rerender } = renderHook(
      ({ revisionId }) => {
        const controller = useResourceNodeRevisionPreviewController("project-1", [
          { ...binding, revisionId },
        ]);
        renderedStates.push(controller.states["moodboard-1"] ?? null);
        return controller;
      },
      {
        wrapper,
        initialProps: { revisionId: "revision-1" },
      },
    );
    await waitFor(() => expect(
      renderedStates.at(-1)?.status,
    ).toBe("ready"));

    renderedStates.length = 0;
    rerender({ revisionId: "revision-2" });

    expect(renderedStates[0]).toMatchObject({
      binding: { revisionId: "revision-2" },
      status: "loading",
      preview: null,
      error: null,
    });
    expect(renderedStates.every((state) => (
      state === null
      || state.binding.revisionId !== "revision-2"
      || state.preview === null
      || state.preview.kind !== "moodboard"
      || state.preview.boardName !== "KITE / Direction A"
    ))).toBe(true);

    changedMoodboardRequest.resolve(moodboardRevisionView("revision-2", "KITE / Direction B"));
    await waitFor(() => expect(renderedStates.at(-1)).toMatchObject({
      binding: { revisionId: "revision-2" },
      status: "ready",
      preview: { kind: "moodboard", boardName: "KITE / Direction B" },
    }));
  });

  test("does not attribute Revision A content to Revision B after B fails and retries only B", async () => {
    const failedRefresh = deferred<ResourceRevisionView>();
    let revisionTwoAttempts = 0;
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      resourceId: string,
      revisionId: string,
    ) => {
      if (resourceId === "research-1") return Promise.resolve(researchView());
      if (revisionId === "revision-1") return Promise.resolve(moodboardView());
      revisionTwoAttempts += 1;
      return revisionTwoAttempts === 1
        ? failedRefresh.promise
        : Promise.resolve(moodboardRevisionView("revision-2", "KITE / Direction B"));
    });
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const researchBinding = {
      workspaceId: "workspace-1",
      resourceId: "research-1",
      revisionId: "research-revision-1",
      resourceKind: "research" as const,
    };
    const moodboardBinding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard" as const,
    };

    const { result, rerender } = renderHook(
      ({ bindings }) => useResourceNodeRevisionPreviewController("project-1", bindings),
      {
        wrapper,
        initialProps: { bindings: [researchBinding, moodboardBinding] },
      },
    );
    await waitFor(() => expect(result.current.states["moodboard-1"]?.status).toBe("ready"));

    rerender({
      bindings: [
        researchBinding,
        { ...moodboardBinding, revisionId: "revision-2" },
      ],
    });
    expect(result.current.states["moodboard-1"]).toMatchObject({
      binding: { revisionId: "revision-2" },
      status: "loading",
      preview: null,
      error: null,
    });

    await act(async () => {
      failedRefresh.reject(new Error("Preview service unavailable"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.states["moodboard-1"]).toMatchObject({
      binding: { revisionId: "revision-2" },
      status: "error",
      preview: null,
      error: new Error("Preview service unavailable"),
    }));
    expect(result.current.states["research-1"]?.preview?.kind).toBe("research");
    expect(getResourceRevisionView).toHaveBeenCalledTimes(3);

    act(() => result.current.retry("moodboard-1"));
    await waitFor(() => expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      preview: {
        kind: "moodboard",
        boardName: "KITE / Direction B",
      },
      error: null,
    }));
    expect(getResourceRevisionView).toHaveBeenCalledTimes(4);
  });

  test("ignores a cancelled stale result after the same Resource switches Revision", async () => {
    const revisionOne = deferred<ResourceRevisionView>();
    const revisionTwo = deferred<ResourceRevisionView>();
    const getResourceRevisionView = vi.fn((
      _projectId: string,
      _resourceId: string,
      revisionId: string,
    ) => revisionId === "revision-1" ? revisionOne.promise : revisionTwo.promise);
    const client = makeResourcePreviewApi({ getResourceRevisionView });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const binding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      revisionId: "revision-1",
      resourceKind: "moodboard" as const,
    };
    const { result, rerender } = renderHook(
      ({ revisionId }) => useResourceNodeRevisionPreviewController("project-1", [
        { ...binding, revisionId },
      ]),
      { wrapper, initialProps: { revisionId: "revision-1" } },
    );

    rerender({ revisionId: "revision-2" });
    await act(async () => {
      revisionTwo.resolve(moodboardRevisionView("revision-2", "KITE / Direction B"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      binding: { revisionId: "revision-2" },
      preview: { kind: "moodboard", boardName: "KITE / Direction B" },
    }));

    await act(async () => {
      revisionOne.resolve(moodboardView());
      await Promise.resolve();
    });
    expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      binding: { revisionId: "revision-2" },
      preview: { kind: "moodboard", boardName: "KITE / Direction B" },
    });
  });

  test("cancels pending cover bytes when the same Resource switches Revision", async () => {
    const revisionOneCover = deferred<Blob>();
    const coverSignals: AbortSignal[] = [];
    const getResourceRevisionView = vi.fn(async (
      _projectId: string,
      _resourceId: string,
      revisionId: string,
    ) => revisionId === "revision-1"
      ? moodboardView()
      : moodboardRevisionView("revision-2", "KITE / Direction B"));
    const getResourceRevisionBlob = vi.fn((
      path: string,
      signal?: AbortSignal,
    ) => {
      if (signal !== undefined) coverSignals.push(signal);
      return path.includes("/revision-1/")
        ? revisionOneCover.promise
        : Promise.resolve(moodboardCoverBlob());
    });
    const client = makeResourcePreviewApi({
      getResourceRevisionView,
      getResourceRevisionBlob,
    });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      ApiProvider,
      { client, children },
    );
    const binding = {
      workspaceId: "workspace-1",
      resourceId: "moodboard-1",
      resourceKind: "moodboard" as const,
    };
    const { result, rerender } = renderHook(
      ({ revisionId }) => useResourceNodeRevisionPreviewController("project-1", [
        { ...binding, revisionId },
      ]),
      { wrapper, initialProps: { revisionId: "revision-1" } },
    );
    await waitFor(() => expect(getResourceRevisionBlob).toHaveBeenCalledTimes(1));

    rerender({ revisionId: "revision-2" });
    await waitFor(() => expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      binding: { revisionId: "revision-2" },
      preview: { kind: "moodboard", boardName: "KITE / Direction B" },
    }));
    expect(coverSignals[0]?.aborted).toBe(true);

    revisionOneCover.resolve(moodboardCoverBlob());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.states["moodboard-1"]).toMatchObject({
      status: "ready",
      binding: { revisionId: "revision-2" },
      preview: { kind: "moodboard", boardName: "KITE / Direction B" },
    });
  });
});
