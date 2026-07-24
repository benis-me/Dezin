import { test, expect, vi } from "vitest";
import {
  createApiClient,
  ApiError,
  GenerationPlanStreamError,
  decodeContextItemRef,
  decodeResource,
  decodeResourceRevision,
  decodeResourceRevisionHistoryPage,
  decodeResourceRevisionView,
  decodeScopedAgentTurnReceipt,
  parseSseBlock,
  type CreateResearchDirectionArtifactIntentInput,
  type FetchLike,
} from "./api.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBlobText(blob: Blob): Promise<string> {
  const text = Reflect.get(blob, "text");
  if (typeof text === "function") {
    return await Reflect.apply(text, blob, []) as string;
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new TypeError("Blob text result is not a string"));
    }, { once: true });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Blob text read failed"));
    }, { once: true });
    reader.readAsText(blob);
  });
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

const PROJECT = {
  id: "p1",
  name: "P",
  skillId: null,
  designSystemId: "modern-minimal",
  createdAt: 1,
  updatedAt: 1,
};

function scopedAgentReceipt() {
  return {
    contextPackId: "context-pack-1",
    task: {
      id: "task-1",
      ordinal: 0,
      workspaceId: "workspace-1",
      planId: "plan-1",
      kind: "page",
      target: { type: "artifact", workspaceId: "workspace-1", id: "artifact-1", trackId: "track-1" },
      dependencyIds: [],
      capabilities: ["artifact.generate"],
      status: "queued",
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
      createdAt: 1,
      finishedAt: null,
    },
  };
}

test("scoped Agent receipts are decoded before entering UI state", async () => {
  const receipt = scopedAgentReceipt();
  expect(decodeScopedAgentTurnReceipt(receipt)).toEqual(receipt);

  const malformed = structuredClone(receipt);
  malformed.task.target.workspaceId = "workspace-other";
  expect(() => decodeScopedAgentTurnReceipt(malformed)).toThrow(/another Workspace/);

  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(malformed, 202));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.artifactAgentTurn("project-1", "artifact-1", {
    turnId: "turn-12345678-1234-4123-8123-123456789abc",
    intent: "edit",
    message: "Refine the layout",
    explicitContext: [],
    graphRevision: 1,
    baseRevisionId: "revision-1",
  })).rejects.toThrow(/another Workspace/);
});

test("createProject posts JSON and returns the project", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(PROJECT, 201));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const got = await api.createProject({ name: "P", designSystemId: "modern-minimal" });
  expect(got).toEqual(PROJECT);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects",
    expect.objectContaining({ method: "POST" }),
  );
});

test("Research direction intent sends only the strict Agent wire selection", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ plan: { id: "plan-1" } }, 201));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const input = {
    selectionRequestId: "selection-00000000-0000-4000-8000-000000000041",
    artifactId: "artifact-1",
    agentCommand: "codebuddy",
    model: "gpt-5.6-sol",
    expectedResourceHeadRevisionId: "research-revision-1",
    expectedGraphRevision: 3,
    expectedSnapshotId: "snapshot-3",
    expectedLayoutChecksum: "a".repeat(64),
    confirmHypothesis: false,
  } satisfies CreateResearchDirectionArtifactIntentInput;

  await api.createResearchDirectionArtifactIntent(
    "project /1",
    "resource /1",
    "revision /1",
    "direction /1",
    input,
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/project%20%2F1/resources/resource%20%2F1/revisions/revision%20%2F1/directions/direction%20%2F1/artifact-intents",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
    }),
  );

  expect(() => api.createResearchDirectionArtifactIntent(
    "project /1",
    "resource /1",
    "revision /1",
    "direction /1",
    { ...input, providerId: "codebuddy" } as unknown as CreateResearchDirectionArtifactIntentInput,
  )).toThrow(/unsupported field providerId/i);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("Conversation APIs preserve strict scopes in responses, list queries, and create bodies", async () => {
  const conversation = {
    id: "conversation-1",
    projectId: "project /1",
    title: "Artifact chat",
    scope: { type: "artifact", id: "artifact /1" },
    createdAt: 1,
    turns: 2,
  } as const;
  const responses = [[conversation], conversation];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift()));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listConversations("project /1", conversation.scope)).resolves.toEqual([conversation]);
  await expect(api.createConversation("project /1", "Artifact chat", conversation.scope)).resolves.toEqual(conversation);
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/projects/project%20%2F1/conversations?scopeType=artifact&scopeId=artifact%20%2F1",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/project%20%2F1/conversations",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ title: "Artifact chat", scope: conversation.scope }),
    }),
  );

  const invalidFetch = vi.fn<FetchLike>(async () => jsonResponse([{ ...conversation, scope: { type: "branch", id: "artifact /1" } }]));
  await expect(createApiClient({ fetchImpl: invalidFetch }).listConversations("p1")).rejects.toThrow(/scope type/);
});

test("createApiClient sends the daemon token header on JSON requests", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "tok_123" });

  await api.listProjects();

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects",
    expect.objectContaining({ headers: { "x-dezin-daemon-token": "tok_123" } }),
  );
});

test("createApiClient reads the daemon token from the injected page global by default", async () => {
  const g = globalThis as typeof globalThis & { __DEZIN_DAEMON_TOKEN__?: string };
  const previous = g.__DEZIN_DAEMON_TOKEN__;
  g.__DEZIN_DAEMON_TOKEN__ = "tok_global";
  try {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
    const api = createApiClient({ baseUrl: "http://d", fetchImpl });

    await api.listProjects();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://d/api/projects",
      expect.objectContaining({ headers: { "x-dezin-daemon-token": "tok_global" } }),
    );
  } finally {
    g.__DEZIN_DAEMON_TOKEN__ = previous;
  }
});

test("createApiClient preserves existing headers when adding the daemon token", async () => {
  const imported = { ...PROJECT, id: "p2", name: "Imported" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(imported, 201));
  const api = createApiClient({ fetchImpl, daemonToken: "tok_123" });
  const file = new Blob(["zip"], { type: "application/zip" });

  await api.importProject(file);

  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/import",
    expect.objectContaining({
      headers: { "content-type": "application/zip", "x-dezin-daemon-token": "tok_123" },
    }),
  );
});

test("createApiClient sends the daemon token header on SSE requests", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(sseStream([`data: {"type":"run-done"}\n\n`]), { status: 200 }));
  const api = createApiClient({ fetchImpl, daemonToken: "tok_123" });

  for await (const _ of api.streamRun({ projectId: "p1", brief: "make a hero", effectRefs: [{ id: "paper-texture", name: "paper texture" }] })) {
    // consume stream
  }

  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/runs",
    expect.objectContaining({
      headers: { "content-type": "application/json", "x-dezin-daemon-token": "tok_123" },
      body: JSON.stringify({ projectId: "p1", brief: "make a hero", effectRefs: [{ id: "paper-texture", name: "paper texture" }] }),
    }),
  );
});

test("generateProjectTitle POSTs the background title endpoint", async () => {
  const titled = { ...PROJECT, name: "Pricing Control Room" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(titled));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.generateProjectTitle("p1", "A dashboard for pricing experiments")).resolves.toEqual(titled);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/title",
    expect.objectContaining({ method: "POST" }),
  );
});

test("optimizePrompt POSTs the selected prompt optimizer context", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ prompt: "Create a finished Awwwards-level brief." }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(
    api.optimizePrompt({
      prompt: "make it cool",
      agentCommand: "codebuddy",
      model: "hunyuan",
      mode: "standard",
      skillId: "frontend-design",
      designSystemId: "modern-minimal",
    }),
  ).resolves.toEqual({ prompt: "Create a finished Awwwards-level brief." });

  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/prompts/optimize",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "make it cool",
        agentCommand: "codebuddy",
        model: "hunyuan",
        mode: "standard",
        skillId: "frontend-design",
        designSystemId: "modern-minimal",
      }),
    }),
  );
});

test("listProjects GETs the collection", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([PROJECT]));
  const api = createApiClient({ fetchImpl });
  expect(await api.listProjects()).toEqual([PROJECT]);
  expect(fetchImpl).toHaveBeenCalledWith("/api/projects", undefined);
});

test("deleteProject handles 204 No Content", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
  const api = createApiClient({ fetchImpl });
  await expect(api.deleteProject("p1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/p1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("releaseDevServer DELETEs the project devserver lease", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ released: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.releaseDevServer("p1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/devserver",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("preview lease APIs renew and release the exact lease id", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (_input, init) => {
    if (init?.method === "PATCH") return jsonResponse({ leaseId: "lease-1", url: "http://127.0.0.1:5300/", expiresAt: 99 });
    return jsonResponse({ released: true });
  });
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.renewPreviewLease("lease-1")).resolves.toEqual({
    leaseId: "lease-1",
    url: "http://127.0.0.1:5300/",
    expiresAt: 99,
  });
  await expect(api.releasePreviewLease("lease-1")).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/preview-leases/lease-1",
    expect.objectContaining({ method: "PATCH" }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/preview-leases/lease-1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("captureProjectCover POSTs the cover capture endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ captured: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.captureProjectCover("p1")).resolves.toEqual({ captured: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/cover/capture",
    expect.objectContaining({ method: "POST" }),
  );
});

test("setVersionCover POSTs the version cover endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ captured: true }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.setVersionCover("p1", "r1")).resolves.toEqual({ captured: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/versions/r1/cover",
    expect.objectContaining({ method: "POST" }),
  );
});

test("getVersionDiff GETs the version diff endpoint", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse([{ t: "add", text: "new line" }]));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.getVersionDiff("p1", "r1")).resolves.toEqual([{ t: "add", text: "new line" }]);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/versions/r1/diff", undefined);
});

test("workspace APIs encode project and artifact IDs and send typed mutation bodies", async () => {
  const responses = [
    { status: "unsupported", code: "workspace_requires_standard_project", projectId: "p /1", projectMode: "prototype" },
    { graph: { workspaceId: "w1", revision: 2, nodes: [], edges: [] }, snapshot: { id: "s2" } },
    { workspaceId: "w1", layoutId: "default", objects: [], viewport: { x: 2, y: 3, zoom: 1 }, checksum: "layout-2" },
    { id: "a /1", workspaceId: "w1", kind: "page", name: "Page" },
    [],
    [],
    { id: "r /1", artifactId: "a /1" },
    [],
    { id: "s /1", workspaceId: "w1" },
  ];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift()));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const graphInput = {
    baseGraphRevision: 1,
    expectedSnapshotId: "s1",
    commands: [{ id: "c1", type: "rename-node" as const, nodeId: "n1", name: "Checkout" }],
  };
  const layoutInput = {
    layoutId: "default",
    graphRevision: 2,
    baseLayoutChecksum: "layout-1",
    commands: [{ type: "set-viewport" as const, viewport: { x: 2, y: 3, zoom: 1 } }],
  };

  await api.getWorkspace("p /1");
  await api.applyWorkspaceGraphCommands("p /1", graphInput);
  await api.saveWorkspaceLayout("p /1", layoutInput);
  await api.getArtifact("p /1", "a /1");
  await api.listArtifactTracks("p /1", "a /1");
  await api.listArtifactRevisions("p /1", "a /1");
  await api.getArtifactRevision("p /1", "a /1", "r /1");
  await api.listWorkspaceSnapshots("p /1");
  await api.getWorkspaceSnapshot("p /1", "s /1");

  expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://d/api/projects/p%20%2F1/workspace", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/p%20%2F1/workspace/graph/commands",
    expect.objectContaining({ method: "POST", body: JSON.stringify(graphInput) }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    3,
    "http://d/api/projects/p%20%2F1/workspace/layout",
    expect.objectContaining({ method: "PUT", body: JSON.stringify(layoutInput) }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(4, "http://d/api/projects/p%20%2F1/artifacts/a%20%2F1", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(5, "http://d/api/projects/p%20%2F1/artifacts/a%20%2F1/tracks", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(6, "http://d/api/projects/p%20%2F1/artifacts/a%20%2F1/revisions", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(7, "http://d/api/projects/p%20%2F1/artifacts/a%20%2F1/revisions/r%20%2F1", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(8, "http://d/api/projects/p%20%2F1/workspace/snapshots", undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(9, "http://d/api/projects/p%20%2F1/workspace/snapshots/s%20%2F1", undefined);
});

test("Artifact history APIs preserve paging and immutable version action fences", async () => {
  const page = { items: [{ id: "revision /2" }], nextCursor: "cursor /2" };
  const restored = { action: "restore-as-new-revision", revision: { id: "revision-restored" } };
  const forked = { action: "fork-track", revision: { id: "revision-forked" }, track: { id: "track-forked" } };
  const responses = [page, restored, forked];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift(), 201));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listArtifactRevisionHistory("project /1", "artifact /1", {
    limit: 12,
    cursor: "cursor /1",
  })).resolves.toEqual(page);
  await expect(api.restoreArtifactRevision("project /1", "artifact /1", "revision /1", {
    expectedHeadRevisionId: "revision /2",
    expectedSnapshotId: "snapshot /2",
  })).resolves.toEqual(restored);
  await expect(api.forkArtifactTrack("project /1", "artifact /1", "revision /1", {
    name: "Exploration A",
    expectedHeadRevisionId: "revision /2",
    expectedSnapshotId: "snapshot /2",
  })).resolves.toEqual(forked);

  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/projects/project%20%2F1/artifacts/artifact%20%2F1/history?limit=12&cursor=cursor%20%2F1",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/project%20%2F1/artifacts/artifact%20%2F1/revisions/revision%20%2F1/restore",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedHeadRevisionId: "revision /2", expectedSnapshotId: "snapshot /2" }),
    }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    3,
    "http://d/api/projects/project%20%2F1/artifacts/artifact%20%2F1/revisions/revision%20%2F1/fork-track",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Exploration A",
        expectedHeadRevisionId: "revision /2",
        expectedSnapshotId: "snapshot /2",
      }),
    }),
  );
});

test("Resource codecs validate every discriminant and immutable response field", () => {
  const resource = {
    id: "resource-1",
    workspaceId: "workspace-1",
    kind: "moodboard",
    title: "Warm references",
    headRevisionId: null,
    defaultPinPolicy: "follow-head",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const revision = {
    id: "resource-revision-1",
    workspaceId: "workspace-1",
    resourceId: "resource-1",
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resources/resource-1/revisions/resource-revision-1/manifest.json",
    summary: "Frozen moodboard",
    metadata: { sourceId: "moodboard-1" },
    checksum: "a".repeat(64),
    provenance: { source: "moodboard" },
    createdByRunId: null,
    createdAt: 3,
  };

  expect(decodeResource(resource)).toEqual(resource);
  expect(decodeResourceRevision(revision)).toEqual(revision);
  expect(() => decodeResource({ ...resource, kind: "plugin" })).toThrow(/Resource kind/);
  expect(() => decodeResource({ ...resource, defaultPinPolicy: "sometimes" })).toThrow(/pin policy/);
  expect(() => decodeResourceRevision({ ...revision, sequence: 0 })).toThrow(/sequence/);
  expect(() => decodeResourceRevision({ ...revision, metadata: [] })).toThrow(/metadata/);
});

test("canonical Context refs preserve Resource kind and reject pre-canonical identities", () => {
  expect(decodeContextItemRef({
    kind: "resource",
    id: "resource-1",
    resourceKind: "moodboard",
    revisionId: "revision-1",
  })).toEqual({
    kind: "resource",
    id: "resource-1",
    resourceKind: "moodboard",
    revisionId: "revision-1",
  });
  expect(() => decodeContextItemRef({ kind: "resource", id: "resource-1" })).toThrow(/resourceKind/);
  expect(() => decodeContextItemRef({ kind: "workspace-node", id: "node-1" })).toThrow(/kind/);
  expect(() => decodeContextItemRef({ kind: "inline", id: "inline-1", content: "not canonical" })).toThrow(/unsupported field/);
});

test("Resource client covers the seven approved routes with owned-source and CAS request bodies", async () => {
  const resource = {
    id: "resource /1",
    workspaceId: "workspace-1",
    kind: "file",
    title: "Hero image",
    headRevisionId: null,
    defaultPinPolicy: "follow-head",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const revision = {
    id: "revision /1",
    workspaceId: "workspace-1",
    resourceId: "resource /1",
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resources/resource-1/revisions/revision-1/manifest.json",
    summary: "Frozen upload",
    metadata: {},
    checksum: "b".repeat(64),
    provenance: { source: "uploaded-file" },
    createdByRunId: null,
    createdAt: 2,
  };
  const graph = { workspaceId: "workspace-1", revision: 2, nodes: [], edges: [] };
  const snapshot = { id: "snapshot-2", workspaceId: "workspace-1" };
  const responses = [
    [resource],
    { resource, node: { id: "node-1", workspaceId: "workspace-1", name: "Hero image", kind: "resource", resourceId: "resource /1" }, graph, snapshot },
    resource,
    { action: "set-default-pin-policy", resource: { ...resource, defaultPinPolicy: "pin-current" } },
    [revision],
    revision,
    snapshot,
  ];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift()));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const createInput = {
    kind: "file" as const,
    title: "Hero image",
    defaultPinPolicy: "follow-head" as const,
    baseGraphRevision: 1,
    expectedSnapshotId: "snapshot-1",
  };
  const updateInput = {
    action: "set-default-pin-policy" as const,
    expectedDefaultPinPolicy: "follow-head" as const,
    defaultPinPolicy: "pin-current" as const,
  };
  const revisionInput = {
    expectedHeadRevisionId: null,
    source: { type: "uploaded-file" as const, uploadedFileId: "upload-1" },
  };
  const publishInput = {
    expectedHeadRevisionId: null,
    expectedSnapshotId: "snapshot-1",
    reason: "Publish uploaded hero image",
  };

  await api.listResources("project /1");
  await api.createResource("project /1", createInput);
  await api.getResource("project /1", "resource /1");
  await api.updateResource("project /1", "resource /1", updateInput);
  await api.listResourceRevisions("project /1", "resource /1");
  await api.createResourceRevision("project /1", "resource /1", revisionInput);
  await api.publishResourceRevision("project /1", "resource /1", "revision /1", publishInput);

  const base = "http://d/api/projects/project%20%2F1/resources";
  expect(fetchImpl).toHaveBeenNthCalledWith(1, base, undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(2, base, expect.objectContaining({ method: "POST", body: JSON.stringify(createInput) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(3, `${base}/resource%20%2F1`, undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(4, `${base}/resource%20%2F1`, expect.objectContaining({ method: "PATCH", body: JSON.stringify(updateInput) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(5, `${base}/resource%20%2F1/revisions`, undefined);
  expect(fetchImpl).toHaveBeenNthCalledWith(6, `${base}/resource%20%2F1/revisions`, expect.objectContaining({ method: "POST", body: JSON.stringify(revisionInput) }));
  expect(fetchImpl).toHaveBeenNthCalledWith(
    7,
    `${base}/resource%20%2F1/revisions/revision%20%2F1/publish`,
    expect.objectContaining({ method: "POST", body: JSON.stringify(publishInput) }),
  );
});

test("Resource Revision requests reject client-authored storage and integrity fields before fetch", () => {
  const fetchImpl = vi.fn<FetchLike>();
  const api = createApiClient({ fetchImpl });

  expect(() =>
    api.createResourceRevision("p1", "resource-1", {
      expectedHeadRevisionId: null,
      source: { type: "uploaded-file", uploadedFileId: "upload-1" },
      manifestPath: "/tmp/client-manifest.json",
      checksum: "client-authored",
      provenance: { trusted: true },
    } as never),
  ).toThrow(/unsupported field manifestPath/);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("exact Resource Revision view and paged history use strict browser decoders", async () => {
  const resource = {
    id: "resource-1",
    workspaceId: "workspace-1",
    kind: "file",
    title: "Product brief",
    headRevisionId: "revision-1",
    defaultPinPolicy: "follow-head",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
  } as const;
  const revision = {
    id: "revision-1",
    workspaceId: resource.workspaceId,
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resource-revisions/a/b/manifest.json",
    summary: "Frozen product brief",
    metadata: {},
    checksum: "a".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 2,
  };
  const view = {
    protocol: "dezin.resource-revision-view.v1",
    kind: "file",
    resource,
    revision: {
      id: revision.id,
      workspaceId: revision.workspaceId,
      resourceId: revision.resourceId,
      sequence: revision.sequence,
      parentRevisionId: revision.parentRevisionId,
      summary: revision.summary,
      checksum: revision.checksum,
      createdAt: revision.createdAt,
    },
    observed: { headRevisionId: revision.id, snapshotId: "snapshot-1" },
    payload: {
      mimeType: "text/plain",
      byteLength: 12,
      checksum: "a".repeat(64),
      previewKind: "text",
      url: null,
      downloadUrl: "/api/projects/project-1/resources/resource-1/revisions/revision-1/payload",
    },
    content: { fileName: "brief.txt", previewKind: "text", text: "Exact bytes", textTruncated: false },
  };
  expect(decodeResourceRevisionView(view)).toEqual(view);
  expect(() => decodeResourceRevisionView({ ...view, unexpected: true })).toThrow(/unsupported field unexpected/);
  const externalView = {
    ...view,
    kind: "external-reference",
    resource: { ...resource, kind: "external-reference" },
    content: {
      sourceUrl: "https://example.test/",
      finalUrl: "https://example.test/frozen",
      status: 200,
      previewKind: "text",
      text: "Frozen response",
      textTruncated: false,
    },
  };
  expect(decodeResourceRevisionView(externalView)).toEqual(externalView);
  expect(() => decodeResourceRevisionView({
    ...externalView,
    content: { ...externalView.content, sourceUrl: "https://example.test?access_token=secret" },
  })).toThrow(/canonical credential-free/);
  expect(decodeResourceRevisionHistoryPage({ items: [revision], nextCursor: "opaque-cursor" })).toEqual({
    items: [revision],
    nextCursor: "opaque-cursor",
  });

  let callIndex = 0;
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(callIndex++ === 0
    ? view
    : { items: [revision], nextCursor: "opaque-cursor" }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.getResourceRevisionView("project /1", "resource /1", "revision /1")).resolves.toEqual(view);
  await expect(api.listResourceRevisionHistory("project /1", "resource /1", {
    limit: 20,
    cursor: "opaque cursor",
  })).resolves.toEqual({ items: [revision], nextCursor: "opaque-cursor" });
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/projects/project%20%2F1/resources/resource%20%2F1/revisions/revision%20%2F1",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/project%20%2F1/resources/resource%20%2F1/history?limit=20&cursor=opaque%20cursor",
    undefined,
  );
});

test("exact Resource media bytes are fetched with daemon authentication and never a token query", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(new TextEncoder().encode("exact"), {
    status: 200,
    headers: { "content-type": "image/png" },
  }));
  const api = createApiClient({ baseUrl: "http://d", daemonToken: "daemon-secret", fetchImpl });

  const blob = await api.getResourceRevisionBlob(
    "/api/projects/project-1/resources/resource-1/revisions/revision-1/embedded-assets/asset-1",
  );
  expect(blob.size).toBe(5);
  expect(blob.type).toBe("image/png");
  await expect(readBlobText(blob)).resolves.toBe("exact");
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/project-1/resources/resource-1/revisions/revision-1/embedded-assets/asset-1",
    expect.objectContaining({ headers: { "x-dezin-daemon-token": "daemon-secret" } }),
  );
  expect(fetchImpl.mock.calls[0]?.[0]).not.toContain("token=");
  expect(() => api.getResourceRevisionBlob(
    "/api/projects/project-1/resources/resource-1/revisions/revision-1/payload?token=daemon-secret",
  )).toThrow(/protected Resource Revision byte path/);
});

test("Resource client materializes an owned source through one atomic route", async () => {
  const resource = {
    id: "resource-1",
    workspaceId: "workspace-1",
    kind: "file",
    title: "Product brief",
    headRevisionId: "revision-1",
    defaultPinPolicy: "pin-current",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
  } as const;
  const revision = {
    id: "revision-1",
    workspaceId: "workspace-1",
    resourceId: resource.id,
    sequence: 1,
    parentRevisionId: null,
    manifestPath: "resource-revisions/a/b/manifest.json",
    summary: "Uploaded file: brief.txt",
    metadata: {},
    checksum: "a".repeat(64),
    provenance: {},
    createdByRunId: null,
    createdAt: 2,
  };
  const result = {
    resource,
    revision,
    node: {
      id: "node-1",
      workspaceId: "workspace-1",
      name: resource.title,
      kind: "resource",
      resourceId: resource.id,
    },
    graph: {
      workspaceId: "workspace-1",
      revision: 2,
      nodes: [{
        id: "node-1",
        workspaceId: "workspace-1",
        name: resource.title,
        kind: "resource",
        resourceId: resource.id,
      }],
      edges: [],
    },
    snapshot: {
      id: "snapshot-2",
      workspaceId: "workspace-1",
      resourceRevisions: { [resource.id]: revision.id },
    },
  };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(result, 201));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const input = {
    kind: "file" as const,
    title: resource.title,
    defaultPinPolicy: "pin-current" as const,
    baseGraphRevision: 1,
    expectedSnapshotId: "snapshot-1",
    source: { type: "uploaded-file" as const, uploadedFileId: ".refs/brief.txt" },
    reason: "Attached to scoped Agent Context",
  };

  await expect(api.materializeResource("project /1", input)).resolves.toEqual(result);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/project%20%2F1/resources/materialize",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
  );
});

test("forkMessage POSTs the message fork endpoint", async () => {
  const payload = { conversationId: "c2", variantId: "v2", variants: [] };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(payload));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  await expect(api.forkMessage("p1", "m1")).resolves.toEqual(payload);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/p1/messages/m1/fork",
    expect.objectContaining({ method: "POST" }),
  );
});

test("non-ok responses throw ApiError with the status", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("nope", { status: 404 }));
  const api = createApiClient({ fetchImpl });
  await expect(api.getProject("x")).rejects.toMatchObject({ name: "ApiError", status: 404 });
  await expect(api.getProject("x")).rejects.toBeInstanceOf(ApiError);
});

test("non-ok JSON responses throw ApiError with the daemon error message", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({
    error: "OpenAI rejected credentials.",
    code: "provider_auth_failed",
    providerId: "openai",
  }, 401));
  const api = createApiClient({ fetchImpl });
  await expect(api.testModelProvider("openai")).rejects.toMatchObject({
    name: "ApiError",
    status: 401,
    message: "OpenAI rejected credentials.",
    details: {
      error: "OpenAI rejected credentials.",
      code: "provider_auth_failed",
      providerId: "openai",
    },
  });
});

test("previewUrl and exportUrl build the right paths", () => {
  const api = createApiClient({ baseUrl: "http://d" });
  expect(api.previewUrl("p1")).toBe("http://d/projects/p1/preview/");
  expect(api.exportUrl("p1")).toBe("http://d/api/projects/p1/export");
  expect(api.exportUrl("p1", "full")).toBe("http://d/api/projects/p1/export?scope=full");
});

test("importProject posts a zip file and returns the created project", async () => {
  const imported = { ...PROJECT, id: "p2", name: "Imported" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(imported, 201));
  const api = createApiClient({ fetchImpl });
  const file = new Blob(["zip"], { type: "application/zip" });
  await expect(api.importProject(file)).resolves.toEqual(imported);
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/projects/import",
    expect.objectContaining({
      method: "POST",
      body: file,
      headers: { "content-type": "application/zip" },
    }),
  );
});

test("streamRun yields SSE events, including one split across chunks", async () => {
  const chunks = [
    `data: {"type":"run-start","runId":"r1","conversationId":"c1"}\n\n`,
    `data: {"type":"turn-start","round":0,"isRepair":fal`, // split mid-JSON
    `se}\n\ndata: {"type":"run-done","runId":"r1","passed":true,"rounds":0,"previewUrl":"/projects/p1/preview/","findings":[]}\n\n`,
  ];
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(sseStream(chunks), { status: 200 }));
  const api = createApiClient({ fetchImpl });

  const events = [];
  for await (const ev of api.streamRun({ projectId: "p1", brief: "make a hero" })) {
    events.push(ev);
  }

  expect(events.map((e) => e.type)).toEqual(["run-start", "turn-start", "run-done"]);
  expect(events[1]).toMatchObject({ round: 0, isRepair: false });
  expect(events[2]).toMatchObject({ passed: true, previewUrl: "/projects/p1/preview/" });
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/runs",
    expect.objectContaining({ method: "POST" }),
  );
});

test("reattachRun can request events after a sequence cursor", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () =>
    new Response(sseStream([`data: {"type":"run-done","seq":3}\n\n`]), { status: 200 }),
  );
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  const events = [];
  for await (const ev of api.reattachRun("r1", undefined, { afterSeq: 2 })) events.push(ev);

  expect(events).toEqual([{ type: "run-done", seq: 3 }]);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/runs/r1/stream?after=2", { signal: undefined });
});

test("listDesignSystems and listSkills GET the catalog", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (url) =>
    url.endsWith("/api/design-systems")
      ? jsonResponse([{ id: "modern-minimal", name: "Modern Minimal", category: "Modern & Minimal", summary: "x" }])
      : jsonResponse([{ id: "frontend-design", name: "Frontend design", description: "d", mode: "prototype", triggers: [], designSystem: true }]),
  );
  const api = createApiClient({ fetchImpl });
  const ds = await api.listDesignSystems();
  assert.equal(ds[0]?.id, "modern-minimal");
  const sk = await api.listSkills();
  assert.equal(sk[0]?.mode, "prototype");
  assert.ok(fetchImpl.mock.calls.some(([u]) => u === "/api/design-systems"));
  assert.ok(fetchImpl.mock.calls.some(([u]) => u === "/api/skills"));
});

test("settings + agents + health endpoints", async () => {
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/api/settings") && init?.method === "PUT") {
      return jsonResponse({
        agentCommand: "codex",
        model: "o3",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: false,
        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      });
    }
    if (url.endsWith("/api/settings")) {
      return jsonResponse({
        agentCommand: "claude",
        model: "",
        apiBaseUrl: "",
        apiKey: "",
        defaultDesignSystemId: "modern-minimal",
        customInstructions: "",
        imageApiBaseUrl: "",
        imageApiKey: "",
        imageModel: "",
        removeBackgroundModel: "",
        editRegionModel: "",
        extractLayerModel: "",
        videoApiBaseUrl: "",
        videoApiKey: "",
        videoModel: "",
        aiProviderId: "openai",
        aiProviderEnabled: false,
        aiProviderModels: "gpt-image-1",
        aiProviderOrganization: "",
        aiProviderProfiles: "",
        visualQaEnabled: false,
        visualQaAgentCommand: "",
        visualQaModel: "",
        autoImproveEnabled: true,
        autoImproveMaxRounds: 8,
      });
    }
    if (url.endsWith("/api/agents")) return jsonResponse([{ id: "claude", command: "claude", available: true, version: "1.2.3" }]);
    return jsonResponse({ ok: true, version: "0.0.0" });
  });
  const api = createApiClient({ fetchImpl });
  assert.equal((await api.getSettings()).agentCommand, "claude");
  assert.equal((await api.updateSettings({ agentCommand: "codex", model: "o3" })).model, "o3");
  assert.equal((await api.listAgents())[0]?.available, true);
  assert.equal((await api.getHealth()).version, "0.0.0");
});

test("moodboard client methods hit first-class board endpoints", async () => {
  const board = { id: "b1", name: "Refs", createdAt: 1, updatedAt: 2, archivedAt: null, coverAssetId: null, coverUrl: null };
  const node = {
    id: "n1",
    boardId: "b1",
    type: "note" as const,
    x: 0,
    y: 0,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex: 0,
    data: { content: "x" },
    createdAt: 1,
    updatedAt: 1,
  };
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/api/moodboards/start")) return jsonResponse(board, 201);
    if (url.endsWith("/api/moodboards") && init?.method === "POST") return jsonResponse(board, 201);
    if (url.endsWith("/api/moodboards")) return jsonResponse([board]);
    if (url.endsWith("/api/moodboards/b1/nodes") && init?.method === "PUT") return jsonResponse([node]);
    if (url.endsWith("/api/moodboards/b1/messages") && init?.method === "POST") return jsonResponse({ messages: [] }, 201);
    if (url.endsWith("/api/moodboards/b1/generate-image")) {
      return jsonResponse({ asset: { id: "a1", boardId: "b1", kind: "image", fileName: "generated.png", mimeType: "image/png", width: 1024, height: 1024, source: "generated", createdAt: 1, url: "/asset" }, nodes: [node], messages: [] }, 201);
    }
    return jsonResponse({ ...board, assets: [], nodes: [node], messages: [] });
  });
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listMoodboards()).resolves.toEqual([board]);
  await expect(api.createMoodboard({ name: "Refs" })).resolves.toEqual(board);
  await expect(api.startMoodboard({ name: "Refs", prompt: "Warm editorial", mode: "agent", agentCommand: "codex" })).resolves.toEqual(board);
  await expect(api.getMoodboard("b1")).resolves.toMatchObject({ id: "b1", nodes: [node] });
  await expect(api.saveMoodboardNodes("b1", [node])).resolves.toEqual([node]);
  await expect(api.postMoodboardMessage("b1", "read the board", { agentCommand: "codex", model: "gpt-5" })).resolves.toEqual({ messages: [] });
  await expect(api.generateMoodboardImage("b1", "soft glass")).resolves.toMatchObject({ nodes: [node] });
  await expect(api.generateMoodboardImage("b1", "make it warmer", { sourceAssetId: "asset-1", model: "gpt-image-2" })).resolves.toMatchObject({
    nodes: [node],
  });

  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards", undefined);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/moodboards/start",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Refs", prompt: "Warm editorial", mode: "agent", agentCommand: "codex" }),
    }),
  );
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards/b1/nodes", expect.objectContaining({ method: "PUT" }));
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/moodboards/b1/messages",
    expect.objectContaining({ body: JSON.stringify({ content: "read the board", agentCommand: "codex", model: "gpt-5" }) }),
  );
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/moodboards/b1/generate-image", expect.objectContaining({ method: "POST" }));
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/moodboards/b1/generate-image",
    expect.objectContaining({
      body: JSON.stringify({ prompt: "make it warmer", sourceAssetId: "asset-1", model: "gpt-image-2" }),
    }),
  );
});

test("effect client methods hit the first-class effect endpoints", async () => {
  const effect = {
    id: "fx-1",
    name: "Glass ribbon",
    origin: "custom" as const,
    category: "Custom",
    summary: "A local editable effect.",
    parameters: [],
    presets: [{ id: "default", name: "Default", values: {} }],
    code: "function renderEffect(ctx) { ctx.clearRect(0,0,10,10); }",
    createdAt: 1,
    updatedAt: 2,
  };
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith("/api/effects") && init?.method === "POST") return jsonResponse(effect, 201);
    if (url.endsWith("/api/effects/fx-1") && init?.method === "PATCH") return jsonResponse({ ...effect, name: "Glass ribbon v2" });
    if (url.endsWith("/api/effects")) return jsonResponse([effect]);
    return jsonResponse(effect);
  });
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listEffects()).resolves.toEqual([effect]);
  await expect(api.createEffect({ name: "Glass ribbon" })).resolves.toEqual(effect);
  await expect(api.getEffect("fx-1")).resolves.toEqual(effect);
  await expect(api.updateEffect("fx-1", { name: "Glass ribbon v2" })).resolves.toMatchObject({ name: "Glass ribbon v2" });

  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/effects", undefined);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/effects", expect.objectContaining({ method: "POST" }));
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/effects/fx-1", undefined);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/effects/fx-1", expect.objectContaining({ method: "PATCH" }));
});

test("parseSseBlock ignores non-data noise", () => {
  expect(parseSseBlock(": keep-alive")).toBeNull();
  expect(parseSseBlock("data: not json")).toBeNull();
  expect(parseSseBlock(`data: {"type":"x"}`)).toEqual({ type: "x" });
});

test("Generation Plan APIs preserve encoded ownership paths and exact control bodies", async () => {
  const plan = {
    id: "plan /1",
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    proposalRevision: 1,
    baseSnapshotId: "snapshot-1",
    status: "running",
    constructionSealed: true,
    compileError: null,
    createdAt: 1,
    finishedAt: null,
  } as const;
  const detail = { plan, tasks: [], dependencies: [], currentAttempts: [] };
  const responses = [[plan], detail, detail, detail];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift()));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.listGenerationPlans("project /1")).resolves.toEqual([plan]);
  await expect(api.getGenerationPlan("project /1", "plan /1")).resolves.toEqual(detail);
  await expect(api.cancelGenerationPlan("project /1", "plan /1")).resolves.toEqual(detail);
  await expect(api.retryGenerationTask("project /1", "plan /1", "task /1", "latest-context")).resolves.toEqual(detail);

  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/projects/project%20%2F1/workspace/plans",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/project%20%2F1/workspace/plans/plan%20%2F1",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    3,
    "http://d/api/projects/project%20%2F1/workspace/plans/plan%20%2F1/cancel",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    4,
    "http://d/api/projects/project%20%2F1/workspace/plans/plan%20%2F1/tasks/task%20%2F1/retry",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "latest-context" }),
    }),
  );
});

test("latest scoped Artifact Plan API returns only the durable Plan id", async () => {
  const responses = [{ planId: "plan-scoped" }, { planId: null }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(responses.shift()));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  await expect(api.getLatestScopedArtifactPlanId("project-1", "artifact-1"))
    .resolves.toBe("plan-scoped");
  await expect(api.getLatestScopedArtifactPlanId("project-1", "artifact-2"))
    .resolves.toBeNull();
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://d/api/projects/project-1/artifacts/artifact-1/agent/latest-plan",
    undefined,
  );
  expect(fetchImpl).toHaveBeenNthCalledWith(
    2,
    "http://d/api/projects/project-1/artifacts/artifact-2/agent/latest-plan",
    undefined,
  );
});

test("streamGenerationPlanEvents resumes from a durable cursor with daemon authentication", async () => {
  const event = {
    planId: "plan /1",
    sequence: 8,
    taskId: "task-1",
    type: "task-succeeded",
    payload: { revisionId: "revision-1" },
    createdAt: 9,
  };
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(
    sseStream([`id: 8\ndata: ${JSON.stringify(event)}\n\n`]),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl, daemonToken: "tok_plan" });

  const received = [];
  for await (const item of api.streamGenerationPlanEvents("project /1", "plan /1", undefined, { after: 7 })) {
    received.push(item);
  }

  expect(received).toEqual([event]);
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://d/api/projects/project%20%2F1/workspace/plans/plan%20%2F1/events?after=7",
    expect.objectContaining({ headers: { "x-dezin-daemon-token": "tok_plan" } }),
  );
});

test("streamGenerationPlanEvents surfaces a permanent SSE error instead of yielding an invalid Plan event", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response(
    sseStream([`event: error\ndata: ${JSON.stringify({ error: "Plan ownership no longer matches." })}\n\n`]),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });

  const consume = async (): Promise<void> => {
    for await (const _event of api.streamGenerationPlanEvents("project-1", "plan-1")) {
      // A typed stream error must terminate before any payload is exposed as a durable Plan event.
    }
  };

  await expect(consume()).rejects.toEqual(expect.objectContaining<Partial<GenerationPlanStreamError>>({
    name: "GenerationPlanStreamError",
    message: "Plan ownership no longer matches.",
    retryable: false,
  }));
});

test("getDesignSystem GETs the detail endpoint", async () => {
  const detail = { id: "modern-minimal", name: "Modern Minimal", category: "c", summary: "s", swatch: { bg: "#fff", surface: "#eee", fg: "#111", accent: "#36f" }, designMd: "## 1.", tokensCss: "--accent:#36f" };
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(detail));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.getDesignSystem("modern-minimal")).toEqual(detail);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/design-systems/modern-minimal", undefined);
});

test("listFiles GETs the files endpoint", async () => {
  const files = [{ path: "index.html", size: 12 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(files));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listFiles("p1")).toEqual(files);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/files", undefined);
});

test("listRuns GETs the active-branch runs endpoint by default", async () => {
  const runs = [{ id: "r1", variantId: "v1", status: "succeeded", score: 92, repairRounds: 1, lintPassed: true, createdAt: 1, finishedAt: 2 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(runs));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listRuns("p1")).toEqual(runs);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/runs", undefined);
});

test("listRuns can request all branch runs", async () => {
  const runs = [{ id: "r1", variantId: "v1", status: "succeeded", score: 92, repairRounds: 1, lintPassed: true, createdAt: 1, finishedAt: 2 }];
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(runs));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.listRuns("p1", { all: true })).toEqual(runs);
  expect(fetchImpl).toHaveBeenCalledWith("http://d/api/projects/p1/runs?all=1", undefined);
});

test("getFileText fetches the static preview file as text", async () => {
  const fetchImpl = vi.fn<FetchLike>(async () => new Response("<h1>hi</h1>", { status: 200 }));
  const api = createApiClient({ baseUrl: "http://d", fetchImpl });
  expect(await api.getFileText("p1", "assets/x.css")).toBe("<h1>hi</h1>");
  expect(fetchImpl).toHaveBeenCalledWith("http://d/projects/p1/preview/assets/x.css");
});
